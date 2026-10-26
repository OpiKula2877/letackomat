// REST API Letáčkomatu.
import { CATEGORY_LABELS } from './categories.js';
import { cartSlugs, registerCart } from './cart.js';
import { getMeta } from './db.js';
import { installId } from './install.js';
import { isLocal, isTrusted } from './local.js';
import { isInstalled } from './paths.js';
import { registerPrefs } from './prefs.js';
import { registerProduct } from './product.js';
import { registerAlerts } from './watch/routes.js';
import { buildFilter, SORTS, splitCsv, toItem } from './query.js';
import { isScraping, runScrapeWithRetry, scrapeProgress } from './scraper/run.js';
import { subcategoriesStep } from './scraper/subcategories.js';
import { readPackage } from './update.js';
import { addDays, isISODate, todayISO } from './util.js';

export function registerRoutes(app, db, { onShutdown, update, alerts, installed } = {}) {
  const version = readPackage().version;
  const id = installId();

  app.get('/api/health', async (req) => ({
    ok: true,
    version,
    installId: id,
    installed: installed ?? isInstalled(), // nainstalováno instalátorem: tlačítko Nainstalovat appku se pak nenabízí
    today: todayISO(),
    lastScrape: getMeta(db, 'last_scrape'),
    scraping: isScraping(),
    progress: scrapeProgress(),
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
    // podkategorie bez vlastního filtru, jen ty, které v daném výběru mají akce
    const fSub = buildFilter(req.query, { skip: ['subcategory'] });
    const subInfo = new Map(db.prepare('SELECT slug, name, parent_slug, parent_name FROM subcategories').all().map((r) => [r.slug, r]));
    const subcategories = db
      .prepare(`SELECT d.subcategory slug, COUNT(*) n FROM deals d WHERE ${fSub.where} AND d.subcategory IS NOT NULL GROUP BY d.subcategory`)
      .all(fSub.params)
      .map((r) => {
        const info = subInfo.get(r.slug);
        return { slug: r.slug, name: info?.name ?? r.slug, parent: info?.parent_slug ?? null, parentName: info?.parent_name ?? '', count: r.n };
      })
      .sort((a, b) => a.parentName.localeCompare(b.parentName, 'cs') || a.name.localeCompare(b.name, 'cs'));

    const inCart = cartSlugs(db);
    return { date: f.date, dateTo: f.dateTo, total, limit, offset, items: rows.map((r) => toItem(r, inCart)), facets: { shops, categories, subcategories } };
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
  registerProduct(app, db);
  registerPrefs(app, db);
  if (alerts) registerAlerts(app, db, alerts);

  /** Je k dispozici novější verze na GitHubu? (výsledek se cachuje, ?force=1 jen z tohoto počítače) */
  app.get('/api/update', async (req) => {
    if (!update) return { enabled: false, current: version, available: false };
    await update.check({ force: req.query.force === '1' && isLocal(req) });
    return update.status();
  });

  /** Stáhne novou verzi z GitHubu, vypne server a nechá updater vyměnit soubory a spustit ho znovu. */
  app.post('/api/update/apply', async (req, reply) => {
    if (!update || !onShutdown) return reply.code(501).send({ error: 'aktualizace není v tomto režimu dostupná' });
    if (!isTrusted(req)) return reply.code(403).send({ error: 'jen z tohoto počítače' });
    try {
      const { version: to, shutdown = true, installer = false, elevated = false } = await update.startApply();
      reply.code(202).send({ starting: true, version: to, installer, elevated });
      // zip: updater čeká, až server skončí; instalátor server vypne sám, až uživatel potvrdí UAC
      if (shutdown) setTimeout(() => onShutdown(), 500);
      return reply;
    } catch (e) {
      return reply.code(e.code ?? 500).send({ error: e.message });
    }
  });

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
    runScrapeWithRetry(db, { shops: shops.length ? shops : undefined, log: (m) => app.log.info(m), refreshSubs: subcategoriesStep }).catch((e) => app.log.error(e));
    return reply.code(202).send({ started: true });
  });
}
