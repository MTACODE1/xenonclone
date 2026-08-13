const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const databasePath = path.join(os.tmpdir(), `xero-token-connection-${process.pid}-${Date.now()}.db`);
process.env.XERO_DASHBOARD_DB_PATH = databasePath;

const {
  upsertToken, upsertTokenForConnection, getToken, markConnectionDisconnected,
  getTenantsSharingRefreshToken, upsertOrganisation,
} = require('../src/db/queries');
const { getDb } = require('../src/db/schema');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(databasePath + suffix, { force: true });
});

// One Xero consent covers several tenants and yields ONE token set, which auth.js stores against
// every tenant row. This is the shape that made the rotation bug possible.
function seedConnection(tenantIds, refreshToken, expiresAt = '2026-01-01T00:00:00.000Z') {
  for (const tenantId of tenantIds) {
    upsertOrganisation({
      xero_tenant_id: tenantId, name: `Org ${tenantId}`, client_ref: null, tag: null,
      connection_status: 'connected', last_synced_at: null,
    });
    upsertToken({
      xero_tenant_id: tenantId, access_token: `access-${refreshToken}`,
      refresh_token: refreshToken, expires_at: expiresAt,
    });
  }
}

test('rotating a refresh token updates every tenant sharing that connection', () => {
  const shared = ['t-a', 't-b', 't-c', 't-d', 't-e', 't-f'];
  seedConnection(shared, 'original-refresh');
  // A second, independent connection must not be touched.
  seedConnection(['t-other'], 'other-refresh');

  const propagated = upsertTokenForConnection('original-refresh', {
    xero_tenant_id: 't-a',
    access_token: 'new-access',
    refresh_token: 'rotated-refresh',
    expires_at: '2026-06-01T00:00:00.000Z',
  });
  assert.equal(propagated, shared.length);

  // Before the fix only t-a carried the rotated token and the other five were stranded on a
  // consumed one, so the next sync of any of them failed with invalid_grant.
  for (const tenantId of shared) {
    const row = getToken(tenantId);
    assert.equal(row.refresh_token, 'rotated-refresh', `${tenantId} kept a stale refresh token`);
    assert.equal(row.access_token, 'new-access');
    assert.equal(row.expires_at, '2026-06-01T00:00:00.000Z');
  }
  assert.equal(getToken('t-other').refresh_token, 'other-refresh');
});

test('a tenant on its own connection still has its token written', () => {
  seedConnection(['t-solo'], 'solo-refresh');
  const propagated = upsertTokenForConnection('solo-refresh', {
    xero_tenant_id: 't-solo', access_token: 'a2', refresh_token: 'solo-rotated',
    expires_at: '2026-07-01T00:00:00.000Z',
  });
  assert.equal(propagated, 1);
  assert.equal(getToken('t-solo').refresh_token, 'solo-rotated');
});

test('an unchanged refresh token is written without a pointless propagation pass', () => {
  seedConnection(['t-same'], 'same-refresh');
  const propagated = upsertTokenForConnection('same-refresh', {
    xero_tenant_id: 't-same', access_token: 'a3', refresh_token: 'same-refresh',
    expires_at: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(propagated, 0);
  const row = getToken('t-same');
  assert.equal(row.access_token, 'a3');
  assert.equal(row.expires_at, '2026-08-01T00:00:00.000Z');
});

test('a first-time tenant with no prior row is inserted rather than lost', () => {
  const propagated = upsertTokenForConnection(null, {
    xero_tenant_id: 't-new', access_token: 'a4', refresh_token: 'new-refresh',
    expires_at: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(propagated, 0);
  assert.equal(getToken('t-new').refresh_token, 'new-refresh');
});

test('a dead authorisation disconnects every organisation it covered', () => {
  const shared = ['d-a', 'd-b', 'd-c'];
  seedConnection(shared, 'dead-refresh');
  seedConnection(['d-live'], 'live-refresh');
  const db = getDb();

  const affected = markConnectionDisconnected('dead-refresh', 'd-a');
  assert.equal(affected, shared.length);

  for (const tenantId of shared) {
    const row = db.prepare('SELECT connection_status FROM organisations WHERE xero_tenant_id = ?').get(tenantId);
    assert.equal(row.connection_status, 'disconnected', `${tenantId} still shows as connected`);
  }
  // An unrelated connection keeps working.
  assert.equal(
    db.prepare('SELECT connection_status FROM organisations WHERE xero_tenant_id = ?').get('d-live').connection_status,
    'connected'
  );
});

test('the organisations on a connection can be named for the reconnect message', () => {
  seedConnection(['n-a', 'n-b'], 'named-refresh');
  const rows = getTenantsSharingRefreshToken('named-refresh');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.name).sort(), ['Org n-a', 'Org n-b']);
  assert.deepEqual(getTenantsSharingRefreshToken(null), []);
});

test('authorisation failures are told apart from network failures', () => {
  // Loaded lazily so the DB path above is already set.
  const clientSource = fs.readFileSync(path.join(__dirname, '../src/services/xeroClient.js'), 'utf8');
  // isAuthorisationFailure is module-private; exercise it through a small shim of the same source.
  const isAuthorisationFailure = new Function('err', `
    ${clientSource.match(/function isAuthorisationFailure[\s\S]*?\n}/)[0]}
    return isAuthorisationFailure(err);
  `);

  // The live failure that stranded six tenants.
  assert.equal(isAuthorisationFailure(
    new Error('invalid_grant (Refresh token has been consumed)')), true);
  assert.equal(isAuthorisationFailure({ error: 'invalid_grant' }), true);
  assert.equal(isAuthorisationFailure({ error: 'unauthorized_client' }), true);
  assert.equal(isAuthorisationFailure(new Error('Token has been revoked')), true);

  // These must NOT disconnect the organisation.
  const reset = new Error('socket hang up'); reset.code = 'ECONNRESET';
  assert.equal(isAuthorisationFailure(reset), false);
  const timeout = new Error('timeout'); timeout.code = 'ETIMEDOUT';
  assert.equal(isAuthorisationFailure(timeout), false);
  const serverError = new Error('Bad Gateway'); serverError.response = { statusCode: 502 };
  assert.equal(isAuthorisationFailure(serverError), false);
});

test('every scope the app requests is present, including the ones just added', () => {
  process.env.XERO_CLIENT_ID = process.env.XERO_CLIENT_ID || 'test-id';
  process.env.XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET || 'test-secret';
  process.env.XERO_REDIRECT_URI = process.env.XERO_REDIRECT_URI || 'http://localhost:3000/auth/callback';
  const { createXeroClient } = require('../src/services/xeroClient');
  const scopes = createXeroClient().config.scopes;
  for (const required of [
    'offline_access',
    'accounting.settings.read', 'accounting.contacts.read', 'accounting.invoices.read',
    'accounting.banktransactions.read', 'accounting.payments.read',
    'accounting.manualjournals.read',
    // Journals is a different endpoint from ManualJournals; without this the transaction-count
    // journal fetch 403s and silently reports zero.
    'accounting.journals.read',
    'accounting.reports.balancesheet.read',
    // bank_balance reads Reports/BankSummary and previously depended on the deprecated broad scope.
    'accounting.reports.banksummary.read',
  ]) {
    assert.ok(scopes.includes(required), `missing scope: ${required}`);
  }
});
