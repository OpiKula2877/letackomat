// Přepočet ceny za jednotku z textu kupi.cz na srovnatelnou hodnotu (Kč za 1 kg / 1 l / 1 ks).

/**
 * "13,95 Kč / 100 g"  -> { kind: 'kg', price: 139.5 }
 * "31,80 Kč / 1 l"    -> { kind: 'l',  price: 31.8 }
 * "24,90 Kč / 1 ks"   -> { kind: 'ks', price: 24.9 }
 * Neznámá jednotka (m, cm, …) nebo nečitelný text -> null.
 */
export function parseUnitPrice(text) {
  const m = String(text ?? '')
    .replace(/ /g, ' ')
    .match(/^\s*(\d+(?:[.,]\d+)?)\s*Kč\s*\/\s*(\d+(?:[.,]\d+)?)?\s*(kg|g|ml|l|ks)\b/i);
  if (!m) return null;

  const price = Number(m[1].replace(',', '.'));
  const qty = m[2] ? Number(m[2].replace(',', '.')) : 1;
  if (!(qty > 0) || !Number.isFinite(price)) return null;

  const unit = m[3].toLowerCase();
  // kolik "základních jednotek" (kg, l, ks) je v uvedeném množství
  const base = { kg: ['kg', qty], g: ['kg', qty / 1000], l: ['l', qty], ml: ['l', qty / 1000], ks: ['ks', qty] }[unit];
  return { kind: base[0], price: Math.round((price / base[1]) * 100) / 100 };
}

export const UNIT_LABEL = { kg: 'kg', l: 'l', ks: 'ks' };
