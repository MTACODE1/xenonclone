// Phase 5, section 1: full-refresh deletion vs incremental-refresh retention, and renamed/voided/
// deleted/merged entity handling. mergeEntityCache (queries.js) is the single write path for every
// cached Xero entity type — this proves its two documented modes live, plus the upsert behaviour
// that renamed/voided/merged entities all rely on (Xero represents rename/void/merge as an updated
// row with the same ID and a bumped UpdatedDateUTC, not a special event type).
//
// Note: getCachedEntities returns the parsed Xero-shaped JSON payloads (contactID/invoiceID etc.),
// not raw DB rows — there is no `entity_id` field on what it returns, only the entity's own ID field.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.XERO_DASHBOARD_DB_PATH = path.join(
  os.tmpdir(), `xero-entity-cache-lifecycle-${process.pid}-${Date.now()}.db`
);

const { getDb } = require('../src/db/schema');
const { upsertOrganisation, getOrganisationByTenantId, mergeEntityCache, getCachedEntities } = require('../src/db/queries');

const db = getDb();
upsertOrganisation({ xero_tenant_id: 'cache-lifecycle-org', name: 'Cache Lifecycle Org', client_ref: null, tag: null, connection_status: 'connected', last_synced_at: null });
const org = getOrganisationByTenantId('cache-lifecycle-org');

test('a full refresh removes entities no longer present in the fetched set (genuine deletion)', () => {
  mergeEntityCache(org.id, 'invoice', [
    { invoiceID: 'inv-1', invoiceNumber: 'INV-001', status: 'AUTHORISED' },
    { invoiceID: 'inv-2', invoiceNumber: 'INV-002', status: 'AUTHORISED' },
    { invoiceID: 'inv-3', invoiceNumber: 'INV-003', status: 'AUTHORISED' },
  ], { fullRefresh: true });
  assert.equal(getCachedEntities(org.id, 'invoice').length, 3);

  // inv-2 is gone from the fresh full fetch — e.g. a hard-deleted draft that never left DRAFT status,
  // which Xero's modified-since filter would not surface incrementally either.
  mergeEntityCache(org.id, 'invoice', [
    { invoiceID: 'inv-1', invoiceNumber: 'INV-001', status: 'AUTHORISED' },
    { invoiceID: 'inv-3', invoiceNumber: 'INV-003', status: 'AUTHORISED' },
  ], { fullRefresh: true });
  const after = getCachedEntities(org.id, 'invoice');
  assert.equal(after.length, 2, 'a full refresh must remove cache entries absent from the fresh fetch');
  assert.ok(!after.some(row => row.invoiceID === 'inv-2'));
});

test('an incremental refresh never removes entities absent from its (partial, modified-since) batch', () => {
  mergeEntityCache(org.id, 'contact', [
    { contactID: 'c-1', name: 'Alpha Ltd', contactStatus: 'ACTIVE' },
    { contactID: 'c-2', name: 'Beta Ltd', contactStatus: 'ACTIVE' },
  ], { fullRefresh: true });
  assert.equal(getCachedEntities(org.id, 'contact').length, 2);

  // Only c-1 changed since the last sync — c-2 is legitimately absent from this batch because
  // nothing about it changed, NOT because it was deleted. Incremental must retain it regardless.
  mergeEntityCache(org.id, 'contact', [
    { contactID: 'c-1', name: 'Alpha Ltd (renamed)', contactStatus: 'ACTIVE' },
  ], { fullRefresh: false });
  const after = getCachedEntities(org.id, 'contact');
  assert.equal(after.length, 2, 'incremental refresh must retain c-2 even though it was absent from this batch');
  assert.ok(after.some(row => row.contactID === 'c-2'), 'c-2 must still be cached');
});

test('a renamed contact updates in place — same entity_id, new JSON, not a duplicate row', () => {
  mergeEntityCache(org.id, 'contact', [{ contactID: 'c-rename', name: 'Old Name Ltd', contactStatus: 'ACTIVE' }], { fullRefresh: false });
  mergeEntityCache(org.id, 'contact', [{ contactID: 'c-rename', name: 'New Name Ltd', contactStatus: 'ACTIVE' }], { fullRefresh: false });
  const rows = getCachedEntities(org.id, 'contact').filter(r => r.contactID === 'c-rename');
  assert.equal(rows.length, 1, 'a rename must update the existing row, not create a second one');
  assert.equal(rows[0].name, 'New Name Ltd');
});

test('a voided invoice updates status in place, and a check filtering by AUTHORISED naturally drops it', () => {
  mergeEntityCache(org.id, 'invoice', [{ invoiceID: 'inv-void', invoiceNumber: 'INV-900', status: 'AUTHORISED', total: 500 }], { fullRefresh: true });
  let cached = getCachedEntities(org.id, 'invoice').find(r => r.invoiceID === 'inv-void');
  assert.equal(cached.status, 'AUTHORISED');

  // Xero represents a void as an updated row with the same invoiceID and a bumped UpdatedDateUTC —
  // an incremental (modified-since) fetch picks this up exactly like any other field change.
  mergeEntityCache(org.id, 'invoice', [{ invoiceID: 'inv-void', invoiceNumber: 'INV-900', status: 'VOIDED', total: 500 }], { fullRefresh: false });
  cached = getCachedEntities(org.id, 'invoice').find(r => r.invoiceID === 'inv-void');
  assert.equal(cached.status, 'VOIDED', 'the cached record must reflect the new VOIDED status');
  // Every check's inclusion filter checks status === 'AUTHORISED' (or PAID) explicitly (see
  // CHECK_CONTRACTS.md's "Included/excluded" line for every check) — a VOIDED status simply fails
  // that filter on the next analysis pass, with no separate "handle voids" branch needed anywhere.
});

test('a merged contact (Xero archives the losing contactID, the surviving one absorbs its data) leaves both rows individually correct', () => {
  mergeEntityCache(org.id, 'contact', [
    { contactID: 'c-survivor', name: 'Merged Co', contactStatus: 'ACTIVE' },
    { contactID: 'c-absorbed', name: 'Merged Co (old)', contactStatus: 'ACTIVE' },
  ], { fullRefresh: true });
  // Xero's merge operation archives the losing contact; it does not delete it or reassign its ID.
  mergeEntityCache(org.id, 'contact', [
    { contactID: 'c-absorbed', name: 'Merged Co (old)', contactStatus: 'ARCHIVED' },
  ], { fullRefresh: false });
  const rows = getCachedEntities(org.id, 'contact');
  assert.equal(rows.length, 2, 'the merge does not remove either row from the cache');
  assert.equal(rows.find(r => r.contactID === 'c-absorbed').contactStatus, 'ARCHIVED');
  assert.equal(rows.find(r => r.contactID === 'c-survivor').contactStatus, 'ACTIVE');
  // duplicate_contacts (checkRules.js) filters to contactStatus === 'ACTIVE', so an archived,
  // merged-away contact naturally stops being flagged as a near-duplicate of its survivor on the
  // next analysis — again via the existing status filter, not a merge-specific code path.
});
