// Převzetí dat ze starší instalace ze zipu při prvním spuštění aplikace nainstalované instalátorem.
// O staré instalaci ví Windows: ukazuje na ni skript po přihlášení (oznámení na pozadí) a tlačítko Spustit server.
import { existsSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { dataDir, isInstalled } from './paths.js';
import { rootDir } from './install.js';
import { readHandler, scriptPathOf } from './protocol.js';
import { installedRoot } from './watch/autostart.js';

/** Složky starších instalací, o kterých Windows ví. */
export async function legacyRoots({ read = readHandler } = {}) {
  const roots = new Set();
  const fromAutostart = installedRoot();
  if (fromAutostart) roots.add(fromAutostart);
  const script = scriptPathOf(await read().catch(() => null));
  if (script) roots.add(dirname(dirname(script))); // <složka>\scripts\start-hidden.vbs
  return [...roots];
}

const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

/**
 * Zkopíruje databázi (nákupní seznam, pravidla, stažené akce) ze starší instalace do datové složky instalátoru.
 * Dělá se jen u instalátorové varianty a jen když tam ještě žádná databáze není.
 * Kopie používá VACUUM INTO, takže je konzistentní, i kdyby ji stará aplikace měla právě otevřenou.
 * @returns {{status: 'skipped'|'exists'|'none'|'migrated', from?: string}}
 */
export async function migrateLegacyData({ root = rootDir, dest = dataDir({ root }), candidates, installed = isInstalled(root) } = {}) {
  if (!installed) return { status: 'skipped' };
  const destDb = join(dest, 'letackomat.db');
  if (existsSync(destDb)) return { status: 'exists' };
  for (const r of candidates ?? (await legacyRoots())) {
    if (same(r, root)) continue;
    const src = join(r, 'data', 'letackomat.db');
    if (!existsSync(src)) continue;
    mkdirSync(dest, { recursive: true });
    const db = new DatabaseSync(src, { readOnly: true });
    try {
      db.exec(`VACUUM INTO '${destDb.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
    return { status: 'migrated', from: r };
  }
  return { status: 'none' };
}
