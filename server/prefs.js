// Předvolby uložené v databázi: vybrané obchody. Platí i po restartu počítače a v každém okně nebo prohlížeči.
// Čtení je volné, zápis jen z tohoto počítače s hlavičkou X-Letackomat (viz server/local.js).
import { getMeta, setMeta } from './db.js';
import { isTrusted } from './local.js';

const SLUG = /^[a-z0-9-]{1,60}$/;
const MAX_SHOPS = 200;

/** Uložené předvolby; shops = null, když uživatel ještě nic nenastavil. */
export function readPrefs(db) {
  try {
    const saved = JSON.parse(getMeta(db, 'prefs') ?? 'null');
    return { shops: Array.isArray(saved?.shops) ? saved.shops : null };
  } catch {
    return { shops: null };
  }
}

export function registerPrefs(app, db) {
  app.get('/api/prefs', async () => readPrefs(db));

  app.put('/api/prefs', async (req, reply) => {
    if (!isTrusted(req)) return reply.code(403).send({ error: 'jen z tohoto počítače' });
    const shops = req.body?.shops;
    const valid = Array.isArray(shops) && shops.length <= MAX_SHOPS && shops.every((s) => typeof s === 'string' && SLUG.test(s));
    if (!valid) return reply.code(400).send({ error: 'shops musí být seznam slugů obchodů' });
    const prefs = { shops: [...new Set(shops)] };
    setMeta(db, 'prefs', JSON.stringify(prefs));
    return prefs;
  });
}
