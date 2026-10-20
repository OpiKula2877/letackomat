// Sdílené stavební kameny dotazů na slevy (používá API slev i nákupní seznam).
import { CATEGORY_LABELS } from './categories.js';
import { addDays, isISODate, normalize, todayISO } from './util.js';

/** Podmínka "sleva je potvrzeně platná alespoň jeden den v rozsahu @date až @dateTo". */
export const VALID_ON = `
  (COALESCE(d.valid_from, d.first_seen) <= @dateTo)
  AND (
    (d.valid_to IS NOT NULL AND d.valid_to >= @date)
    OR (d.valid_to IS NULL AND d.last_seen >= date(@date, '-3 day'))
  )`;

export const MAX_RANGE_DAYS = 366;

export function splitCsv(v) {
  return String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Z query `date` a `to` udělá platné období (od <= do, nejvýš MAX_RANGE_DAYS). */
export function resolvePeriod(query) {
  let date = isISODate(query.date) ? query.date : todayISO();
  let dateTo = isISODate(query.to) ? query.to : date;
  if (dateTo < date) [date, dateTo] = [dateTo, date];
  if (dateTo > addDays(date, MAX_RANGE_DAYS)) dateTo = addDays(date, MAX_RANGE_DAYS);
  return { date, dateTo };
}

export function buildFilter(query, { skip = [] } = {}) {
  const { date, dateTo } = resolvePeriod(query);
  const where = [VALID_ON];
  const params = { date, dateTo };

  if (!skip.includes('shops')) {
    const shops = splitCsv(query.shops);
    if (shops.length) {
      where.push(`d.shop_slug IN (${shops.map((_, i) => `@s${i}`).join(',')})`);
      shops.forEach((s, i) => (params[`s${i}`] = s));
    }
  }
  if (!skip.includes('category') && query.category) {
    const cats = splitCsv(query.category);
    where.push(`d.category IN (${cats.map((_, i) => `@c${i}`).join(',')})`);
    cats.forEach((c, i) => (params[`c${i}`] = c));
  }
  if (query.q) {
    const words = normalize(query.q).split(/\s+/).filter(Boolean).slice(0, 6);
    words.forEach((w, i) => {
      where.push(`d.name_norm LIKE @q${i} ESCAPE '\\'`);
      params[`q${i}`] = `%${w.replace(/[\\%_]/g, '\\$&')}%`;
    });
  }
  const minDiscount = Number(query.minDiscount);
  if (minDiscount > 0) {
    where.push('d.discount_pct >= @minDiscount');
    params.minDiscount = minDiscount;
  }
  if (query.onlyDiscounted === '1') where.push('d.discount_pct IS NOT NULL');

  return { date, dateTo, where: where.join(' AND '), params };
}

export const SORTS = {
  discount: 'd.discount_pct IS NULL, d.discount_pct DESC, d.price_sale ASC',
  price: 'd.price_sale ASC',
  name: 'd.name_norm ASC',
  shop: 's.name ASC, d.name_norm ASC',
};

/** Řádek z `deals JOIN shops` -> objekt pro API. */
export function toItem(r, inCartSlugs) {
  return {
    id: r.id,
    shop: { slug: r.shop_slug, name: r.shop_name, logo: r.logo_url },
    productSlug: r.product_slug,
    name: r.name,
    quantity: r.quantity,
    note: r.note,
    category: r.category,
    categoryLabel: CATEGORY_LABELS[r.category] ?? r.category,
    priceSale: r.price_sale,
    priceOrig: r.price_orig,
    origApprox: r.price_orig != null,
    discountPct: r.discount_pct,
    pricePerUnit: r.price_per_unit,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    image: /^https?:\/\//.test(r.image_url ?? '') ? r.image_url : null,
    url: r.source_url,
    leafletUrl: r.leaflet_url,
    inCart: inCartSlugs?.has(r.product_slug) ?? false,
  };
}
