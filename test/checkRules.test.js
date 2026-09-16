const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/xenon-parity.json');
const {
  CHECK_DEFAULTS,
  CHECK_DEFINITIONS,
  RESERVED_PERIOD_LABELS,
  addFindingKeys,
  calculateHealthScore,
  contactNameSimilarity,
  findDirectMatches,
  findDuplicateContacts,
  findDuplicates,
  excludeDuplicateDrafts,
  findUnexpectedDefaultLines,
  findMisallocatedLines,
  resolveCapitalReviewCandidateCodes,
  isOldDocument,
  isPurchaseTaxExemptAccount,
  resolvePeriodChecked,
  resolveCheckDisplayStatus,
  resolveSupplierPatternLookbackMonths,
  resolveMultiAccountPatternLookbackMonths,
  resolveMultiAccountSuppliersMinValue,
  resolveMultiTaxSuppliersMinValue,
  resolveCapitalReviewDefaultThreshold,
  resolveMisallocatedItemsDefaultThreshold,
  resolvePurchaseTaxMissingExcludeCodes,
  resolveDuplicateInvoiceWindowDays,
  resolveDuplicateBillWindowDays,
  selectAuthorisedUnreconciled,
  selectOldCredits,
  sumAbsoluteExposure,
  grossLineAmount,
  netLineAmount,
  withDisplayOnlyBankFindings,
} = require('../src/services/checkRules');

test('registry has exactly 29 unique checks', () => {
  assert.equal(CHECK_DEFINITIONS.length, 29);
  assert.equal(new Set(CHECK_DEFINITIONS.map(check => check.type)).size, 29);
  assert.ok(CHECK_DEFINITIONS.every(check => check.type && check.importance && check.label));
});

test('documented defaults remain explicit and stable', () => {
  assert.deepEqual(CHECK_DEFAULTS, {
    duplicateWindowDays: 3,
    duplicateBillWindowDays: 3,
    oldDocumentDays: 60,
    directMatchWindowDays: 30,
    contactSimilarityThreshold: 0.9,
  });
});

test('unreconciled selection unions authorised bank items and payments only', () => {
  const selected = selectAuthorisedUnreconciled(
    fixture.unreconciled.bankTransactions,
    fixture.unreconciled.payments
  );
  assert.equal(selected.length, fixture.unreconciled.expectedCount);
  assert.deepEqual(selected.map(item => item.source), ['bank', 'payment']);
  assert.equal(
    sumAbsoluteExposure(selected, item => item.total ?? item.amount),
    fixture.unreconciled.expectedExposure
  );
});

test('unreconciled payments are restricted to genuine bank accounts', () => {
  const payments = [
    { paymentID: 'on-bank', status: 'AUTHORISED', isReconciled: false, account: { accountID: 'bank-1' }, amount: 120 },
    { paymentID: 'on-suspense', status: 'AUTHORISED', isReconciled: false, account: { accountID: 'suspense' }, amount: 300 },
    { paymentID: 'no-account', status: 'AUTHORISED', isReconciled: false, amount: 40 },
  ];
  const selected = selectAuthorisedUnreconciled([], payments, new Set(['bank-1']));
  assert.deepEqual(selected.map(item => item.paymentID), ['on-bank']);

  // Without a chart of accounts the payment side stays unfiltered rather than silently empty.
  assert.equal(selectAuthorisedUnreconciled([], payments).length, 3);
});

test('bankAccountIds also excludes specific bank accounts on the bank-transaction side — Xenon\'s per-account exclusion', () => {
  const bankTransactions = [
    { bankTransactionID: 'kept', status: 'AUTHORISED', isReconciled: false, bankAccount: { accountID: 'bank-1' }, total: 50 },
    { bankTransactionID: 'excluded', status: 'AUTHORISED', isReconciled: false, bankAccount: { accountID: 'bank-2' }, total: 75 },
  ];
  // A practice excludes bank-2 (e.g. a dormant account) by passing only the remaining accounts.
  const selected = selectAuthorisedUnreconciled(bankTransactions, [], new Set(['bank-1']));
  assert.deepEqual(selected.map(item => item.bankTransactionID), ['kept']);

  // With no bankAccountIds at all (no exclusions configured), nothing is filtered — every
  // currently-validated client's behaviour is unchanged by this filter existing.
  assert.equal(selectAuthorisedUnreconciled(bankTransactions, []).length, 2);
});

test('unreconciled selection is scoped to the selected period, not to all history', () => {
  const { resolvePeriod, isWithinPeriod } = require('../src/services/periodResolver');
  const period = resolvePeriod(
    { type: 'since_lock_date' },
    { lockDate: '2025-10-31', asOf: '2026-08-09' }
  );
  const selected = selectAuthorisedUnreconciled([
    { bankTransactionID: 'pre-lock', status: 'AUTHORISED', isReconciled: false, date: '2019-04-02', total: 500 },
    { bankTransactionID: 'on-lock-date', status: 'AUTHORISED', isReconciled: false, date: '2025-10-31', total: 40 },
    { bankTransactionID: 'in-period', status: 'AUTHORISED', isReconciled: false, date: '2026-02-11', total: 250 },
    { bankTransactionID: 'after-period', status: 'AUTHORISED', isReconciled: false, date: '2026-12-01', total: 90 },
  ], []).filter(item => isWithinPeriod(String(item.date).slice(0, 10), period));

  // Xenon "since lock date" excludes the lock date itself (Rose PT/unexpected-account evidence).
  assert.deepEqual(selected.map(item => item.bankTransactionID), ['in-period']);
  assert.equal(isWithinPeriod('2025-10-31', period), false);
  assert.equal(isWithinPeriod('2025-11-01', period), true);
});

test('reanalysis fetches fresh Xero data for the active period and uses cache for a preview period', () => {
  const { shouldUseCacheOnlyForReanalysis } = require('../src/services/periodResolver');
  const active = 'since_lock_date:2025-10-31:2026-08-07';
  assert.equal(shouldUseCacheOnlyForReanalysis(active, active), false);
  assert.equal(
    shouldUseCacheOnlyForReanalysis(active, 'rolling_12_months:2025-08-08:2026-08-07'),
    true
  );
  assert.equal(shouldUseCacheOnlyForReanalysis(null, active), false);
});

test('absolute exposure prevents credits from cancelling debits', () => {
  assert.equal(sumAbsoluteExposure([{ amount: 100 }, { amount: -40 }]), 140);
});

test('unexpected defaults count each offending line', () => {
  const { documents, contactsById } = fixture.unexpectedDefaults;
  const accountLines = findUnexpectedDefaultLines(
    documents, contactsById, 'purchasesDefaultAccountCode', 'accountCode'
  );
  const taxLines = findUnexpectedDefaultLines(
    documents, contactsById, 'accountsPayableTaxType', 'taxType'
  );
  assert.equal(accountLines.length, fixture.unexpectedDefaults.expectedAccountLines);
  assert.equal(taxLines.length, fixture.unexpectedDefaults.expectedTaxLines);
  assert.equal(
    sumAbsoluteExposure(accountLines, finding => finding.line.lineAmount),
    fixture.unexpectedDefaults.expectedExposure
  );
});

test('purchase tax exemptions exclude core non-VAT accounts but include bank and processor fees', () => {
  const overrides = new Set(['999']);
  assert.equal(isPurchaseTaxExemptAccount('Payroll Costs', overrides, '100'), true);
  assert.equal(isPurchaseTaxExemptAccount('Corporation Tax', overrides, '101'), true);
  assert.equal(isPurchaseTaxExemptAccount('Bank Interest', overrides, '102'), true);
  // Plain "Interest Paid" is in Xenon's Fast Track purchase-tax set (2 lines / £1259);
  // only bank interest stays exempt.
  assert.equal(isPurchaseTaxExemptAccount('Interest Paid', overrides, '437'), false);
  // Xenon counts bank fee lines on every measured client, so they are not exempt by default;
  // practices that do exclude them configure it per client.
  assert.equal(isPurchaseTaxExemptAccount('Bank Fees', overrides, '105'), false);
  assert.equal(isPurchaseTaxExemptAccount('Bank Charges', overrides, '106'), false);
  assert.equal(isPurchaseTaxExemptAccount('PayPal Processing Fees', overrides, '103'), false);
  assert.equal(isPurchaseTaxExemptAccount('Merchant Card Charges', overrides, '104'), false);
  assert.equal(isPurchaseTaxExemptAccount('Ordinary Expense', overrides, '999'), true);
  // Residual census: Rates / donations / mileage match Xenon count+£ on MBX and Handymanz.
  assert.equal(isPurchaseTaxExemptAccount('Rates', overrides, '465'), true);
  assert.equal(isPurchaseTaxExemptAccount('Business Rates', overrides, '466'), true);
  assert.equal(isPurchaseTaxExemptAccount('Charitable and Political Donations', overrides, '418'), true);
  assert.equal(isPurchaseTaxExemptAccount('Mileage', overrides, '329'), true);
  // Rent is ordinarily VATable — do not treat the combined rent account as rates-only.
  assert.equal(isPurchaseTaxExemptAccount('Rent & Rates', overrides, '469'), false);
});

test('a duplicate group is one issue worth one document amount, not one per extra or per pair', () => {
  // Four £120 invoices for one customer: three on 10 Jan, one on 11 Jan. Within a 3-day window
  // that is a SINGLE suspected duplicate worth £120 once — not 3 extras (£360) and not 6 pairs.
  const groups = findDuplicates(fixture.duplicates);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].documentCount, 4);
  assert.equal(sumAbsoluteExposure(groups), 120);
  assert.deepEqual(groups[0].documentIds.sort(), ['inv-1', 'inv-2', 'inv-3', 'inv-next-day']);
  // id1/id2 span the group's earliest and latest members so pair-shaped rendering still works.
  assert.equal(groups[0].date1, '2026-01-10');
  assert.equal(groups[0].date2, '2026-01-11');

  // A 0-day window splits the 11 Jan invoice out, leaving only the same-day group.
  const sameDayOnly = findDuplicates(fixture.duplicates, 0);
  assert.equal(sameDayOnly.length, 1);
  assert.equal(sameDayOnly[0].documentCount, 3);
  assert.equal(sumAbsoluteExposure(sameDayOnly), 120);
});

test('grouping is greedy from the newest document, matching Xenon group boundaries', () => {
  // Xenon's 4X4 export keeps groups two days apart separate while allowing three days inside a
  // group, which only a newest-first greedy anchor reproduces. Dates: 20, 22, 23 | 15, 17.
  const invoice = (id, date) => ({
    invoiceID: id, date, total: 50, contact: { contactID: 'c', name: 'Unknown' },
  });
  const groups = findDuplicates([
    invoice('a', '2026-06-20'), invoice('b', '2026-06-22'), invoice('c', '2026-06-23'),
    invoice('d', '2026-06-15'), invoice('e', '2026-06-17'),
  ], 3);
  assert.equal(groups.length, 2);
  // Newest group first, anchored on 23 June and reaching back to 20 June.
  assert.deepEqual(groups[0].documentIds.sort(), ['a', 'b', 'c']);
  // 17 June anchors the second group; 15 June joins it and does not merge with the first.
  assert.deepEqual(groups[1].documentIds.sort(), ['d', 'e']);
  assert.equal(sumAbsoluteExposure(groups), 100);
});

test('bill duplicates use a 3-day window and keep pairs with at least one unpaid bill', () => {
  const bills = [
    // Cross-day unpaid twins — counted
    { invoiceID: 'a', contact: { contactID: 'napa' }, date: '2026-06-09', total: 12.16, amountDue: 12.16, invoiceNumber: 'NCUV392876' },
    { invoiceID: 'b', contact: { contactID: 'napa' }, date: '2026-06-12', total: 12.16, amountDue: 12.16, invoiceNumber: 'NCUV393311' },
    // Paid twin of an unpaid bill — counted
    { invoiceID: 'c', contact: { contactID: 'fuel' }, date: '2024-05-31', total: 20.4, amountDue: 20.4, invoiceNumber: 'RB1' },
    { invoiceID: 'd', contact: { contactID: 'fuel' }, date: '2024-05-31', total: 20.4, amountDue: 0, invoiceNumber: '9001' },
    // Both fully paid — excluded
    { invoiceID: 'e', contact: { contactID: 'banoze' }, date: '2026-02-17', total: 108.72, amountDue: 0, invoiceNumber: 'BNZM1' },
    { invoiceID: 'f', contact: { contactID: 'banoze' }, date: '2026-02-18', total: 108.72, amountDue: 0, invoiceNumber: 'BNZM2' },
  ];
  const found = findDuplicates(bills, 3, { requireUnpaidPair: true });
  // One group per suspected duplicate, and the fully-paid pair is dropped entirely.
  assert.deepEqual(found.map(group => group.documentIds.sort()).sort(), [
    ['a', 'b'],
    ['c', 'd'],
  ].sort());
  // Value is each group's amount counted once: 12.16 + 20.40.
  assert.equal(Number(sumAbsoluteExposure(found).toFixed(2)), 32.56);
});

test('excludeDuplicateDrafts drops a whole duplicate cluster, matching RBC Sutherland Ltd real evidence', () => {
  // Real RBC Sutherland Ltd data: 6 identical £24,164.34 drafts for one contact, all dated the
  // same day (saved repeatedly within a 10-minute window), plus two genuine one-off drafts.
  // Xenon's real Unapproved Invoices for this client is exactly 2/£40,907 — the two singles,
  // with the whole 6-invoice cluster excluded (not collapsed to one representative).
  const contact = { contactID: 'scargall' };
  const drafts = [
    ...['711', '735', '572', '57200', '386', '432'].map(number => ({
      invoiceID: `inv-${number}`, invoiceNumber: number, date: '2026-03-01', total: 24164.34, contact,
    })),
    { invoiceID: 'inv-mosley', invoiceNumber: 'M1', date: '2026-03-02', total: 10000, contact: { contactID: 'mosley' } },
    { invoiceID: 'inv-mk', invoiceNumber: 'MK1', date: '2026-03-08', total: 30907, contact: { contactID: 'mk' } },
  ];
  const kept = excludeDuplicateDrafts(drafts);
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map(i => i.invoiceID).sort(), ['inv-mk', 'inv-mosley']);
  assert.equal(sumAbsoluteExposure(kept, i => i.total), 40907);
});

test('old documents age from document date, not due date', () => {
  assert.equal(isOldDocument({ date: '2026-01-01', dueDate: '2026-12-31' }, '2026-03-03'), true);
  assert.equal(isOldDocument({ date: '2026-01-02', dueDate: '2026-01-03' }, '2026-03-03'), false);
});

test('old credits require a supported status, document age and positive remaining credit', () => {
  const credits = selectOldCredits([
    { creditNoteID: 'authorised', status: 'AUTHORISED', date: '2026-01-01', dueDate: '2027-01-01', remainingCredit: 10 },
    { creditNoteID: 'submitted', status: 'SUBMITTED', date: '2026-01-01', remainingCredit: 5 },
    { creditNoteID: 'paid', status: 'PAID', date: '2026-01-01', remainingCredit: 10 },
    { creditNoteID: 'allocated', status: 'AUTHORISED', date: '2026-01-01', remainingCredit: 0 },
    { creditNoteID: 'recent', status: 'AUTHORISED', date: '2026-02-01', remainingCredit: 10 },
  ], '2026-03-03');
  assert.deepEqual(credits.map(credit => credit.creditNoteID), ['authorised', 'submitted']);
});

test('direct matching accepts only payments zero to 30 days after the document', () => {
  const matches = findDirectMatches(
    fixture.directMatch.transactions,
    fixture.directMatch.documents,
    new Set(['200'])
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].document.invoiceID, 'doc-before');
});

test('direct matching consumes each document once and prefers the nearest date', () => {
  const documents = [
    { invoiceID: 'far', date: '2026-01-01', status: 'AUTHORISED', amountDue: 100, contact: { contactID: 'c' } },
    { invoiceID: 'near', date: '2026-01-10', status: 'DRAFT', total: 100, contact: { contactID: 'c' } },
  ];
  const transactions = [
    { bankTransactionID: 't1', date: '2026-01-11', total: 100, contact: { contactID: 'c' }, lineItems: [{ accountCode: '200' }] },
    { bankTransactionID: 't2', date: '2026-01-12', total: 100, contact: { contactID: 'c' }, lineItems: [{ accountCode: '200' }] },
    { bankTransactionID: 't3', date: '2026-01-13', total: 100, contact: { contactID: 'c' }, lineItems: [{ accountCode: '200' }] },
  ];
  const matches = findDirectMatches(transactions, documents, new Set(['200']));
  assert.equal(matches.length, 2);
  assert.equal(matches[0].document.invoiceID, 'near');
  assert.equal(matches[1].document.invoiceID, 'far');
});

// Threshold raised from 70% to 90% on 7 Sep 2026, cross-checked against the practice's own real
// Xenon general settings ("Contact name similarity score is at least 90%") — see CHECK_DEFAULTS.
test('duplicate contacts use normalized 90 percent similarity', () => {
  assert.ok(contactNameSimilarity(fixture.contactNames[0].name, fixture.contactNames[1].name) >= 0.9);
  assert.equal(findDuplicateContacts(fixture.contactNames).length, 1);
  // A pair that would have been flagged at the old 70% threshold (differs by "Ltd" vs "Limited",
  // ~83% similar) must NOT be flagged at 90% — proves the threshold actually moved, not just the
  // fixture getting easier to pass.
  assert.ok(contactNameSimilarity('Northstar Supplies Ltd', 'Northstar Supplies Limited') < 0.9);
});

test('bank wrong-direction tax findings are display-only', () => {
  const result = withDisplayOnlyBankFindings(
    [{ source: 'bill', amount: -20 }],
    [{ source: 'bank_spend', amount: 500 }]
  );
  assert.equal(result.count, 1);
  assert.equal(result.potentialValue, 20);
  assert.equal(result.details[1].displayOnly, true);
});

test('finding keys are stable and distinguish finding granularity', () => {
  const rows = [
    { invoiceId: 'doc-1', lineItemId: 'line-1', accountCode: '200', amount: 10 },
    { id1: 'contact-2', id2: 'contact-1' },
    { contactId: 'contact-3', name: 'Example' },
    { accountId: 'account-1', discrepancy: 2 },
  ];
  const first = addFindingKeys('example_check', rows);
  const second = addFindingKeys('example_check', rows);
  assert.deepEqual(first.map(row => row.finding_key), second.map(row => row.finding_key));
  assert.deepEqual(first.map(row => row.finding_key.split(':')[0]), ['line', 'pair', 'contact', 'account']);
  assert.equal(new Set(first.map(row => row.finding_key)).size, rows.length);
});

test('pair finding keys are order-independent and pair-specific', () => {
  const forward = addFindingKeys('duplicate_invoices', [{ id1: 'invoice-a', id2: 'invoice-b' }])[0];
  const reversed = addFindingKeys('duplicate_invoices', [{ id1: 'invoice-b', id2: 'invoice-a' }])[0];
  const otherPair = addFindingKeys('duplicate_invoices', [{ id1: 'invoice-a', id2: 'invoice-c' }])[0];
  assert.equal(forward.finding_key, reversed.finding_key);
  assert.notEqual(forward.finding_key, otherPair.finding_key);

  const direct = addFindingKeys('invoice_or_direct', [{
    bankTransactionId: 'bank-1', invoiceId: 'invoice-a', amount: 100,
  }])[0];
  assert.equal(
    direct.finding_key,
    addFindingKeys('invoice_or_direct', [{
      invoiceId: 'invoice-a', bankTransactionId: 'bank-1', amount: 999,
    }])[0].finding_key
  );
});

test('fail-safe score ignores null and zero counts', () => {
  const baseline = calculateHealthScore([]);
  assert.equal(calculateHealthScore([
    { check_type: 'unprocessed_bank', importance: 'critical', count: null },
    { check_type: 'bank_balance', importance: 'critical', count: 0 },
  ]), baseline);
  // A real issue always deducts. One low-volume critical issue deducts well under half a point on
  // the calibrated scale, so assert on the deduction itself rather than the rounded percentage.
  const { calculateScoreBreakdown } = require('../src/services/scoreProfile');
  const single = calculateScoreBreakdown([
    { check_type: 'bank_balance', importance: 'critical', count: 1 },
  ]);
  assert.ok(single.totalDeduction > 0);
  assert.ok(single.score <= baseline);
});

// --- resolvePeriodChecked / RESERVED_PERIOD_LABELS ---
// xeroSync.js's persistIssue and statementEvidence.js's recomputeEvidenceIssues both
// unconditionally overwrote a check's own period_checked with the sync's period key, so
// capital_item_review/bank_balance/unprocessed_bank could never persist their intended
// "not_configured"/"needs_sync" label — every unconfigured check displayed as generic
// "Not synced" instead. resolvePeriodChecked is the single place both write paths now decide
// what to persist.

test('a semantic label survives instead of being replaced by the active period key', () => {
  for (const label of RESERVED_PERIOD_LABELS) {
    assert.equal(resolvePeriodChecked(label, 'since_lock_date:2025-10-31:2026-08-13'), label);
  }
});

test('a normal calculated check still receives the real period key', () => {
  assert.equal(
    resolvePeriodChecked(undefined, 'since_lock_date:2025-10-31:2026-08-13'),
    'since_lock_date:2025-10-31:2026-08-13'
  );
  // A dated label a check sets itself (e.g. opening_balance_differences' own
  // "filed_accounts_2025-10-31") is NOT a reserved label, so it still yields to the active
  // period key exactly as before this fix — only the five reserved strings are protected.
  assert.equal(
    resolvePeriodChecked('filed_accounts_2025-10-31', 'since_lock_date:2025-10-31:2026-08-13'),
    'since_lock_date:2025-10-31:2026-08-13'
  );
});

test('with no active period key, a non-reserved label falls back to itself rather than becoming null', () => {
  assert.equal(resolvePeriodChecked('imported_statements_2026-07-31', null), 'imported_statements_2026-07-31');
  assert.equal(resolvePeriodChecked(undefined, null), undefined);
});

test('RESERVED_PERIOD_LABELS contains exactly the six semantic states, nothing else', () => {
  // 'not_vat_registered' and 'not_applicable_freeagent' (both the not_applicable category) joined
  // the other four across sessions — see periodStatus.js for the full model. This test exists
  // specifically to catch a future label being added without updating resolveCheckDisplayStatus to
  // handle it.
  assert.deepEqual([...RESERVED_PERIOD_LABELS].sort(), [
    'needs_sync', 'not_applicable_freeagent', 'not_configured', 'not_vat_registered',
    'out_of_scope', 'unavailable',
  ]);
});

// Confirmed bug this fixes: sales_tax_missing/purchase_tax_missing write
// period_checked: 'not_vat_registered' for a client whose Xero salesTaxBasis is 'NONE', but before
// it was added to RESERVED_PERIOD_LABELS it was silently overwritten by the sync's real period key
// — a non-VAT-registered client's zero-findings result was then indistinguishable in storage from
// a VAT-registered client that was checked and genuinely found nothing.
test('not_vat_registered survives resolvePeriodChecked across every kind of active period key', () => {
  // The active period key differs between a full sync (a real since_lock_date/custom/etc. key) and
  // a single-check reanalysis (still a real key, just resolved from a possibly different selected
  // period) — resolvePeriodChecked has no branch that behaves differently between those two
  // callers, so proving preservation holds for several distinct key shapes covers both paths.
  for (const activeKey of [
    'since_lock_date:2025-10-31:2026-09-07',
    'custom:2019-11-30:2026-08-07',
    'rolling_12_months:2025-09-08:2026-09-07',
    null,
  ]) {
    assert.equal(resolvePeriodChecked('not_vat_registered', activeKey), 'not_vat_registered');
  }
});

// --- resolveCheckDisplayStatus ---
// The single source of truth the dashboard UI and the health score both read from, so the two can
// never disagree about what a persisted issue means.

test('resolveCheckDisplayStatus: not_applicable is distinct from ok, even though both carry count: 0', () => {
  assert.equal(
    resolveCheckDisplayStatus({ period_checked: 'not_vat_registered', count: 0 }),
    'not_applicable'
  );
  assert.equal(
    resolveCheckDisplayStatus({ period_checked: 'since_lock_date:2025-10-31:2026-09-07', count: 0 }),
    'ok'
  );
});

test('resolveCheckDisplayStatus: issues, not_configured, unavailable, and not_synced resolve correctly', () => {
  assert.equal(
    resolveCheckDisplayStatus({ period_checked: 'since_lock_date:2025-10-31:2026-09-07', count: 5 }),
    'issues'
  );
  assert.equal(resolveCheckDisplayStatus({ period_checked: 'not_configured', count: null }), 'not_configured');
  assert.equal(resolveCheckDisplayStatus({ period_checked: 'needs_sync', count: null }), 'not_configured');
  assert.equal(resolveCheckDisplayStatus({ period_checked: 'unavailable', count: null }), 'unavailable');
  assert.equal(resolveCheckDisplayStatus({ period_checked: 'out_of_scope', count: null }), 'unavailable');
  assert.equal(
    resolveCheckDisplayStatus({ period_checked: 'since_lock_date:2025-10-31:2026-09-07', count: null }),
    'not_synced'
  );
});

test('resolveCheckDisplayStatus: unavailable/not_configured take precedence if a check ever wrote both a reserved label and a null count', () => {
  // Defensive ordering test: unavailable and not_configured checks always carry count: null in
  // practice, so they must be resolved before the null-count fallback claims them as "not_synced".
  assert.equal(resolveCheckDisplayStatus({ period_checked: 'unavailable', count: null }), 'unavailable');
  assert.equal(resolveCheckDisplayStatus({ period_checked: 'not_configured', count: null }), 'not_configured');
});

// grossLineAmount/netLineAmount — shared so every check reading line.lineAmount for a total or
// threshold comparison can use a consistent VAT basis instead of trusting Xero's mixed
// Inclusive/Exclusive convention directly. Fixed a real Multi-Account/Multi-Tax Suppliers value
// bug on Fast Track Excavations (see xeroSync.js); locked here so it can't silently regress.

test('grossLineAmount: Inclusive lines are already gross, Exclusive/NoTax lines need taxAmount added', () => {
  assert.equal(grossLineAmount('Inclusive', { lineAmount: 100, taxAmount: 20 }), 100);
  assert.equal(grossLineAmount('Exclusive', { lineAmount: 100, taxAmount: 20 }), 120);
  assert.equal(grossLineAmount('NoTax', { lineAmount: 100, taxAmount: 0 }), 100);
});

test('netLineAmount: Exclusive lines are already net, Inclusive lines need taxAmount subtracted', () => {
  assert.equal(netLineAmount('Exclusive', { lineAmount: 100, taxAmount: 20 }), 100);
  assert.equal(netLineAmount('Inclusive', { lineAmount: 120, taxAmount: 20 }), 100);
  assert.equal(netLineAmount('NoTax', { lineAmount: 100, taxAmount: 0 }), 100);
});

test('gross and net always differ by exactly taxAmount, regardless of lineAmountTypes', () => {
  for (const lineAmountTypes of ['Inclusive', 'Exclusive', 'NoTax', undefined]) {
    const line = { lineAmount: 87.5, taxAmount: 17.5 };
    assert.equal(
      grossLineAmount(lineAmountTypes, line) - netLineAmount(lineAmountTypes, line),
      line.taxAmount
    );
  }
});

test('grossLineAmount/netLineAmount default missing lineAmount/taxAmount to zero rather than throwing', () => {
  assert.equal(grossLineAmount('Exclusive', {}), 0);
  assert.equal(netLineAmount('Inclusive', {}), 0);
});

// resolveSupplierPatternLookbackMonths — Xenon's own docs for Multi-Account/Multi-Tax Code
// Suppliers state the lookback is 3 months by default and changeable per client; this app's
// 12-month value is its own fallback, tuned before this setting existed, and must stay the
// default for any client without an explicit override so already-validated clients don't change.

test('resolveSupplierPatternLookbackMonths defaults to 12 when unset, null, or invalid', () => {
  assert.equal(resolveSupplierPatternLookbackMonths({}), 12);
  assert.equal(resolveSupplierPatternLookbackMonths({ supplier_pattern_lookback_months: null }), 12);
  assert.equal(resolveSupplierPatternLookbackMonths({ supplier_pattern_lookback_months: 0 }), 12);
  assert.equal(resolveSupplierPatternLookbackMonths({ supplier_pattern_lookback_months: -3 }), 12);
  assert.equal(resolveSupplierPatternLookbackMonths(undefined), 12);
});

test('resolveSupplierPatternLookbackMonths uses a configured positive value, matching Xenon\'s own per-client setting', () => {
  assert.equal(resolveSupplierPatternLookbackMonths({ supplier_pattern_lookback_months: 3 }), 3);
  assert.equal(resolveSupplierPatternLookbackMonths({ supplier_pattern_lookback_months: 6 }), 6);
});

// resolveMultiAccountPatternLookbackMonths — multi-account documents the identical "3 months
// prior, changeable per client" rule as multi-tax above, but must not share multi-tax's column:
// widening one client's multi-tax lookback (e.g. Handymanz to 18 months) must not also widen
// their separately-validated multi-account default.

test('resolveMultiAccountPatternLookbackMonths defaults to 12 when unset, null, or invalid', () => {
  assert.equal(resolveMultiAccountPatternLookbackMonths({}), 12);
  assert.equal(resolveMultiAccountPatternLookbackMonths({ multi_account_pattern_lookback_months: null }), 12);
  assert.equal(resolveMultiAccountPatternLookbackMonths({ multi_account_pattern_lookback_months: 0 }), 12);
  assert.equal(resolveMultiAccountPatternLookbackMonths({ multi_account_pattern_lookback_months: -3 }), 12);
  assert.equal(resolveMultiAccountPatternLookbackMonths(undefined), 12);
});

test('resolveMultiAccountPatternLookbackMonths uses a configured positive value independent of supplier_pattern_lookback_months', () => {
  assert.equal(resolveMultiAccountPatternLookbackMonths({ multi_account_pattern_lookback_months: 3 }), 3);
  assert.equal(resolveMultiAccountPatternLookbackMonths({
    multi_account_pattern_lookback_months: 3, supplier_pattern_lookback_months: 18,
  }), 3);
});

// Config-isolation resolvers (2026-09) — each takes (org, practiceDefault) and must fall through to
// the practice default unchanged when the organisation has no override, so every currently-validated
// client's behaviour is untouched by these columns simply existing.

test('resolveMultiAccountSuppliersMinValue falls through to the practice default when unset', () => {
  assert.equal(resolveMultiAccountSuppliersMinValue({}, 0), 0);
  assert.equal(resolveMultiAccountSuppliersMinValue({ multi_account_suppliers_min_value_gbp: null }, 25), 25);
  assert.equal(resolveMultiAccountSuppliersMinValue(undefined, 25), 25);
});

test('resolveMultiAccountSuppliersMinValue uses a configured organisation override, including zero', () => {
  assert.equal(resolveMultiAccountSuppliersMinValue({ multi_account_suppliers_min_value_gbp: 50 }, 0), 50);
  assert.equal(resolveMultiAccountSuppliersMinValue({ multi_account_suppliers_min_value_gbp: 0 }, 25), 0);
});

test('resolveMultiTaxSuppliersMinValue falls through to the practice default when unset', () => {
  assert.equal(resolveMultiTaxSuppliersMinValue({}, 0), 0);
  assert.equal(resolveMultiTaxSuppliersMinValue({ multi_tax_suppliers_min_value_gbp: null }, 10), 10);
  assert.equal(resolveMultiTaxSuppliersMinValue(undefined, 10), 10);
});

test('resolveMultiTaxSuppliersMinValue uses a configured organisation override, independent of multi-account\'s', () => {
  assert.equal(resolveMultiTaxSuppliersMinValue({ multi_tax_suppliers_min_value_gbp: 15 }, 0), 15);
  assert.equal(resolveMultiTaxSuppliersMinValue(
    { multi_tax_suppliers_min_value_gbp: 15, multi_account_suppliers_min_value_gbp: 999 }, 0
  ), 15);
});

test('resolveCapitalReviewDefaultThreshold falls through to the practice default when unset or invalid', () => {
  assert.equal(resolveCapitalReviewDefaultThreshold({}, 500), 500);
  assert.equal(resolveCapitalReviewDefaultThreshold({ capital_review_default_threshold_gbp: null }, 500), 500);
  assert.equal(resolveCapitalReviewDefaultThreshold({ capital_review_default_threshold_gbp: -10 }, 500), 500);
});

test('resolveCapitalReviewDefaultThreshold uses a configured organisation override', () => {
  assert.equal(resolveCapitalReviewDefaultThreshold({ capital_review_default_threshold_gbp: 200 }, 500), 200);
  assert.equal(resolveCapitalReviewDefaultThreshold({ capital_review_default_threshold_gbp: 0 }, 500), 0);
});

test('resolveMisallocatedItemsDefaultThreshold falls through to the practice default when unset', () => {
  assert.equal(resolveMisallocatedItemsDefaultThreshold({}, 100), 100);
  assert.equal(resolveMisallocatedItemsDefaultThreshold({ misallocated_items_default_threshold_gbp: null }, 100), 100);
});

test('resolveMisallocatedItemsDefaultThreshold uses a configured organisation override', () => {
  assert.equal(resolveMisallocatedItemsDefaultThreshold({ misallocated_items_default_threshold_gbp: 250 }, 100), 250);
});

test('resolvePurchaseTaxMissingExcludeCodes falls through to the practice default when null/absent', () => {
  assert.equal(resolvePurchaseTaxMissingExcludeCodes({}, '404,501'), '404,501');
  assert.equal(resolvePurchaseTaxMissingExcludeCodes(undefined, '404,501'), '404,501');
});

test('resolvePurchaseTaxMissingExcludeCodes treats an explicit empty-string override as "no exclusions", not "unset"', () => {
  assert.equal(resolvePurchaseTaxMissingExcludeCodes({ purchase_tax_missing_exclude_codes: '' }, '404,501'), '');
  assert.equal(resolvePurchaseTaxMissingExcludeCodes({ purchase_tax_missing_exclude_codes: '999' }, '404,501'), '999');
});

test('resolveDuplicateInvoiceWindowDays defaults to the practice value (CHECK_DEFAULTS.duplicateWindowDays) when unset', () => {
  assert.equal(resolveDuplicateInvoiceWindowDays({}), CHECK_DEFAULTS.duplicateWindowDays);
  assert.equal(resolveDuplicateInvoiceWindowDays({ duplicate_invoice_window_days: null }), CHECK_DEFAULTS.duplicateWindowDays);
  assert.equal(resolveDuplicateInvoiceWindowDays(undefined), CHECK_DEFAULTS.duplicateWindowDays);
});

test('resolveDuplicateInvoiceWindowDays uses a configured organisation override, including Xenon\'s documented 1-day default', () => {
  assert.equal(resolveDuplicateInvoiceWindowDays({ duplicate_invoice_window_days: 1 }), 1);
  assert.equal(resolveDuplicateInvoiceWindowDays({ duplicate_invoice_window_days: 0 }), 0);
});

test('resolveDuplicateBillWindowDays defaults to the practice value (CHECK_DEFAULTS.duplicateBillWindowDays) when unset', () => {
  assert.equal(resolveDuplicateBillWindowDays({}), CHECK_DEFAULTS.duplicateBillWindowDays);
  assert.equal(resolveDuplicateBillWindowDays({ duplicate_bill_window_days: null }), CHECK_DEFAULTS.duplicateBillWindowDays);
});

test('resolveDuplicateBillWindowDays uses a configured organisation override independent of the invoice window', () => {
  assert.equal(resolveDuplicateBillWindowDays({ duplicate_bill_window_days: 1, duplicate_invoice_window_days: 5 }), 1);
});

test('a VAT-only Inclusive line nets to zero while remaining a real, non-zero gross amount', () => {
  // Regression guard for the bug this shape caused: a line that is entirely VAT (e.g. an
  // import-VAT adjustment) has net=0 but must not be mistaken for a genuinely empty £0.00 line —
  // callers must gate "does this line have real value" on the raw lineAmount, not on
  // netLineAmount's output, or a real transaction silently disappears from detection.
  const vatOnlyLine = { lineAmount: 24, taxAmount: 24 };
  assert.equal(netLineAmount('Inclusive', vatOnlyLine), 0);
  assert.notEqual(vatOnlyLine.lineAmount, 0);
});

// --- Cross-client isolation ---
// The completion audit's #1 architectural risk: a setting change intended for one client must
// never alter another client's result. Every config-isolation resolver takes the organisation row
// as a plain argument (no shared/global lookup keyed by anything other than that argument), so
// isolation is structural — these tests exist to prove and lock that in, not to discover it.

test('organisation-scoped overrides cannot leak between two different organisations', () => {
  const clientA = { id: 1, multi_account_suppliers_min_value_gbp: 500 };
  const clientB = { id: 2 }; // no override at all

  assert.equal(resolveMultiAccountSuppliersMinValue(clientA, 0), 500);
  // Client B must still see the practice default, completely unaffected by client A's override,
  // even though both calls happen in the same process using the same practiceDefault argument.
  assert.equal(resolveMultiAccountSuppliersMinValue(clientB, 0), 0);
});

test('a per-account override for one organisation cannot alter the same account code for another', () => {
  // account_override lives in chart_of_accounts_cache keyed by (org_id, account_code) — the
  // resolvers here only ever see the org-level fields already scoped to a single organisation's
  // row, so there is no code path by which reading org A's columns could return org B's values.
  const orgA = { id: 1, capital_review_default_threshold_gbp: 200 };
  const orgB = { id: 2, capital_review_default_threshold_gbp: 750 };
  assert.equal(resolveCapitalReviewDefaultThreshold(orgA, 500), 200);
  assert.equal(resolveCapitalReviewDefaultThreshold(orgB, 500), 750);
  assert.notEqual(
    resolveCapitalReviewDefaultThreshold(orgA, 500),
    resolveCapitalReviewDefaultThreshold(orgB, 500)
  );
});

test('duplicate window overrides are independent per organisation and per check', () => {
  const orgA = { id: 1, duplicate_invoice_window_days: 1 }; // Xenon's documented default
  const orgB = { id: 2, duplicate_invoice_window_days: 3 }; // this practice's calibrated default
  assert.equal(resolveDuplicateInvoiceWindowDays(orgA), 1);
  assert.equal(resolveDuplicateInvoiceWindowDays(orgB), 3);
  // Neither organisation configured a bill window, so both fall through to the same practice
  // default — that's the correct SHARED fallback behaviour, not leakage between organisations.
  assert.equal(resolveDuplicateBillWindowDays(orgA), CHECK_DEFAULTS.duplicateBillWindowDays);
  assert.equal(resolveDuplicateBillWindowDays(orgB), CHECK_DEFAULTS.duplicateBillWindowDays);
});

// --- Misallocated Items (findMisallocatedLines) ---
// Xenon's Misallocated Items documentation covers four sources: Supplier Bill Line Items, Customer
// Invoice Line Items, Money Out, and Money In. This was a confirmed coverage gap — the check only
// ever scanned bills and Money Out. findMisallocatedLines is called once per source with that
// source's own monitored-codes set, so these tests exercise it directly rather than through a live
// sync (the calling logic in xeroSync.js is inline and not itself independently testable).

test('findMisallocatedLines flags a line on a monitored account at or above threshold', () => {
  const documents = [{
    invoiceID: 'inv-1', contact: { name: 'Acme Ltd' }, date: '2026-01-15', lineAmountTypes: 'Exclusive',
    lineItems: [{ accountCode: '260', description: 'trailer sale', lineAmount: 1000, taxAmount: 0 }],
  }];
  const findings = findMisallocatedLines(documents, new Set(['260']), () => 500, 'invoice');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].source, 'invoice');
  assert.equal(findings[0].accountCode, '260');
  assert.equal(findings[0].amount, 1000);
});

test('findMisallocatedLines excludes lines below threshold, on unmonitored accounts, or with no account code', () => {
  const documents = [{
    invoiceID: 'inv-2', contact: { name: 'Acme Ltd' }, date: '2026-01-15', lineAmountTypes: 'Exclusive',
    lineItems: [
      { accountCode: '260', lineAmount: 10, taxAmount: 0 }, // below threshold
      { accountCode: '429', lineAmount: 1000, taxAmount: 0 }, // not in monitoredCodes
      { accountCode: null, lineAmount: 1000, taxAmount: 0 }, // no account code at all
    ],
  }];
  const findings = findMisallocatedLines(documents, new Set(['260']), () => 500, 'invoice');
  assert.equal(findings.length, 0);
});

test('findMisallocatedLines applies a per-account threshold override over the shared default', () => {
  const documents = [{
    invoiceID: 'inv-3', contact: { name: 'Acme Ltd' }, date: '2026-01-15', lineAmountTypes: 'Exclusive',
    lineItems: [{ accountCode: '260', lineAmount: 150, taxAmount: 0 }],
  }];
  const getThreshold = code => (code === '260' ? 100 : 500);
  assert.equal(findMisallocatedLines(documents, new Set(['260']), getThreshold, 'invoice').length, 1);
  assert.equal(findMisallocatedLines(documents, new Set(['260']), () => 500, 'invoice').length, 0);
});

test('findMisallocatedLines keeps expense-side (bill/Money Out) and revenue-side (invoice/Money In) monitored sets independent', () => {
  const expenseDoc = [{
    invoiceID: 'bill-1', contact: { name: 'Supplier' }, date: '2026-01-15', lineAmountTypes: 'Exclusive',
    lineItems: [{ accountCode: '429', lineAmount: 1000, taxAmount: 0 }], // General Expenses
  }];
  const revenueDoc = [{
    invoiceID: 'inv-4', contact: { name: 'Customer' }, date: '2026-01-15', lineAmountTypes: 'Exclusive',
    lineItems: [{ accountCode: '260', lineAmount: 1000, taxAmount: 0 }], // Other Revenue
  }];
  const expenseCodes = new Set(['429']);
  const revenueCodes = new Set(['260']);
  // A bill on a revenue-only monitored code is not flagged, and vice versa — the two sides don't
  // cross-contaminate each other's candidate set.
  assert.equal(findMisallocatedLines(expenseDoc, revenueCodes, () => 500, 'bill').length, 0);
  assert.equal(findMisallocatedLines(revenueDoc, expenseCodes, () => 500, 'invoice').length, 0);
  assert.equal(findMisallocatedLines(expenseDoc, expenseCodes, () => 500, 'bill').length, 1);
  assert.equal(findMisallocatedLines(revenueDoc, revenueCodes, () => 500, 'invoice').length, 1);
});

test('findMisallocatedLines computes net (ex-VAT) amount consistently regardless of Inclusive/Exclusive basis', () => {
  const inclusiveDoc = [{
    invoiceID: 'txn-1', contact: { name: 'X' }, date: '2026-01-15', lineAmountTypes: 'Inclusive',
    lineItems: [{ accountCode: '260', lineAmount: 120, taxAmount: 20 }], // gross 120, net 100
  }];
  const findings = findMisallocatedLines(inclusiveDoc, new Set(['260']), () => 50, 'bank_receive');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].amount, 100);
});

// --- Capital Item Review defaults + opt-out (resolveCapitalReviewCandidateCodes) ---
// Confirmed gap: 461/473 were auto-added unconditionally on every sync, so an accountant could
// never deliberately exclude either one — is_capital_candidate=0 looked identical whether it meant
// "never touched" or "explicitly unchecked." accountSettingsInitialised is the tri-state that
// makes an opt-out possible once the Per-account Check Settings page has been saved at least once.

test('a never-configured organisation gets Xenon\'s documented 461/473 default automatically', () => {
  const codes = resolveCapitalReviewCandidateCodes(
    [], { '461': 'Printing & Stationery', '473': 'Repairs & Maintenance' }, false
  );
  assert.deepEqual([...codes].sort(), ['461', '473']);
});

test('461/473 are only added when the account actually exists in the chart of accounts', () => {
  const codes = resolveCapitalReviewCandidateCodes([], { '473': 'Repairs & Maintenance' }, false);
  assert.deepEqual([...codes], ['473']);
});

test('an explicit account-level override is always respected, initialised or not', () => {
  const configs = [{ account_code: '325', is_capital_candidate: 1 }];
  const codes = resolveCapitalReviewCandidateCodes(configs, {}, false);
  assert.ok(codes.has('325'));
});

test('once the settings page has been saved, an explicit opt-out on 461 genuinely excludes it — no auto-add override', () => {
  // The accountant saved the form with 461 left unchecked and 473 checked: both store
  // is_capital_candidate, but only accountSettingsInitialised=true tells us 461's 0 was deliberate.
  const configs = [
    { account_code: '461', is_capital_candidate: 0 },
    { account_code: '473', is_capital_candidate: 1 },
  ];
  const names = { '461': 'Printing & Stationery', '473': 'Repairs & Maintenance' };
  assert.deepEqual([...resolveCapitalReviewCandidateCodes(configs, names, true)], ['473']);
});

test('before the settings page is ever saved, the SAME explicit-zero-on-461 data still gets auto-added back', () => {
  // Contrast with the test above: identical is_capital_candidate data, but accountSettingsInitialised
  // is still false (this org has genuinely never saved the form) — 461 having 0 here is coincidental
  // (perhaps a stale default row), not a deliberate choice, so the documented default still applies.
  const configs = [
    { account_code: '461', is_capital_candidate: 0 },
    { account_code: '473', is_capital_candidate: 1 },
  ];
  const names = { '461': 'Printing & Stationery', '473': 'Repairs & Maintenance' };
  assert.deepEqual([...resolveCapitalReviewCandidateCodes(configs, names, false)].sort(), ['461', '473']);
});

// --- findDuplicates: requireExactReference (Xenon's documented "Exact Reference" toggle) ---
// Off by default (this function's existing behaviour already matches that — no reference check at
// all), but a client can turn it on to additionally require a shared reference before two same-
// contact/same-amount/same-window documents count as a suspected duplicate.

test('requireExactReference is off by default — matching by contact/amount/date alone, ignoring reference', () => {
  const items = [
    { invoiceID: 'a', contact: { contactID: 'c1' }, date: '2026-01-10', total: 100, invoiceNumber: 'INV-001' },
    { invoiceID: 'b', contact: { contactID: 'c1' }, date: '2026-01-10', total: 100, invoiceNumber: 'INV-002' },
  ];
  assert.equal(findDuplicates(items).length, 1);
});

test('requireExactReference excludes a same-contact/amount/date pair whose references differ', () => {
  const items = [
    { invoiceID: 'a', contact: { contactID: 'c1' }, date: '2026-01-10', total: 100, invoiceNumber: 'INV-001' },
    { invoiceID: 'b', contact: { contactID: 'c1' }, date: '2026-01-10', total: 100, invoiceNumber: 'INV-002' },
  ];
  assert.equal(findDuplicates(items, 3, { requireExactReference: true }).length, 0);
});

test('requireExactReference includes a pair that genuinely shares the same reference', () => {
  const items = [
    { invoiceID: 'a', contact: { contactID: 'c1' }, date: '2026-01-10', total: 100, invoiceNumber: 'INV-001' },
    { invoiceID: 'b', contact: { contactID: 'c1' }, date: '2026-01-10', total: 100, invoiceNumber: 'INV-001' },
  ];
  const groups = findDuplicates(items, 3, { requireExactReference: true });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].documentCount, 2);
});

test('requireExactReference treats two blank references as NOT a match — absence of a reference is not a shared one', () => {
  const items = [
    { invoiceID: 'a', contact: { contactID: 'c1' }, date: '2026-01-10', total: 100 },
    { invoiceID: 'b', contact: { contactID: 'c1' }, date: '2026-01-10', total: 100 },
  ];
  assert.equal(findDuplicates(items, 3, { requireExactReference: true }).length, 0);
});

test('requireUnpaidPair: false reproduces Xenon\'s "Also check paid invoices/bills" toggle — fully-paid groups are included', () => {
  const items = [
    { invoiceID: 'a', contact: { contactID: 'c1' }, date: '2026-01-10', total: 100, amountDue: 0 },
    { invoiceID: 'b', contact: { contactID: 'c1' }, date: '2026-01-10', total: 100, amountDue: 0 },
  ];
  assert.equal(findDuplicates(items, 3, { requireUnpaidPair: true }).length, 0);
  assert.equal(findDuplicates(items, 3, { requireUnpaidPair: false }).length, 1);
});

// --- resolveDuplicate*RequireExactReference / IncludeFullyPaid ---

test('duplicate invoice/bill exact-reference and fully-paid resolvers default to Xenon\'s documented off, independently of each other', () => {
  const { resolveDuplicateInvoiceRequireExactReference, resolveDuplicateInvoiceIncludeFullyPaid,
    resolveDuplicateBillRequireExactReference, resolveDuplicateBillIncludeFullyPaid } = require('../src/services/checkRules');
  assert.equal(resolveDuplicateInvoiceRequireExactReference({}), false);
  assert.equal(resolveDuplicateInvoiceIncludeFullyPaid({}), false);
  assert.equal(resolveDuplicateBillRequireExactReference({}), false);
  assert.equal(resolveDuplicateBillIncludeFullyPaid({}), false);
  assert.equal(resolveDuplicateInvoiceRequireExactReference(undefined), false);
});

test('duplicate invoice/bill toggles are trusted verbatim once configured, invoice and bill independent', () => {
  const { resolveDuplicateInvoiceRequireExactReference, resolveDuplicateBillRequireExactReference } = require('../src/services/checkRules');
  const org = { duplicate_invoice_require_exact_reference: 1, duplicate_bill_require_exact_reference: 0 };
  assert.equal(resolveDuplicateInvoiceRequireExactReference(org), true);
  assert.equal(resolveDuplicateBillRequireExactReference(org), false);
});

// --- findDuplicates: requireExactTotal (Xenon's documented "Exact Total" toggle) ---
// Defaults to TRUE here — the opposite of Xenon's own documented "off" default — because Xenon's
// documentation explicitly does not disclose what the baseline match looks like without it, only
// that both Exact Reference and Exact Total are optional "further narrowing." Defaulting to true
// preserves every currently-validated client's existing grouping; requireExactTotal: false is only
// for a specific client confirmed (via their real Xenon export) to have the setting off.

test('requireExactTotal defaults to true — different-amount documents for the same contact/date never group', () => {
  const items = [
    { invoiceID: 'a', contact: { contactID: 'c1' }, date: '2026-01-10', total: 100 },
    { invoiceID: 'b', contact: { contactID: 'c1' }, date: '2026-01-10', total: 150 },
  ];
  assert.equal(findDuplicates(items).length, 0);
});

test('requireExactTotal: false groups by contact + date window alone, regardless of amount', () => {
  const items = [
    { invoiceID: 'a', contact: { contactID: 'c1' }, date: '2026-01-10', total: 100 },
    { invoiceID: 'b', contact: { contactID: 'c1' }, date: '2026-01-10', total: 150 },
  ];
  const groups = findDuplicates(items, 3, { requireExactTotal: false });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].documentCount, 2);
});

test('requireExactTotal: false still respects the date window and a different contact', () => {
  const items = [
    { invoiceID: 'a', contact: { contactID: 'c1' }, date: '2026-01-10', total: 100 },
    { invoiceID: 'b', contact: { contactID: 'c1' }, date: '2026-01-20', total: 150 }, // outside a 3-day window
    { invoiceID: 'c', contact: { contactID: 'c2' }, date: '2026-01-10', total: 100 }, // different contact
  ];
  assert.equal(findDuplicates(items, 3, { requireExactTotal: false }).length, 0);
});

test('requireExactTotal: false composes correctly with requireExactReference — reference still narrows the looser amount-agnostic match', () => {
  const items = [
    { invoiceID: 'a', contact: { contactID: 'c1' }, date: '2026-01-10', total: 100, invoiceNumber: 'REF-1' },
    { invoiceID: 'b', contact: { contactID: 'c1' }, date: '2026-01-10', total: 150, invoiceNumber: 'REF-1' },
    { invoiceID: 'c', contact: { contactID: 'c1' }, date: '2026-01-10', total: 200, invoiceNumber: 'REF-2' },
  ];
  const groups = findDuplicates(items, 3, { requireExactTotal: false, requireExactReference: true });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].documentIds.sort(), ['a', 'b']);
});

test('duplicate invoice/bill exact-total resolvers default to true (this practice\'s calibrated default), not Xenon\'s documented off', () => {
  const { resolveDuplicateInvoiceRequireExactTotal, resolveDuplicateBillRequireExactTotal } = require('../src/services/checkRules');
  assert.equal(resolveDuplicateInvoiceRequireExactTotal({}), true);
  assert.equal(resolveDuplicateBillRequireExactTotal({}), true);
  assert.equal(resolveDuplicateInvoiceRequireExactTotal(undefined), true);
});

test('duplicate invoice/bill exact-total resolvers are trusted verbatim once explicitly configured', () => {
  const { resolveDuplicateInvoiceRequireExactTotal, resolveDuplicateBillRequireExactTotal } = require('../src/services/checkRules');
  const org = { duplicate_invoice_require_exact_total: 0, duplicate_bill_require_exact_total: 1 };
  assert.equal(resolveDuplicateInvoiceRequireExactTotal(org), false);
  assert.equal(resolveDuplicateBillRequireExactTotal(org), true);
});
