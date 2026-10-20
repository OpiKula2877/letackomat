// REST API Letáčkomatu.
import { CATEGORY_LABELS } from './categories.js';
import { cartSlugs, registerCart } from './cart.js';
import { getMeta } from './db.js';
import { buildFilter, SORTS, splitCsv, toItem } from './query.js';
import { isScraping, runScrape } from './scraper/run.js';
import { addDays, isISODate, todayISO } from './util.js';

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** Požadavek z toho samého počítače (ne z mobilu v síti, ne přes cizí doménu = ochrana proti DNS rebindingu). */
export const isLocal = (req) => LOOPBACK.includes(req.ip) && LOCAL_HOST.test(req.headers.host ?? '');

/** Akce měnící stav serveru: jen lokálně a s vlastní hlavičkou (cizí web ji bez CORS nepošle). */
export const isTrusted = (req) => isLocal(req) && req.headers['x-letackomat'] === '1';

export function registerRoutes(app, db, { onShutdown } = {}) {
  app.get('/api/health', async (req) => ({
    ok: true,
    today: todayISO(),
    lastScrape: getMeta(db, 'last_scrape'),
    scraping: isScraping(),
    deals: db.prepare('SELECT COUNT(*) n FROM deals').get().n,
    canShutdown: Boolean(onShutdown) && isLocal(req),
  }));

  app.get('/api/shops', async (req) => {
    const f = buildFilter(req.query, { skip: ['shops', 'category'] });
    const rows = db
      .prepare(
        `SELECT s.slug, s.name, s.logo_url, COUNT(d.id) AS n
         FROM shops s LEFT JOIN deals d ON d.shop_slug = s.slug AND ${f.where}
         GROUP BY s.slug HAVING n > 0 ORDER BY n DESC`,
      )
      .all(f.params);
    return { date: f.date, dateTo: f.dateTo, shops: rows.map((r) => ({ slug: r.slug, name: r.name, logo: r.logo_url, count: r.n })) };
  });

  app.get('/api/deals', async (req, reply) => {
    for (const key of ['date', 'to']) {
      if (req.query[key] && !isISODate(req.query[key])) {
        return reply.code(400).send({ error: `${key} musí být ve tvaru YYYY-MM-DD` });
      }
    }
    const f = buildFilter(req.query);
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const order = SORTS[req.query.sort] ?? SORTS.discount;

    const total = db.prepare(`SELECT COUNT(*) n FROM deals d WHERE ${f.where}`).get(f.params).n;
    const rows = db
      .prepare(
        `SELECT d.*, s.name AS shop_name, s.logo_url
         FROM deals d JOIN shops s ON s.slug = d.shop_slug
         WHERE ${f.where} ORDER BY ${order}, d.id LIMIT @limit OFFSET @offset`,
      )
      .all({ ...f.params, limit, offset });

    // fasety (počty) bez vlastního filtru, aby šlo přepínat
    const fShops = buildFilter(req.query, { skip: ['shops'] });
    const shops = db
      .prepare(
        `SELECT s.slug, s.name, s.logo_url, COUNT(*) n FROM deals d JOIN shops s ON s.slug=d.shop_slug
         WHERE ${fShops.where} GROUP BY s.slug ORDER BY n DESC`,
      )
      .all(fShops.params)
      .map((r) => ({ slug: r.slug, name: r.name, logo: r.logo_url, count: r.n }));
    const fCat = buildFilter(req.query, { skip: ['category'] });
    const categories = db
      .prepare(`SELECT d.category id, COUNT(*) n FROM deals d WHERE ${fCat.where} GROUP BY d.category ORDER BY n DESC`)
      .all(fCat.params)
      .map((r) => ({ id: r.id, label: CATEGORY_LABELS[r.id] ?? r.id, count: r.n }));

    const inCart = cartSlugs(db);
    return { date: f.date, dateTo: f.dateTo, total, limit, offset, items: rows.map((r) => toItem(r, inCart)), facets: { shops, categories } };
  });

  /** Počet akcí pro každý den v řadě (pásek dnů v UI). Respektuje filtry obchodů/hledání. */
  app.get('/api/days', async (req) => {
    const from = isISODate(req.query.from) ? req.query.from : todayISO();
    const count = Math.min(Math.max(Number(req.query.count) || 14, 1), 60);
    const days = [];
    for (let i = 0; i < count; i++) {
      const date = addDays(from, i);
      const f = buildFilter({ ...req.query, date, to: undefined });
      const sql = `SELECT COUNT(*) n FROM deals d WHERE ${f.where}`;
      days.push({ date, count: db.prepare(sql).get(f.params).n });
    }
    return { days };
  });

  /** Rozsah dnů, ve kterých něco máme (pro kalendář). */
  app.get('/api/range', async () => {
    const r = db
      .prepare(`SELECT MIN(COALESCE(valid_from, first_seen)) AS min, MAX(valid_to) AS max FROM deals`)
      .get();
    return { min: r.min, max: r.max, today: todayISO() };
  });

  registerCart(app, db);

  /** Vypnutí serveru (tlačítko Vypnout v aplikaci, end.bat). */
  app.post('/api/shutdown', async (req, reply) => {
    if (!onShutdown) return reply.code(501).send({ error: 'vypnutí není v tomto režimu dostupné' });
    if (!isTrusted(req)) return reply.code(403).send({ error: 'jen z tohoto počítače' });
    reply.code(202).send({ stopping: true });
    // odpověď se musí stihnout odeslat, než se proces ukončí
    setTimeout(() => onShutdown(), 200);
    return reply;
  });

  /** Ruční spuštění scrapu – jen z localhostu. */
  app.post('/api/scrape', async (req, reply) => {
    if (!isTrusted(req)) return reply.code(403).send({ error: 'jen z tohoto počítače' });
    if (isScraping()) return reply.code(409).send({ error: 'scrape už běží' });
    const shops = splitCsv(req.query.shops);
    runScrape(db, shops.length ? shops : undefined).catch((e) => app.log.error(e));
    return reply.code(202).send({ started: true });
  });
}
