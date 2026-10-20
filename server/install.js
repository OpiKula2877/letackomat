// Identifikace instalace: podle složky, ze které aplikace běží.
// start.bat díky tomu pozná, že na portu běží Letáčkomat z jiné složky (nebo ze starší verze), a nespletlo by si ho s touto kopií.
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Krátký otisk cesty ke složce (cesta samotná se ven neposílá). Stejný výpočet je v scripts/launcher.js. */
export function installId(root = rootDir) {
  return createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 10);
}
