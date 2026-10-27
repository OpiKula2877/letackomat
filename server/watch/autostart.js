// Spuštění aplikace na pozadí po přihlášení do Windows: jeden malý skript ve složce "Po spuštění".
// Vytváří se jen na výslovné zapnutí oznámení v aplikaci a zapnutím/vypnutím se mazat.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'Letackomat-na-pozadi.vbs';

export function startupDir() {
  return process.env.LETACKOMAT_STARTUP_DIR ?? join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export const autostartSupported = () => process.platform === 'win32' || Boolean(process.env.LETACKOMAT_STARTUP_DIR);

/**
 * Zástupce, který Edge vytvoří u webové aplikace se spuštěním po přihlášení: pak se při každém přihlášení
 * otevře okno Letáčkomat (i když server běží na pozadí). Vrací jména souborů, prázdné pole = nic.
 */
export function browserLoginShortcuts() {
  if (!autostartSupported()) return [];
  let names;
  try {
    names = readdirSync(startupDir());
  } catch {
    return [];
  }
  // zástupce ukládá argumenty v UTF-16, starší v jednobajtovém kódování; hledáme obojí
  const needles = [Buffer.from('app-run-on-os-login', 'utf16le'), Buffer.from('app-run-on-os-login', 'latin1')];
  return names.filter((name) => {
    if (!name.toLowerCase().endsWith('.lnk') || !/letáčkomat|letackomat/i.test(name)) return false;
    const bytes = readFileSync(join(startupDir(), name));
    return needles.some((needle) => bytes.includes(needle));
  });
}
export const autostartFile = () => join(startupDir(), FILE);
export const autostartInstalled = () => existsSync(autostartFile());

const vbsString = (s) => `"${String(s).replace(/"/g, '""')}"`;

/**
 * Obsah skriptu: spustí launcher skrytě v dané instalaci.
 * Používá celou cestu k node.exe, protože po přihlášení do Windows nemusí být node v PATH
 * (a u instalátoru je node.exe přibalený vedle aplikace).
 */
export function buildAutostartScript(root, nodePath = process.execPath) {
  return [
    "' Letáčkomat: spustí aplikaci na pozadí po přihlášení do Windows.",
    "' Vytvořeno zapnutím oznámení v aplikaci. Smaže se jejich vypnutím.",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = ${vbsString(root)}`,
    `shell.Run Chr(34) & ${vbsString(nodePath)} & Chr(34) & " scripts\\launcher.js start --no-open", 0, False`,
    '',
  ].join('\r\n');
}

export function enableAutostart(root, nodePath = process.execPath) {
  if (!autostartSupported()) throw new Error('Spouštění po přihlášení je jen pro Windows.');
  mkdirSync(startupDir(), { recursive: true });
  // UTF-16 s BOM: wscript tak přečte i cestu s českými znaky
  writeFileSync(autostartFile(), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(buildAutostartScript(root, nodePath), 'utf16le')]));
}

export function disableAutostart() {
  rmSync(autostartFile(), { force: true });
}

function readScript() {
  try {
    const raw = readFileSync(autostartFile());
    return raw.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) ? raw.subarray(2).toString('utf16le') : raw.toString('utf8');
  } catch {
    return null;
  }
}

const unquote = (s) => s.replace(/""/g, '"');

/** Složka, na kterou ukazuje nainstalovaný skript (z řádku shell.CurrentDirectory). */
export function installedRoot() {
  const m = /shell\.CurrentDirectory = "((?:[^"]|"")*)"/.exec(readScript() ?? '');
  return m ? unquote(m[1]) : null;
}

/** Cesta k node.exe uložená ve skriptu (starší skripty ji nemají a spoléhají na PATH). */
export function installedNode() {
  const m = /shell\.Run Chr\(34\) & "((?:[^"]|"")*)" & Chr\(34\)/.exec(readScript() ?? '');
  return m ? unquote(m[1]) : null;
}

/**
 * Po přejmenování nebo přesunu složky aplikace (nebo po instalaci jinam) ukazuje skript po přihlášení do prázdna.
 * Při startu serveru se proto přepíše na aktuální umístění, ale jen když to původní už neexistuje.
 */
export function repairAutostart(root, nodePath = process.execPath) {
  if (!autostartSupported() || !autostartInstalled()) return 'absent';
  const old = installedRoot();
  const node = installedNode();
  const rootOk = old && existsSync(join(old, 'scripts', 'launcher.js'));
  const nodeOk = node === null || existsSync(node);
  if (rootOk && nodeOk) return 'ok';
  enableAutostart(root, nodePath);
  return 'repaired';
}
