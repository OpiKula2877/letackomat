import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserLoginShortcuts } from '../server/watch/autostart.js';

test('okno Edge při přihlášení: najde se jen zástupce Letáčkomat s přepínačem app-run-on-os-login', () => {
  const dir = mkdtempSync(join(tmpdir(), 'letackomat-startup-edge-'));
  const prev = process.env.LETACKOMAT_STARTUP_DIR;
  process.env.LETACKOMAT_STARTUP_DIR = dir;
  try {
    assert.deepEqual(browserLoginShortcuts(), []);
    writeFileSync(join(dir, 'Letáčkomat.lnk'), Buffer.from('msedge_proxy --app-run-on-os-login-mode=windowed', 'utf16le'));
    writeFileSync(join(dir, 'Jiná aplikace.lnk'), Buffer.from('--app-run-on-os-login-mode=windowed', 'utf16le')); // není Letáčkomat
    writeFileSync(join(dir, 'Letackomat-na-pozadi.vbs'), 'shell.Run "launcher.js start --no-open"');
    assert.deepEqual(browserLoginShortcuts(), ['Letáčkomat.lnk']);
  } finally {
    if (prev === undefined) delete process.env.LETACKOMAT_STARTUP_DIR;
    else process.env.LETACKOMAT_STARTUP_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
