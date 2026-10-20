// Sdilene pomocne funkce: datumy v Europe/Prague, normalizace textu.

const TZ = 'Europe/Prague';

/** Dnesni datum jako YYYY-MM-DD v pražském čase. */
export function todayISO(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(now);
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isISODate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/** Malá písmena bez diakritiky – pro vyhledávání ("sunka" najde "Šunka"). */
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** "24,90 Kč" -> 24.9 */
export function parseCzNumber(s) {
  if (s == null) return null;
  const m = String(s).replace(/ |\s/g, '').match(/-?\d+(?:[.,]\d+)?/);
  return m ? Number(m[0].replace(',', '.')) : null;
}

function iso(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Rok pro den/měsíc tak, aby datum bylo nejblíž dnešku (±~6 měsíců). */
function resolveYear(day, month, todayStr) {
  const [ty] = todayStr.split('-').map(Number);
  const today = Date.parse(`${todayStr}T12:00:00Z`);
  let best = null;
  for (const y of [ty - 1, ty, ty + 1]) {
    const t = Date.parse(`${iso(y, month, day)}T12:00:00Z`);
    if (best === null || Math.abs(t - today) < Math.abs(best.t - today)) best = { y, t };
  }
  return best.y;
}

/**
 * Parsuje text platnosti z kupi.cz do {from, to}.
 * Podporované tvary:
 *   "st 21. 10. – út 27. 10."   -> od-do
 *   "platí do úterý 27. 10."    -> jen do
 *   "platí od čtvrtka 22. 10."  -> jen od
 *   "dnes končí" / "zítra končí"
 * Nerozpoznané -> {from:null,to:null,unknown:true}
 */
export function parseValidity(text, todayStr = todayISO()) {
  const t = String(text ?? '')
    .replace(/&nbsp;|&ndash;| /g, (m) => (m === '&ndash;' ? '–' : ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (!t) return { from: null, to: null, unknown: true };
  if (/dnes končí/.test(t)) return { from: null, to: todayStr };
  if (/zítra končí/.test(t)) return { from: null, to: addDays(todayStr, 1) };
  if (/pozítří končí/.test(t)) return { from: null, to: addDays(todayStr, 2) };

  const dates = [...t.matchAll(/(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(\d{4}))?/g)].map((m) => {
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = m[3] ? Number(m[3]) : resolveYear(day, month, todayStr);
    return iso(year, month, day);
  });

  if (dates.length >= 2) return { from: dates[0], to: dates[1] };
  if (dates.length === 1) {
    if (/\bod\b/.test(t) && !/\bdo\b/.test(t)) return { from: dates[0], to: null };
    return { from: null, to: dates[0] };
  }
  return { from: null, to: null, unknown: true };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
