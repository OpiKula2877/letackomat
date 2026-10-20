// Nákupní seznam: položky (produkty) + vlastní sekce. Zůstává v databázi, dokud ho uživatel nesmaže,
// takže jde dívat se i na minulá období (slevy se nemažou).
import { resolvePeriod, toItem, VALID_ON } from './query.js';
import { addDays, isISODate, todayISO } from './util.js';

const MAX_SECTIONS = 30;
const MAX_NAME = 40;

function cleanName(v) {
  const name = String(v ?? '').replace(/\s+/g, ' ').trim();
  return name && name.length <= MAX_NAME ? name : null;
}

export function cartSlugs(db) {
  return new Set(db.prepare('SELECT product_slug FROM cart_items').all().map((r) => r.product_slug));
}

const DEAL_SELECT = `SELECT d.*, s.name AS shop_name, s.logo_url FROM deals d JOIN shops s ON s.slug = d.shop_slug`;

export function registerCart(app, db) {
  const latestDeal = db.prepare(`${DEAL_SELECT} WHERE d.product_slug = ? ORDER BY d.last_seen DESC, d.id DESC LIMIT 1`);
  const sectionExists = db.prepare('SELECT 1 FROM sections WHERE id = ?');

  function itemRow(slug) {
    return db.prepare('SELECT * FROM cart_items WHERE product_slug = ?').get(slug);
  }

  function publicItem(r, deals = [], last = null) {
    return {
      slug: r.product_slug,
      name: r.name,
      image: /^https?:\/\//.test(r.image_url ?? '') ? r.image_url : null,
      quantity: r.quantity,
      sectionId: r.section_id,
      checked: !!r.checked,
      addedAt: r.added_at,
      deals,
      last,
    };
  }

  app.get('/api/cart/slugs', async () => ({ slugs: [...cartSlugs(db)] }));

  /** Pro každý den: kolik produktů z nákupního seznamu je v ten den v akci. */
  app.get('/api/cart/days', async (req) => {
    const from = isISODate(req.query.from) ? req.query.from : todayISO();
    const count = Math.min(Math.max(Number(req.query.count) || 14, 1), 60);
    const stmt = db.prepare(
      `SELECT COUNT(DISTINCT d.product_slug) n FROM deals d
       WHERE ${VALID_ON} AND d.product_slug IN (SELECT product_slug FROM cart_items)`,
    );
    const days = [];
    for (let i = 0; i < count; i++) {
      const date = addDays(from, i);
      days.push({ date, count: stmt.get({ date, dateTo: date }).n });
    }
    return { days };
  });

  /** Seznam + sekce + slevy položek v období (?date=&to=). */
  app.get('/api/cart', async (req) => {
    const { date, dateTo } = resolvePeriod(req.query);
    const rows = db.prepare('SELECT * FROM cart_items ORDER BY added_at DESC, rowid DESC').all();
    const slugs = new Set(rows.map((r) => r.product_slug));

    const dealRows = rows.length
      ? db
          .prepare(
            `${DEAL_SELECT} WHERE ${VALID_ON} AND d.product_slug IN (SELECT product_slug FROM cart_items)
             ORDER BY d.price_sale ASC, d.id`,
          )
          .all({ date, dateTo })
      : [];
    const bySlug = new Map();
    for (const d of dealRows) {
      if (!bySlug.has(d.product_slug)) bySlug.set(d.product_slug, []);
      bySlug.get(d.product_slug).push(toItem(d, slugs));
    }

    const items = rows.map((r) => {
      const deals = bySlug.get(r.product_slug) ?? [];
      const last = deals.length ? null : (() => {
        const l = latestDeal.get(r.product_slug);
        return l ? toItem(l, slugs) : null;
      })();
      return publicItem(r, deals, last);
    });

    const sections = db.prepare('SELECT id, name FROM sections ORDER BY position, id').all();
    return { date, dateTo, sections, items };
  });

  app.post('/api/cart', async (req, reply) => {
    const slug = String(req.body?.productSlug ?? '').trim();
    if (!slug) return reply.code(400).send({ error: 'chybí productSlug' });
    const existing = itemRow(slug);
    if (existing) return publicItem(existing);

    const deal = latestDeal.get(slug);
    if (!deal) return reply.code(404).send({ error: 'produkt neznám' });

    let sectionId = req.body?.sectionId ?? null;
    if (sectionId != null && !sectionExists.get(Number(sectionId))) sectionId = null;

    db.prepare('INSERT INTO cart_items(product_slug, section_id, name, image_url, quantity) VALUES(?,?,?,?,?)').run(
      slug,
      sectionId == null ? null : Number(sectionId),
      deal.name,
      deal.image_url,
      deal.quantity,
    );
    return reply.code(201).send(publicItem(itemRow(slug)));
  });

  app.patch('/api/cart/:slug', async (req, reply) => {
    const slug = req.params.slug;
    if (!itemRow(slug)) return reply.code(404).send({ error: 'položka neexistuje' });
    const body = req.body ?? {};
    if ('sectionId' in body) {
      const id = body.sectionId;
      if (id !== null && !sectionExists.get(Number(id))) return reply.code(400).send({ error: 'sekce neexistuje' });
      db.prepare('UPDATE cart_items SET section_id = ? WHERE product_slug = ?').run(id === null ? null : Number(id), slug);
    }
    if ('checked' in body) {
      db.prepare('UPDATE cart_items SET checked = ? WHERE product_slug = ?').run(body.checked ? 1 : 0, slug);
    }
    return publicItem(itemRow(slug));
  });

  app.delete('/api/cart/:slug', async (req) => {
    db.prepare('DELETE FROM cart_items WHERE product_slug = ?').run(req.params.slug);
    return { ok: true };
  });

  app.post('/api/cart/clear-checked', async () => {
    const r = db.prepare('DELETE FROM cart_items WHERE checked = 1').run();
    return { removed: Number(r.changes) };
  });

  /* ——— sekce ——— */
  app.post('/api/sections', async (req, reply) => {
    const name = cleanName(req.body?.name);
    if (!name) return reply.code(400).send({ error: `název sekce musí mít 1 až ${MAX_NAME} znaků` });
    if (db.prepare('SELECT COUNT(*) n FROM sections').get().n >= MAX_SECTIONS) {
      return reply.code(400).send({ error: `nejvýš ${MAX_SECTIONS} sekcí` });
    }
    const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM sections').get().p;
    const r = db.prepare('INSERT INTO sections(name, position) VALUES(?, ?)').run(name, pos);
    return reply.code(201).send({ id: Number(r.lastInsertRowid), name });
  });

  app.patch('/api/sections/:id', async (req, reply) => {
    const name = cleanName(req.body?.name);
    if (!name) return reply.code(400).send({ error: `název sekce musí mít 1 až ${MAX_NAME} znaků` });
    const r = db.prepare('UPDATE sections SET name = ? WHERE id = ?').run(name, Number(req.params.id));
    if (!r.changes) return reply.code(404).send({ error: 'sekce neexistuje' });
    return { id: Number(req.params.id), name };
  });

  /** Smazání sekce: položky zůstanou, jen přejdou do "Nezařazeno". */
  app.delete('/api/sections/:id', async (req) => {
    const id = Number(req.params.id);
    db.prepare('UPDATE cart_items SET section_id = NULL WHERE section_id = ?').run(id);
    db.prepare('DELETE FROM sections WHERE id = ?').run(id);
    return { ok: true };
  });
}
