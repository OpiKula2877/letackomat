// Otevření Letáčkomatu jako samostatného okna aplikace (bez adresního řádku a záložek).
// Edge i Chrome to umí přepínačem --app=ADRESA; okno má ikonu a název aplikace a v panelu úloh je jako jiný program.
// Když žádný z nich není k nalezení, otevře se adresa v běžném prohlížeči.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Cesty k Edge a Chrome v pořadí, v jakém se zkouší (Edge je ve Windows 10 a 11 vždy). */
export function browserCandidates(env = process.env) {
  const under = (dirs, sub) => dirs.filter(Boolean).map((d) => join(d, sub));
  const programs = [env['ProgramFiles(x86)'], env.ProgramFiles];
  return [
    ...under(programs, join('Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ...under([...programs, env.LOCALAPPDATA], join('Google', 'Chrome', 'Application', 'chrome.exe')),
  ];
}

/**
 * Příkaz, který otevře adresu jako okno aplikace; null, když se hodí jen běžný prohlížeč.
 * LETACKOMAT_BROWSER=tab vypne okno aplikace a vrátí starou záložku v prohlížeči.
 */
export function appWindowCommand(url, { env = process.env, exists = existsSync } = {}) {
  if (env.LETACKOMAT_BROWSER === 'tab') return null;
  const exe = browserCandidates(env).find((p) => exists(p));
  return exe ? { file: exe, args: [`--app=${url}`] } : null;
}

/** Otevře adresu jako okno aplikace, případně jako záložku v běžném prohlížeči. */
export function openApp(url) {
  const cmd = appWindowCommand(url);
  const child = cmd
    ? spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore' })
    : spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {}); // nepovedené otevření nesmí shodit launcher
  child.unref();
}
