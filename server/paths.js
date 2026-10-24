// Kde má aplikace data (databáze, log, soubory aktualizace).
//  - ze zipu / z gitu: složka data/ vedle aplikace (přenosná varianta)
//  - z instalátoru (soubor installed.flag v kořeni): %LocalAppData%\Letackomat, protože do C:\Program Files
//    běžný uživatel zapisovat nesmí
//  - proměnná LETACKOMAT_DATA přebije obojí
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { rootDir } from './install.js';

export const installedFlagFile = (root = rootDir) => join(root, 'installed.flag');

/** Aplikace byla nainstalována instalátorem (a ne rozbalena ze zipu). */
export const isInstalled = (root = rootDir) => existsSync(installedFlagFile(root));

export function dataDir({ root = rootDir, env = process.env } = {}) {
  if (env.LETACKOMAT_DATA) return resolve(env.LETACKOMAT_DATA);
  if (isInstalled(root)) return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Letackomat');
  return join(root, 'data');
}
