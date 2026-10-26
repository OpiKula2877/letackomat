import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { buildApp } from '../server/index.js';

const local = { host: 'localhost:3000' };

test('zdraví: říká, jestli je aplikace nainstalovaná instalátorem', async () => {
  const installed = buildApp(openDb(':memory:'), { installed: true });
  assert.equal((await installed.inject({ url: '/api/health', headers: local })).json().installed, true);
  await installed.close();

  const portable = buildApp(openDb(':memory:'), { installed: false });
  assert.equal((await portable.inject({ url: '/api/health', headers: local })).json().installed, false);
  await portable.close();
});
