import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseListing } from '../server/scraper/kupi.js';
import { parseValidity, normalize } from '../server/util.js';
import { categorize } from '../server/categories.js';
import { ensureUnitColumns, makeWriter, migrateFavoritesToCart, openDb } from '../server/db.js';
import { rankOffers } from '../server/product.js';
import { parseUnitPrice } from '../server/units.js';
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

test('parseUnitPrice: přepočet na 1 kg / 1 l / 1 ks', () => {
  assert.deepEqual(parseUnitPrice('13,95 Kč / 100 g'), { kind: 'kg', price: 139.5 });
  assert.deepEqual(parseUnitPrice('31,80 Kč / 1 l'), { kind: 'l', price: 31.8 });
  assert.deepEqual(parseUnitPrice('9,90 Kč / 250 ml'), { kind: 'l', price: 39.6 });
  assert.deepEqual(parseUnitPrice('24,90 Kč / 1 kg'), { kind: 'kg', price: 24.9 });
  assert.deepEqual(parseUnitPrice('21,90 Kč / 1 ks'), { kind: 'ks', price: 21.9 });
  assert.deepEqual(parseUnitPrice('5,50 Kč / ks'), { kind: 'ks', price: 5.5 });
  assert.equal(parseUnitPrice('12 Kč / 1 m'), null);
  assert.equal(parseUnitPrice(null), null);
  assert.equal(parseUnitPrice('blbost'), null);
});

test('rankOffers: podle ceny za jednotku, jinak podle ceny; štítek nejlevnější a rozdíl', () => {
  const o = (name, priceSale, unitKind, unitPrice) => ({ name, priceSale, unitKind, unitPrice });
  const byUnit = rankOffers([o('A', 50, 'kg', 100), o('B', 80, 'kg', 80), o('C', 90, 'kg', 120)]);
  assert.equal(byUnit.metric, 'unit');
  assert.deepEqual(byUnit.offers.map((x) => x.name), ['B', 'A', 'C']); // B má dražší balení, ale levnější kilo
  assert.equal(byUnit.offers[0].cheapest, true);
  assert.equal(byUnit.offers[1].moreExpensivePct, 25);
  assert.equal(byUnit.offers[2].moreExpensivePct, 50);

  const mixed = rankOffers([o('A', 50, 'kg', 100), o('B', 40, 'l', 40), o('C', 60, null, null)]);
  assert.equal(mixed.metric, 'price');
  assert.deepEqual(mixed.offers.map((x) => x.name), ['B', 'A', 'C']);
  assert.equal(rankOffers([]).offers.length, 0);
});

function priceSeed() {
  const db = openDb(':memory:');
  const w = makeWriter(db);
  w.shop({ slug: 'albert', name: 'Albert' });
  w.shop({ slug: 'lidl', name: 'Lidl' });
  const base = {
    product_id: 7, note: null, image_url: 'https://img.example/banany.jpg', leaflet_url: null, seen: '2026-10-20',
    quantity: '1 kg', category: 'ovoce', source_url: 'https://www.kupi.cz/sleva/banany', price_orig: null,
    discount_pct: null, name: 'Banány', name_norm: 'banany', product_slug: 'banany',
  };
  w.deal({ ...base, id: 1, shop_slug: 'albert', price_sale: 24.9, price_per_unit: '24,90 Kč / 1 kg', valid_from: '2026-10-21', valid_to: '2026-10-27' });
  w.deal({ ...base, id: 2, shop_slug: 'lidl', price_sale: 22.9, price_per_unit: '22,90 Kč / 1 kg', valid_from: '2026-10-22', valid_to: '2026-10-25' });
  w.deal({ ...base, id: 3, shop_slug: 'albert', price_sale: 29.9, price_per_unit: '29,90 Kč / 1 kg', valid_from: '2026-10-07', valid_to: '2026-10-13' }); // dřívější akce
  w.deal({ ...base, id: 4, shop_slug: 'lidl', product_slug: 'rohlik', name: 'Rohlík', name_norm: 'rohlik', quantity: '1 ks', price_sale: 1.9, price_per_unit: '1,90 Kč / 1 ks', valid_from: '2026-10-22', valid_to: '2026-10-25' });
  return db;
}

test('API: porovnání cen produktu (nabídky, nejlevnější, historie, statistiky)', async () => {
  const app = buildApp(priceSeed());
  const get = async (url) => app.inject({ url });

  const r = (await get('/api/products/banany?date=2026-10-23')).json();
  assert.equal(r.name, 'Banány');
  assert.equal(r.metric, 'unit');
  assert.equal(r.unitKind, 'kg');
  assert.deepEqual(r.offers.map((o) => o.shop.slug), ['lidl', 'albert']);
  assert.equal(r.offers[0].cheapest, true);
  assert.equal(r.offers[1].cheapest, false);
  assert.equal(r.offers[1].moreExpensivePct, 9); // 24,9 / 22,9
  assert.equal(r.offers[0].unitPrice, 22.9);

  // jiné období: jen Albert; v období bez akcí nejsou nabídky, ale historie zůstává
  assert.deepEqual((await get('/api/products/banany?date=2026-10-27')).json().offers.map((o) => o.shop.slug), ['albert']);
  const empty = (await get('/api/products/banany?date=2026-12-01')).json();
  assert.equal(empty.offers.length, 0);
  assert.equal(empty.history.length, 3);

  assert.equal(r.stats.basis, 'unit');
  assert.equal(r.stats.unitKind, 'kg');
  assert.equal(r.stats.count, 3);
  assert.equal(r.stats.min, 22.9);
  assert.equal(r.stats.max, 29.9);
  assert.equal(r.stats.median, 24.9);
  assert.equal(r.stats.lowestShop, 'Lidl');
  assert.equal(r.stats.since, '2026-10-07');
  assert.deepEqual(r.history.map((h) => h.validFrom), ['2026-10-07', '2026-10-21', '2026-10-22']);

  assert.equal((await get('/api/products/neexistuje')).statusCode, 404);
  assert.equal((await get('/api/products/banany?date=blbost')).statusCode, 400);
  await app.close();
});

test('API: statistiky historie se při různých baleních počítají z ceny za jednotku', async () => {
  const db = priceSeed();
  const w = makeWriter(db);
  const base = {
    product_id: 9, note: null, image_url: null, leaflet_url: null, seen: '2026-10-20', category: 'napoje',
    source_url: 'u', price_orig: null, discount_pct: null, name: 'Pepsi', name_norm: 'pepsi', product_slug: 'pepsi',
    valid_from: '2026-10-21', valid_to: '2026-10-27',
  };
  w.deal({ ...base, id: 20, shop_slug: 'albert', quantity: '2,25 l', price_sale: 24.9, price_per_unit: '11,07 Kč / 1 l' });
  w.deal({ ...base, id: 21, shop_slug: 'lidl', quantity: '0,5 l', price_sale: 14.9, price_per_unit: '29,80 Kč / 1 l' });
  const app = buildApp(db);
  const r = (await app.inject({ url: '/api/products/pepsi?date=2026-10-23' })).json();
  assert.equal(r.stats.basis, 'unit');
  assert.equal(r.stats.min, 11.07); // ne 14,9 (levnější balení, ale dražší litr)
  assert.equal(r.stats.lowestShop, 'Albert');
  assert.equal(r.offers[0].shop.slug, 'albert');
  await app.close();
});

test('API: řazení podle ceny za jednotku', async () => {
  const app = buildApp(priceSeed());
  const r = (await app.inject({ url: '/api/deals?date=2026-10-23&sort=unit' })).json();
  assert.deepEqual(r.items.map((i) => `${i.unitKind}:${i.unitPrice}`), ['kg:22.9', 'kg:24.9', 'ks:1.9']);
  await app.close();
});

test('Migrace: sloupce s cenou za jednotku se doplní do starší databáze', () => {
  const db = openDb(':memory:');
  const w = makeWriter(db);
  w.shop({ slug: 'albert', name: 'Albert' });
  w.deal({
    id: 1, shop_slug: 'albert', product_id: 1, product_slug: 'x', name: 'X', name_norm: 'x', quantity: null, note: null,
    category: 'ostatni', price_sale: 10, price_orig: null, discount_pct: null, price_per_unit: '10,00 Kč / 100 g',
    valid_from: null, valid_to: '2026-10-28', image_url: null, source_url: 'u', leaflet_url: null, seen: '2026-10-20',
  });
  // simulace staré databáze: bez sloupců a bez příznaku
  db.exec('DROP INDEX idx_deals_unit; ALTER TABLE deals DROP COLUMN unit_kind; ALTER TABLE deals DROP COLUMN unit_price;');
  db.prepare("DELETE FROM meta WHERE key='units_backfilled'").run();
  ensureUnitColumns(db);
  assert.deepEqual({ ...db.prepare('SELECT unit_kind, unit_price FROM deals WHERE id=1').get() }, { unit_kind: 'kg', unit_price: 100 });
  ensureUnitColumns(db); // podruhé bez chyby
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
