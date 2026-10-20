// Spuštění aplikace na pozadí po přihlášení do Windows: jeden malý skript ve složce "Po spuštění".
// Vytváří se jen na výslovné zapnutí oznámení v aplikaci a zapnutím/vypnutím se mazat.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'Letackomat-na-pozadi.vbs';

export function startupDir() {
  return process.env.LETACKOMAT_STARTUP_DIR ?? join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export const autostartSupported = () => process.platform === 'win32' || Boolean(process.env.LETACKOMAT_STARTUP_DIR);
export const autostartFile = () => join(startupDir(), FILE);
export const autostartInstalled = () => existsSync(autostartFile());

const vbsString = (s) => `"${String(s).replace(/"/g, '""')}"`;

/** Obsah skriptu: spustí launcher skrytě v dané instalaci. */
export function buildAutostartScript(root) {
  return [
    "' Letáčkomat: spustí aplikaci na pozadí po přihlášení do Windows.",
    "' Vytvořeno zapnutím oznámení v aplikaci. Smaže se jejich vypnutím.",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = ${vbsString(root)}`,
    'shell.Run "cmd /c node scripts\\launcher.js start --no-open", 0, False',
    '',
  ].join('\r\n');
}

export function enableAutostart(root) {
  if (!autostartSupported()) throw new Error('Spouštění po přihlášení je jen pro Windows.');
  mkdirSync(startupDir(), { recursive: true });
  // UTF-16 s BOM: wscript tak přečte i cestu s českými znaky
  writeFileSync(autostartFile(), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(buildAutostartScript(root), 'utf16le')]));
}

export function disableAutostart() {
  rmSync(autostartFile(), { force: true });
}
