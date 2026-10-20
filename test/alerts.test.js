import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeWriter, openDb } from '../server/db.js';
import { buildApp } from '../server/index.js';
import { buildToastXml } from '../server/watch/notifier.js';
import { autostartFile, buildAutostartScript, disableAutostart, enableAutostart } from '../server/watch/autostart.js';
import { buildDigest, createAlerts } from '../server/watch/alerts.js';
import { createRule, deleteRule, listRules, markNotified, matchesFor, pendingMatches, updateRule } from '../server/watch/rules.js';

const TODAY = '2026-10-23';

let nextId = 1;
function seed() {
  const db = openDb(':memory:');
  const w = makeWriter(db);
  for (const [slug, name] of [['albert', 'Albert'], ['lidl', 'Lidl']]) w.shop({ slug, name });
  const add = (o) =>
    w.deal({
      id: nextId++, product_id: 1, note: null, image_url: null, leaflet_url: null, seen: TODAY, quantity: '0,7 l',
      category: 'alkohol', source_url: 'https://www.kupi.cz/sleva/x', price_orig: null, discount_pct: null, price_per_unit: null,
      valid_from: '2026-10-21', valid_to: '2026-10-28', shop_slug: 'albert', ...o,
    });
  return { db, add };
}

test('oznámení: XML se správně escapuje a kliknutí otevírá aplikaci', () => {
  const xml = buildToastXml({ title: 'A & B <test>', lines: ['řádek 1', 'řádek 2', 'tenhle se zahodí'], url: 'http://localhost:3000/?a=1&b=2' });
  assert.match(xml, /<text>A &amp; B &lt;test&gt;<\/text>/);
  assert.equal((xml.match(/<text>/g) ?? []).length, 3); // nadpis + 2 řádky
  assert.match(xml, /launch="http:\/\/localhost:3000\/\?a=1&amp;b=2"/);
  assert.match(xml, /activationType="protocol"/);
});

test('spouštění po přihlášení: skript se vytvoří, přečte jako UTF-16 a jde smazat', () => {
  const dir = mkdtempSync(join(tmpdir(), 'letackomat-startup-'));
  process.env.LETACKOMAT_STARTUP_DIR = dir;
  try {
    const root = 'C:\\Users\\Čeněk "Test"\\Letáčkomat';
    assert.match(buildAutostartScript(root), /shell\.CurrentDirectory = "C:\\Users\\Čeněk ""Test""\\Letáčkomat"/);
    enableAutostart(root);
    assert.equal(existsSync(autostartFile()), true);
    const raw = readFileSync(autostartFile());
    assert.deepEqual([...raw.subarray(0, 2)], [0xff, 0xfe]); // BOM UTF-16 LE
    const text = raw.subarray(2).toString('utf16le');
    assert.match(text, /Čeněk/);
    assert.match(text, /launcher\.js start --no-open/);
    disableAutostart();
    assert.equal(existsSync(autostartFile()), false);
    disableAutostart(); // podruhé bez chyby
  } finally {
    delete process.env.LETACKOMAT_STARTUP_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pravidla: slovo v názvu bez diakritiky a velikosti písmen, podmínky a okno dnů', () => {
  const { db, add } = seed();
  add({ product_slug: 'jager-07', name: 'Bylinný likér Jägermeister', name_norm: 'bylinny liker jagermeister', price_sale: 279, discount_pct: 25 });
  add({ product_slug: 'jager-1', name: 'Jägermeister 1 l', name_norm: 'jagermeister 1 l', price_sale: 399, discount_pct: 10, shop_slug: 'lidl' });
  add({ product_slug: 'jager-stary', name: 'Jägermeister skončený', name_norm: 'jagermeister skonceny', price_sale: 100, valid_from: '2026-10-01', valid_to: '2026-10-10' });
  add({ product_slug: 'jager-pozdeji', name: 'Jägermeister příští týden', name_norm: 'jagermeister pristi tyden', price_sale: 100, valid_from: '2026-10-29', valid_to: '2026-11-04' });
  add({ product_slug: 'jager-brzy', name: 'Jägermeister od pondělí', name_norm: 'jagermeister od pondeli', price_sale: 100, valid_from: '2026-10-26', valid_to: '2026-11-01' });
  add({ product_slug: 'rum', name: 'Rum Bacardi', name_norm: 'rum bacardi', price_sale: 249 });

  const { rule } = createRule(db, { kind: 'keyword', value: '  JÄGERMEISTER ' }, TODAY);
  assert.equal(rule.value, 'jagermeister');
  assert.equal(rule.label, 'JÄGERMEISTER'); // zobrazí se tak, jak to uživatel napsal
  const names = matchesFor(db, rule, TODAY).map((m) => m.productSlug).sort();
  assert.deepEqual(names, ['jager-07', 'jager-1', 'jager-brzy']); // bez skončené, bez té za 6 dní, bez rumu

  const cond = (c) => matchesFor(db, { ...rule, ...c }, TODAY).map((m) => m.productSlug).sort();
  assert.deepEqual(cond({ minDiscount: 20 }), ['jager-07']);
  assert.deepEqual(cond({ maxPrice: 300 }), ['jager-07', 'jager-brzy']);
  assert.deepEqual(cond({ shops: ['lidl'] }), ['jager-1']);

  // více slov musí platit všechna
  const two = createRule(db, { kind: 'keyword', value: 'liker jagermeister' }, TODAY).rule;
  assert.deepEqual(matchesFor(db, two, TODAY).map((m) => m.productSlug), ['jager-07']);
});

test('pravidla: validace, duplicity, baseline a nové akce', () => {
  const { db, add } = seed();
  add({ product_slug: 'pivo', name: 'Pivo Pilsner', name_norm: 'pivo pilsner', price_sale: 19.9 });

  for (const bad of [
    { kind: 'keyword', value: 'a' },
    { kind: 'keyword', value: 'x'.repeat(61) },
    { kind: 'keyword', value: 'jedna dva tři čtyři pět šest sedm' },
    { kind: 'nic', value: 'pivo' },
    { kind: 'keyword', value: 'pivo', minDiscount: 150 },
    { kind: 'keyword', value: 'pivo', maxPrice: -5 },
  ]) assert.throws(() => createRule(db, bad, TODAY), (e) => e.code === 400, JSON.stringify(bad));
  assert.throws(() => createRule(db, { kind: 'product', value: 'neexistuje' }, TODAY), (e) => e.code === 404);

  const { rule, created } = createRule(db, { kind: 'keyword', value: 'pivo' }, TODAY);
  assert.equal(created, true);
  assert.equal(createRule(db, { kind: 'keyword', value: 'PIVO' }, TODAY).created, false); // stejné pravidlo podruhé
  assert.equal(listRules(db).length, 1);

  // akce, které už existovaly při vytvoření pravidla, nespustí oznámení
  assert.equal(pendingMatches(db, TODAY).length, 0);
  // nová akce ano
  add({ product_slug: 'pivo-2', name: 'Pivo Gambrinus', name_norm: 'pivo gambrinus', price_sale: 17.9, shop_slug: 'lidl' });
  let pending = pendingMatches(db, TODAY);
  assert.deepEqual(pending.map((p) => p.deal.productSlug), ['pivo-2']);
  markNotified(db, pending);
  assert.equal(pendingMatches(db, TODAY).length, 0); // podruhé už ne

  // vypnuté pravidlo nehlídá; po zapnutí se zpětné akce neoznamují
  updateRule(db, rule.id, { enabled: false }, TODAY);
  add({ product_slug: 'pivo-3', name: 'Pivo Radegast', name_norm: 'pivo radegast', price_sale: 18.9 });
  assert.equal(pendingMatches(db, TODAY).length, 0);
  updateRule(db, rule.id, { enabled: true }, TODAY);
  assert.equal(pendingMatches(db, TODAY).length, 0);
  add({ product_slug: 'pivo-4', name: 'Pivo Kozel', name_norm: 'pivo kozel', price_sale: 16.9 });
  assert.deepEqual(pendingMatches(db, TODAY).map((p) => p.deal.productSlug), ['pivo-4']);

  // konkrétní produkt
  const prod = createRule(db, { kind: 'product', value: 'pivo' }, TODAY);
  assert.equal(prod.rule.label, 'Pivo Pilsner');
  deleteRule(db, rule.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications WHERE rule_id = ?').get(rule.id).n, 0); // smazáním pravidla zmizí i záznamy
});

test('souhrn oznámení: jedna akce, více akcí, víc pravidel', () => {
  const deal = (name, priceSale, shop, pct = null, slug = name) => ({ name, priceSale, discountPct: pct, shop: { name: shop }, productSlug: slug, id: Math.random() });
  const rule = (id, label) => ({ id, label });

  const one = buildDigest([{ rule: rule(1, 'Jägermeister'), deal: deal('Jägermeister 0,7 l', 279, 'Albert', 25) }]);
  assert.equal(one.title, 'Jägermeister 0,7 l je ve slevě');
  assert.equal(one.lines[0], 'Jägermeister 0,7 l: 279 Kč, Albert, −25 %');

  const many = buildDigest([
    { rule: rule(1, 'Jägermeister'), deal: deal('Jägermeister 0,7 l', 279, 'Albert', 25, 'a') },
    { rule: rule(1, 'Jägermeister'), deal: deal('Jägermeister 1 l', 349.5, 'Lidl', null, 'b') },
  ]);
  assert.equal(many.title, '2 hlídané produkty ve slevě');
  assert.equal(many.lines[0], 'Jägermeister: od 279 Kč, Albert, −25 % (+1)');

  const three = buildDigest([1, 2, 3, 4].map((i) => ({ rule: rule(i, `Pravidlo ${i}`), deal: deal(`P${i}`, 10 * i, 'Tesco', null, `p${i}`) })));
  assert.equal(three.title, '4 hlídané produkty ve slevě');
  assert.equal(three.lines.length, 2);
  assert.match(three.lines[1], /…a další \(2\)$/);
  assert.equal(buildDigest(Array.from({ length: 5 }, (_, i) => ({ rule: rule(i, 'x'), deal: deal('p', 1, 's', null, `s${i}`) }))).title, '5 hlídaných produktů ve slevě');
});

test('hlídač: oznámí jen při zapnutí, jen nové akce a při selhání to zkusí příště', async () => {
  const { db, add } = seed();
  const dir = mkdtempSync(join(tmpdir(), 'letackomat-startup-'));
  process.env.LETACKOMAT_STARTUP_DIR = dir;
  const sent = [];
  let fail = false;
  const alerts = createAlerts(db, {
    port: 3000, root: 'C:\\x', today: () => TODAY,
    notify: async (n) => { if (fail) return { ok: false, error: 'nelze' }; sent.push(n); return { ok: true }; },
  });
  try {
    createRule(db, { kind: 'keyword', value: 'pivo' }, TODAY);
    add({ product_slug: 'pivo-a', name: 'Pivo A', name_norm: 'pivo a', price_sale: 20, discount_pct: 30 });

    assert.deepEqual(await alerts.run(), { sent: 0, matches: 0 }); // vypnuto: nic
    assert.equal(sent.length, 0);

    await alerts.setEnabled(true);
    assert.equal(existsSync(autostartFile()), true); // zapnutí vytvořilo spouštění po přihlášení
    assert.equal((await alerts.status()).autostart.installed, true);

    fail = true;
    assert.deepEqual((await alerts.run()).sent, 0); // oznámení selhalo
    assert.equal((await alerts.status()).lastError, 'nelze');
    fail = false;
    const r = await alerts.run(); // znovu: akce se neztratila
    assert.equal(r.sent, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, 'Pivo A je ve slevě');
    assert.equal(sent[0].url, 'http://localhost:3000/');

    assert.equal((await alerts.run()).matches, 0); // podruhé už nic

    await alerts.setEnabled(false);
    assert.equal(existsSync(autostartFile()), false);
    assert.equal(alerts.enabled(), false);

    await alerts.test(); // zkušební oznámení jde i při vypnutém hlídači
    assert.match(sent.at(-1).title, /zkušební/);
  } finally {
    delete process.env.LETACKOMAT_STARTUP_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('API upozornění: ochrana, pravidla, náhled, zvonek u produktu a zkušební oznámení', async () => {
  const { db, add } = seed();
  add({ product_slug: 'jager', name: 'Jägermeister', name_norm: 'jagermeister', price_sale: 279, discount_pct: 25 });
  const sent = [];
  const alerts = createAlerts(db, { today: () => TODAY, notify: async (n) => { sent.push(n); return { ok: true, setting: 'Enabled' }; }, setting: async () => ({ ok: true, setting: 'Enabled' }) });
  const app = buildApp(db, { alerts });
  const local = { host: 'localhost:3000' };
  const trusted = { ...local, 'x-letackomat': '1' };
  const call = async (method, url, payload, headers = trusted) => {
    const r = await app.inject({ method, url, payload, headers });
    return { code: r.statusCode, body: r.body ? r.json() : null };
  };

  // prázdné tělo s hlavičkou application/json nesmí skončit chybou 400 (tak to posílá prohlížeč)
  const emptyJson = await app.inject({ method: 'POST', url: '/api/alerts/test', headers: { ...trusted, 'content-type': 'application/json' } });
  assert.equal(emptyJson.statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/alerts/rules', headers: { ...trusted, 'content-type': 'application/json' }, payload: '{blbost' })).statusCode, 400);

  // ochrana
  assert.equal((await call('GET', '/api/alerts', undefined, { host: 'evil.example.com' })).code, 403);
  assert.equal((await call('POST', '/api/alerts/rules', { kind: 'keyword', value: 'jager' }, local)).code, 403); // chybí hlavička
  assert.equal((await call('PUT', '/api/alerts/settings', { enabled: true }, local)).code, 403);

  // náhled bez uložení
  const prev = await call('GET', '/api/alerts/preview?kind=keyword&value=J%C3%A4germeister', undefined, local);
  assert.equal(prev.body.count, 1);
  assert.equal(prev.body.examples[0].name, 'Jägermeister');
  assert.equal((await call('GET', '/api/alerts/preview?kind=keyword&value=a', undefined, local)).code, 400);
  assert.equal((await call('GET', '/api/alerts', undefined, local)).body.rules.length, 0);

  // pravidlo + podmínky
  const created = await call('POST', '/api/alerts/rules', { kind: 'keyword', value: 'jager', minDiscount: 20, maxPrice: 300, shops: ['albert'] });
  assert.equal(created.code, 201);
  assert.equal(created.body.matches.count, 1);
  assert.deepEqual(created.body.shops, ['albert']);
  assert.equal((await call('POST', '/api/alerts/rules', { kind: 'keyword', value: 'nic' })).code, 201);
  const patched = await call('PATCH', `/api/alerts/rules/${created.body.id}`, { enabled: false });
  assert.equal(patched.body.enabled, false);
  assert.equal((await call('PATCH', '/api/alerts/rules/999', { enabled: true })).code, 404);

  // zvonek u produktu
  assert.equal((await call('POST', '/api/alerts/watch/jager')).code, 201);
  assert.equal((await call('POST', '/api/alerts/watch/jager')).code, 200); // podruhé jen potvrdí
  assert.deepEqual((await call('GET', '/api/alerts/watched', undefined, local)).body.slugs, ['jager']);
  assert.equal((await call('POST', '/api/alerts/watch/neexistuje')).code, 404);
  await call('DELETE', '/api/alerts/watch/jager');
  assert.deepEqual((await call('GET', '/api/alerts/watched', undefined, local)).body.slugs, []);

  // zkušební oznámení a stav
  const t = await call('POST', '/api/alerts/test');
  assert.equal(t.body.ok, true);
  assert.match(sent.at(-1).title, /zkušební/);
  assert.equal((await call('GET', '/api/alerts?setting=1', undefined, local)).body.windowsSetting, 'Enabled');

  // mazání
  assert.equal((await call('DELETE', `/api/alerts/rules/${created.body.id}`)).code, 200);
  assert.equal((await call('GET', '/api/alerts', undefined, local)).body.rules.length, 1);
  await app.close();
});

/* ——— samoopravy po přejmenování nebo přesunu složky ——— */

test('letackomat://start: cesta se opraví jen při chybějícím cíli a jen když registrace existuje', async () => {
  const { expectedCommand, repairProtocolHandler, scriptPathOf } = await import('../server/protocol.js');
  assert.equal(scriptPathOf('wscript.exe "C:\A B\scripts\start-hidden.vbs"'), 'C:\A B\scripts\start-hidden.vbs');
  assert.equal(scriptPathOf('něco jiného'), null);

  let stored = null;
  const adds = [];
  const run = async (args) => {
    if (args[0] === 'query') {
      return stored === null ? { ok: false, stdout: '' } : { ok: true, stdout: `\r\nHKEY_CURRENT_USER\...\command\r\n    (Výchozí)    REG_SZ    ${stored}\r\n` };
    }
    adds.push(args);
    stored = args[4];
    return { ok: true, stdout: '' };
  };
  const root = 'C:\Nova\letackomat';
  const opts = (exists) => ({ run, platform: 'win32', exists: () => exists });

  assert.deepEqual(await repairProtocolHandler(root, opts(false)), { status: 'absent' }); // registrace není, nic se nevytváří
  assert.equal(adds.length, 0);

  stored = 'wscript.exe "C:\Stara\scripts\start-hidden.vbs"';
  assert.equal((await repairProtocolHandler(root, opts(true))).status, 'ok'); // původní cíl existuje (jiná instalace), nepřepisuje se
  assert.equal(adds.length, 0);

  const r = await repairProtocolHandler(root, opts(false)); // původní složka zmizela
  assert.equal(r.status, 'repaired');
  assert.equal(stored, expectedCommand(root));
  assert.equal(adds.length, 1);

  assert.equal((await repairProtocolHandler(root, { ...opts(false), platform: 'linux' })).status, 'unsupported');
  stored = 'wscript.exe "C:\Stara\scripts\start-hidden.vbs"';
  assert.equal((await repairProtocolHandler(root, { run: async (a) => (a[0] === 'query' ? run(a) : { ok: false, stdout: '' }), platform: 'win32', exists: () => false })).status, 'failed');
});

test('skript po přihlášení: po přesunu složky se přepíše, existující cíl se nechá', async () => {
  const { autostartFile, enableAutostart, installedRoot, repairAutostart } = await import('../server/watch/autostart.js');
  const dir = mkdtempSync(join(tmpdir(), 'letackomat-startup-'));
  const fresh = mkdtempSync(join(tmpdir(), 'letackomat-root-'));
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(fresh, 'scripts'));
  writeFileSync(join(fresh, 'scripts', 'launcher.js'), '//');
  process.env.LETACKOMAT_STARTUP_DIR = dir;
  try {
    assert.equal(repairAutostart(fresh), 'absent'); // nic nainstalováno, nic se nevytváří
    assert.equal(existsSync(autostartFile()), false);

    enableAutostart('C:\Stara složka\neexistuje');
    assert.equal(installedRoot(), 'C:\Stara složka\neexistuje');
    assert.equal(repairAutostart(fresh), 'repaired');
    assert.equal(installedRoot(), fresh);
    assert.equal(repairAutostart(fresh), 'ok'); // podruhé beze změny

    // jiná existující instalace se nepřepisuje
    const other = mkdtempSync(join(tmpdir(), 'letackomat-other-'));
    mkdirSync(join(other, 'scripts'));
    writeFileSync(join(other, 'scripts', 'launcher.js'), '//');
    enableAutostart(other);
    assert.equal(repairAutostart(fresh), 'ok');
    assert.equal(installedRoot(), other);
    rmSync(other, { recursive: true, force: true });
  } finally {
    delete process.env.LETACKOMAT_STARTUP_DIR;
    rmSync(dir, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});
