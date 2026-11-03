import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startCheck, validateFn, validateVat } from '../src/check-request.js';
import { d1, migratedDatabase } from './d1.js';

test('a valid Austrian VAT number is accepted', () => {
  assert.deepEqual(validateVat('ATU12345678'), { ok: true, vat: 'ATU12345678' });
});

test('spaces and lowercase cleaned up', () => {
  assert.deepEqual(validateVat('atu 1234 5678'), { ok: true, vat: 'ATU12345678' });
});

test('one digit short produces an error', () => {
  assert.deepEqual(validateVat('ATU1234567'), { ok: false, error: 'INVALID_VAT' });
});

test('numbers and no text, are rejected', () => {
  assert.deepEqual(validateVat(''), { ok: false, error: 'INVALID_VAT' });
  assert.deepEqual(validateVat(12345), { ok: false, error: 'INVALID_VAT' });
});

test('Deutschland is accepted', () => {
  assert.deepEqual(validateVat('DE123456789'), { ok: true, vat: 'DE123456789' });
});

test('unknown country is rejected', () => {
  assert.deepEqual(validateVat('XX123456789'), { ok: false, error: 'INVALID_VAT' });
});

test('DE VAT number too short', () => {
  assert.deepEqual(validateVat('DE12345678'), { ok: false, error: 'INVALID_VAT' });
});

test('other EU countries are accepted', () => {
  assert.deepEqual(validateVat('FR12345678901'), { ok: true, vat: 'FR12345678901' });
  assert.deepEqual(validateVat('IT12345678901'), { ok: true, vat: 'IT12345678901' });
});

test('a Greek VAT number with GR is stored with the VIES prefix EL', () => {
  assert.deepEqual(validateVat('GR123456789'), { ok: true, vat: 'EL123456789' });
});

test('no FN entered is fine', () => {
  assert.deepEqual(validateFn(undefined), { ok: true, fn: null });
  assert.deepEqual(validateFn(''), { ok: true, fn: null });
});

test('a valid FN is accepted', () => {
  assert.deepEqual(validateFn('123456a'), { ok: true, fn: '123456a' });
});

test('an FN with spaces and uppercase is cleaned up', () => {
  assert.deepEqual(validateFn('123456 A'), { ok: true, fn: '123456a' });
});

test('an FN without the check letter is rejected', () => {
  assert.deepEqual(validateFn('12345'), { ok: false, error: 'INVALID_FN' });
});

test('an FN that is not digits plus a letter is rejected', () => {
  assert.deepEqual(validateFn('abc'), { ok: false, error: 'INVALID_FN' });
});

// ---- startCheck: these use a real SQLite database in memory ----

// One organisation with one user per role.
function setup() {
  const sqlite = migratedDatabase();
  const db = d1(sqlite);
  sqlite.exec(`
    INSERT INTO organisations (id, name, fn) VALUES (1, 'Muster Bau GmbH', '111111a');
    INSERT INTO users (id, organisation_id, email, first_name, last_name, role, status) VALUES
      (10, 1, 'req@example.at',    'Rita', 'Request', 'REQUEST_USER', 'ACTIVE'),
      (11, 1, 'admin@example.at',  'Anna', 'Admin',   'ADMIN',        'ACTIVE'),
      (12, 1, 'review@example.at', 'Rudi', 'Review',  'REVIEW_USER',  'ACTIVE');
  `);
  const user = (id) => sqlite.prepare('SELECT id, organisation_id AS organisationId, role FROM users WHERE id = ?').get(id);
  return { db, sqlite, user };
}

const now = new Date('2026-11-02T09:00:00Z');

test('a Request User starts a check and gets a request ID', async () => {
  const { db, sqlite, user } = setup();
  const result = await startCheck({ db, now }, user(10), { vat: 'atu 1234 5678', fn: '123456A' });

  assert.equal(result.ok, true);
  const row = sqlite.prepare('SELECT * FROM requests WHERE id = ?').get(result.requestId);
  assert.equal(row.organisation_id, 1);
  assert.equal(row.user_id, 10);
  assert.equal(row.input_vat, 'ATU12345678'); // stored cleaned up
  assert.equal(row.input_fn, '123456a');
  assert.equal(row.status, 'RUNNING');
  assert.equal(row.started_at, '2026-11-02T09:00:00.000Z'); // UTC
});

test('an Admin can start a check, and the FN may be left out', async () => {
  const { db, sqlite, user } = setup();
  const result = await startCheck({ db, now }, user(11), { vat: 'DE123456789' });

  assert.equal(result.ok, true);
  const row = sqlite.prepare('SELECT input_fn FROM requests WHERE id = ?').get(result.requestId);
  assert.equal(row.input_fn, null);
});

test('a Review User cannot start a check', async () => {
  const { db, sqlite, user } = setup();
  const result = await startCheck({ db, now }, user(12), { vat: 'ATU12345678' });

  assert.deepEqual(result, { ok: false, error: 'FORBIDDEN' });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
});

test('an invalid VAT number creates no request but is logged', async () => {
  const { db, sqlite, user } = setup();
  const result = await startCheck({ db, now }, user(10), { vat: 'ATU123' });

  assert.deepEqual(result, { ok: false, error: 'INVALID_VAT' });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
  const log = sqlite.prepare('SELECT user_id, action, details FROM audit_log').all();
  assert.deepEqual(
    log.map((entry) => ({ ...entry })),
    [{ user_id: 10, action: 'REQUEST_REJECTED', details: '{"error":"INVALID_VAT"}' }],
  );
});

test('an invalid FN creates no request', async () => {
  const { db, sqlite, user } = setup();
  const result = await startCheck({ db, now }, user(10), { vat: 'ATU12345678', fn: 'abc' });

  assert.deepEqual(result, { ok: false, error: 'INVALID_FN' });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
});

test('a started check is logged with its request ID', async () => {
  const { db, sqlite, user } = setup();
  const { requestId } = await startCheck({ db, now }, user(10), { vat: 'ATU12345678' });

  const entry = sqlite.prepare("SELECT details FROM audit_log WHERE action = 'REQUEST_STARTED'").get();
  assert.deepEqual(JSON.parse(entry.details), { requestId });
});