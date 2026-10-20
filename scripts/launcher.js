// Spuštění a vypnutí serveru na pozadí (volají start.bat a end.bat).
//   node scripts/launcher.js start   – spustí server bez okna a otevře prohlížeč
//   node scripts/launcher.js stop    – vypne server
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 3000;
const base = `http://127.0.0.1:${port}`;
const pidFile = join(root, 'data', 'server.pid');
const logFile = join(root, 'data', 'server.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Odpověď /api/health běžícího serveru, nebo null, když na portu nic neodpovídá. */
async function healthInfo() {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.json().catch(() => ({})) : null;
  } catch {
    return null;
  }
}

async function health() {
  return (await healthInfo()) !== null;
}

/** Otisk této složky, stejný výpočet jako server/install.js. */
const myInstallId = createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 10);

/** Požádá běžící server o vypnutí a počká, až přestane odpovídat. */
async function requestShutdown() {
  try {
    const res = await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'x-letackomat': '1' }, signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`Slušné vypnutí selhalo (${e.message}).`);
    return false;
  }
  return waitFor(async () => !(await health()), 8000);
}

async function waitFor(predicate, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await sleep(250);
  }
  return false;
}

function tail(file, bytes = 1500) {
  try {
    const size = statSync(file).size;
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(bytes, size));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

const noOpen = process.argv.includes('--no-open');

function openBrowser(url) {
  if (noOpen) return;
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function start() {
  const running = await healthInfo();
  if (running && running.installId === myInstallId) {
    console.log(`Letáčkomat už běží na ${base.replace('127.0.0.1', 'localhost')}`);
    openBrowser(`http://localhost:${port}`);
    return 0;
  }
  if (running) {
    // na portu běží Letáčkomat z jiné složky (nebo starší verze bez otisku); otevřel by se tedy ne ten, který chceš spustit
    console.log('Na tomhle portu už běží Letáčkomat z jiné složky nebo ze starší verze. Vypínám ho a spouštím tuto kopii...');
    if (!(await requestShutdown())) {
      console.error('Nepodařilo se ho vypnout. Zavři ho (end.bat v jeho složce) a spusť start.bat znovu.');
      return 1;
    }
  }
  mkdirSync(dirname(logFile), { recursive: true });
  const log = openSync(logFile, 'a');
  const child = spawn(process.execPath, [join(root, 'server', 'index.js')], {
    cwd: root,
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: { ...process.env, PORT: String(port) },
  });
  child.unref();

  console.log('Spouštím server na pozadí...');
  if (!(await waitFor(health, 20_000))) {
    console.error('Server se nespustil. Poslední řádky logu (data/server.log):\n');
    console.error(tail(logFile));
    return 1;
  }
  console.log(`Hotovo, běží na http://localhost:${port}`);
  console.log('Vypnout ho jde přes end.bat nebo tlačítkem Vypnout v aplikaci.');
  openBrowser(`http://localhost:${port}`);
  return 0;
}

/** Je proces s tímto PID opravdu náš server? (aby se nikdy nezabil cizí proces se starým PID) */
function isOurServer(pid) {
  try {
    const cmd = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`],
      { encoding: 'utf8', windowsHide: true },
    );
    return /server[\\/]+index\.js/i.test(cmd);
  } catch {
    return false;
  }
}

async function stop() {
  if (await health()) {
    if (await requestShutdown()) {
      rmSync(pidFile, { force: true });
      console.log('Server je vypnutý.');
      return 0;
    }
  }

  // nouzově podle PID, ale jen když to opravdu je náš server
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    if (pid && isOurServer(pid)) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        rmSync(pidFile, { force: true });
        console.log('Server byl ukončen násilím.');
        return 0;
      } catch {
        console.error('Server se nepodařilo ukončit.');
        return 1;
      }
    }
    rmSync(pidFile, { force: true });
  }
  console.log('Server neběží.');
  return 0;
}

const cmd = process.argv[2];
if (cmd !== 'start' && cmd !== 'stop') {
  console.error('Použití: node scripts/launcher.js start|stop');
  process.exit(2);
}
process.exit(await (cmd === 'start' ? start() : stop()));
