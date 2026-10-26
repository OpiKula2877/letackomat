import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeWriter, openDb, setMeta } from '../server/db.js';
import { buildApp } from '../server/index.js';
import { BASE } from '../server/scraper/kupi.js';
import {
  applySubcategories, crawlSubcategory, parseCategories, parseProductCards, parseSubcategories, refreshSubcategories,
  refreshSubcategoriesIfStale,
} from '../server/scraper/subcategories.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');
const local = { host: 'localhost:3000' };
const quiet = () => {};

/** Stránka s kartami produktů (jen to, co parser čte). */
const cards = (ids) => ids.map((id) => `<div class="product--wrap" data-product-id="${id}"></div>`).join('');
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

test('podkategorie: z filtru Podkategorie se vezme jen seznam té kategorie, bez položky Všechny', () => {
  const subs = parseSubcategories(fixture('kupi-subcategories.html'), 'alkohol');
  assert.equal(subs.length, 15);
  assert.deepEqual(subs[0], { slug: 'brandy-a-konak', name: 'Brandy a koňak' });
  assert.ok(!subs.some((s) => s.slug === 'vse'));
  assert.deepEqual(parseSubcategories(fixture('kupi-subcategories.html'), 'auto-moto'), []); // jiný rodič
});

test('podkategorie: karty produktů se čtou podle data-product-id', () => {
  const { ids, cards: count } = parseProductCards(fixture('kupi-subcategory-products.html'));
  assert.deepEqual(ids, [299, 3529]);
  assert.equal(count, 2);
});

test('podkategorie: kategorie z nabídky /slevy', () => {
  const html = '<a href="/slevy/alkohol" class="suggest_item suggest_categories" data-category="211">Alkohol</a>'
    + '<a href="/slevy/pecivo" class="suggest_item suggest_categories" data-category="13">Pečivo</a>';
  assert.deepEqual(parseCategories(html), [{ slug: 'alkohol', name: 'Alkohol' }, { slug: 'pecivo', name: 'Pečivo' }]);
});

test('podkategorie: stránky se procházejí, dokud je plná poslední; kratší stránka končí', async () => {
  const pages = {
    [`${BASE}/slevy/x`]: cards(range(1, 18)),
    [`${BASE}/slevy/x?page=2`]: cards(range(19, 36)),
    [`${BASE}/slevy/x?page=3`]: cards(range(37, 41)), // poslední, kratší
  };
  const calls = [];
  const ids = await crawlSubcategory('x', { fetch: async (url) => { calls.push(url); return pages[url] ?? null; }, delayMs: 0 });
  assert.equal(ids.length, 41);
  assert.equal(calls.length, 3); // za kratší stránkou se už nežádá
});

test('podkategorie: když se obsah opakuje, procházení skončí', async () => {
  const calls = [];
  const same = cards(range(1, 18));
  const ids = await crawlSubcategory('y', { fetch: async (url) => { calls.push(url); return same; }, delayMs: 0 });
  assert.equal(ids.length, 18);
  assert.equal(calls.length, 2);
});

/** Falešný kupi.cz pro obnovu mapování: nabídka, filtr podkategorií a stránky výpisů. */
function fakeSite() {
  const pages = {
    [`${BASE}/slevy`]: '<a href="/slevy/alkohol" class="suggest_categories">Alkohol</a><a href="/slevy/pecivo" class="suggest_categories">Pečivo</a>',
    [`${BASE}/slevy/alkohol`]: '<li data-type="subcategory" data-category="vodka" data-parent="alkohol"><a href="/slevy/vodka">Vodka</a></li>'
      + '<li data-type="subcategory" data-category="pivo" data-parent="alkohol"><a href="/slevy/pivo">Pivo</a></li>',
    [`${BASE}/slevy/pecivo`]: '<li data-type="subcategory" data-category="chleb" data-parent="pecivo"><a href="/slevy/chleb">Chléb</a></li>',
    [`${BASE}/slevy/vodka`]: cards([101, 102]),
    [`${BASE}/slevy/pivo`]: cards([102, 103]), // 102 je i ve vodce, platí první nalezená (vodka)
    [`${BASE}/slevy/chleb`]: cards([201]),
  };
  return async (url) => pages[url] ?? null;
}

test('podkategorie: obnova uloží podkategorie a mapování produktů (první nalezená vyhrává)', async () => {
  const db = openDb(':memory:');
  await refreshSubcategories(db, { fetch: fakeSite(), delayMs: 0, log: quiet });
  const subs = db.prepare('SELECT slug, name, parent_name FROM subcategories ORDER BY slug').all();
  assert.deepEqual(subs.map((s) => s.slug), ['chleb', 'pivo', 'vodka']);
  assert.equal(subs.find((s) => s.slug === 'vodka').parent_name, 'Alkohol');
  const map = Object.fromEntries(db.prepare('SELECT product_id, subcategory FROM product_subcategory').all().map((r) => [r.product_id, r.subcategory]));
  assert.deepEqual(map, { 101: 'vodka', 102: 'vodka', 103: 'pivo', 201: 'chleb' });
});

function seedDeal(writer, o) {
  writer.deal({
    id: o.id, shop_slug: 'albert', product_id: o.product_id, product_slug: `p${o.id}`, name: o.name, name_norm: o.name.toLowerCase(),
    quantity: null, note: null, category: 'alkohol', price_sale: 99, price_orig: null, discount_pct: null, price_per_unit: null,
    valid_from: '2026-10-20', valid_to: '2026-10-30', image_url: null, source_url: 'https://www.kupi.cz/sleva/x', leaflet_url: null,
    seen: '2026-10-23',
  });
}

test('podkategorie: akce dostane podkategorii podle produktu a API ji vyfiltruje', async () => {
  const db = openDb(':memory:');
  const w = makeWriter(db);
  w.shop({ slug: 'albert', name: 'Albert' });
  seedDeal(w, { id: 1, product_id: 101, name: 'Vodka A' });
  seedDeal(w, { id: 2, product_id: 103, name: 'Pivo B' });
  seedDeal(w, { id: 3, product_id: 999, name: 'Bez mapování' });
  await refreshSubcategories(db, { fetch: fakeSite(), delayMs: 0, log: quiet });
  applySubcategories(db);

  const sub = Object.fromEntries(db.prepare('SELECT id, subcategory FROM deals').all().map((r) => [r.id, r.subcategory]));
  assert.deepEqual(sub, { 1: 'vodka', 2: 'pivo', 3: null });

  const app = buildApp(db);
  const get = async (qs) => (await app.inject({ url: `/api/deals?date=2026-10-23&${qs}`, headers: local })).json();
  assert.equal((await get('subcategory=vodka')).total, 1);
  assert.equal((await get('')).total, 3); // bez podkategorie se berou všechny akce
  assert.equal((await get('subcategory=vodka,pivo')).total, 2);

  const facet = (await get('')).facets.subcategories;
  assert.deepEqual(facet.map((s) => [s.slug, s.count]).sort(), [['pivo', 1], ['vodka', 1]]);
  assert.equal(facet.find((s) => s.slug === 'vodka').parentName, 'Alkohol');
  // facet nezávisí na vybrané podkategorii, aby se dal přepnout
  assert.equal((await get('subcategory=vodka')).facets.subcategories.length, 2);
  await app.close();
});

test('podkategorie: obnova se nedělá, když je mapování čerstvé', async () => {
  const db = openDb(':memory:');
  const boom = async () => { throw new Error('nemělo se stahovat'); };
  assert.equal(await refreshSubcategoriesIfStale(db, { fetch: boom, delayMs: 0, log: quiet }).catch((e) => e.message), 'nemělo se stahovat');
  setMeta(db, 'subcategories_at', new Date().toISOString());
  assert.equal(await refreshSubcategoriesIfStale(db, { fetch: boom, delayMs: 0, log: quiet }), null);
});
