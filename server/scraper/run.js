// Spuštění scrapu: `npm run scrape [-- albert lidl ...]`
import { fileURLToPath } from 'node:url';
import { makeWriter, openDb, setMeta } from '../db.js';
import { DEFAULT_SHOPS, scrapeShop } from './kupi.js';
import { applySubcategories, subcategoriesStep } from './subcategories.js';
import { sleep, todayISO } from '../util.js';

let running = false;

export function isScraping() {
  return running;
}

const SHOP_NAMES = {
  'penny-market': 'Penny', coop: 'COOP', cba: 'CBA', jip: 'JIP', 'flop-top': 'Flop Top', 'eso-market': 'ESO Market',
  'dm-drogerie': 'dm drogerie', 'teta-drogerie': 'Teta drogerie', 'dr-max': 'Dr. Max',
};
const shopName = (slug) => SHOP_NAMES[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1);

const idle = () => ({ phase: 'idle', total: 0, done: 0, current: null, page: 0, deals: 0, failed: new Set(), retryAt: null });
let progress = idle();

/**
 * Průběh stahování pro ukazatel v aplikaci: kolik obchodů je hotových z kolika, který se právě stahuje,
 * kolik akcí už je a jestli se čeká na další pokus (`phase`: idle | running | waiting).
 */
export function scrapeProgress() {
  const { failed, ...rest } = progress;
  return { ...rest, failed: failed.size };
}

/**
 * `refreshSubs(db, log)` obnoví podkategorie z kupi.cz (když jsou staré); bez něj se jen doplní podkategorie
 * u akcí z dřívějšího mapování. Spouští se až po stažení obchodů, aby selhání podkategorií neshodilo akce.
 */
export async function runScrape(db, shops = DEFAULT_SHOPS, log = console.log, { scrape = scrapeShop, refreshSubs = null } = {}) {
  if (running) throw new Error('Scrape už běží');
  running = true;
  // samostatné stažení si průběh vede samo; při opakování ho vede obálka runScrapeWithRetry
  const ownProgress = progress.phase === 'idle';
  if (ownProgress) progress = { ...idle(), total: shops.length };
  progress.phase = 'running';
  progress.retryAt = null;
  const writer = makeWriter(db);
  const seen = todayISO();
  const summary = {};
  try {
    for (const slug of shops) {
      progress.current = shopName(slug);
      progress.page = 0;
      try {
        const { deals, unknownValidity, error } = await scrape(slug, {
          onPage: (p) => { progress.page = p.page; log(`  ${slug} str. ${p.page}: +${p.added}`); },
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
        progress.deals += deals.length;
        if (error) progress.failed.add(slug);
        else { progress.failed.delete(slug); progress.done++; }
        log(error ? `${slug}: ${deals.length} akcí, ale přerušeno: ${error}` : `${slug}: ${deals.length} akcí (nerozpoznaná platnost: ${unknownValidity})`);
      } catch (e) {
        summary[slug] = { error: e.message };
        progress.failed.add(slug);
        log(`${slug}: CHYBA ${e.message}`);
      }
    }
    // „hotovo“ se zapíše jen když se aspoň něco stáhlo; po výpadku sítě se tak server za chvíli zkusí znovu
    if (Object.values(summary).some((s) => !s.error)) setMeta(db, 'last_scrape', new Date().toISOString());
    applySubcategories(db);
    if (refreshSubs) {
      progress.current = 'Podkategorie';
      progress.page = 0;
      try {
        await refreshSubs(db, log);
      } catch (e) {
        log(`podkategorie: ${e.message}`);
      }
      applySubcategories(db);
    }
    setMeta(db, 'last_scrape_summary', JSON.stringify(summary));
  } finally {
    running = false;
    if (ownProgress) progress = idle();
    else progress.current = null;
  }
  return summary;
}

let retrying = null;

/**
 * Stažení s opakováním: obchody, které selhaly (výpadek sítě, spánek počítače), se po chvíli zkusí znovu.
 * Běží-li už jedno takové stahování, vrátí se jeho výsledek.
 */
export function runScrapeWithRetry(db, { shops = DEFAULT_SHOPS, log = console.log, scrape, refreshSubs = null, retryMs = 10 * 60_000, maxRetries = 5, wait = sleep } = {}) {
  if (retrying) return retrying;
  retrying = (async () => {
    const summary = {};
    let todo = shops;
    let attempts = 0;
    if (running) throw new Error('Scrape už běží'); // ruční stažení běží vlastním průběhem, ten se nepřepisuje
    progress = { ...idle(), phase: 'running', total: shops.length };
    try {
      for (;;) {
        attempts++;
        Object.assign(summary, await runScrape(db, todo, log, { scrape, refreshSubs }));
        todo = Object.keys(summary).filter((s) => summary[s].error);
        if (!todo.length || attempts > maxRetries) break;
        log(`stahování: ${todo.length} obchodů selhalo, zkusím znovu za ${Math.round(retryMs / 60_000)} min`);
        progress.phase = 'waiting';
        progress.retryAt = Date.now() + retryMs;
        await wait(retryMs);
      }
    } finally {
      progress = idle();
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
  const summary = await runScrape(db, shops, console.log, { refreshSubs: subcategoriesStep });
  const total = Object.values(summary).reduce((a, s) => a + (s.deals ?? 0), 0);
  console.log(`Hotovo, celkem ${total} akcí.`);
}
