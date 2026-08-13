const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.XERO_DASHBOARD_DB_PATH = path.join(
  os.tmpdir(), `xero-validation-${process.pid}-${Date.now()}.db`
);

const { getDb } = require('../src/db/schema');
const {
  createValidationSnapshot, getValidationGateAssurances, getValidationSnapshots,
  setValidationGateAssurance,
} = require('../src/db/queries');
const { CHECK_SUPPORT } = require('../src/services/validationGate');

test('validation snapshots persist 29 immutable check observations and assurance evidence', () => {
  const db = getDb();
  const orgId = Number(db.prepare(`
    INSERT INTO organisations (xero_tenant_id, name) VALUES ('validation-org', 'Validation Ltd')
  `).run().lastInsertRowid);
  const checks = Object.entries(CHECK_SUPPORT).map(([type, supportType]) => ({
    type, supportType, count: 0, value: 0, mismatchNote: '',
  }));
  createValidationSnapshot(orgId, {
    periodKey: 'current_month:2026-08-01:2026-08-07',
    xenonScore: 100,
    xenonIssues: 0,
    xenonValue: 0,
    sourceDate: '2026-08-07',
    sourceFilename: 'private.json',
    sourceFileSha256: 'a'.repeat(64),
    evidencePath: 'a.json',
    notes: '',
    scoreReason: '',
    profileTags: ['clean'],
    evidenceKind: 'json',
    countsTowardGate: true,
  }, checks);

  const snapshots = getValidationSnapshots();
  assert.equal(snapshots.length, 1);
  assert.equal(Object.keys(snapshots[0].checks).length, 29);
  assert.equal(snapshots[0].sourceFileSha256, 'a'.repeat(64));

  setValidationGateAssurance('no_data_loss_sync', 'passed', '2026-08-07', 'Failure injection passed');
  assert.deepEqual(getValidationGateAssurances().no_data_loss_sync, {
    status: 'passed',
    evidenceDate: '2026-08-07',
    notes: 'Failure injection passed',
    updatedAt: getValidationGateAssurances().no_data_loss_sync.updatedAt,
  });
});
