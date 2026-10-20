// Provede aktualizaci aplikace. Spouští ho server z kopie data/update/updater-run.mjs.
//   1. počká, až se server vypne
//   2. rozbalí stažený zip a zkontroluje ho
//   3. staré soubory aplikace přesune do zálohy a nové zkopíruje (data/ a node_modules/ se nikdy nemění)
//   4. když se změnily závislosti, spustí npm install
//   5. spustí server znovu a ověří, že běží nová verze; jinak vrátí zálohu a spustí původní verzi
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Tyto položky v kořeni aplikace se při aktualizaci nikdy nepřepisují ani nemažou. */
const KEEP = new Set(['data', 'node_modules', '.git']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function extractZip(zip, dest) {
  mkdirSync(dest, { recursive: true });
  const attempts = [];
  if (process.platform === 'win32') {
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'); // bsdtar umí zip, tar z Git Bash ne
    attempts.push(() => execFileSync(tar, ['-xf', zip, '-C', dest], { stdio: 'pipe', windowsHide: true }));
    const q = (s) => s.replace(/'/g, "''");
    attempts.push(() =>
      execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${q(zip)}' -DestinationPath '${q(dest)}' -Force`], { stdio: 'pipe', windowsHide: true }),
    );
  } else {
    attempts.push(() => execFileSync('unzip', ['-q', '-o', zip, '-d', dest], { stdio: 'pipe' }));
    attempts.push(() => execFileSync('tar', ['-xf', zip, '-C', dest], { stdio: 'pipe' }));
  }
  let last;
  for (const run of attempts) {
    try {
      run();
      return;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`Zip se nepodařilo rozbalit: ${last?.message ?? 'neznámá chyba'}`);
}

/** Zip z GitHubu obsahuje jednu složku (letackomat-vX.Y.Z/); vrátí cestu k ní. */
export function findSourceRoot(dir) {
  if (existsSync(join(dir, 'package.json'))) return dir;
  const subs = readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory());
  if (subs.length === 1) return join(dir, subs[0]);
  throw new Error('V zipu chybí složka s aplikací.');
}

export function verifySource(src, expectedVersion) {
  for (const f of ['package.json', 'server/index.js', 'web/index.html', 'scripts/launcher.js']) {
    if (!existsSync(join(src, f))) throw new Error(`V aktualizaci chybí soubor ${f}.`);
  }
  const version = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version;
  if (version !== expectedVersion) throw new Error(`Zip obsahuje verzi ${version}, čekala se ${expectedVersion}.`);
}

/** Přesun souboru nebo složky; na Windows občas na chvíli selže, když ho drží antivir. */
export async function movePath(from, to) {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      if (e.code === 'EXDEV') {
        cpSync(from, to, { recursive: true });
        rmSync(from, { recursive: true, force: true });
        return;
      }
      if (i >= 5) throw e;
      await sleep(400);
    }
  }
}

function dependenciesDiffer(oldPkgPath, newPkgPath, root) {
  if (!existsSync(join(root, 'node_modules'))) return true;
  try {
    const dep = (p) => JSON.stringify(JSON.parse(readFileSync(p, 'utf8')).dependencies ?? {});
    return dep(oldPkgPath) !== dep(newPkgPath);
  } catch {
    return true;
  }
}

/**
 * Hlavní logika. Vstupy závislé na systému (čekání na server, spuštění, npm) jsou předávané zvenku,
 * takže se výměna souborů a vracení zálohy dají testovat bez serveru.
 */
export async function applyUpdate(o) {
  const log = o.log ?? (() => {});
  const extract = o.extract ?? extractZip;
  const updateDir = join(o.root, 'data', 'update');
  const stamp = Date.now();
  const tmp = join(updateDir, `extract-${stamp}`);
  const backup = join(updateDir, `backup-${o.from}-${stamp}`);
  const moved = [];
  const copied = [];
  const writeResult = (r) => writeFileSync(join(updateDir, 'result.json'), JSON.stringify({ from: o.from, to: o.to, at: new Date().toISOString(), ...r }));

  try {
    log('čekám na vypnutí serveru');
    await o.waitDown();

    log('rozbaluji zip');
    extract(o.zip, tmp);
    const src = findSourceRoot(tmp);
    verifySource(src, o.to);

    const names = readdirSync(src).filter((n) => !KEEP.has(n));
    mkdirSync(backup, { recursive: true });
    log(`vyměňuji: ${names.join(', ')}`);
    for (const name of names) {
      const dst = join(o.root, name);
      if (existsSync(dst)) {
        await movePath(dst, join(backup, name));
        moved.push(name);
      }
    }
    for (const name of names) {
      cpSync(join(src, name), join(o.root, name), { recursive: true });
      copied.push(name);
    }

    if (dependenciesDiffer(join(backup, 'package.json'), join(o.root, 'package.json'), o.root)) {
      log('instaluji závislosti (npm install)');
      await o.installDeps(o.root);
    }

    log('spouštím server');
    await o.startServer();
    const running = await o.healthVersion();
    if (running !== o.to) throw new Error(`Po spuštění běží verze ${running ?? 'žádná'}, čekala se ${o.to}.`);

    writeResult({ ok: true });
    log(`hotovo, běží verze ${o.to}`);
    rmSync(tmp, { recursive: true, force: true });
    rmSync(o.zip, { force: true });
    pruneBackups(updateDir, backup);
    return { ok: true };
  } catch (e) {
    log(`chyba: ${e.message}; vracím původní verzi`);
    try {
      await o.stopServer?.();
      for (const name of copied) rmSync(join(o.root, name), { recursive: true, force: true });
      for (const name of moved) await movePath(join(backup, name), join(o.root, name));
      await o.startServer();
    } catch (e2) {
      log(`vrácení zálohy selhalo: ${e2.message}; záloha je ve ${backup}`);
    }
    writeResult({ ok: false, error: e.message });
    rmSync(tmp, { recursive: true, force: true });
    return { ok: false, error: e.message };
  }
}

/** Nechá jen nejnovější zálohu; ostatní zálohy a zbytky rozbalování smaže. */
function pruneBackups(updateDir, keep) {
  for (const n of readdirSync(updateDir)) {
    const p = join(updateDir, n);
    if ((n.startsWith('backup-') && p !== keep) || n.startsWith('extract-')) rmSync(p, { recursive: true, force: true });
  }
}

/* ——— spuštění jako samostatný proces ——— */
function args() {
  const a = process.argv.slice(2);
  const get = (k) => a[a.indexOf(`--${k}`) + 1];
  return { root: get('root'), zip: get('zip'), from: get('from'), to: get('to'), port: Number(get('port')) || 3000 };
}

async function main() {
  const { root, zip, from, to, port } = args();
  if (!root || !zip || !from || !to) throw new Error('Chybí parametry (--root --zip --from --to).');
  const updateDir = join(root, 'data', 'update');
  mkdirSync(updateDir, { recursive: true });
  const logFile = join(updateDir, 'update.log');
  const log = (m) => appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`);
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port) };
  const launcher = () => join(root, 'scripts', 'launcher.js');

  const health = async () => {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  };

  const result = await applyUpdate({
    root, zip, from, to, log,
    waitDown: async () => {
      for (let i = 0; i < 60; i++) {
        if (!(await health())) return;
        await sleep(500);
      }
      throw new Error('Server se nevypnul.');
    },
    startServer: async () => {
      const r = spawnSync(process.execPath, [launcher(), 'start', '--no-open'], { cwd: root, env, windowsHide: true, timeout: 60_000, encoding: 'utf8' });
      if (r.status !== 0) {
        log(`výstup spuštění: ${(r.stderr || r.stdout || '').trim().slice(-600)}`); // podrobnosti jen do logu
        throw new Error('Nová verze se nespustila.');
      }
    },
    stopServer: async () => {
      spawnSync(process.execPath, [launcher(), 'stop'], { cwd: root, env, windowsHide: true, timeout: 30_000 });
    },
    healthVersion: async () => (await health())?.version ?? null,
    installDeps: async (cwd) => {
      const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd, shell: true, windowsHide: true, timeout: 300_000, encoding: 'utf8' });
      if (r.status !== 0) {
        log(`výstup npm install: ${(r.stderr || r.stdout || '').trim().slice(-600)}`);
        throw new Error('Nepodařilo se nainstalovat závislosti (npm install).');
      }
    },
  });
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
