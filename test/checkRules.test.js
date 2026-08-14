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
  findUnexpectedDefaultLines,
  isOldDocument,
  isPurchaseTaxExemptAccount,
  resolvePeriodChecked,
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
    contactSimilarityThreshold: 0.7,
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

test('duplicate contacts use normalized 70 percent similarity', () => {
  assert.ok(contactNameSimilarity(fixture.contactNames[0].name, fixture.contactNames[1].name) >= 0.7);
  assert.equal(findDuplicateContacts(fixture.contactNames).length, 1);
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
  // period key exactly as before this fix — only the four reserved strings are protected.
  assert.equal(
    resolvePeriodChecked('filed_accounts_2025-10-31', 'since_lock_date:2025-10-31:2026-08-13'),
    'since_lock_date:2025-10-31:2026-08-13'
  );
});

test('with no active period key, a non-reserved label falls back to itself rather than becoming null', () => {
  assert.equal(resolvePeriodChecked('imported_statements_2026-07-31', null), 'imported_statements_2026-07-31');
  assert.equal(resolvePeriodChecked(undefined, null), undefined);
});

test('RESERVED_PERIOD_LABELS contains exactly the four semantic states, nothing else', () => {
  assert.deepEqual([...RESERVED_PERIOD_LABELS].sort(), [
    'needs_sync', 'not_configured', 'out_of_scope', 'unavailable',
  ]);
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

test('a VAT-only Inclusive line nets to zero while remaining a real, non-zero gross amount', () => {
  // Regression guard for the bug this shape caused: a line that is entirely VAT (e.g. an
  // import-VAT adjustment) has net=0 but must not be mistaken for a genuinely empty £0.00 line —
  // callers must gate "does this line have real value" on the raw lineAmount, not on
  // netLineAmount's output, or a real transaction silently disappears from detection.
  const vatOnlyLine = { lineAmount: 24, taxAmount: 24 };
  assert.equal(netLineAmount('Inclusive', vatOnlyLine), 0);
  assert.notEqual(vatOnlyLine.lineAmount, 0);
});
