// Kontrola a spuštění aktualizace z GitHub Releases.
// Server jen zjistí novou verzi, stáhne ověřený zip a předá práci procesu scripts/updater.js,
// který po vypnutí serveru vymění soubory aplikace (data/ a node_modules/ zůstávají) a server spustí znovu.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMeta, setMeta } from './db.js';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_TTL_MS = 6 * 3600 * 1000; // GitHub API bez přihlášení má limit 60 dotazů za hodinu
const RETRY_AFTER_ERROR_MS = 10 * 60 * 1000;
const MAX_ZIP_BYTES = 100 * 1024 * 1024;

export function readPackage(rootDir = defaultRoot) {
  return JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
}

/** "git+https://github.com/OpiKula2877/letackomat.git" -> { owner, repo } */
export function repoFromPackage(pkg) {
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '';
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function parseVersion(v) {
  const m = String(v ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** 1 když a > b, -1 když a < b, 0 když stejné nebo nečitelné. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

/** Odpověď GitHubu (releases/latest) na to, co aplikace potřebuje. null = nic použitelného. */
export function parseRelease(json) {
  if (!json || json.draft || json.prerelease) return null;
  const version = String(json.tag_name ?? '').replace(/^v/, '');
  if (!parseVersion(version)) return null;
  const asset = (json.assets ?? []).find((a) => /^letackomat-v?\d+\.\d+\.\d+\.zip$/i.test(a.name) && a.state !== 'new');
  return {
    version,
    name: json.name ?? `Verze ${version}`,
    notes: String(json.body ?? ''),
    url: json.html_url ?? null,
    publishedAt: json.published_at ?? null,
    asset: asset
      ? {
          name: asset.name,
          url: asset.browser_download_url,
          size: asset.size ?? null,
          sha256: /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '')?.[1]?.toLowerCase() ?? null,
        }
      : null,
  };
}

export function createUpdateService(db, opts = {}) {
  const rootDir = opts.rootDir ?? defaultRoot;
  const pkg = readPackage(rootDir);
  const current = pkg.version;
  const repo = repoFromPackage(pkg);
  const apiUrl = opts.apiUrl ?? process.env.UPDATE_API_URL ?? (repo ? `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest` : null);
  const fetchImpl = opts.fetch ?? fetch;
  const ttl = opts.ttlMs ?? CHECK_TTL_MS;
  const disabled = opts.disabled ?? (process.env.NO_UPDATE_CHECK === '1' || !apiUrl);
  const updateDir = join(rootDir, 'data', 'update');
  const isGitCheckout = existsSync(join(rootDir, '.git'));

  // stahovat smí jen z releasů tohoto repa (nebo z adresy zadané pro testy přes UPDATE_API_URL)
  const allowedPrefixes = [
    repo ? `https://github.com/${repo.owner}/${repo.repo}/releases/download/` : null,
    opts.apiUrl || process.env.UPDATE_API_URL ? `${new URL(apiUrl).origin}/` : null,
  ].filter(Boolean);

  let cache = null; // { checkedAt, nextCheckAt, release, error }
  try {
    const saved = JSON.parse(getMeta(db, 'update_cache') ?? 'null');
    if (saved?.release !== undefined && Date.now() < saved.nextCheckAt) cache = saved;
  } catch { /* poškozená cache se ignoruje */ }

  async function check({ force = false } = {}) {
    if (disabled) return cache;
    if (!force && cache && Date.now() < cache.nextCheckAt) return cache;
    const now = Date.now();
    try {
      const res = await fetchImpl(apiUrl, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'Letackomat-updater' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404) cache = { checkedAt: now, nextCheckAt: now + ttl, release: null, error: null };
      else if (!res.ok) throw new Error(`GitHub vrátil ${res.status}`);
      else cache = { checkedAt: now, nextCheckAt: now + ttl, release: parseRelease(await res.json()), error: null };
    } catch (e) {
      // bez internetu nebo při chybě se nic nerozbije; zkusí se to znovu za chvíli
      cache = { checkedAt: cache?.checkedAt ?? null, nextCheckAt: now + RETRY_AFTER_ERROR_MS, release: cache?.release ?? null, error: e.message };
    }
    try { setMeta(db, 'update_cache', JSON.stringify(cache)); } catch { /* nevadí */ }
    return cache;
  }

  function lastResult() {
    try {
      return JSON.parse(readFileSync(join(updateDir, 'result.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  function status() {
    const rel = cache?.release ?? null;
    const available = Boolean(rel) && compareVersions(rel.version, current) > 0;
    let reason = null;
    if (available && isGitCheckout) reason = 'git';
    else if (available && !rel.asset) reason = 'no-asset';
    return {
      enabled: !disabled,
      current,
      latest: rel?.version ?? null,
      available,
      name: available ? rel.name : null,
      notes: available ? rel.notes : '',
      releaseUrl: available ? rel.url : null,
      canApply: available && !reason,
      reason,
      checkedAt: cache?.checkedAt ?? null,
      error: cache?.error ?? null,
      lastResult: lastResult(),
    };
  }

  /** Stáhne a ověří zip nejnovější verze a spustí updater. Vyhodí chybu s popisem pro uživatele. */
  async function startApply() {
    await check({ force: true });
    const st = status();
    if (!st.available) throw Object.assign(new Error('Žádná novější verze není k dispozici.'), { code: 409 });
    if (!st.canApply) throw Object.assign(new Error(st.reason === 'git' ? 'Instalace přes git se aktualizuje příkazem git pull.' : 'Release neobsahuje zip s aplikací.'), { code: 409 });

    const rel = cache.release;
    if (!allowedPrefixes.some((p) => rel.asset.url?.startsWith(p))) {
      throw Object.assign(new Error('Adresa souboru s aktualizací není z tohoto repozitáře.'), { code: 502 });
    }

    const res = await fetchImpl(rel.asset.url, { redirect: 'follow', headers: { 'user-agent': 'Letackomat-updater' }, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw Object.assign(new Error(`Stažení selhalo (${res.status}).`), { code: 502 });
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_ZIP_BYTES) throw Object.assign(new Error('Stažený soubor má nečekanou velikost.'), { code: 502 });
    if (rel.asset.size && bytes.length !== rel.asset.size) throw Object.assign(new Error('Stažený soubor je neúplný.'), { code: 502 });
    if (bytes.subarray(0, 2).toString() !== 'PK') throw Object.assign(new Error('Stažený soubor není zip.'), { code: 502 });
    if (rel.asset.sha256 && createHash('sha256').update(bytes).digest('hex') !== rel.asset.sha256) {
      throw Object.assign(new Error('Kontrolní součet staženého souboru nesedí.'), { code: 502 });
    }

    mkdirSync(updateDir, { recursive: true });
    const zipPath = join(updateDir, rel.asset.name);
    writeFileSync(zipPath, bytes);
    // updater se spouští z kopie, protože při výměně souborů přepíše i složku scripts/
    const runner = join(updateDir, 'updater-run.mjs');
    copyFileSync(join(rootDir, 'scripts', 'updater.js'), runner);

    const child = spawn(
      process.execPath,
      [runner, '--root', rootDir, '--zip', zipPath, '--from', current, '--to', rel.version, '--port', String(process.env.PORT || 3000)],
      { detached: true, stdio: 'ignore', windowsHide: true, env: process.env },
    );
    child.unref();
    return { version: rel.version };
  }

  return { check, status, startApply, current };
}
