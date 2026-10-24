// Sestaví instalátor Letáčkomatu: dist/Letackomat-Setup-<verze>.exe
//   node scripts/build-installer.js                 (verze z package.json)
//   node scripts/build-installer.js --version 9.9.9 (zkušební sestavení, verze se přepíše i v balíčku)
//   node scripts/build-installer.js --out C:\jina\slozka
// Potřebuje Inno Setup 6 (winget install JRSoftware.InnoSetup) a Node.js, jehož node.exe se přibalí.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = arg('version') ?? pkg.version;
const outDir = resolve(arg('out') ?? join(root, 'dist'));
const stage = join(outDir, `stage-${version}`);

function findIscc() {
  const candidates = [
    process.env.ISCC,
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    join(process.env.ProgramFiles ?? '', 'Inno Setup 6', 'ISCC.exe'),
    join(process.env['ProgramFiles(x86)'] ?? '', 'Inno Setup 6', 'ISCC.exe'),
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Nenašel jsem Inno Setup (ISCC.exe). Nainstaluj ho: winget install JRSoftware.InnoSetup');
  return found;
}

console.log(`Letáčkomat ${version}: sestavuji instalátor`);

/** Připraví složku s aplikací, node.exe a produkčními závislostmi (to, co instalátor zabalí). */
function prepareStage() {
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// 1) soubory aplikace (bez testů, dat a vývojových věcí)
for (const d of ['server', 'web', 'scripts']) cpSync(join(root, d), join(stage, d), { recursive: true });
for (const f of ['package.json', 'package-lock.json', 'LICENSE', 'README.md']) copyFileSync(join(root, f), join(stage, f));
if (arg('version')) {
  const p = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'));
  p.version = version; // zkušební sestavení hlásí vlastní verzi
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(p, null, 2)}\n`);
}
if (!existsSync(join(stage, 'web', 'icons', 'icon.ico'))) throw new Error('Chybí web/icons/icon.ico, spusť node scripts/make-icons.js');

// 2) jen produkční závislosti podle package-lock.json
console.log('instaluji závislosti (npm ci --omit=dev)');
const npm = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, shell: true, stdio: 'inherit' });
if (npm.status !== 0) throw new Error('npm ci selhal');

// 3) Node.js: přesně ten node.exe, který sestavení spouští, aby uživatel nemusel nic instalovat
copyFileSync(process.execPath, join(stage, 'node.exe'));
const nodeLicense = join(dirname(process.execPath), 'LICENSE');
if (existsSync(nodeLicense)) copyFileSync(nodeLicense, join(stage, 'NODE-LICENSE.txt'));
else writeFileSync(join(stage, 'NODE-LICENSE.txt'), `Přibalený node.exe je Node.js ${process.version} (licence MIT, https://github.com/nodejs/node/blob/main/LICENSE).\n`);

// 4) příznak, podle kterého aplikace pozná, že je z instalátoru (data jdou do %LocalAppData%\Letackomat)
writeFileSync(join(stage, 'installed.flag'), `Nainstalovano instalatorem. Data: %LocalAppData%\\Letackomat\n`);
}

// --reuse-stage přeskočí pomalé npm ci, když už stage existuje (při ladění instalátoru)
if (process.argv.includes('--reuse-stage') && existsSync(join(stage, 'installed.flag'))) console.log('používám existující stage');
else prepareStage();

// 5) Inno Setup
const iscc = findIscc();
mkdirSync(outDir, { recursive: true });
console.log(`kompiluji (${iscc})`);
const numVersion = `${/^\d+\.\d+\.\d+/.exec(version)?.[0] ?? '0.0.0'}.0`; // Windows chce čtyři čísla
const fast = process.argv.includes('--fast'); // rychlé sestavení na zkoušky (větší soubor, kompilace pár sekund)
execFileSync(iscc, [...(fast ? ['/DFast=1'] : []), `/DAppVersion=${version}`, `/DNumVersion=${numVersion}`, `/DStageDir=${stage}`, `/DOutDir=${outDir}`, '/Qp', join(root, 'installer', 'letackomat.iss')], { stdio: 'inherit' });

const exe = join(outDir, `Letackomat-Setup-${version}.exe`);
const bytes = readFileSync(exe);
console.log(`\nHotovo: ${exe}`);
console.log(`velikost: ${(statSync(exe).size / 1024 / 1024).toFixed(1)} MB`);
console.log(`sha256:   ${createHash('sha256').update(bytes).digest('hex')}`);
if (!arg('keep-stage') && !process.argv.includes('--keep-stage') && !process.argv.includes('--reuse-stage')) rmSync(stage, { recursive: true, force: true });
