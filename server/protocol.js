// Tlačítko "Spustit server" používá adresu letackomat://start, kterou ve Windows zaregistroval install-start-button.bat.
// V registru je uložená celá cesta ke složce, takže po jejím přejmenování nebo přesunu přestane fungovat.
// Při startu serveru se proto cesta opraví, ale jen když původní cíl už neexistuje a jen když už registrace existuje.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const KEY = 'HKCU\\Software\\Classes\\letackomat\\shell\\open\\command';

export const expectedCommand = (root) => `wscript.exe "${join(root, 'scripts', 'start-hidden.vbs')}"`;

/** Cesta ke skriptu z příkazu uloženého v registru: wscript.exe "C:\...\start-hidden.vbs" */
export function scriptPathOf(command) {
  return /"([^"]+start-hidden\.vbs)"/i.exec(command ?? '')?.[1] ?? null;
}

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true, encoding: 'utf8', timeout: 10_000 }, (err, stdout) => resolve({ ok: !err, stdout: stdout ?? '' }));
  });
}

export async function readHandler(run = reg) {
  const r = await run(['query', KEY, '/ve']);
  if (!r.ok) return null;
  // výpis je lokalizovaný ("(Výchozí)"), proto se hledá jen řádek s typem REG_SZ
  return /REG_SZ\s+(.+?)\s*$/m.exec(r.stdout)?.[1] ?? null;
}

/** Opraví zastaralou cestu v registraci. Vrací { status: 'absent' | 'ok' | 'repaired' | 'failed' | 'unsupported' }. */
export async function repairProtocolHandler(root, { run = reg, platform = process.platform, exists = existsSync } = {}) {
  if (platform !== 'win32') return { status: 'unsupported' };
  const current = await readHandler(run);
  if (current === null) return { status: 'absent' }; // uživatel registraci nezapnul, nic se nevytváří
  const target = scriptPathOf(current);
  if (target && exists(target)) return { status: 'ok' };
  const done = await run(['add', KEY, '/ve', '/d', expectedCommand(root), '/f']);
  return done.ok ? { status: 'repaired', from: current } : { status: 'failed', from: current };
}
