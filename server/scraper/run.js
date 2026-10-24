// Spuštění scrapu: `npm run scrape [-- albert lidl ...]`
import { fileURLToPath } from 'node:url';
import { makeWriter, openDb, setMeta } from '../db.js';
import { DEFAULT_SHOPS, scrapeShop } from './kupi.js';
import { sleep, todayISO } from '../util.js';

let running = false;

export function isScraping() {
  return running;
}

export async function runScrape(db, shops = DEFAULT_SHOPS, log = console.log, { scrape = scrapeShop } = {}) {
  if (running) throw new Error('Scrape už běží');
  running = true;
  const writer = makeWriter(db);
  const seen = todayISO();
  const summary = {};
  try {
    for (const slug of shops) {
      try {
        const { deals, unknownValidity, error } = await scrape(slug, {
          onPage: (p) => log(`  ${slug} str. ${p.page}: +${p.added}`),
        });
        writer.tx(() => {
          const shopsDone = new Set();
          for (const d of deals) {
            if (!shopsDone.has(d.shop_slug)) {
              writer.shop({ slug: d.shop_slug, name: d.shop_name, logo_url: d.shop_logo });
              shopsDone.add(d.shop_slug);
            }
            const { shop_name, shop_logo, validity_text, ...row } = d;
            writer.deal({ ...row, seen });
          }
        });
        // obchod, který se přerušil uprostřed, uloží stažené stránky a pořád se bere jako chyba (zkusí se znovu)
        summary[slug] = error ? { deals: deals.length, unknownValidity, error } : { deals: deals.length, unknownValidity };
        log(error ? `${slug}: ${deals.length} akcí, ale přerušeno: ${error}` : `${slug}: ${deals.length} akcí (nerozpoznaná platnost: ${unknownValidity})`);
      } catch (e) {
        summary[slug] = { error: e.message };
        log(`${slug}: CHYBA ${e.message}`);
      }
    }
    // „hotovo“ se zapíše jen když se aspoň něco stáhlo; po výpadku sítě se tak server za chvíli zkusí znovu
    if (Object.values(summary).some((s) => !s.error)) setMeta(db, 'last_scrape', new Date().toISOString());
    setMeta(db, 'last_scrape_summary', JSON.stringify(summary));
  } finally {
    running = false;
  }
  return summary;
}

let retrying = null;

/**
 * Stažení s opakováním: obchody, které selhaly (výpadek sítě, spánek počítače), se po chvíli zkusí znovu.
 * Běží-li už jedno takové stahování, vrátí se jeho výsledek.
 */
export function runScrapeWithRetry(db, { shops = DEFAULT_SHOPS, log = console.log, scrape, retryMs = 10 * 60_000, maxRetries = 5, wait = sleep } = {}) {
  if (retrying) return retrying;
  retrying = (async () => {
    const summary = {};
    let todo = shops;
    let attempts = 0;
    for (;;) {
      attempts++;
      Object.assign(summary, await runScrape(db, todo, log, { scrape }));
      todo = Object.keys(summary).filter((s) => summary[s].error);
      if (!todo.length || attempts > maxRetries) break;
      log(`stahování: ${todo.length} obchodů selhalo, zkusím znovu za ${Math.round(retryMs / 60_000)} min`);
      await wait(retryMs);
    }
    return { summary, attempts };
  })().finally(() => { retrying = null; });
  return retrying;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const shops = args.length ? args : process.env.SHOPS?.split(',') ?? DEFAULT_SHOPS;
  const db = openDb();
  console.log(`Scrape: ${shops.join(', ')}`);
  const summary = await runScrape(db, shops);
  const total = Object.values(summary).reduce((a, s) => a + (s.deals ?? 0), 0);
  console.log(`Hotovo, celkem ${total} akcí.`);
}
