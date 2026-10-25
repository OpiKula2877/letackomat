import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { getMeta, openDb } from '../server/db.js';
import { migrateLegacyData } from '../server/migrate.js';
import { runScrape, runScrapeWithRetry, scrapeProgress } from '../server/scraper/run.js';
import { scrapeShop } from '../server/scraper/kupi.js';

const here = dirname(fileURLToPath(import.meta.url));
const listing = readFileSync(join(here, 'fixtures', 'kupi-listing.html'), 'utf8');
const tmp = (name) => mkdtempSync(join(tmpdir(), `letackomat-${name}-`));
const memDb = () => openDb(':memory:');
const quiet = () => {};

test('stahování, které selhalo u všech obchodů, se nezapisuje jako hotové', async () => {
  const db = memDb();
  const summary = await runScrape(db, ['albert', 'lidl'], quiet, { scrape: async () => { throw new Error('fetch failed'); } });
  assert.deepEqual(Object.keys(summary), ['albert', 'lidl']);
  assert.equal(getMeta(db, 'last_scrape'), null); // jinak by se příští hodiny nic nepokusilo znovu
  assert.match(getMeta(db, 'last_scrape_summary'), /fetch failed/);
  db.close();
});

test('stahování, které aspoň něco stáhlo, se zapíše', async () => {
  const db = memDb();
  const ok = async () => ({ deals: [], unknownValidity: 0 });
  await runScrape(db, ['albert'], quiet, { scrape: ok });
  assert.ok(getMeta(db, 'last_scrape'));
  db.close();
});

test('neúspěšné obchody se zkusí znovu, úspěšné ne', async () => {
  const db = memDb();
  const calls = [];
  let lidlTries = 0;
  const scrape = async (slug) => {
    calls.push(slug);
    if (slug === 'lidl' && ++lidlTries < 3) throw new Error('fetch failed');
    return { deals: [], unknownValidity: 0 };
  };
  const waits = [];
  const out = await runScrapeWithRetry(db, { shops: ['albert', 'lidl'], log: quiet, scrape, retryMs: 123, wait: async (ms) => { waits.push(ms); } });
  assert.deepEqual(calls, ['albert', 'lidl', 'lidl', 'lidl']);
  assert.deepEqual(waits, [123, 123]);
  assert.equal(out.summary.lidl.error, undefined);
  assert.equal(out.attempts, 3);
  db.close();
});

test('průběh stahování: hotové obchody, aktuální obchod, čekání na další pokus a návrat do klidu', async () => {
  const db = memDb();
  assert.equal(scrapeProgress().phase, 'idle');
  const seen = [];
  let lidlTries = 0;
  const scrape = async (slug, { onPage }) => {
    onPage?.({ page: 3, added: 1 });
    seen.push({ slug, ...scrapeProgress() });
    if (slug === 'lidl' && ++lidlTries < 2) throw new Error('fetch failed');
    return { deals: [], unknownValidity: 0 };
  };
  const waiting = [];
  await runScrapeWithRetry(db, {
    shops: ['albert', 'penny-market', 'lidl'], log: quiet, scrape, retryMs: 1000,
    wait: async () => { waiting.push(scrapeProgress()); },
  });
  assert.deepEqual(seen.map((s) => [s.phase, s.total, s.done, s.current, s.page]), [
    ['running', 3, 0, 'Albert', 3],
    ['running', 3, 1, 'Penny', 3],
    ['running', 3, 2, 'Lidl', 3],
    ['running', 3, 2, 'Lidl', 3], // druhý pokus: hotové obchody se nezapomněly
  ]);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].phase, 'waiting');
  assert.equal(waiting[0].failed, 1);
  assert.ok(waiting[0].retryAt > Date.now());
  assert.equal(scrapeProgress().phase, 'idle');
  assert.equal(scrapeProgress().total, 0);
  db.close();
});

test('opakování má strop a pak se vzdá', async () => {
  const db = memDb();
  const scrape = async () => { throw new Error('fetch failed'); };
  const out = await runScrapeWithRetry(db, { shops: ['albert'], log: quiet, scrape, retryMs: 1, maxRetries: 2, wait: async () => {} });
  assert.equal(out.attempts, 3);
  assert.match(out.summary.albert.error, /fetch failed/);
  assert.equal(getMeta(db, 'last_scrape'), null);
  db.close();
});

test('scrapeShop: když to uprostřed selže, vrátí to, co už stáhl', async () => {
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    if (++n === 1) return new Response(listing, { status: 200 });
    throw new TypeError('fetch failed');
  };
  try {
    const r = await scrapeShop('albert', { delayMs: 0, retries: 1 });
    assert.ok(r.deals.length > 0);
    assert.match(r.error, /fetch failed/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('scrapeShop: když to selže hned na první stránce, vyhodí chybu', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  try {
    await assert.rejects(() => scrapeShop('albert', { delayMs: 0, retries: 1 }), /fetch failed/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- převzetí dat, když v datové složce už leží prázdná databáze

const installedRootDir = () => {
  const root = tmp('root');
  writeFileSync(join(root, 'installed.flag'), '');
  return root;
};

function legacyWithData(dir) {
  mkdirSync(join(dir, 'data'), { recursive: true });
  const db = openDb(join(dir, 'data', 'letackomat.db'));
  db.prepare("INSERT INTO sections(name, position) VALUES ('Kalba', 1)").run();
  db.close();
}

test('prázdná databáze v datové složce nebrání převzetí starých dat (a zůstane jako záloha)', async () => {
  const legacy = tmp('legacy');
  legacyWithData(legacy);
  const root = installedRootDir();
  const dest = join(tmp('dest'), 'Letackomat');
  mkdirSync(dest, { recursive: true });
  const empty = openDb(join(dest, 'letackomat.db'));
  empty.close(); // čerstvá databáze: žádné akce, žádný seznam, žádné sekce

  const r = await migrateLegacyData({ root, dest, candidates: [legacy] });
  assert.equal(r.status, 'migrated');
  const copy = new DatabaseSync(join(dest, 'letackomat.db'), { readOnly: true });
  assert.equal(copy.prepare("SELECT COUNT(*) n FROM sections WHERE name = 'Kalba'").get().n, 1);
  copy.close();
  assert.ok(readdirSync(dest).some((f) => f.includes('.prazdna-')), 'původní prázdná databáze se uschová');
  for (const d of [legacy, root, join(dest, '..')]) rmSync(d, { recursive: true, force: true });
});

test('databáze s uživatelskými daty se nikdy nepřepíše', async () => {
  const legacy = tmp('legacy');
  legacyWithData(legacy);
  const root = installedRootDir();
  const dest = join(tmp('dest'), 'Letackomat');
  mkdirSync(dest, { recursive: true });
  const mine = openDb(join(dest, 'letackomat.db'));
  mine.prepare("INSERT INTO sections(name, position) VALUES ('Moje', 1)").run();
  mine.close();

  assert.equal((await migrateLegacyData({ root, dest, candidates: [legacy] })).status, 'exists');
  const keep = new DatabaseSync(join(dest, 'letackomat.db'), { readOnly: true });
  assert.equal(keep.prepare("SELECT COUNT(*) n FROM sections WHERE name = 'Moje'").get().n, 1);
  keep.close();
  assert.equal(existsSync(join(dest, 'letackomat.db')), true);
  for (const d of [legacy, root, join(dest, '..')]) rmSync(d, { recursive: true, force: true });
});
