// Scraper kupi.cz: /slevy/<obchod>?page=N  (povoleno v robots.txt).
import * as cheerio from 'cheerio';
import { categorize } from '../categories.js';
import { normalize, parseCzNumber, parseValidity, sleep, todayISO } from '../util.js';

export const BASE = 'https://www.kupi.cz';
export const USER_AGENT = 'Letackomat/1.0 (osobni nekomercni projekt; 1-2 stazeni denne)';

/** Slugy obchodů na kupi.cz (potraviny + drogerie). Lze přepsat env SHOPS=albert,lidl */
export const DEFAULT_SHOPS = [
  'albert',
  'lidl',
  'kaufland',
  'penny-market',
  'billa',
  'tesco',
  'globus',
  'coop',
  'cba',
  'makro',
  'flop-top',
  'jip',
  'eso-market',
  'rossmann',
  'dm-drogerie',
  'teta-drogerie',
  'dr-max',
];

const text = ($el) => $el.text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Z HTML jedné stránky výpisu vytáhne slevy.
 * @returns {{deals: object[], unknownValidity: number}}
 */
/**
 * @param {{ fallbackProduct?: {name: string, slug: string, image?: string|null} }} [opts]
 *   fallbackProduct: pro stránku jednoho produktu (/sleva/<slug>), kde chybí karty .product--wrap
 */
export function parseListing(html, shopSlug, today = todayISO(), opts = {}) {
  const $ = cheerio.load(html);

  // produkty: id -> {name, slug, quantity, image}
  const products = new Map();
  $('.product--wrap').each((_, el) => {
    const $p = $(el);
    const id = $p.attr('data-product-id');
    if (!id || products.has(id)) return;
    const $a = $p.find('.product_name h2 a').first();
    const img = $p.find('.product_image img').first();
    products.set(id, {
      name: text($a.find('strong').first()) || $a.attr('title') || '',
      slug: ($a.attr('href') ?? '').replace(/^\/sleva\//, '') || $p.find('a[data-product]').attr('data-product'),
      quantity: text($p.find('.product_name .nowrap').first()) || null,
      // placeholder "/img/no_img/..." není obrázek produktu
      image: /^https?:\/\//.test(img.attr('data-src') ?? '') ? img.attr('data-src') : null,
    });
  });

  const seen = new Set();
  const deals = [];
  let unknownValidity = 0;

  $('.discount_row').each((_, el) => {
    const $r = $(el);
    const id = Number($r.attr('data-discount'));
    if (!id || seen.has(id)) return;
    seen.add(id);

    const productId = $r.attr('data-product');
    const product = products.get(productId) ?? (opts.fallbackProduct && { quantity: null, image: null, ...opts.fallbackProduct });
    if (!product?.name) return;

    const priceSale = parseCzNumber(text($r.find('.discount_price_value').first()));
    if (priceSale == null) return;

    const pctRaw = text($r.find('.discount_percentage').first()).replace(/[–−-]/g, '');
    const pct = parseCzNumber(pctRaw);
    const discountPct = pct != null && pct > 0 && pct < 100 ? Math.round(pct) : null;
    const priceOrig = discountPct ? Math.round((priceSale / (1 - discountPct / 100)) * 10) / 10 : null;

    const validityText = text($r.find('.discounts_validity').first());
    const validity = parseValidity($r.find('.discounts_validity').first().text(), today);
    if (validity.unknown) unknownValidity++;

    const shopHref = $r.find('.discounts_shop_info a[href^="/letaky/"]').first().attr('href') ?? '';
    const rowShopSlug = shopHref.replace('/letaky/', '').split(/[/?#]/)[0] || shopSlug;
    const shopName = text($r.find('.discounts_shop_name').first()) || rowShopSlug;
    const logo = $r.find('.discounts_shop_image img').first().attr('src') || null;
    const leaflet = $r.find('a.btn_link_leaflet').first().attr('href');
    const amount = text($r.find('.discount_amount').first()).replace(/^\/\s*/, '');
    const quantity = [product.quantity, amount].find((q) => q && q.length) ?? null;

    deals.push({
      id,
      shop_slug: rowShopSlug,
      shop_name: shopName,
      shop_logo: logo,
      product_id: Number(productId) || null,
      product_slug: product.slug,
      name: product.name,
      name_norm: normalize(product.name),
      quantity,
      note: text($r.find('.discount_note').first()) || null,
      category: categorize(product.name),
      price_sale: priceSale,
      price_orig: priceOrig,
      discount_pct: discountPct,
      price_per_unit: text($r.find('.price_per_unit').first()) || null,
      valid_from: validity.from,
      valid_to: validity.to,
      validity_text: validityText,
      image_url: product.image,
      source_url: `${BASE}/sleva/${product.slug}`,
      leaflet_url: leaflet ? `${BASE}${leaflet}` : null,
    });
  });

  return { deals, unknownValidity };
}

export async function fetchHtml(url, { retries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'cs,en;q=0.5' },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error(`Stažení ${url} selhalo: ${lastErr?.message}`);
}

/**
 * Projde všechny stránky jednoho obchodu. Končí na prázdné stránce
 * nebo když se stránka opakuje (kupi.cz vrací poslední stránku dokola).
 */
export async function scrapeShop(slug, { delayMs = 800, maxPages = 400, onPage } = {}) {
  const all = new Map();
  let unknownValidity = 0;
  let prevSig = '';
  for (let page = 1; page <= maxPages; page++) {
    const html = await fetchHtml(`${BASE}/slevy/${slug}?page=${page}`);
    if (!html) break;
    const { deals, unknownValidity: u } = parseListing(html, slug);
    if (!deals.length) break;
    const sig = deals.map((d) => d.id).join(',');
    if (sig === prevSig) break;
    prevSig = sig;
    const before = all.size;
    for (const d of deals) all.set(d.id, d);
    unknownValidity += u;
    onPage?.({ slug, page, found: deals.length, added: all.size - before });
    if (all.size === before) break;
    await sleep(delayMs);
  }
  return { deals: [...all.values()], unknownValidity };
}

/** Stránka jednoho produktu (/sleva/<slug>): všechny aktuální akce napříč obchody v jednom požadavku. */
export function parseProductPage(html, slug, today = todayISO()) {
  const $ = cheerio.load(html);
  const name = text($('h1').first());
  if (!name) return { deals: [], unknownValidity: 0 };
  let image = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const ld = JSON.parse($(el).html() ?? '{}');
      const img = Array.isArray(ld.image) ? ld.image[0] : ld.image;
      if (ld['@type'] === 'Product' && String(img ?? '').startsWith('http')) image = img;
    } catch { /* poškozený JSON-LD se ignoruje */ }
  });
  return parseListing(html, slug, today, { fallbackProduct: { name, slug, image } });
}

/** Výsledky hledání (/hledej?f=slovo), jen první stránka (další stránky robots.txt zakazuje). */
export const searchUrl = (words) => `${BASE}/hledej?f=${encodeURIComponent(words)}`;
export const productUrl = (slug) => `${BASE}/sleva/${encodeURIComponent(slug)}`;
