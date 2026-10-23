// Upozornění: zapnutí/vypnutí, vyhodnocení pravidel po stažení dat a odeslání souhrnného Windows oznámení.
import { getMeta, setMeta } from '../db.js';
import { rootDir } from '../install.js';
import { todayISO } from '../util.js';
import { autostartInstalled, autostartSupported, disableAutostart, enableAutostart } from './autostart.js';
import { showToast, toastSetting } from './notifier.js';
import { markNotified, pendingMatches } from './rules.js';

const price = (n) => String(Math.round(n * 100) / 100).replace('.', ',');
const plural = (n, one, few, many) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many);

/**
 * Souhrn nových shod do jednoho oznámení.
 * Nadpis: "Jägermeister je ve slevě" / "5 hlídaných produktů ve slevě", dva řádky: nejlepší pravidla.
 */
export function buildDigest(pairs) {
  const byRule = new Map();
  for (const p of pairs) {
    if (!byRule.has(p.rule.id)) byRule.set(p.rule.id, { rule: p.rule, deals: [] });
    byRule.get(p.rule.id).deals.push(p.deal);
  }
  const groups = [...byRule.values()];
  const products = new Set(pairs.map((p) => p.deal.productSlug)).size;

  const describe = ({ rule, deals }) => {
    const cheapest = deals.reduce((a, b) => (b.priceSale < a.priceSale ? b : a));
    const more = deals.length - 1;
    const head = deals.length === 1 ? cheapest.name : rule.label;
    const tail = `${price(cheapest.priceSale)} Kč, ${cheapest.shop.name}${cheapest.discountPct ? `, −${cheapest.discountPct} %` : ''}`;
    return `${head}: ${deals.length === 1 ? '' : 'od '}${tail}${more > 0 ? ` (+${more})` : ''}`;
  };

  const title =
    pairs.length === 1
      ? `${pairs[0].deal.name} je ve slevě`
      : `${products} ${plural(products, 'hlídaný produkt', 'hlídané produkty', 'hlídaných produktů')} ve slevě`;
  const lines = groups.slice(0, 2).map(describe);
  if (groups.length > 2) lines[1] = `${lines[1]} …a další (${groups.length - 2})`;
  // jedno pravidlo = kliknutí otevře Upozornění a rovnou rozbalí jeho akce
  return { title, lines, ruleId: groups.length === 1 ? groups[0].rule.id : null };
}

export function createAlerts(db, { port = 3000, notify = showToast, setting = toastSetting, root = rootDir, today = todayISO, refresh = async () => ({}) } = {}) {
  const url = (hash = '') => `http://localhost:${port}/${hash}`;
  const enabled = () => getMeta(db, 'alerts_enabled') === '1';
  let running = false;

  async function run() {
    if (!enabled() || running) return { sent: 0, matches: 0 };
    running = true;
    try {
      const pairs = pendingMatches(db, today());
      setMeta(db, 'alerts_last_run', new Date().toISOString());
      if (!pairs.length) return { sent: 0, matches: 0 };
      const digest = buildDigest(pairs);
      const res = await notify({ title: digest.title, lines: digest.lines, url: url(digest.ruleId ? `#alerts/${digest.ruleId}` : '#alerts') });
      if (res.ok) {
        markNotified(db, pairs); // jen když se oznámení opravdu odeslalo, jinak se zkusí příště
        setMeta(db, 'alerts_last_sent', new Date().toISOString());
        return { sent: pairs.length, matches: pairs.length };
      }
      setMeta(db, 'alerts_last_error', String(res.error ?? 'neznámá chyba'));
      return { sent: 0, matches: pairs.length, error: res.error };
    } finally {
      running = false;
    }
  }

  async function setEnabled(value) {
    if (value) {
      if (autostartSupported()) enableAutostart(root); // selže-li, oznámení se nezapne napůl
      setMeta(db, 'alerts_enabled', '1');
    } else {
      setMeta(db, 'alerts_enabled', '0');
      disableAutostart();
    }
  }

  async function status({ withSetting = false } = {}) {
    return {
      enabled: enabled(),
      autostart: { supported: autostartSupported(), installed: autostartInstalled() },
      lastRun: getMeta(db, 'alerts_last_run'),
      lastSent: getMeta(db, 'alerts_last_sent'),
      lastError: getMeta(db, 'alerts_last_error'),
      windowsSetting: withSetting ? (await setting()).setting ?? null : undefined,
    };
  }

  const test = () =>
    notify({
      title: 'Letáčkomat: zkušební oznámení',
      lines: ['Takhle budou vypadat oznámení o slevách.', 'Kliknutím se otevře aplikace.'],
      url: url('#alerts'),
    });

  /** Obnoví data hlídaných pravidel a hned vyhodnotí (tlačítko Zkontrolovat teď). */
  async function check() {
    await refresh();
    return run();
  }

  return { run, check, setEnabled, status, test, enabled };
}
