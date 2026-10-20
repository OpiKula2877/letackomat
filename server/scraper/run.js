// Spuštění scrapu: `npm run scrape [-- albert lidl ...]`
import { fileURLToPath } from 'node:url';
import { makeWriter, openDb, setMeta } from '../db.js';
import { DEFAULT_SHOPS, scrapeShop } from './kupi.js';
import { todayISO } from '../util.js';

let running = false;

export function isScraping() {
  return running;
}

export async function runScrape(db, shops = DEFAULT_SHOPS, log = console.log) {
  if (running) throw new Error('Scrape už běží');
  running = true;
  const writer = makeWriter(db);
  const seen = todayISO();
  const summary = {};
  try {
    for (const slug of shops) {
      try {
        const { deals, unknownValidity } = await scrapeShop(slug, {
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
        summary[slug] = { deals: deals.length, unknownValidity };
        log(`${slug}: ${deals.length} akcí (nerozpoznaná platnost: ${unknownValidity})`);
      } catch (e) {
        summary[slug] = { error: e.message };
        log(`${slug}: CHYBA ${e.message}`);
      }
    }
    setMeta(db, 'last_scrape', new Date().toISOString());
    setMeta(db, 'last_scrape_summary', JSON.stringify(summary));
  } finally {
    running = false;
  }
  return summary;
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
