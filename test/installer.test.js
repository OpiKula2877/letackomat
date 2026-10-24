import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.js';
import { buildApp } from '../server/index.js';
import { migrateLegacyData } from '../server/migrate.js';
import { dataDir, isInstalled } from '../server/paths.js';
import { createUpdateService, parseRelease } from '../server/update.js';
import { buildAutostartScript, disableAutostart, enableAutostart, installedNode, installedRoot, repairAutostart } from '../server/watch/autostart.js';

const REPO_URL = 'git+https://github.com/Owner/letackomat.git';
const tmp = (name) => mkdtempSync(join(tmpdir(), `letackomat-${name}-`));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const jsonResponse = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const EXE = Buffer.from('MZ\x90\x00installer');
const setupRelease = (version, bytes = EXE, extra = {}) => ({
  tag_name: `v${version}`,
  name: `Letáčkomat ${version}`,
  body: '- novinka',
  html_url: `https://github.com/Owner/letackomat/releases/tag/v${version}`,
  draft: false,
  prerelease: false,
  assets: [
    {
      name: `Letackomat-Setup-${version}.exe`,
      state: 'uploaded',
      size: bytes.length,
      browser_download_url: `https://github.com/Owner/letackomat/releases/download/v${version}/Letackomat-Setup-${version}.exe`,
      digest: `sha256:${sha(bytes)}`,
    },
    {
      name: `letackomat-v${version}.zip`,
      state: 'uploaded',
      size: 4,
      browser_download_url: `https://github.com/Owner/letackomat/releases/download/v${version}/letackomat-v${version}.zip`,
      digest: `sha256:${sha('PK\x03\x04')}`,
    },
  ],
  ...extra,
});

function installedRootDir(version = '1.4.1') {
  const root = tmp('inst');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'letackomat', version, repository: { type: 'git', url: REPO_URL } }));
  writeFileSync(join(root, 'installed.flag'), 'x');
  return root;
}

test('paths: data instalace jdou do %LocalAppData%\\Letackomat, přenosný zip drží data u sebe', () => {
  const root = tmp('paths');
  assert.equal(isInstalled(root), false);
  assert.equal(dataDir({ root, env: {} }), join(root, 'data'));
  writeFileSync(join(root, 'installed.flag'), 'x');
  assert.equal(isInstalled(root), true);
  assert.equal(dataDir({ root, env: { LOCALAPPDATA: 'C:\\Users\\A\\AppData\\Local' } }), join('C:\\Users\\A\\AppData\\Local', 'Letackomat'));
  assert.equal(dataDir({ root, env: { LETACKOMAT_DATA: 'D:\\moje-data', LOCALAPPDATA: 'C:\\x' } }), 'D:\\moje-data'); // přepsání má přednost
  rmSync(root, { recursive: true, force: true });
});

test('parseRelease: rozpozná instalátor i zip', () => {
  const r = parseRelease(setupRelease('1.4.1'));
  assert.equal(r.installer.name, 'Letackomat-Setup-1.4.1.exe');
  assert.match(r.installer.sha256, /^[0-9a-f]{64}$/);
  assert.equal(r.asset.name, 'letackomat-v1.4.1.zip');
  assert.equal(parseRelease(setupRelease('1.4.1', EXE, { assets: [{ name: 'Letackomat-Setup-latest.exe' }] })).installer, null);
});

test('aktualizace z instalátoru: stav a režim', async () => {
  const root = installedRootDir('1.4.1');
  const svc = createUpdateService(openDb(':memory:'), { rootDir: root, installed: true, programFiles: ['C:\\Program Files'], fetch: async () => jsonResponse(setupRelease('1.5.0')) });
  await svc.check();
  const st = svc.status();
  assert.equal(st.mode, 'installer');
  assert.equal(st.available, true);
  assert.equal(st.canApply, true);
  assert.equal(st.needsAdmin, false);

  // jen zip v release: instalace z instalátoru se z něj aktualizovat nedá
  const zipOnly = setupRelease('1.5.0');
  zipOnly.assets = zipOnly.assets.slice(1);
  const svc2 = createUpdateService(openDb(':memory:'), { rootDir: root, installed: true, fetch: async () => jsonResponse(zipOnly) });
  await svc2.check();
  assert.equal(svc2.status().canApply, false);
  assert.equal(svc2.status().reason, 'no-asset');
  await assert.rejects(() => svc2.startApply(), /neobsahuje instalátor/);
  rmSync(root, { recursive: true, force: true });
});

test('aktualizace z instalátoru: spuštění potichu, správné argumenty, server se nevypíná', async () => {
  const root = installedRootDir('1.4.1');
  const calls = [];
  const make = (rel, bytes, programFiles = []) =>
    createUpdateService(openDb(':memory:'), {
      rootDir: root,
      installed: true,
      programFiles,
      spawn: (exe, args, o) => { calls.push({ exe, args, o }); return { unref() {}, on() {} }; },
      fetch: async (url) => (String(url).includes('/releases/latest') ? jsonResponse(rel) : new Response(bytes)),
    });

  const res = await make(setupRelease('1.5.0'), EXE).startApply();
  assert.deepEqual(res, { version: '1.5.0', shutdown: false, installer: true, elevated: false });
  assert.equal(calls.length, 1);
  const { exe, args } = calls[0];
  assert.match(exe, /Letackomat-Setup-1\.5\.0\.exe$/);
  assert.equal(readFileSync(exe).equals(EXE), true);
  assert.ok(args.includes('/SILENT') && args.includes('/SUPPRESSMSGBOXES') && args.includes('/NORESTART'));
  assert.ok(args.includes(`/DIR=${root}`));
  assert.ok(args.includes('/CURRENTUSER') && !args.includes('/ALLUSERS'));

  // složka v Program Files: instalátor se spouští pro všechny uživatele (UAC)
  calls.length = 0;
  const admin = await make(setupRelease('1.5.0'), EXE, [tmpdir()]).startApply();
  assert.equal(admin.elevated, true);
  assert.ok(calls[0].args.includes('/ALLUSERS') && !calls[0].args.includes('/CURRENTUSER'));
  rmSync(root, { recursive: true, force: true });
});

test('stažení instalátoru se odmítne bez součtu, při špatném součtu, obsahu nebo adrese', async () => {
  const root = installedRootDir();
  let spawned = 0;
  const make = (rel, bytes) =>
    createUpdateService(openDb(':memory:'), {
      rootDir: root,
      installed: true,
      spawn: () => { spawned++; return { unref() {}, on() {} }; },
      fetch: async (url) => (String(url).includes('/releases/latest') ? jsonResponse(rel) : new Response(bytes)),
    });

  const noSum = setupRelease('1.5.0');
  noSum.assets[0].digest = null;
  await assert.rejects(() => make(noSum, EXE).startApply(), /chybí kontrolní součet/);

  const bad = Buffer.from('MZ\x90\x00installXX'); // stejná velikost, jiný obsah
  await assert.rejects(() => make(setupRelease('1.5.0'), bad).startApply(), /Kontrolní součet/);

  const notExe = Buffer.from('PK\x03\x04zip-ne-exe');
  await assert.rejects(() => make(setupRelease('1.5.0', notExe), notExe).startApply(), /není instalátor/);

  await assert.rejects(() => make(setupRelease('1.5.0'), Buffer.from('MZ')).startApply(), /neúplný/);

  const foreign = setupRelease('1.5.0');
  foreign.assets[0].browser_download_url = 'https://evil.example.com/Letackomat-Setup-1.5.0.exe';
  await assert.rejects(() => make(foreign, EXE).startApply(), /není z tohoto repozitáře/);

  assert.equal(spawned, 0);
  assert.equal(existsSync(join(root, 'data', 'update')), false);
  rmSync(root, { recursive: true, force: true });
});

test('API: při aktualizaci instalátorem se server sám nevypne', async () => {
  const db = openDb(':memory:');
  const trusted = { host: 'localhost:3000', 'x-letackomat': '1' };
  let stopped = 0;
  const update = {
    check: async () => {},
    status: () => ({ enabled: true, current: '1.4.1', available: true, latest: '1.5.0' }),
    startApply: async () => ({ version: '1.5.0', shutdown: false, installer: true, elevated: true }),
  };
  const app = buildApp(db, { onShutdown: () => { stopped++; }, update });
  const r = await app.inject({ method: 'POST', url: '/api/update/apply', headers: trusted });
  assert.equal(r.statusCode, 202);
  assert.deepEqual(r.json(), { starting: true, version: '1.5.0', installer: true, elevated: true });
  await new Promise((res) => setTimeout(res, 700));
  assert.equal(stopped, 0); // kdyby uživatel zrušil okno správce, aplikace musí dál běžet
  await app.close();
});

test('převzetí dat ze starší instalace ze zipu', async () => {
  const legacy = tmp('legacy');
  const root = installedRootDir();
  const dest = join(tmp('dest'), 'Letackomat');
  mkdirSync(join(legacy, 'data'), { recursive: true });
  const ldb = openDb(join(legacy, 'data', 'letackomat.db'));
  ldb.prepare("INSERT INTO sections(name, position) VALUES ('Kalba', 1)").run();
  ldb.close();

  // přenosná varianta (bez installed.flag) se nemigruje
  assert.deepEqual(await migrateLegacyData({ root, dest, candidates: [legacy], installed: false }), { status: 'skipped' });
  // vlastní složka se nepovažuje za starou instalaci
  assert.equal((await migrateLegacyData({ root, dest, candidates: [root] })).status, 'none');
  assert.equal(existsSync(join(dest, 'letackomat.db')), false);

  const done = await migrateLegacyData({ root, dest, candidates: [legacy] });
  assert.deepEqual(done, { status: 'migrated', from: legacy });
  const copy = new DatabaseSync(join(dest, 'letackomat.db'), { readOnly: true });
  assert.equal(copy.prepare("SELECT COUNT(*) n FROM sections WHERE name = 'Kalba'").get().n, 1);
  copy.close();
  assert.equal(existsSync(join(legacy, 'data', 'letackomat.db')), true); // originál zůstává

  // podruhé už se nic nepřepisuje
  assert.equal((await migrateLegacyData({ root, dest, candidates: [legacy] })).status, 'exists');
  for (const d of [legacy, root, join(dest, '..')]) rmSync(d, { recursive: true, force: true });
});

test('skript po přihlášení: celá cesta k node.exe a oprava, když node zmizí', () => {
  const script = buildAutostartScript('C:\\Program Files\\Letackomat', 'C:\\Program Files\\Letackomat\\node.exe');
  assert.match(script, /shell\.CurrentDirectory = "C:\\Program Files\\Letackomat"/);
  assert.match(script, /Chr\(34\) & "C:\\Program Files\\Letackomat\\node\.exe" & Chr\(34\) & " scripts\\launcher\.js start --no-open"/);

  const startup = tmp('startup');
  const prev = process.env.LETACKOMAT_STARTUP_DIR;
  process.env.LETACKOMAT_STARTUP_DIR = startup;
  try {
    const app = tmp('app');
    mkdirSync(join(app, 'scripts'), { recursive: true });
    writeFileSync(join(app, 'scripts', 'launcher.js'), '');
    const node = join(app, 'node.exe');
    writeFileSync(node, '');

    enableAutostart(app, node);
    assert.equal(installedRoot(), app);
    assert.equal(installedNode(), node);
    assert.equal(repairAutostart(app, node), 'ok');

    // node.exe zmizel (třeba po odinstalaci Node.js): skript se přepíše na aktuální
    const other = join(app, 'jiny-node.exe');
    writeFileSync(other, '');
    rmSync(node);
    assert.equal(repairAutostart(app, other), 'repaired');
    assert.equal(installedNode(), other);

    // složka zmizela
    rmSync(join(app, 'scripts', 'launcher.js'));
    writeFileSync(join(app, 'scripts', 'launcher.js'), '');
    disableAutostart();
    assert.equal(repairAutostart(app, other), 'absent');
    rmSync(app, { recursive: true, force: true });
  } finally {
    if (prev === undefined) delete process.env.LETACKOMAT_STARTUP_DIR;
    else process.env.LETACKOMAT_STARTUP_DIR = prev;
    rmSync(startup, { recursive: true, force: true });
  }
});
