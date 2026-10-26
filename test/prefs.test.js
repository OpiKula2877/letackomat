import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { buildApp } from '../server/index.js';

const local = { host: 'localhost:3000' };
const trusted = { ...local, 'x-letackomat': '1', 'content-type': 'application/json' };

test('předvolené obchody: uloží se na server a přežijí nový start aplikace', async () => {
  const db = openDb(':memory:');
  const app = buildApp(db);
  const get = async () => (await app.inject({ url: '/api/prefs', headers: local })).json().shops;
  const put = (shops, headers = trusted) => app.inject({ method: 'PUT', url: '/api/prefs', headers, payload: JSON.stringify({ shops }) });

  assert.equal(await get(), null); // zatím nic nenastaveno
  assert.equal((await put(['lidl'], { ...local, 'content-type': 'application/json' })).statusCode, 403); // bez hlavičky se nezapisuje
  assert.equal((await put(['Lidl'])).statusCode, 400); // slug musí být malými písmeny
  assert.equal((await app.inject({ method: 'PUT', url: '/api/prefs', headers: trusted, payload: JSON.stringify({ shops: 'lidl' }) })).statusCode, 400);
  assert.equal((await put(['lidl', 'lidl', 'kaufland'])).statusCode, 200);
  assert.deepEqual(await get(), ['lidl', 'kaufland']); // duplicity se sloučí
  await app.close();

  const again = buildApp(db); // nový start aplikace nad stejnou databází
  assert.deepEqual((await again.inject({ url: '/api/prefs', headers: local })).json().shops, ['lidl', 'kaufland']);
  await again.close();
});

test('předvolby: prázdný výběr znamená "všechny obchody" a jde uložit', async () => {
  const app = buildApp(openDb(':memory:'));
  const r = await app.inject({ method: 'PUT', url: '/api/prefs', headers: trusted, payload: JSON.stringify({ shops: [] }) });
  assert.equal(r.statusCode, 200);
  assert.deepEqual((await app.inject({ url: '/api/prefs', headers: local })).json().shops, []);
  await app.close();
});
