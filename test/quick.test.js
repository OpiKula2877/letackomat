import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeWriter, openDb } from '../server/db.js';
import { buildApp } from '../server/index.js';
import { parseListing, parseProductPage, productUrl, searchUrl } from '../server/scraper/kupi.js';
import { buildDigest, createAlerts } from '../server/watch/alerts.js';
import { quickRefresh, quickTargets } from '../server/watch/quick.js';
import { createRule } from '../server/watch/rules.js';
import { createWatcher } from '../server/watch/watcher.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(here, 'fixtures', n), 'utf8');
const TODAY = '2026-10-23';

test('stránka produktu: název z h1, obrázek z JSON-LD, akce ze všech obchodů bez karet product--wrap', () => {
  const { deals } = parseProductPage(fixture('kupi-product.html'), 'bylinny-liker-jagermeister', TODAY);
  assert.equal(deals.length, 2);
  const albert = deals.find((d) => d.id === 7001);
  assert.equal(albert.name, 'Bylinný likér Jägermeister');
  assert.equal(albert.product_slug, 'bylinny-liker-jagermeister');
  assert.equal(albert.product_id, 669);
  assert.equal(albert.shop_slug, 'albert');
  assert.equal(albert.price_sale, 229);
  assert.equal(albert.discount_pct, 25);
  assert.equal(albert.valid_from, '2026-10-21');
  assert.equal(albert.valid_to, '2026-10-27');
  assert.equal(albert.image_url, 'https://img.kupi.cz/kupi/thumbs/jagermeister_170_340.jpg');
  assert.equal(albert.source_url, 'https://www.kupi.cz/sleva/bylinny-liker-jagermeister');
  const tesco = deals.find((d) => d.id === 7002);
  assert.equal(tesco.shop_slug, 'tesco');
  assert.equal(tesco.valid_to, '2026-10-27');
  assert.equal(parseProductPage('<html><body>nic</body></html>', 'x', TODAY).deals.length, 0);
  // běžný výpis bez fallbacku se chová jako dřív (řádek bez produktu se přeskočí)
  assert.equal(parseListing(fixture('kupi-product.html'), 'x', TODAY).deals.length, 0);
});

test('rychlá kontrola: adresy podle pravidel, stažení a uložení akcí, chyby se počítají', async () => {
  const db = openDb(':memory:');
  createRule(db, { kind: 'keyword', value: 'Jägermeister' }, TODAY);
  createRule(db, { kind: 'keyword', value: 'jagermeister', minDiscount: 20 }, TODAY); // stejné slovo, jiná podmínka: stáhne se jednou
  const w = makeWriter(db);
  w.shop({ slug: 'albert', name: 'Albert' });
  w.deal({
    id: 1, shop_slug: 'albert', product_id: 669, product_slug: 'bylinny-liker-jagermeister', name: 'Bylinný likér Jägermeister', name_norm: 'bylinny liker jagermeister',
    quantity: null, note: null, category: 'alkohol', price_sale: 299, price_orig: null, discount_pct: null, price_per_unit: null,
    valid_from: null, valid_to: '2026-10-27', image_url: null, source_url: 'u', leaflet_url: null, seen: TODAY,
  });
  createRule(db, { kind: 'product', value: 'bylinny-liker-jagermeister' }, TODAY);

  const targets = quickTargets((await import('../server/watch/rules.js')).listRules(db));
  assert.deepEqual(targets.map((t) => t.url).sort(), [searchUrl('jagermeister'), productUrl('bylinny-liker-jagermeister')].sort());

  const asked = [];
  const out = await quickRefresh(db, {
    today: TODAY, delayMs: 0,
    fetchPage: async (url) => { asked.push(url); return url.includes('/sleva/') ? fixture('kupi-product.html') : fixture('kupi-listing.html'); },
  });
  assert.deepEqual([...asked].sort(), [searchUrl('jagermeister'), productUrl('bylinny-liker-jagermeister')].sort());
  assert.equal(out.requested, 2);
  assert.equal(out.ok, 2);
  assert.equal(out.failed, 0);
  assert.ok(out.deals >= 2);
  const row = db.prepare('SELECT price_sale, discount_pct, valid_from FROM deals WHERE id = 7001').get();
  assert.equal(row.price_sale, 229);
  assert.equal(row.discount_pct, 25);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM shops WHERE slug = 'tesco'").get().n, 1);

  // bez připojení: chyby se spočítají a nic se nerozbije; 404 (produkt zmizel) chybou není
  const failing = await quickRefresh(db, { today: TODAY, delayMs: 0, fetchPage: async () => { throw new Error('offline'); } });
  assert.deepEqual({ ok: failing.ok, failed: failing.failed }, { ok: 0, failed: 2 });
  const gone = await quickRefresh(db, { today: TODAY, delayMs: 0, fetchPage: async () => null });
  assert.deepEqual({ ok: gone.ok, failed: gone.failed }, { ok: 2, failed: 0 });
});

test('plánovač: hned po startu, pak po 30 minutách, po spánku počítače a při výpadku sítě brzy znovu', async () => {
  let clock = 1_000_000;
  let enabled = true;
  const calls = { quick: 0, run: 0 };
  let quickResult = { requested: 2, ok: 2, failed: 0 };
  const w = createWatcher({
    now: () => clock,
    alerts: { enabled: () => enabled, run: async () => { calls.run++; return { sent: 0, matches: 0 }; } },
    quick: async () => { calls.quick++; return quickResult; },
  });
  /** Běží jako reálné tiky po 10 s; vrací počet rychlých kontrol za tu dobu. */
  const tickFor = async (ms) => {
    const before = calls.quick;
    for (let t = 0; t < ms; t += 10_000) { clock += 10_000; await w.tick(); }
    return calls.quick - before;
  };

  assert.equal((await w.tick()).ok, true); // hned po startu, bez čekání
  assert.deepEqual(calls, { quick: 1, run: 1 });
  assert.equal(await tickFor(29 * 60_000), 0); // dalších 29 minut nic
  assert.equal(await tickFor(2 * 60_000), 1); // po 30 minutách znovu

  // spánek: časovač stál 2 hodiny, po probuzení se kontroluje hned (jeden tik)
  clock += 2 * 3600_000;
  const woke = await w.tick();
  assert.equal(woke.woke, true);
  assert.equal(woke.ok, true);
  assert.equal(await tickFor(5 * 60_000), 0); // a pak zase klid

  // vypnuté hlídání nedělá nic ani po probuzení
  enabled = false;
  const q = calls.quick;
  clock += 2 * 3600_000;
  assert.equal((await w.tick()).skipped, true);
  assert.equal(calls.quick, q);
  enabled = true;

  // bez připojení (Wi-Fi po startu ještě není): nezapíše se jako hotové, zkusí se znovu za 15 s
  quickResult = { requested: 2, ok: 0, failed: 2 };
  const w2 = createWatcher({
    now: () => clock,
    alerts: { enabled: () => true, run: async () => ({}) },
    quick: async () => { calls.quick++; return quickResult; },
  });
  assert.equal((await w2.tick()).retry, true);
  const n = calls.quick;
  clock += 10_000;
  assert.equal((await w2.tick()).skipped, true); // ještě nepřešlo 15 s
  quickResult = { requested: 2, ok: 2, failed: 0 };
  clock += 10_000;
  assert.equal((await w2.tick()).ok, true); // teď už se podařilo
  assert.equal(calls.quick, n + 1);
});

test('oznámení: kliknutí otevírá Upozornění, u jednoho pravidla rovnou jeho akce; Zkontrolovat teď nejdřív obnoví data', async () => {
  const db = openDb(':memory:');
  const w = makeWriter(db);
  w.shop({ slug: 'albert', name: 'Albert' });
  const add = (id, slug, name) => w.deal({
    id, shop_slug: 'albert', product_id: id, product_slug: slug, name, name_norm: name.toLowerCase(), quantity: null, note: null, category: 'ostatni',
    price_sale: 100, price_orig: null, discount_pct: 20, price_per_unit: null, valid_from: '2026-10-22', valid_to: '2026-10-30', image_url: null, source_url: 'u', leaflet_url: null, seen: TODAY,
  });
  add(1, 'pivo-a', 'Pivo A');
  const a = createRule(db, { kind: 'keyword', value: 'pivo' }, TODAY).rule;
  const b = createRule(db, { kind: 'keyword', value: 'rum' }, TODAY).rule;

  const sent = [];
  const order = [];
  const alerts = createAlerts(db, {
    port: 3123, today: () => TODAY, root: 'C:\\x',
    notify: async (n) => { order.push('notify'); sent.push(n); return { ok: true }; },
    refresh: async () => { order.push('refresh'); add(2, 'pivo-b', 'Pivo B'); },
  });
  process.env.LETACKOMAT_STARTUP_DIR = (await import('node:os')).tmpdir();
  await alerts.setEnabled(true);
  const { rmSync } = await import('node:fs');
  rmSync((await import('../server/watch/autostart.js')).autostartFile(), { force: true });
  delete process.env.LETACKOMAT_STARTUP_DIR;

  const r = await alerts.check(); // obnoví data (přibyl Pivo B) a vyhodnotí
  assert.deepEqual(order, ['refresh', 'notify']);
  assert.equal(r.sent, 1);
  assert.equal(sent[0].url, `http://localhost:3123/#alerts/${a.id}`); // jedno pravidlo = rozbalí se jeho akce
  assert.ok(b.id);

  await alerts.test();
  assert.equal(sent.at(-1).url, 'http://localhost:3123/#alerts');

  const many = buildDigest([
    { rule: { id: 1, label: 'x' }, deal: { name: 'A', priceSale: 1, discountPct: null, shop: { name: 'S' }, productSlug: 'a' } },
    { rule: { id: 2, label: 'y' }, deal: { name: 'B', priceSale: 2, discountPct: null, shop: { name: 'S' }, productSlug: 'b' } },
  ]);
  assert.equal(many.ruleId, null); // víc pravidel = jen záložka Upozornění
});

test('API: všechny akce pravidla pro rozbalení', async () => {
  const db = openDb(':memory:');
  const w = makeWriter(db);
  w.shop({ slug: 'albert', name: 'Albert' });
  for (let i = 1; i <= 3; i++) {
    w.deal({
      id: i, shop_slug: 'albert', product_id: i, product_slug: `jager-${i}`, name: `Jägermeister ${i}`, name_norm: `jagermeister ${i}`, quantity: null, note: null, category: 'alkohol',
      price_sale: 100 + i, price_orig: null, discount_pct: 10 * i, price_per_unit: null, valid_from: '2026-10-22', valid_to: '2099-12-31', image_url: null, source_url: 'u', leaflet_url: null, seen: TODAY,
    });
  }
  const alerts = createAlerts(db, { notify: async () => ({ ok: true }) });
  const app = buildApp(db, { alerts });
  const local = { host: 'localhost:3000' };
  const { todayISO } = await import('../server/util.js');
  const rule = createRule(db, { kind: 'keyword', value: 'jagermeister' }, todayISO()).rule;

  const res = await app.inject({ url: `/api/alerts/rules/${rule.id}/matches`, headers: local });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.items.length, 3);
  assert.equal(body.total, 3);
  assert.equal(body.items[0].discountPct, 30); // největší sleva první
  assert.equal(body.items[0].shop.name, 'Albert');
  assert.equal((await app.inject({ url: '/api/alerts/rules/999/matches', headers: local })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/alerts/rules/${rule.id}/matches`, headers: { host: 'evil.example.com' } })).statusCode, 403);
  await app.close();
});
