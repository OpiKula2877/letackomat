import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.js';
import { buildApp } from '../server/index.js';
import { compareVersions, createUpdateService, parseRelease, repoFromPackage } from '../server/update.js';
import { applyUpdate, findSourceRoot, verifySource } from '../scripts/updater.js';

const REPO_URL = 'git+https://github.com/Owner/letackomat.git';

function tempRoot(version = '1.0.0', { git = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'letackomat-test-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'letackomat', version, repository: { type: 'git', url: REPO_URL } }));
  if (git) mkdirSync(join(root, '.git'));
  return root;
}

const release = (version, extra = {}) => ({
  tag_name: `v${version}`,
  name: `Letáčkomat ${version}`,
  body: '- něco nového',
  html_url: `https://github.com/Owner/letackomat/releases/tag/v${version}`,
  draft: false,
  prerelease: false,
  assets: [
    {
      name: `letackomat-v${version}.zip`,
      state: 'uploaded',
      size: 4,
      browser_download_url: `https://github.com/Owner/letackomat/releases/download/v${version}/letackomat-v${version}.zip`,
      digest: `sha256:${createHash('sha256').update('PK\x03\x04').digest('hex')}`,
    },
  ],
  ...extra,
});

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('compareVersions: číselné porovnání verzí', () => {
  assert.equal(compareVersions('1.2.0', '1.1.9'), 1);
  assert.equal(compareVersions('1.0.2', '1.0.10'), -1); // 10 je víc než 2, ne textově
  assert.equal(compareVersions('v1.0.3', '1.0.3'), 0);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('blbost', '1.0.0'), 0);
});

test('repoFromPackage a parseRelease', () => {
  assert.deepEqual(repoFromPackage({ repository: { url: REPO_URL } }), { owner: 'Owner', repo: 'letackomat' });
  assert.deepEqual(repoFromPackage({ repository: 'https://github.com/a/b' }), { owner: 'a', repo: 'b' });
  assert.equal(repoFromPackage({}), null);

  const r = parseRelease(release('1.2.0'));
  assert.equal(r.version, '1.2.0');
  assert.equal(r.asset.name, 'letackomat-v1.2.0.zip');
  assert.match(r.asset.sha256, /^[0-9a-f]{64}$/);
  assert.equal(parseRelease(release('1.2.0', { draft: true })), null);
  assert.equal(parseRelease(release('1.2.0', { prerelease: true })), null);
  assert.equal(parseRelease(release('x')), null);
  assert.equal(parseRelease(release('1.2.0', { assets: [{ name: 'jine.zip' }] })).asset, null);
});

test('kontrola aktualizací: novější verze, cache, chyby a vynucení', async () => {
  const root = tempRoot('1.0.0');
  let calls = 0;
  let next = () => jsonResponse(release('1.0.1'));
  const svc = createUpdateService(openDb(':memory:'), { rootDir: root, fetch: async () => { calls++; return next(); } });

  await svc.check();
  let st = svc.status();
  assert.equal(st.available, true);
  assert.equal(st.latest, '1.0.1');
  assert.equal(st.canApply, true);
  assert.equal(st.current, '1.0.0');

  await svc.check(); // z cache
  assert.equal(calls, 1);
  await svc.check({ force: true });
  assert.equal(calls, 2);

  // stejná nebo starší verze na GitHubu = žádná aktualizace
  next = () => jsonResponse(release('1.0.0'));
  await svc.check({ force: true });
  assert.equal(svc.status().available, false);

  // bez internetu: nic se nerozbije a poslední známá verze zůstane
  next = () => jsonResponse(release('1.0.5'));
  await svc.check({ force: true });
  next = () => { throw new Error('offline'); };
  await svc.check({ force: true });
  st = svc.status();
  assert.equal(st.error, 'offline');
  assert.equal(st.latest, '1.0.5');
  assert.equal(st.available, true);

  // repo bez releasů
  const none = createUpdateService(openDb(':memory:'), { rootDir: root, fetch: async () => jsonResponse({}, 404) });
  await none.check();
  assert.equal(none.status().available, false);
  assert.equal(none.status().error, null);
  rmSync(root, { recursive: true, force: true });
});

test('aktualizace se nenabízí k automatické instalaci u git klonu ani bez zipu', async () => {
  const gitRoot = tempRoot('1.0.0', { git: true });
  const svc = createUpdateService(openDb(':memory:'), { rootDir: gitRoot, fetch: async () => jsonResponse(release('1.0.1')) });
  await svc.check();
  assert.equal(svc.status().available, true);
  assert.equal(svc.status().canApply, false);
  assert.equal(svc.status().reason, 'git');
  await assert.rejects(() => svc.startApply(), /git pull/);

  const root = tempRoot('1.0.0');
  const noZip = createUpdateService(openDb(':memory:'), { rootDir: root, fetch: async () => jsonResponse(release('1.0.1', { assets: [] })) });
  await noZip.check();
  assert.equal(noZip.status().reason, 'no-asset');
  rmSync(gitRoot, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test('stažení aktualizace se odmítne při špatném součtu, velikosti, obsahu nebo adrese', async () => {
  const root = tempRoot('1.0.0');
  const make = (rel, bytes) =>
    createUpdateService(openDb(':memory:'), {
      rootDir: root,
      fetch: async (url) => (String(url).includes('/releases/latest') ? jsonResponse(rel) : new Response(bytes)),
    });

  // kontrolní součet nesedí (velikost 4 B sedí)
  await assert.rejects(() => make(release('1.0.1'), Buffer.from('PKxx')).startApply(), /Kontrolní součet/);
  // špatná velikost
  await assert.rejects(() => make(release('1.0.1'), Buffer.from('PK')).startApply(), /neúplný/);
  // není zip
  const notZip = release('1.0.1');
  notZip.assets[0].digest = null;
  await assert.rejects(() => make(notZip, Buffer.from('ABCD')).startApply(), /není zip/);
  // cizí adresa
  const foreign = release('1.0.1');
  foreign.assets[0].browser_download_url = 'https://evil.example.com/letackomat-v1.0.1.zip';
  await assert.rejects(() => make(foreign, Buffer.from('PK\x03\x04')).startApply(), /není z tohoto repozitáře/);
  assert.equal(existsSync(join(root, 'data', 'update')), false); // nic se na disk nezapsalo
  rmSync(root, { recursive: true, force: true });
});

test('API aktualizace: stav, ochrana tlačítka a spuštění', async () => {
  const db = openDb(':memory:');
  const local = { host: 'localhost:3000' };
  const trusted = { ...local, 'x-letackomat': '1' };

  // bez služby (testy, vypnuto): nic se neděje
  const plain = buildApp(db);
  assert.equal((await plain.inject({ url: '/api/update', headers: local })).json().enabled, false);
  assert.equal((await plain.inject({ method: 'POST', url: '/api/update/apply', headers: trusted })).statusCode, 501);
  assert.match((await plain.inject({ url: '/api/health', headers: local })).json().version, /^\d+\.\d+\.\d+$/);
  await plain.close();

  let applied = 0;
  let stopped = 0;
  const fake = {
    check: async () => {},
    status: () => ({ enabled: true, current: '1.0.0', available: true, latest: '1.0.1' }),
    startApply: async () => { applied++; return { version: '1.0.1' }; },
  };
  const app = buildApp(db, { onShutdown: () => { stopped++; }, update: fake });
  assert.equal((await app.inject({ url: '/api/update', headers: local })).json().latest, '1.0.1');
  assert.equal((await app.inject({ method: 'POST', url: '/api/update/apply', headers: local })).statusCode, 403); // chybí hlavička
  assert.equal((await app.inject({ method: 'POST', url: '/api/update/apply', headers: { ...trusted, host: 'evil.example.com' } })).statusCode, 403);
  assert.equal(applied, 0);
  const ok = await app.inject({ method: 'POST', url: '/api/update/apply', headers: trusted });
  assert.equal(ok.statusCode, 202);
  assert.equal(ok.json().version, '1.0.1');
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(applied, 1);
  assert.equal(stopped, 1); // server se vypne, aby updater mohl vyměnit soubory
  await app.close();

  // chyba při stahování se vrátí uživateli a server se nevypne
  let stopped2 = 0;
  const failing = buildApp(db, {
    onShutdown: () => { stopped2++; },
    update: { ...fake, startApply: async () => { throw Object.assign(new Error('Stažení selhalo (500).'), { code: 502 }); } },
  });
  const bad = await failing.inject({ method: 'POST', url: '/api/update/apply', headers: trusted });
  assert.equal(bad.statusCode, 502);
  assert.match(bad.json().error, /Stažení selhalo/);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(stopped2, 0);
  await failing.close();
});

/* ——— updater: výměna souborů a vrácení zálohy (bez serveru a bez zipu) ——— */

function installDir(version) {
  const root = tempRoot(version);
  mkdirSync(join(root, 'server'));
  writeFileSync(join(root, 'server', 'index.js'), `// ${version}`);
  writeFileSync(join(root, 'server', 'stary-soubor.js'), 'smazat');
  mkdirSync(join(root, 'web'));
  writeFileSync(join(root, 'web', 'index.html'), `<!-- ${version} -->`);
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts', 'launcher.js'), '//');
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data', 'letackomat.db'), 'MOJE DATA');
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
  return root;
}

function newVersionDir(version) {
  const dir = mkdtempSync(join(tmpdir(), 'letackomat-new-'));
  const top = join(dir, `letackomat-v${version}`);
  mkdirSync(join(top, 'server'), { recursive: true });
  writeFileSync(join(top, 'package.json'), JSON.stringify({ name: 'letackomat', version, dependencies: {} }));
  writeFileSync(join(top, 'server', 'index.js'), `// ${version}`);
  writeFileSync(join(top, 'server', 'novy-soubor.js'), 'nový');
  mkdirSync(join(top, 'web'));
  writeFileSync(join(top, 'web', 'index.html'), `<!-- ${version} -->`);
  mkdirSync(join(top, 'scripts'));
  writeFileSync(join(top, 'scripts', 'launcher.js'), '//');
  return dir;
}

function fakes(root, { newDir, runningVersion, startFails = false }) {
  const calls = [];
  return {
    calls,
    opts: {
      root,
      zip: join(root, 'data', 'update', 'x.zip'),
      from: '1.0.0',
      to: '1.0.1',
      log: (m) => calls.push(m),
      extract: (_zip, dest) => cpSync(newDir, dest, { recursive: true }), // místo rozbalení zipu
      waitDown: async () => calls.push('down'),
      startServer: async () => { calls.push('start'); if (startFails && calls.filter((c) => c === 'start').length === 1) throw new Error('nespustilo se'); },
      stopServer: async () => calls.push('stop'),
      healthVersion: async () => runningVersion,
      installDeps: async () => calls.push('npm'),
    },
  };
}

test('updater: vymění soubory aplikace, data zůstanou, staré soubory zmizí, záloha se uloží', async () => {
  const root = installDir('1.0.0');
  mkdirSync(join(root, 'data', 'update'), { recursive: true });
  const { opts, calls } = fakes(root, { newDir: newVersionDir('1.0.1'), runningVersion: '1.0.1' });

  const r = await applyUpdate(opts);
  assert.equal(r.ok, true);
  assert.equal(readFileSync(join(root, 'server', 'index.js'), 'utf8'), '// 1.0.1');
  assert.equal(existsSync(join(root, 'server', 'novy-soubor.js')), true);
  assert.equal(existsSync(join(root, 'server', 'stary-soubor.js')), false); // složka se vyměňuje celá
  assert.equal(readFileSync(join(root, 'data', 'letackomat.db'), 'utf8'), 'MOJE DATA');
  assert.equal(existsSync(join(root, 'node_modules', 'x')), true);
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '1.0.1');
  assert.equal(JSON.parse(readFileSync(join(root, 'data', 'update', 'result.json'), 'utf8')).ok, true);
  assert.ok(readdirSync(join(root, 'data', 'update')).some((n) => n.startsWith('backup-1.0.0')));
  assert.deepEqual(calls.filter((c) => ['down', 'start', 'npm'].includes(c)), ['down', 'start']); // závislosti stejné, npm netřeba
  rmSync(root, { recursive: true, force: true });
});

test('updater: při změně závislostí spustí npm install', async () => {
  const root = installDir('1.0.0');
  mkdirSync(join(root, 'data', 'update'), { recursive: true });
  const newDir = newVersionDir('1.0.1');
  const pkgPath = join(newDir, 'letackomat-v1.0.1', 'package.json');
  writeFileSync(pkgPath, JSON.stringify({ name: 'letackomat', version: '1.0.1', dependencies: { nova: '^1.0.0' } }));
  const { opts, calls } = fakes(root, { newDir, runningVersion: '1.0.1' });
  assert.equal((await applyUpdate(opts)).ok, true);
  assert.ok(calls.includes('npm'));
  rmSync(root, { recursive: true, force: true });
});

test('updater: když po aktualizaci neběží nová verze, vrátí původní soubory a spustí starou verzi', async () => {
  const root = installDir('1.0.0');
  mkdirSync(join(root, 'data', 'update'), { recursive: true });
  const { opts, calls } = fakes(root, { newDir: newVersionDir('1.0.1'), runningVersion: '1.0.0' }); // pořád běží stará
  const r = await applyUpdate(opts);
  assert.equal(r.ok, false);
  assert.match(r.error, /Po spuštění běží verze 1\.0\.0/);
  assert.equal(readFileSync(join(root, 'server', 'index.js'), 'utf8'), '// 1.0.0');
  assert.equal(existsSync(join(root, 'server', 'novy-soubor.js')), false);
  assert.equal(existsSync(join(root, 'server', 'stary-soubor.js')), true);
  assert.equal(readFileSync(join(root, 'data', 'letackomat.db'), 'utf8'), 'MOJE DATA');
  assert.deepEqual(calls.filter((c) => ['start', 'stop'].includes(c)), ['start', 'stop', 'start']);
  assert.equal(JSON.parse(readFileSync(join(root, 'data', 'update', 'result.json'), 'utf8')).ok, false);
  rmSync(root, { recursive: true, force: true });
});

test('updater: zip se špatnou verzí nebo bez souborů se odmítne dřív, než se cokoli změní', async () => {
  const root = installDir('1.0.0');
  mkdirSync(join(root, 'data', 'update'), { recursive: true });
  const { opts } = fakes(root, { newDir: newVersionDir('9.9.9'), runningVersion: '1.0.1' }); // v zipu je jiná verze, než se čeká
  const r = await applyUpdate(opts);
  assert.equal(r.ok, false);
  assert.match(r.error, /obsahuje verzi 9\.9\.9/);
  assert.equal(readFileSync(join(root, 'server', 'index.js'), 'utf8'), '// 1.0.0');

  const empty = mkdtempSync(join(tmpdir(), 'letackomat-empty-'));
  mkdirSync(join(empty, 'neco'));
  assert.throws(() => verifySource(join(empty, 'neco'), '1.0.1'), /chybí soubor/);
  assert.equal(findSourceRoot(newVersionDir('1.0.1')).endsWith('letackomat-v1.0.1'), true);
  rmSync(root, { recursive: true, force: true });
});
