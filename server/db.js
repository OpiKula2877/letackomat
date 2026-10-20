// SQLite přes vestavěný node:sqlite (žádná nativní kompilace).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function openDb(file = process.env.DB_FILE ?? resolve('data', 'letackomat.db')) {
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
  `);
  migrateFavoritesToCart(db);
  return db;
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
      price_sale,price_orig,discount_pct,price_per_unit,valid_from,valid_to,image_url,source_url,leaflet_url,first_seen,last_seen)
    VALUES(@id,@shop_slug,@product_id,@product_slug,@name,@name_norm,@quantity,@note,@category,
      @price_sale,@price_orig,@discount_pct,@price_per_unit,@valid_from,@valid_to,@image_url,@source_url,@leaflet_url,@seen,@seen)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, name_norm=excluded.name_norm, quantity=excluded.quantity, note=excluded.note,
      category=excluded.category, price_sale=excluded.price_sale, price_orig=excluded.price_orig,
      discount_pct=excluded.discount_pct, price_per_unit=excluded.price_per_unit,
      valid_from=COALESCE(excluded.valid_from, deals.valid_from),
      valid_to=COALESCE(excluded.valid_to, deals.valid_to),
      image_url=COALESCE(excluded.image_url, deals.image_url),
      leaflet_url=excluded.leaflet_url, last_seen=excluded.last_seen
  `);
  return {
    shop: (s) => shop.run({ logo_url: null, ...s }),
    deal: (d) => deal.run(d),
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
