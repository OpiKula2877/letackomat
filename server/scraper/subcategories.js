// Podkategorie z kupi.cz (třeba Alkohol > Vodka). Akce na stránce obchodu neříká, do které podkategorie patří,
// proto se projdou stránky všech podkategorií a zapíše se, která podkategorie který produkt obsahuje.
import * as cheerio from 'cheerio';
import { getMeta, setMeta } from '../db.js';
import { sleep } from '../util.js';
import { BASE, fetchHtml } from './kupi.js';

/** Mapování se obnovuje nejdřív po dni (a hned, když ještě není). */
export const SUBCATEGORY_MAX_AGE_MS = 24 * 3600 * 1000;

const text = ($el) => $el.text().replace(/\s+/g, ' ').trim();

/** Hlavní kategorie kupi.cz z nabídky na /slevy: [{slug, name}]. */
export function parseCategories(html) {
  const $ = cheerio.load(html);
  const out = new Map();
  $('a.suggest_categories').each((_, a) => {
    const slug = ($(a).attr('href') ?? '').replace(/^\/slevy\//, '');
    if (slug && !out.has(slug)) out.set(slug, text($(a)));
  });
  return [...out].map(([slug, name]) => ({ slug, name }));
}

/** Podkategorie jedné hlavní kategorie z filtru „Podkategorie“: [{slug, name}], bez položky „Všechny“. */
export function parseSubcategories(html, parentSlug) {
  const $ = cheerio.load(html);
  const out = new Map();
  $('li[data-type="subcategory"]').each((_, li) => {
    const $li = $(li);
    const slug = $li.attr('data-category');
    if (!slug || slug === 'vse' || $li.attr('data-parent') !== parentSlug || out.has(slug)) return;
    out.set(slug, { slug, name: text($li.find('a').first()) });
  });
  return [...out.values()];
}

/** Id produktů na jedné stránce výpisu; počet karet říká, jestli je stránka plná (kupi.cz vrací 18 karet). */
export function parseProductCards(html) {
  const $ = cheerio.load(html);
  const ids = [];
  $('.product--wrap[data-product-id]').each((_, el) => ids.push(Number($(el).attr('data-product-id'))));
  return { ids: ids.filter(Boolean), cards: ids.length };
}

/**
 * Všechny produkty jedné podkategorie napříč obchody. Stránky jdou za sebou, dokud je plná poslední;
 * kratší stránka je poslední, a když se obsah opakuje, taky se končí.
 */
export async function crawlSubcategory(slug, { fetch = fetchHtml, delayMs = 800, maxPages = 200 } = {}) {
  const ids = new Set();
  let pageSize = 0;
  for (let page = 1; page <= maxPages; page++) {
    const html = await fetch(page === 1 ? `${BASE}/slevy/${slug}` : `${BASE}/slevy/${slug}?page=${page}`);
    if (!html) break;
    const { ids: found, cards } = parseProductCards(html);
    if (!cards) break;
    pageSize = Math.max(pageSize, cards);
    const before = ids.size;
    for (const id of found) ids.add(id);
    if (ids.size === before || cards < pageSize) break;
    await sleep(delayMs);
  }
  return [...ids];
}

function storeSubcategories(db, subs, productSub) {
  const upSub = db.prepare(`
    INSERT INTO subcategories(slug, name, parent_slug, parent_name) VALUES(@slug, @name, @parent_slug, @parent_name)
    ON CONFLICT(slug) DO UPDATE SET name=excluded.name, parent_slug=excluded.parent_slug, parent_name=excluded.parent_name`);
  const upMap = db.prepare(`
    INSERT INTO product_subcategory(product_id, subcategory) VALUES(?, ?)
    ON CONFLICT(product_id) DO UPDATE SET subcategory=excluded.subcategory`);
  db.exec('BEGIN');
  try {
    for (const s of subs) upSub.run(s);
    for (const [id, slug] of productSub) upMap.run(id, slug);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Stáhne podkategorie všech hlavních kategorií a mapování produkt -> podkategorie uloží do databáze.
 * Záznamy se jen doplňují a přepisují: výpadek části stahování nesmaže to, co už bylo.
 */
export async function refreshSubcategories(db, { fetch = fetchHtml, delayMs = 800, log = () => {} } = {}) {
  const categories = parseCategories((await fetch(`${BASE}/slevy`)) ?? '');
  const subs = new Map(); // slug -> řádek tabulky subcategories
  for (const c of categories) {
    for (const s of parseSubcategories((await fetch(`${BASE}/slevy/${c.slug}`)) ?? '', c.slug)) {
      if (!subs.has(s.slug)) subs.set(s.slug, { ...s, parent_slug: c.slug, parent_name: c.name });
    }
    await sleep(delayMs);
  }

  const productSub = new Map(); // product_id -> slug podkategorie (první nalezená vyhraje)
  let failed = 0;
  for (const s of subs.values()) {
    try {
      for (const id of await crawlSubcategory(s.slug, { fetch, delayMs })) {
        if (!productSub.has(id)) productSub.set(id, s.slug);
      }
    } catch (e) {
      failed++;
      log(`podkategorie ${s.slug}: ${e.message}`);
    }
    await sleep(delayMs);
  }

  storeSubcategories(db, [...subs.values()], productSub);
  setMeta(db, 'subcategories_at', new Date().toISOString());
  log(`podkategorie: ${subs.size} podkategorií, ${productSub.size} produktů${failed ? `, ${failed} podkategorií selhalo` : ''}`);
  return { subcategories: subs.size, products: productSub.size, failed };
}

/** Přepíše podkategorii u každé akce podle jejího produktu (jen řádky, kterým se hodnota změnila). */
export function applySubcategories(db) {
  db.exec(`
    UPDATE deals SET subcategory = (SELECT ps.subcategory FROM product_subcategory ps WHERE ps.product_id = deals.product_id)
    WHERE subcategory IS NOT (SELECT ps.subcategory FROM product_subcategory ps WHERE ps.product_id = deals.product_id)`);
}

/** Obnoví mapování, jen když je starší než den nebo ještě neexistuje. Vrací null, když nebylo potřeba. */
export async function refreshSubcategoriesIfStale(db, opts = {}) {
  const at = Date.parse(getMeta(db, 'subcategories_at') ?? '');
  if (Number.isFinite(at) && Date.now() - at < SUBCATEGORY_MAX_AGE_MS) return null;
  return refreshSubcategories(db, opts);
}

/** Krok stahování pro runScrape: obnoví mapování podle stáří a vždy doplní podkategorie u akcí. */
export const subcategoriesStep = (db, log) => refreshSubcategoriesIfStale(db, { log });
