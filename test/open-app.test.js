import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appWindowCommand, browserCandidates } from '../scripts/open-app.js';

const ENV = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\Me\\AppData\\Local' };
const URL = 'http://localhost:3000';

test('okno aplikace: Edge má přednost před Chrome', () => {
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  assert.deepEqual(appWindowCommand(URL, { env: ENV, exists: (p) => p === edge || p === chrome }), { file: edge, args: ['--app=http://localhost:3000'] });
  assert.deepEqual(appWindowCommand(URL, { env: ENV, exists: (p) => p === chrome }), { file: chrome, args: ['--app=http://localhost:3000'] });
});

test('okno aplikace: Chrome nainstalovaný jen pro uživatele se najde', () => {
  const chrome = 'C:\\Users\\Me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
  assert.equal(appWindowCommand(URL, { env: ENV, exists: (p) => p === chrome }).file, chrome);
});

test('okno aplikace: bez Edge a Chrome nebo s LETACKOMAT_BROWSER=tab se otevře běžný prohlížeč', () => {
  assert.equal(appWindowCommand(URL, { env: ENV, exists: () => false }), null);
  assert.equal(appWindowCommand(URL, { env: { ...ENV, LETACKOMAT_BROWSER: 'tab' }, exists: () => true }), null);
});

test('okno aplikace: chybějící proměnné prostředí nic nerozbijí', () => {
  assert.deepEqual(browserCandidates({}), []);
});
