import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseListing } from '../server/scraper/kupi.js';
import { parseValidity, normalize } from '../server/util.js';
import { categorize } from '../server/categories.js';
import { makeWriter, migrateFavoritesToCart, openDb } from '../server/db.js';
import { buildApp } from '../server/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures', 'kupi-listing.html'), 'utf8');

test('parseValidity: rozsah, dnes/zítra končí, platí do', () => {
  assert.deepEqual(parseValidity(' st 21. 10.  &ndash; út 27. 10. ', '2026-10-20'), { from: '2026-10-21', to: '2026-10-27' });
  assert.deepEqual(parseValidity('dnes končí', '2026-10-20'), { from: null, to: '2026-10-20' });
  assert.deepEqual(parseValidity('zítra končí', '2026-10-31'), { from: null, to: '2026-11-01' });
  assert.deepEqual(parseValidity('platí do úterý 27.&nbsp;10.', '2026-10-20'), { from: null, to: '2026-10-27' });
  assert.equal(parseValidity('něco jiného', '2026-10-20').unknown, true);
});

test('parseValidity: přelom roku', () => {
  assert.deepEqual(parseValidity('st 30. 12. – st 6. 1.', '2026-12-29'), { from: '2026-12-30', to: '2027-01-06' });
});

test('normalize odstraní diakritiku', () => {
  assert.equal(normalize('Šunka Žďárská'), 'sunka zdarska');
});

test('categorize', () => {
  assert.equal(categorize('Sušenky máslové Favorina'), 'sladkosti');
  assert.equal(categorize('Šunka vepřová'), 'maso');
  assert.equal(categorize('Pivo Pilsner Urquell'), 'alkohol');
});

test('parseListing: fixture, deduplikace, ceny, platnost', () => {
  const { deals, unknownValidity } = parseListing(fixture, 'albert', '2026-10-20');
  assert.equal(deals.length, 3);
  assert.equal(unknownValidity, 0); // duplicitní řádek bez platnosti se přeskočí dřív, než se počítá

  const banany = deals.find((d) => d.id === 11205594);
  assert.equal(banany.name, 'Banány');
  assert.equal(banany.shop_slug, 'albert');
  assert.equal(banany.price_sale, 24.9);
  assert.equal(banany.discount_pct, 44);
  assert.equal(banany.price_orig, 44.5);
  assert.equal(banany.valid_from, '2026-10-21');
  assert.equal(banany.valid_to, '2026-10-27');
  assert.equal(banany.source_url, 'https://www.kupi.cz/sleva/banany');
  assert.match(banany.leaflet_url, /^https:\/\/www\.kupi\.cz\/letak\//);

  const kava = deals.find((d) => d.id === 11213277);
  assert.equal(kava.valid_to, '2026-10-20');
  assert.equal(kava.valid_from, null);

  const lidl = deals.find((d) => d.id === 555);
  assert.equal(lidl.shop_slug, 'lidl');
  assert.equal(lidl.discount_pct, null);
  assert.equal(lidl.price_orig, null);
});

function seeded() {
  const db = openDb(':memory:');
  const w = makeWriter(db);
  w.shop({ slug: 'albert', name: 'Albert' });
  w.shop({ slug: 'lidl', name: 'Lidl' });
  const base = {
    product_id: 1, note: null, price_per_unit: null, image_url: null, leaflet_url: null, seen: '2026-10-20',
    quantity: '1 kg', category: 'maso', source_url: 'https://www.kupi.cz/sleva/x', price_orig: null,
  };
  w.deal({ ...base, id: 1, shop_slug: 'albert', product_slug: 'sunka', name: 'Šunka', name_norm: 'sunka', price_sale: 99, discount_pct: 30, valid_from: '2026-10-21', valid_to: '2026-10-28' });
  w.deal({ ...base, id: 2, shop_slug: 'lidl', product_slug: 'maslo', name: 'Máslo', name_norm: 'maslo', category: 'mlecne', price_sale: 49, discount_pct: 20, valid_from: '2026-10-22', valid_to: '2026-10-25' });
  return db;
}

test('API: dotaz podle dne vrací jen potvrzeně platné akce', async () => {
  const app = buildApp(seeded());
  const get = async (qs) => (await app.inject({ url: `/api/deals?${qs}` })).json();

  assert.equal((await get('date=2026-10-23')).total, 2);
  assert.equal((await get('date=2026-10-27')).total, 1); // lidl už skončil
  assert.equal((await get('date=2026-10-29')).total, 0);
  assert.equal((await get('date=2026-10-20')).total, 0); // před začátkem
  const r = await get('date=2026-10-23&shops=lidl');
  assert.equal(r.items[0].name, 'Máslo');
  assert.equal(r.items[0].validFrom, '2026-10-22');
  assert.equal((await get('date=2026-10-23&q=sunka')).items[0].name, 'Šunka');
  assert.equal((await get('date=2026-10-23&minDiscount=25')).total, 1);
  await app.close();
});

test('API: rozsah dnů (od-do) vrací akce platné alespoň jeden den v rozsahu', async () => {
  const app = buildApp(seeded());
  const get = async (qs) => (await app.inject({ url: `/api/deals?${qs}` })).json();

  assert.equal((await get('date=2026-10-20&to=2026-10-21')).total, 1); // jen šunka (od 21.)
  assert.equal((await get('date=2026-10-20&to=2026-10-22')).total, 2);
  assert.equal((await get('date=2026-10-26&to=2026-10-30')).total, 1); // lidl skončil 25.
  assert.equal((await get('date=2026-10-29&to=2026-11-05')).total, 0);
  assert.equal((await get('date=2026-10-25&to=2026-10-22')).total, 2); // prohozené konce
  const r = await get('date=2026-10-22&to=2026-10-25');
  assert.equal(r.date, '2026-10-22');
  assert.equal(r.dateTo, '2026-10-25');
  const days = (await app.inject({ url: '/api/days?from=2026-10-21&count=3&to=2026-12-01' })).json().days;
  assert.deepEqual(days.map((d) => d.count), [1, 2, 2]); // /api/days ignoruje "to"
  assert.equal((await app.inject({ url: '/api/deals?to=blbost' })).statusCode, 400);
  await app.close();
});

test('API: vypnutí serveru jen z tohoto počítače a s hlavičkou', async () => {
  let stopped = 0;
  const app = buildApp(seeded(), { onShutdown: () => { stopped++; } });
  const local = { host: 'localhost:3000' };
  const post = (headers) => app.inject({ method: 'POST', url: '/api/shutdown', headers });

  assert.equal((await post(local)).statusCode, 403); // chybí hlavička (ochrana proti cizím webům)
  assert.equal((await post({ ...local, 'x-letackomat': '1', host: 'evil.example.com' })).statusCode, 403); // cizí Host
  assert.equal((await app.inject({ method: 'POST', url: '/api/shutdown', headers: { ...local, 'x-letackomat': '1' }, remoteAddress: '192.168.1.20' })).statusCode, 403); // jiný počítač
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(stopped, 0);

  const ok = await post({ ...local, 'x-letackomat': '1' });
  assert.equal(ok.statusCode, 202);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(stopped, 1);

  const health = (await app.inject({ url: '/api/health', headers: local })).json();
  assert.equal(health.canShutdown, true);
  const remote = (await app.inject({ url: '/api/health', headers: local, remoteAddress: '192.168.1.20' })).json();
  assert.equal(remote.canShutdown, false);
  await app.close();

  // bez onShutdown (testy, jiný režim) endpoint neexistuje
  const plain = buildApp(seeded());
  assert.equal((await plain.inject({ method: 'POST', url: '/api/shutdown', headers: { ...local, 'x-letackomat': '1' } })).statusCode, 501);
  await plain.close();
});

test('API: špatné datum = 400', async () => {
  const app = buildApp(seeded());
  assert.equal((await app.inject({ url: '/api/deals?date=blbost' })).statusCode, 400);
  await app.close();
});

test('Nákupní seznam: přidání, sekce, přesun, odškrtnutí, historie, smazání', async () => {
  const db = seeded();
  const app = buildApp(db);
  const call = async (method, url, payload) => {
    const r = await app.inject({ method, url, payload });
    return { code: r.statusCode, body: r.body ? r.json() : null };
  };

  // neznámý produkt
  assert.equal((await call('POST', '/api/cart', { productSlug: 'neexistuje' })).code, 404);

  // přidání + idempotence
  const add = await call('POST', '/api/cart', { productSlug: 'sunka' });
  assert.equal(add.code, 201);
  assert.equal(add.body.name, 'Šunka');
  assert.equal((await call('POST', '/api/cart', { productSlug: 'sunka' })).code, 200);
  await call('POST', '/api/cart', { productSlug: 'maslo' });

  // karta v seznamu slev je označená
  const deals = (await call('GET', '/api/deals?date=2026-10-23')).body;
  assert.equal(deals.items.find((i) => i.productSlug === 'sunka').inCart, true);

  // sekce
  assert.equal((await call('POST', '/api/sections', { name: '   ' })).code, 400);
  const kalba = (await call('POST', '/api/sections', { name: 'Kalba' })).body;
  const zradlo = (await call('POST', '/api/sections', { name: 'Žrádlo' })).body;
  assert.equal((await call('PATCH', '/api/cart/sunka', { sectionId: 999 })).code, 400);
  await call('PATCH', '/api/cart/sunka', { sectionId: zradlo.id });
  await call('PATCH', '/api/cart/maslo', { sectionId: kalba.id, checked: true });

  let cart = (await call('GET', '/api/cart?date=2026-10-23')).body;
  assert.deepEqual(cart.sections.map((s) => s.name), ['Kalba', 'Žrádlo']);
  const sunka = cart.items.find((i) => i.slug === 'sunka');
  assert.equal(sunka.sectionId, zradlo.id);
  assert.equal(sunka.deals.length, 1);
  assert.equal(sunka.deals[0].shop.slug, 'albert');
  assert.equal(sunka.last, null);
  assert.equal(cart.items.find((i) => i.slug === 'maslo').checked, true);

  // v termínu mimo platnost je položka dál v seznamu, bez aktuálních slev, s poslední známou
  cart = (await call('GET', '/api/cart?date=2027-01-10')).body;
  const sunka2 = cart.items.find((i) => i.slug === 'sunka');
  assert.equal(sunka2.deals.length, 0);
  assert.equal(sunka2.last.priceSale, 99);

  // přejmenování a smazání sekce nesmaže položky
  assert.equal((await call('PATCH', `/api/sections/${kalba.id}`, { name: 'Kalba a pití' })).body.name, 'Kalba a pití');
  await call('DELETE', `/api/sections/${kalba.id}`);
  cart = (await call('GET', '/api/cart')).body;
  assert.equal(cart.sections.length, 1);
  assert.equal(cart.items.find((i) => i.slug === 'maslo').sectionId, null);

  // vyčištění odškrtnutých a smazání položky
  assert.equal((await call('POST', '/api/cart/clear-checked')).body.removed, 1);
  assert.deepEqual((await call('GET', '/api/cart/slugs')).body.slugs, ['sunka']);
  await call('DELETE', '/api/cart/sunka');
  assert.equal((await call('GET', '/api/cart')).body.items.length, 0);
  assert.equal((await call('PATCH', '/api/cart/sunka', { checked: true })).code, 404);
  await app.close();
});

test('Migrace: dřívější oblíbené se převedou do nákupního seznamu', () => {
  const db = openDb(':memory:');
  const w = makeWriter(db);
  w.shop({ slug: 'albert', name: 'Albert' });
  w.deal({
    id: 1, shop_slug: 'albert', product_id: 1, product_slug: 'sunka', name: 'Šunka', name_norm: 'sunka', quantity: '1 kg',
    note: null, category: 'maso', price_sale: 99, price_orig: null, discount_pct: null, price_per_unit: null,
    valid_from: null, valid_to: '2026-10-28', image_url: null, source_url: 'x', leaflet_url: null, seen: '2026-10-20',
  });
  db.prepare("INSERT INTO favorites(product_slug) VALUES('sunka'),('neznamy-produkt')").run();
  db.prepare("DELETE FROM meta WHERE key='cart_migrated'").run();
  db.prepare('DELETE FROM cart_items').run();
  migrateFavoritesToCart(db);
  const items = db.prepare('SELECT product_slug, name, quantity FROM cart_items ORDER BY product_slug').all();
  assert.deepEqual(items.map((i) => i.name), ['neznamy produkt', 'Šunka']);
  assert.equal(items[1].quantity, '1 kg');
  migrateFavoritesToCart(db); // podruhé se nic nepřidá
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cart_items').get().n, 2);
});
