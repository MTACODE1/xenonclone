// Phase 5, section 1: cross-client isolation audit. Two organisations are seeded with IDENTICAL
// account codes, check types, and finding content (so any missing org_id condition or shared-key
// collision would show up immediately), then every organisation-scoped setting is changed for org A
// only, and every review-state action is exercised on org A only. Org B must be provably unaffected
// throughout — this is a live, end-to-end proof, not a re-statement of the per-resolver unit tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.XERO_DASHBOARD_DB_PATH = path.join(
  os.tmpdir(), `xero-cross-client-isolation-${process.pid}-${Date.now()}.db`
);

const { getDb } = require('../src/db/schema');
const {
  upsertOrganisation, getOrganisationByTenantId, updateOrganisationCheckConfig,
  upsertChartOfAccountsCache, setAccountCheckConfiguration, getAccountCheckConfigurationForOrg,
  insertIssue, getIssueByCheckType, getIssueFindings, setFindingReviewStates, deleteIssuesForOrg,
  getOrganisationById,
} = require('../src/db/queries');
const {
  resolveMultiAccountSuppliersMinValue, resolveMultiTaxSuppliersMinValue,
  resolveCapitalReviewDefaultThreshold, resolveMisallocatedItemsDefaultThreshold,
  resolveDuplicateInvoiceWindowDays, resolveDuplicateBillWindowDays,
  resolveDuplicateInvoiceRequireExactReference, resolveDuplicateInvoiceIncludeFullyPaid,
  resolveDuplicateInvoiceRequireExactTotal, resolveSupplierPatternLookbackMonths,
  resolveMultiAccountPatternLookbackMonths,
} = require('../src/services/checkRules');

const db = getDb();
upsertOrganisation({ xero_tenant_id: 'iso-org-a', name: 'Isolation Client A', client_ref: null, tag: null, connection_status: 'connected', last_synced_at: null });
upsertOrganisation({ xero_tenant_id: 'iso-org-b', name: 'Isolation Client B', client_ref: null, tag: null, connection_status: 'connected', last_synced_at: null });
const orgA = getOrganisationByTenantId('iso-org-a');
const orgB = getOrganisationByTenantId('iso-org-b');

// Identical chart of accounts for both — the exact scenario that would expose a missing org_id
// filter (a WHERE account_code = ? without org_id would touch both organisations' rows).
const sharedChart = [
  { code: '461', name: 'Printing & Stationery', _class: 'EXPENSE', type: 'EXPENSE' },
  { code: '473', name: 'Repairs & Maintenance', _class: 'EXPENSE', type: 'EXPENSE' },
];
upsertChartOfAccountsCache(orgA.id, sharedChart);
upsertChartOfAccountsCache(orgB.id, sharedChart);

test('changing every organisation-scoped check-config setting for A leaves B on defaults', () => {
  const before = {
    a: getOrganisationById(orgA.id),
    b: getOrganisationById(orgB.id),
  };
  // Every column mutated by the check-config settings form, per src/routes/client.js's
  // '/:tenantId/check-config' route — deliberately far from defaults so any leak is unmissable.
  updateOrganisationCheckConfig(orgA.id, {
    opening_balance_threshold_gbp: 999,
    capital_review_default_threshold_gbp: 12345,
    misallocated_items_default_threshold_gbp: 6789,
    multi_account_suppliers_min_value_gbp: 111,
    multi_tax_suppliers_min_value_gbp: 222,
    purchase_tax_missing_exclude_codes: '999,998',
    duplicate_invoice_window_days: 30,
    duplicate_bill_window_days: 45,
    duplicate_invoice_require_exact_reference: '1',
    duplicate_invoice_include_fully_paid: '1',
    duplicate_bill_require_exact_reference: '1',
    duplicate_bill_include_fully_paid: '1',
    duplicate_invoice_require_exact_total: '0',
    duplicate_bill_require_exact_total: '0',
  });

  const orgANow = getOrganisationById(orgA.id);
  const orgBNow = getOrganisationById(orgB.id);

  // A actually changed.
  assert.equal(orgANow.capital_review_default_threshold_gbp, 12345);
  assert.equal(orgANow.duplicate_invoice_window_days, 30);
  assert.equal(orgANow.duplicate_invoice_require_exact_total, 0);

  // B is byte-for-byte unchanged from before A's update.
  assert.deepEqual(orgBNow, before.b, 'organisation B row must be completely untouched by A\'s settings change');

  // Every resolver, called with B, must still return the practice/documented default — not A's value.
  assert.equal(resolveMultiAccountSuppliersMinValue(orgBNow, 0), 0);
  assert.equal(resolveMultiTaxSuppliersMinValue(orgBNow, 0), 0);
  assert.equal(resolveCapitalReviewDefaultThreshold(orgBNow, 500), 500);
  assert.equal(resolveMisallocatedItemsDefaultThreshold(orgBNow, 100), 100);
  assert.equal(resolveDuplicateInvoiceWindowDays(orgBNow), 3);
  assert.equal(resolveDuplicateBillWindowDays(orgBNow), 3);
  assert.equal(resolveDuplicateInvoiceRequireExactReference(orgBNow), false);
  assert.equal(resolveDuplicateInvoiceIncludeFullyPaid(orgBNow), false);
  assert.equal(resolveDuplicateInvoiceRequireExactTotal(orgBNow), true);
  assert.equal(resolveSupplierPatternLookbackMonths(orgBNow), 12);
  assert.equal(resolveMultiAccountPatternLookbackMonths(orgBNow), 12);

  // And A's resolvers correctly reflect A's own override, proving the isolation isn't just "B is
  // broken and reads nothing" but a genuine per-org distinction.
  assert.equal(resolveCapitalReviewDefaultThreshold(orgANow, 500), 12345);
  assert.equal(resolveDuplicateInvoiceWindowDays(orgANow), 30);
});

test('opting out account 461 for A on a shared account code leaves B\'s 461 configuration untouched', () => {
  setAccountCheckConfiguration(orgA.id, [
    { account_code: '461', is_capital_candidate: 0, purchase_tax_ignore: 1 },
  ]);
  const aConfig = getAccountCheckConfigurationForOrg(orgA.id).find(c => c.account_code === '461');
  const bConfig = getAccountCheckConfigurationForOrg(orgB.id).find(c => c.account_code === '461');
  assert.equal(aConfig.purchase_tax_ignore, 1, 'A\'s explicit opt-out must be saved');
  assert.equal(bConfig.purchase_tax_ignore, 0, 'B\'s same-numbered account 461 must remain unconfigured');
  assert.equal(getOrganisationById(orgB.id).account_settings_initialised, 0,
    'B must not be silently flipped to "explicitly configured" by A\'s save');
});

test('dismissing an identical finding for A leaves B\'s identically-keyed finding active', () => {
  // Identical detail_json on both organisations guarantees an identical finding_key hash (the key
  // is derived from [checkType, identity, occurrence] with no org_id in the digest — see
  // addFindingKeys in checkRules.js) — the sharpest possible test of whether every review-state and
  // finding query genuinely filters by org_id rather than relying on finding_key uniqueness alone.
  const sharedDetail = JSON.stringify([{ id1: 'shared-invoice-a', id2: 'shared-invoice-b', amount: 250 }]);
  insertIssue({
    org_id: orgA.id, check_type: 'duplicate_invoices', importance: 'high',
    count: 1, potential_value_gbp: 250, detail_json: sharedDetail, period_checked: 'iso-period',
  });
  insertIssue({
    org_id: orgB.id, check_type: 'duplicate_invoices', importance: 'high',
    count: 1, potential_value_gbp: 250, detail_json: sharedDetail, period_checked: 'iso-period',
  });
  const issueA = getIssueByCheckType(orgA.id, 'duplicate_invoices');
  const issueB = getIssueByCheckType(orgB.id, 'duplicate_invoices');
  const keyA = getIssueFindings(issueA.id, orgA.id, 1, 50, 'active').items[0].finding_key;
  const keyB = getIssueFindings(issueB.id, orgB.id, 1, 50, 'active').items[0].finding_key;
  assert.equal(keyA, keyB, 'identical input must hash to an identical finding_key (this is the point of the test)');

  setFindingReviewStates(orgA.id, 'duplicate_invoices', [keyA], 'dismissed', 'A only');

  assert.equal(getIssueByCheckType(orgA.id, 'duplicate_invoices').count, 0, 'A\'s finding is dismissed');
  assert.equal(getIssueByCheckType(orgB.id, 'duplicate_invoices').count, 1,
    'B\'s identically-keyed finding must remain active — dismissal must be org-scoped, not key-scoped');
  assert.equal(getIssueFindings(issueB.id, orgB.id, 1, 50, 'dismissed').total, 0);
  assert.equal(getIssueFindings(issueB.id, orgB.id, 1, 50, 'active').total, 1);
});

test('a full-sync-style delete/replace for A does not touch B\'s issues or findings', () => {
  const issueBBefore = getIssueByCheckType(orgB.id, 'duplicate_invoices');
  const findingsBBefore = getIssueFindings(issueBBefore.id, orgB.id, 1, 50, 'all');

  deleteIssuesForOrg(orgA.id);

  assert.equal(getIssueByCheckType(orgA.id, 'duplicate_invoices'), undefined, 'A\'s issue is gone');
  const issueBAfter = getIssueByCheckType(orgB.id, 'duplicate_invoices');
  assert.ok(issueBAfter, 'B\'s issue must survive A\'s full-sync-style wipe');
  assert.equal(issueBAfter.id, issueBBefore.id);
  assert.deepEqual(
    getIssueFindings(issueBAfter.id, orgB.id, 1, 50, 'all'),
    findingsBBefore,
    'B\'s findings must be byte-for-byte unaffected by A\'s deleteIssuesForOrg'
  );
});
