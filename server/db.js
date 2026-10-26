// SQLite přes vestavěný node:sqlite (žádná nativní kompilace).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from './paths.js';
import { parseUnitPrice } from './units.js';

export function openDb(file = process.env.DB_FILE ?? join(dataDir(), 'letackomat.db')) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS shops (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      logo_url TEXT
    );

    CREATE TABLE IF NOT EXISTS deals (
      id INTEGER PRIMARY KEY,            -- id slevy na kupi.cz
      shop_slug TEXT NOT NULL REFERENCES shops(slug),
      product_id INTEGER,
      product_slug TEXT NOT NULL,
      name TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      quantity TEXT,
      note TEXT,
      category TEXT NOT NULL DEFAULT 'ostatni',
      price_sale REAL NOT NULL,
      price_orig REAL,                   -- dopočteno z procenta slevy
      discount_pct INTEGER,
      price_per_unit TEXT,
      valid_from TEXT,                   -- YYYY-MM-DD, NULL = neznámý začátek
      valid_to TEXT,                     -- YYYY-MM-DD, NULL = neznámý konec
      image_url TEXT,
      source_url TEXT NOT NULL,
      leaflet_url TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deals_shop ON deals(shop_slug);
    CREATE INDEX IF NOT EXISTS idx_deals_valid ON deals(valid_from, valid_to);
    CREATE INDEX IF NOT EXISTS idx_deals_product ON deals(product_slug);

    -- podkategorie kupi.cz (třeba Alkohol > Vodka) a to, ke které podkategorii patří který produkt
    CREATE TABLE IF NOT EXISTS subcategories (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_slug TEXT NOT NULL,
      parent_name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_subcategory (
      product_id INTEGER PRIMARY KEY,
      subcategory TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS favorites (
      product_slug TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- nákupní seznam (nahradil "oblíbené"): položka je produkt, zůstane do ručního smazání
    CREATE TABLE IF NOT EXISTS sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS cart_items (
      product_slug TEXT PRIMARY KEY,
      section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      image_url TEXT,
      quantity TEXT,
      checked INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- upozornění: pravidla hlídače (slovo v názvu nebo konkrétní produkt) a už odeslaná oznámení
    CREATE TABLE IF NOT EXISTS watch_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('keyword', 'product')),
      value TEXT NOT NULL,               -- keyword: normalizovaná slova; product: product_slug
      label TEXT NOT NULL,               -- co se ukazuje uživateli
      min_discount INTEGER,
      max_price REAL,
      shops TEXT,                        -- slugy obchodů oddělené čárkou, NULL = všechny
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS notifications (
      rule_id INTEGER NOT NULL REFERENCES watch_rules(id) ON DELETE CASCADE,
      deal_id INTEGER NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (rule_id, deal_id)
    );
  `);
  migrateFavoritesToCart(db);
  ensureUnitColumns(db);
  ensureSubcategoryColumn(db);
  return db;
}

/** Podkategorie u akce: přidá sloupec a index (starší databáze ho dostane doplněný, data se nemění). */
export function ensureSubcategoryColumn(db) {
  const cols = db.prepare('PRAGMA table_info(deals)').all().map((c) => c.name);
  if (!cols.includes('subcategory')) db.exec('ALTER TABLE deals ADD COLUMN subcategory TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_deals_subcategory ON deals(subcategory)');
}

/** Cena za 1 kg / 1 l / 1 ks (pro porovnání): přidá sloupce a jednorázově dopočítá starší záznamy. */
export function ensureUnitColumns(db) {
  const cols = db.prepare('PRAGMA table_info(deals)').all().map((c) => c.name);
  if (!cols.includes('unit_kind')) db.exec('ALTER TABLE deals ADD COLUMN unit_kind TEXT');
  if (!cols.includes('unit_price')) db.exec('ALTER TABLE deals ADD COLUMN unit_price REAL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_deals_unit ON deals(unit_kind, unit_price)');
  if (getMeta(db, 'units_backfilled') === '1') return;

  const upd = db.prepare('UPDATE deals SET unit_kind = ?, unit_price = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const r of db.prepare('SELECT id, price_per_unit FROM deals WHERE price_per_unit IS NOT NULL').all()) {
      const u = parseUnitPrice(r.price_per_unit);
      if (u) upd.run(u.kind, u.price, r.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  setMeta(db, 'units_backfilled', '1');
}

/** Jednorázově převede dřívější "oblíbené" na položky nákupního seznamu. */
export function migrateFavoritesToCart(db) {
  if (getMeta(db, 'cart_migrated') === '1') return;
  const latest = db.prepare(
    'SELECT name, image_url, quantity FROM deals WHERE product_slug = ? ORDER BY last_seen DESC, id DESC LIMIT 1',
  );
  const insert = db.prepare('INSERT OR IGNORE INTO cart_items(product_slug, name, image_url, quantity) VALUES(?,?,?,?)');
  for (const { product_slug: slug } of db.prepare('SELECT product_slug FROM favorites').all()) {
    const d = latest.get(slug);
    insert.run(slug, d?.name ?? slug.replace(/-/g, ' '), d?.image_url ?? null, d?.quantity ?? null);
  }
  setMeta(db, 'cart_migrated', '1');
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
    key,
    String(value),
  );
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null;
}

/** Upsert obchodu a slevy. Při opakovaném scrapu zachová dříve známé datum začátku. */
export function makeWriter(db) {
  const shop = db.prepare(`
    INSERT INTO shops(slug,name,logo_url) VALUES(@slug,@name,@logo_url)
    ON CONFLICT(slug) DO UPDATE SET name=excluded.name, logo_url=COALESCE(excluded.logo_url, shops.logo_url)
  `);
  const deal = db.prepare(`
    INSERT INTO deals(id,shop_slug,product_id,product_slug,name,name_norm,quantity,note,category,
      price_sale,price_orig,discount_pct,price_per_unit,unit_kind,unit_price,valid_from,valid_to,image_url,source_url,leaflet_url,first_seen,last_seen)
    VALUES(@id,@shop_slug,@product_id,@product_slug,@name,@name_norm,@quantity,@note,@category,
      @price_sale,@price_orig,@discount_pct,@price_per_unit,@unit_kind,@unit_price,@valid_from,@valid_to,@image_url,@source_url,@leaflet_url,@seen,@seen)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, name_norm=excluded.name_norm, quantity=excluded.quantity, note=excluded.note,
      category=excluded.category, price_sale=excluded.price_sale, price_orig=excluded.price_orig,
      discount_pct=excluded.discount_pct, price_per_unit=excluded.price_per_unit,
      unit_kind=excluded.unit_kind, unit_price=excluded.unit_price,
      valid_from=COALESCE(excluded.valid_from, deals.valid_from),
      valid_to=COALESCE(excluded.valid_to, deals.valid_to),
      image_url=COALESCE(excluded.image_url, deals.image_url),
      leaflet_url=excluded.leaflet_url, last_seen=excluded.last_seen
  `);
  return {
    shop: (s) => shop.run({ logo_url: null, ...s }),
    deal(d) {
      // cena za 1 kg / 1 l / 1 ks se odvozuje z textu "13,95 Kč / 100 g"
      const u = parseUnitPrice(d.price_per_unit);
      return deal.run({ ...d, unit_kind: u?.kind ?? null, unit_price: u?.price ?? null });
    },
    tx(fn) {
      db.exec('BEGIN');
      try {
        fn();
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
