// Pravidla hlídače: slovo v názvu ("Jägermeister") nebo konkrétní produkt, volitelně s podmínkami.
import { toItem, VALID_ON } from '../query.js';
import { addDays, normalize } from '../util.js';

/** Hlídají se akce platné dnes nebo začínající nejpozději za tolik dní. */
export const LOOKAHEAD_DAYS = 3;

const DEAL_SELECT = 'SELECT d.*, s.name AS shop_name, s.logo_url FROM deals d JOIN shops s ON s.slug = d.shop_slug';
const fail = (message, code = 400) => Object.assign(new Error(message), { code });

export function cleanShops(v) {
  const list = (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map((s) => String(s).trim())
    .filter((s) => /^[a-z0-9-]+$/.test(s));
  return list.length ? [...new Set(list)].join(',') : null;
}

export function rowToRule(r) {
  return {
    id: r.id,
    kind: r.kind,
    value: r.value,
    label: r.label,
    minDiscount: r.min_discount,
    maxPrice: r.max_price,
    shops: r.shops ? r.shops.split(',') : [],
    enabled: !!r.enabled,
    createdAt: r.created_at,
  };
}

/** Z podmínek zadaných uživatelem udělá validní "pravidlo" (bez uložení). */
export function normalizeRule(db, input) {
  const kind = input.kind;
  let value;
  let label;
  if (kind === 'keyword') {
    const text = String(input.value ?? '').replace(/\s+/g, ' ').trim();
    const words = normalize(text).split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 6 || text.length < 2 || text.length > 60) {
      throw fail('Slovo v názvu musí mít 2 až 60 znaků a nejvýš 6 slov.');
    }
    value = words.join(' ');
    label = String(input.label ?? '').trim() || text;
  } else if (kind === 'product') {
    value = String(input.value ?? '').trim();
    const deal = db.prepare('SELECT name FROM deals WHERE product_slug = ? ORDER BY last_seen DESC, id DESC LIMIT 1').get(value);
    if (!deal) throw fail('Takový produkt neznám.', 404);
    label = String(input.label ?? '').trim() || deal.name;
  } else {
    throw fail('Druh pravidla musí být keyword nebo product.');
  }

  let minDiscount = input.minDiscount == null || input.minDiscount === '' ? null : Math.round(Number(input.minDiscount));
  if (minDiscount !== null && !(minDiscount >= 1 && minDiscount <= 99)) throw fail('Minimální sleva musí být 1 až 99 %.');
  let maxPrice = input.maxPrice == null || input.maxPrice === '' ? null : Number(String(input.maxPrice).replace(',', '.'));
  if (maxPrice !== null && !(maxPrice > 0 && maxPrice < 100000)) throw fail('Maximální cena musí být kladné číslo.');
  if (minDiscount === 0) minDiscount = null;

  return { kind, value, label, minDiscount, maxPrice, shops: cleanShops(input.shops) };
}

function matchSql(rule, today, { onlyNew = false } = {}) {
  const where = [VALID_ON];
  const params = { date: today, dateTo: addDays(today, LOOKAHEAD_DAYS) };
  if (rule.kind === 'product') {
    where.push('d.product_slug = @slug');
    params.slug = rule.value;
  } else {
    rule.value.split(' ').forEach((w, i) => {
      where.push(`d.name_norm LIKE @w${i} ESCAPE '\\'`);
      params[`w${i}`] = `%${w.replace(/[\\%_]/g, '\\$&')}%`;
    });
  }
  if (rule.minDiscount) {
    where.push('d.discount_pct >= @minD');
    params.minD = rule.minDiscount;
  }
  if (rule.maxPrice) {
    where.push('d.price_sale <= @maxP');
    params.maxP = rule.maxPrice;
  }
  const shops = Array.isArray(rule.shops) ? rule.shops : rule.shops ? String(rule.shops).split(',') : [];
  if (shops.length) {
    where.push(`d.shop_slug IN (${shops.map((_, i) => `@s${i}`).join(',')})`);
    shops.forEach((s, i) => (params[`s${i}`] = s));
  }
  if (onlyNew) {
    where.push('NOT EXISTS (SELECT 1 FROM notifications n WHERE n.rule_id = @rid AND n.deal_id = d.id)');
    params.rid = rule.id;
  }
  return { where: where.join(' AND '), params };
}

/** Akce, které teď pravidlu odpovídají (nejlepší sleva první). */
export function matchesFor(db, rule, today, { limit = 200, onlyNew = false } = {}) {
  const { where, params } = matchSql(rule, today, { onlyNew });
  return db
    .prepare(`${DEAL_SELECT} WHERE ${where} ORDER BY d.discount_pct IS NULL, d.discount_pct DESC, d.price_sale ASC, d.id LIMIT @limit`)
    .all({ ...params, limit })
    .map((r) => toItem(r));
}

export function countMatches(db, rule, today) {
  const { where, params } = matchSql(rule, today);
  return db.prepare(`SELECT COUNT(*) n FROM deals d WHERE ${where}`).get(params).n;
}

export function listRules(db) {
  return db.prepare('SELECT * FROM watch_rules ORDER BY created_at DESC, id DESC').all().map(rowToRule);
}

export function getRule(db, id) {
  const r = db.prepare('SELECT * FROM watch_rules WHERE id = ?').get(id);
  return r ? rowToRule(r) : null;
}

/** Aktuální odpovídající akce se označí jako "už viděné", aby nové pravidlo hned nezahltilo oznámeními. */
export function baseline(db, rule, today) {
  const ins = db.prepare('INSERT OR IGNORE INTO notifications(rule_id, deal_id) VALUES(?, ?)');
  for (const m of matchesFor(db, rule, today, { limit: 5000 })) ins.run(rule.id, m.id);
}

export function createRule(db, input, today) {
  const n = normalizeRule(db, input);
  const dup = db
    .prepare('SELECT * FROM watch_rules WHERE kind = ? AND value = ? AND min_discount IS ? AND max_price IS ? AND shops IS ?')
    .get(n.kind, n.value, n.minDiscount, n.maxPrice, n.shops);
  if (dup) return { rule: rowToRule(dup), created: false };
  const r = db
    .prepare('INSERT INTO watch_rules(kind, value, label, min_discount, max_price, shops) VALUES(?,?,?,?,?,?)')
    .run(n.kind, n.value, n.label, n.minDiscount, n.maxPrice, n.shops);
  const rule = getRule(db, Number(r.lastInsertRowid));
  baseline(db, rule, today);
  return { rule, created: true };
}

export function updateRule(db, id, patch, today) {
  const cur = getRule(db, id);
  if (!cur) throw fail('Pravidlo neexistuje.', 404);
  if ('enabled' in patch) {
    db.prepare('UPDATE watch_rules SET enabled = ? WHERE id = ?').run(patch.enabled ? 1 : 0, id);
    if (patch.enabled && !cur.enabled) baseline(db, { ...cur, enabled: true }, today); // po zapnutí bez zpětného zahlcení
  }
  if ('minDiscount' in patch || 'maxPrice' in patch || 'shops' in patch) {
    const n = normalizeRule(db, {
      kind: cur.kind,
      value: cur.kind === 'keyword' ? cur.label : cur.value,
      label: cur.label,
      minDiscount: 'minDiscount' in patch ? patch.minDiscount : cur.minDiscount,
      maxPrice: 'maxPrice' in patch ? patch.maxPrice : cur.maxPrice,
      shops: 'shops' in patch ? patch.shops : cur.shops,
    });
    db.prepare('UPDATE watch_rules SET min_discount = ?, max_price = ?, shops = ? WHERE id = ?').run(n.minDiscount, n.maxPrice, n.shops, id);
  }
  return getRule(db, id);
}

export function deleteRule(db, id) {
  db.prepare('DELETE FROM watch_rules WHERE id = ?').run(id);
}

/** Nové shody (pravidlo × akce), o kterých uživatel ještě nevěděl. */
export function pendingMatches(db, today) {
  const out = [];
  for (const rule of listRules(db).filter((r) => r.enabled)) {
    for (const deal of matchesFor(db, rule, today, { onlyNew: true, limit: 100 })) out.push({ rule, deal });
  }
  return out;
}

export function markNotified(db, pairs) {
  const ins = db.prepare('INSERT OR IGNORE INTO notifications(rule_id, deal_id) VALUES(?, ?)');
  db.exec('BEGIN');
  try {
    for (const p of pairs) ins.run(p.rule.id, p.deal.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function findProductRule(db, slug) {
  const r = db.prepare("SELECT * FROM watch_rules WHERE kind = 'product' AND value = ? ORDER BY id LIMIT 1").get(slug);
  return r ? rowToRule(r) : null;
}
