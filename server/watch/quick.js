// Rychlé obnovení dat jen pro hlídaná pravidla: místo stahování všech obchodů (asi 10 minut)
// se zeptá přímo na hlídaná slova a produkty (asi 1 až 2 sekundy na pravidlo).
import { makeWriter } from '../db.js';
import { fetchHtml, parseListing, parseProductPage, productUrl, searchUrl } from '../scraper/kupi.js';
import { sleep, todayISO } from '../util.js';
import { listRules } from './rules.js';

const MAX_REQUESTS = 20;

/** Adresy, které je potřeba stáhnout (stejný dotaz pro více pravidel se stáhne jen jednou). */
export function quickTargets(rules) {
  const seen = new Map();
  for (const r of rules.filter((x) => x.enabled)) {
    const key = `${r.kind}:${r.value}`;
    if (seen.has(key)) continue;
    seen.set(key, r.kind === 'keyword' ? { kind: 'search', url: searchUrl(r.value), word: r.value } : { kind: 'product', url: productUrl(r.value), slug: r.value });
  }
  return [...seen.values()].slice(0, MAX_REQUESTS);
}

/**
 * Stáhne a uloží aktuální akce pro hlídaná pravidla.
 * @returns {{ requested: number, ok: number, failed: number, deals: number }}
 */
export async function quickRefresh(db, { fetchPage = (u) => fetchHtml(u, { retries: 1 }), delayMs = 400, today = todayISO(), log = () => {} } = {}) {
  const targets = quickTargets(listRules(db));
  const writer = makeWriter(db);
  const out = { requested: targets.length, ok: 0, failed: 0, deals: 0 };

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    try {
      const html = await fetchPage(t.url);
      if (html == null) { // 404 = produkt už na kupi.cz není, není to chyba spojení
        out.ok++;
        continue;
      }
      const { deals } = t.kind === 'product' ? parseProductPage(html, t.slug, today) : parseListing(html, 'hledani', today);
      writer.tx(() => {
        const shopsDone = new Set();
        for (const d of deals) {
          if (!shopsDone.has(d.shop_slug)) {
            writer.shop({ slug: d.shop_slug, name: d.shop_name, logo_url: d.shop_logo });
            shopsDone.add(d.shop_slug);
          }
          const { shop_name, shop_logo, validity_text, ...row } = d;
          writer.deal({ ...row, seen: today });
        }
      });
      out.ok++;
      out.deals += deals.length;
    } catch (e) {
      out.failed++;
      log(`rychlá kontrola ${t.url}: ${e.message}`);
    }
    if (i < targets.length - 1) await sleep(delayMs);
  }
  return out;
}
