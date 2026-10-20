// Porovnání cen jednoho produktu: nabídky v obchodech v zvoleném období + historie z našich dat.
import { cartSlugs } from './cart.js';
import { resolvePeriod, toItem, VALID_ON } from './query.js';
import { isISODate, normalize } from './util.js';

const DEAL_SELECT = 'SELECT d.*, s.name AS shop_name, s.logo_url FROM deals d JOIN shops s ON s.slug = d.shop_slug';
const HISTORY_DAYS = 365;

const round2 = (n) => Math.round(n * 100) / 100;

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round2(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

/**
 * Nabídky se porovnávají podle ceny za 1 kg / 1 l / 1 ks, když ji mají všechny a je stejného druhu.
 * Jinak podle ceny za balení (různé velikosti balení by jinak nešly srovnat).
 */
export function rankOffers(items) {
  const unit = items.length > 0 && items.every((i) => i.unitPrice != null && i.unitKind === items[0].unitKind);
  const metric = unit ? 'unit' : 'price';
  const value = (i) => (unit ? i.unitPrice : i.priceSale);
  const ranked = [...items].sort((a, b) => value(a) - value(b) || a.priceSale - b.priceSale);
  const min = ranked.length ? value(ranked[0]) : 0;
  return {
    metric,
    unitKind: unit ? items[0].unitKind : null,
    offers: ranked.map((i) => ({
      ...i,
      cheapest: value(i) === min,
      moreExpensivePct: min > 0 ? Math.round((value(i) / min - 1) * 100) : 0,
    })),
  };
}

export function registerProduct(app, db) {
  /** Hledání produktů podle názvu napříč vším, co kdy bylo v akci (výběr produktu pro hlídání). */
  app.get('/api/products', async (req) => {
    const words = normalize(req.query.q ?? '').split(/\s+/).filter(Boolean).slice(0, 6);
    if (!words.length) return { products: [] };
    const params = {};
    const where = words.map((w, i) => {
      params[`w${i}`] = `%${w.replace(/[\\%_]/g, '\\$&')}%`;
      return `name_norm LIKE @w${i} ESCAPE '\\'`;
    });
    const rows = db
      .prepare(
        `SELECT product_slug, name, quantity, image_url, MAX(last_seen) AS last_seen FROM deals
         WHERE ${where.join(' AND ')} GROUP BY product_slug ORDER BY last_seen DESC, name LIMIT 12`,
      )
      .all(params);
    return {
      products: rows.map((r) => ({
        slug: r.product_slug,
        name: r.name,
        quantity: r.quantity,
        image: /^https?:\/\//.test(r.image_url ?? '') ? r.image_url : null,
        lastSeen: r.last_seen,
      })),
    };
  });

  app.get('/api/products/:slug', async (req, reply) => {
    for (const key of ['date', 'to']) {
      if (req.query[key] && !isISODate(req.query[key])) {
        return reply.code(400).send({ error: `${key} musí být ve tvaru YYYY-MM-DD` });
      }
    }
    const slug = req.params.slug;
    const { date, dateTo } = resolvePeriod(req.query);
    const inCart = cartSlugs(db);

    const latest = db.prepare(`${DEAL_SELECT} WHERE d.product_slug = ? ORDER BY d.last_seen DESC, d.id DESC LIMIT 1`).get(slug);
    if (!latest) return reply.code(404).send({ error: 'produkt neznám' });

    const rows = db
      .prepare(`${DEAL_SELECT} WHERE ${VALID_ON} AND d.product_slug = @slug`)
      .all({ date, dateTo, slug });
    const { metric, unitKind, offers } = rankOffers(rows.map((r) => toItem(r, inCart)));

    // historie: jen to, co jsme sami stáhli; roste s časem
    const histRows = db
      .prepare(
        `${DEAL_SELECT} WHERE d.product_slug = @slug
           AND COALESCE(d.valid_to, d.last_seen) >= date('now', @back)
         ORDER BY COALESCE(d.valid_from, d.first_seen), d.id LIMIT 500`,
      )
      .all({ slug, back: `-${HISTORY_DAYS} day` });
    const history = histRows.map((r) => ({
      shop: { slug: r.shop_slug, name: r.shop_name },
      priceSale: r.price_sale,
      discountPct: r.discount_pct,
      unitPrice: r.unit_price,
      unitKind: r.unit_kind,
      validFrom: r.valid_from ?? r.first_seen,
      validTo: r.valid_to ?? r.last_seen,
    }));

    // statistiky a graf jedou podle ceny za 1 kg / 1 l / 1 ks, když ji mají všechny záznamy stejného druhu
    // (jinak by se míchala různě velká balení); jinak podle ceny za balení
    const byUnit = history.length > 0 && history.every((h) => h.unitPrice != null && h.unitKind === history[0].unitKind);
    const val = (h) => (byUnit ? h.unitPrice : h.priceSale);
    const prices = history.map(val);
    const lowest = history.reduce((best, h) => (!best || val(h) < val(best) ? h : best), null);
    const stats = {
      basis: byUnit ? 'unit' : 'price',
      unitKind: byUnit ? history[0].unitKind : null,
      count: history.length,
      min: prices.length ? Math.min(...prices) : null,
      max: prices.length ? Math.max(...prices) : null,
      median: median(prices),
      lowestShop: lowest?.shop.name ?? null,
      lowestFrom: lowest?.validFrom ?? null,
      since: history.length ? history[0].validFrom : null,
    };

    return {
      slug,
      name: latest.name,
      quantity: latest.quantity,
      image: /^https?:\/\//.test(latest.image_url ?? '') ? latest.image_url : null,
      url: latest.source_url,
      inCart: inCart.has(slug),
      date,
      dateTo,
      metric,
      unitKind,
      offers,
      history,
      stats,
    };
  });
}
