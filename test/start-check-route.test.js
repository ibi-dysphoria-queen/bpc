// SCRUM-16: POST /api/requests through the Worker, with login stubbed via env.IDENTITY.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';
import { d1, migratedDatabase } from './d1.js';

const assets = { fetch: async () => new Response('web app') };

// externalUserId: who is signed in at Clerk, or null for nobody.
function setup(externalUserId) {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO organisations (id, name, fn) VALUES (1, 'Muster Bau GmbH', '111111a');
    INSERT INTO users (id, organisation_id, email, first_name, last_name, role, status, external_user_id) VALUES
      (10, 1, 'req@example.at',    'Rita', 'Request', 'REQUEST_USER', 'ACTIVE', 'clerk_request'),
      (12, 1, 'review@example.at', 'Rudi', 'Review',  'REVIEW_USER',  'ACTIVE', 'clerk_review');
  `);
  const identity = {
    authenticate: async () => (externalUserId ? { externalUserId } : null),
    verifiedEmail: async () => null,
  };
  return { sqlite, env: { DB: d1(sqlite), ASSETS: assets, IDENTITY: identity } };
}

const post = (env, body) =>
  worker.fetch(
    new Request('https://bpc.hsynrsd.dev/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );

const countRequests = (sqlite) => sqlite.prepare('SELECT COUNT(*) AS n FROM requests').get().n;

test('POST /api/requests: not signed in gives 401', async () => {
  const { sqlite, env } = setup(null);
  const response = await post(env, { vat: 'ATU12345678' });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'NOT_SIGNED_IN' });
  assert.equal(countRequests(sqlite), 0);
});

test('POST /api/requests: a Review User gives 403', async () => {
  const { sqlite, env } = setup('clerk_review');
  const response = await post(env, { vat: 'ATU12345678' });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'FORBIDDEN' });
  assert.equal(countRequests(sqlite), 0);
});

test('POST /api/requests: an invalid VAT number gives 400', async () => {
  const { sqlite, env } = setup('clerk_request');
  const response = await post(env, { vat: 'ATU123' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'INVALID_VAT' });
  assert.equal(countRequests(sqlite), 0);
});

test('POST /api/requests: a null body gives 400, not a crash', async () => {
  const { env } = setup('clerk_request');
  const response = await post(env, null);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'INVALID_VAT' });
});

test('POST /api/requests: a valid VAT number gives 202 with the request ID', async () => {
  const { sqlite, env } = setup('clerk_request');
  const response = await post(env, { vat: 'ATU12345678', fn: '123456a' });
  assert.equal(response.status, 202);
  const { requestId } = await response.json();
  const row = sqlite.prepare('SELECT user_id, input_vat, input_fn FROM requests WHERE id = ?').get(requestId);
  assert.deepEqual({ ...row }, { user_id: 10, input_vat: 'ATU12345678', input_fn: '123456a' });
});