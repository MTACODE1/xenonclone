// Unreconciled Bank and batch payments (accountant, 28 Oct 2026): a batch paid from the bank is one bank line. Its
// parts are not unreconciled items when the batch is reconciled; an unreconciled batch is ONE item that lists the bills
// and invoices it pays. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  selectAuthorisedUnreconciled, toUnreconciledFinding, purchaseOnlyTaxTypes, PRACTICE_POLICY, addFindingKeys,
} = require('../src/services/checkRules');

const BANK = 'acc-bank';
const pay = (id, batchId, extra = {}) => ({
  paymentID: id, status: 'AUTHORISED', isReconciled: false, date: '2026-10-16T00:00:00', amount: 100, paymentType: 'ACCPAYPAYMENT',
  account: { accountID: BANK, name: 'Current Account' },
  invoice: { invoiceID: `inv-${id}`, invoiceNumber: `BILL-${id}`, type: 'ACCPAY', contact: { name: `Supplier ${id}` } },
  ...(batchId ? { batchPaymentID: batchId, batchPayment: { batchPaymentID: batchId } } : {}),
  ...extra,
});
const batch = (id, isReconciled, extra = {}) => ({
  batchPaymentID: id, status: 'AUTHORISED', isReconciled, date: '2026-10-16T00:00:00', totalAmount: 300, type: 'PAYBATCH',
  account: { accountID: BANK, name: 'Current Account' }, ...extra,
});
const bankTxn = (id, extra = {}) => ({ bankTransactionID: id, status: 'AUTHORISED', isReconciled: false, date: '2026-10-16T00:00:00', total: 50, type: 'SPEND', bankAccount: { accountID: BANK, name: 'Current Account' }, ...extra });
const ids = new Set([BANK]);
const idsOf = items => items.map(i => i.paymentID || i.bankTransactionID);

test('the practice counts an unreconciled batch as one bank line', () => {
  assert.equal(PRACTICE_POLICY.unreconciledBatchCounting, 'one_item');
});

test('parts of a reconciled batch are not unreconciled items', () => {
  const payments = [pay('p1', 'b1'), pay('p2', 'b1'), pay('p3', null)];
  const out = selectAuthorisedUnreconciled([bankTxn('t1')], payments, ids, [batch('b1', true)]);
  assert.deepEqual(idsOf(out), ['t1', 'p3']);
});

test('an unreconciled batch is one item with its total, date, part count and the bills it pays', () => {
  const payments = [pay('p1', 'b1', { amount: 100 }), pay('p2', 'b1', { amount: 200 }), pay('p3', null)];
  const out = selectAuthorisedUnreconciled([], payments, ids, [batch('b1', false, { totalAmount: 300 })]);
  assert.equal(out.length, 2);
  const agg = out.find(i => i.batchPaymentID === 'b1');
  assert.equal(agg.partCount, 2);
  assert.equal(agg.amount, 300);
  assert.equal(agg.source, 'payment');
  assert.deepEqual(agg.parts.map(p => p.paymentID), ['p1', 'p2']);
  assert.ok(out.some(i => i.paymentID === 'p3'), 'a payment outside any batch is unchanged');
});

test('each-part mode keeps every part of an unreconciled batch', () => {
  const payments = [pay('p1', 'b1'), pay('p2', 'b1')];
  assert.deepEqual(idsOf(selectAuthorisedUnreconciled([], payments, ids, [batch('b1', false)], 'each_part')), ['p1', 'p2']);
  assert.deepEqual(idsOf(selectAuthorisedUnreconciled([], payments, ids, [batch('b1', true)], 'each_part')), [], 'reconciled parts still dropped');
});

test('without the batch (not fetched, deleted or no flag) the parts are counted as before', () => {
  const payments = [pay('p1', 'b1'), pay('p2', 'b2'), pay('p3', 'b3')];
  const batches = [batch('b2', true, { status: 'DELETED' }), batch('b3', undefined)];
  assert.deepEqual(idsOf(selectAuthorisedUnreconciled([], payments, ids, batches)), ['p1', 'p2', 'p3']);
  assert.deepEqual(idsOf(selectAuthorisedUnreconciled([], payments, ids)), ['p1', 'p2', 'p3'], 'no batches passed: unchanged');
});

test('the batch flag is read as a boolean or the strings "true"/"false"', () => {
  const payments = [pay('p1', 'b1'), pay('p2', 'b2')];
  const out = selectAuthorisedUnreconciled([], payments, ids, [batch('b1', 'true'), batch('b2', 'false')]);
  assert.deepEqual(out.map(i => i.batchPaymentID || i.paymentID), ['b2']);
});

test('the reconciled flag on the payment itself is not trusted for batch parts', () => {
  const payments = [pay('p1', 'b1', { batchPayment: { batchPaymentID: 'b1', isReconciled: true } })];
  assert.equal(selectAuthorisedUnreconciled([], payments, ids).length, 1, 'only the fetched batch decides');
});

test('excluded bank accounts, deleted and reconciled payments are filtered before grouping', () => {
  const other = { accountID: 'acc-excluded', name: 'Excluded' };
  const payments = [pay('p1', 'b1'), pay('p2', 'b1', { status: 'DELETED' }), pay('p3', 'b1', { isReconciled: true }), pay('p4', 'b2', { account: other })];
  const out = selectAuthorisedUnreconciled([], payments, ids, [batch('b1', false), batch('b2', false, { account: other })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].batchPaymentID, 'b1');
  assert.equal(out[0].partCount, 1);
});

test('a batch with an unusable total or date falls back to its parts', () => {
  const payments = [pay('p1', 'b1'), pay('p2', 'b1')];
  assert.deepEqual(idsOf(selectAuthorisedUnreconciled([], payments, ids, [batch('b1', false, { totalAmount: null })])), ['p1', 'p2']);
  assert.deepEqual(idsOf(selectAuthorisedUnreconciled([], payments, ids, [batch('b1', false, { date: null })])), ['p1', 'p2']);
});

test('inputs are not changed and the old three-argument call behaves as before', () => {
  const payments = [pay('p1', 'b1')];
  const copy = JSON.parse(JSON.stringify(payments));
  selectAuthorisedUnreconciled([], payments, ids, [batch('b1', false)]);
  assert.deepEqual(payments, copy);
  assert.deepEqual(idsOf(selectAuthorisedUnreconciled([bankTxn('t1')], payments, ids)), ['t1', 'p1']);
});

test('finding rows: a batch lists its bills; a single payment and a bank line look as before', () => {
  const [agg] = selectAuthorisedUnreconciled([], [pay('p1', 'b1', { amount: 120 }), pay('p2', 'b1', { amount: 180 })], ids, [batch('b1', false)]);
  const f = toUnreconciledFinding(agg);
  assert.equal(f.id, 'b1');
  assert.equal(f.batchPaymentId, 'b1');
  assert.equal(f.amount, 300);
  assert.equal(f.date, '2026-10-16');
  assert.equal(f.contact, null, 'a batch paying several suppliers has no contact (so "Ignore this contact" cannot hide other batches)');
  assert.equal(f.type, 'Batch payment (2 items)');
  assert.deepEqual(f.transactions.map(t => [t.reference, t.contact, t.amount, t.invoiceId, t.source]), [
    ['BILL-p1', 'Supplier p1', 120, 'inv-p1', 'bill'], ['BILL-p2', 'Supplier p2', 180, 'inv-p2', 'bill'],
  ]);
  const sameSupplier = toUnreconciledFinding(selectAuthorisedUnreconciled([], [
    pay('p1', 'b1', { invoice: { invoiceID: 'i1', invoiceNumber: 'B1', type: 'ACCPAY', contact: { name: 'One Ltd' } } }),
    pay('p2', 'b1', { invoice: { invoiceID: 'i2', invoiceNumber: 'B2', type: 'ACCPAY', contact: { name: 'One Ltd' } } }),
  ], ids, [batch('b1', false)])[0]);
  assert.equal(sameSupplier.contact, 'One Ltd');
  assert.deepEqual(toUnreconciledFinding({ ...pay('p9', null), source: 'payment' }), {
    id: 'p9', date: '2026-10-16', amount: 100, contact: 'Supplier p9', type: 'ACCPAYPAYMENT', account: 'Current Account', source: 'payment',
    linkId: 'inv-p9', linkType: 'ACCPAY',   // the bill it pays, so the row opens it
  });
  assert.deepEqual(toUnreconciledFinding({ ...bankTxn('t1'), contact: { name: 'Shop' }, source: 'bank' }), {
    id: 't1', date: '2026-10-16', amount: 50, contact: 'Shop', type: 'SPEND', account: 'Current Account', source: 'bank',
  });
});

test('finding keys of rows outside batches do not change', () => {
  const before = addFindingKeys('unreconciled_bank_items', [toUnreconciledFinding({ ...pay('p9', null), source: 'payment' })]);
  const after = addFindingKeys('unreconciled_bank_items', selectAuthorisedUnreconciled([], [pay('p9', null)], ids, [batch('b1', true)]).map(toUnreconciledFinding));
  assert.equal(after[0].finding_key, before[0].finding_key);
});

// ---- Reverse charge (accountant, 28 Oct 2026): not flagged as a purchase tax code on sales invoices ----
test('reverse charge tax codes are not treated as purchase-only codes', () => {
  const rates = [
    { taxType: 'INPUT2', name: '20% (VAT on Expenses)', canApplyToExpenses: true, canApplyToRevenue: false },
    { taxType: 'REVERSECHARGES', name: 'Reverse Charge Expenses (20%)', canApplyToExpenses: true, canApplyToRevenue: false },
    { taxType: 'TAX005', name: 'Domestic Reverse Charge @ 20% (VAT on Expenses)', canApplyToExpenses: true, canApplyToRevenue: false },
    { taxType: 'OUTPUT2', name: '20% (VAT on Income)', canApplyToExpenses: false, canApplyToRevenue: true },
    { taxType: 'NONE', name: 'No VAT', canApplyToExpenses: true, canApplyToRevenue: true },
  ];
  assert.deepEqual([...purchaseOnlyTaxTypes(rates)], ['INPUT2']);
});

// ---- Review findings (Codex, 28 Oct 2026) ----
test('a batch on a different or excluded account than its payments is not combined (F2)', () => {
  const excluded = { accountID: 'acc-excluded', name: 'Excluded' };
  const out = selectAuthorisedUnreconciled([], [pay('p1', 'b1')], ids, [batch('b1', false, { account: excluded })]);
  assert.deepEqual(idsOf(out), ['p1'], 'the eligible payment stays; no line on the excluded account');
  const mixed = [pay('p1', 'b2'), pay('p2', 'b2', { account: { accountID: 'acc-other', name: 'Other' } })];
  const out2 = selectAuthorisedUnreconciled([], mixed, new Set([BANK, 'acc-other']), [batch('b2', false)]);
  assert.deepEqual(idsOf(out2), ['p1', 'p2'], 'payments on different accounts are not combined');
});

test('an unreadable batch date keeps the payments (F3)', () => {
  for (const date of ['not-a-date', '2026-13-45', new Date('invalid')]) {
    const out = selectAuthorisedUnreconciled([], [pay('p1', 'b1'), pay('p2', 'b1')], ids, [batch('b1', false, { date })]);
    assert.deepEqual(idsOf(out), ['p1', 'p2'], String(date));
  }
});

test('a supplier credit note in a batch keeps its type so it opens on the supplier side (F4)', () => {
  const { xeroLinks } = require('../src/services/xeroLinks');
  const part = pay('p1', 'b1', { invoice: undefined, paymentType: 'APCREDITPAYMENT', creditNote: { creditNoteID: 'cn1', creditNoteNumber: 'CN-1', type: 'ACCPAYCREDIT', contact: { name: 'Supplier' } } });
  const [agg] = selectAuthorisedUnreconciled([], [part, pay('p2', 'b1')], ids, [batch('b1', false)]);
  const tx = toUnreconciledFinding(agg).transactions.find(t => t.creditNoteId === 'cn1');
  assert.equal(tx.type, 'ACCPAYCREDIT');
  assert.ok(xeroLinks('unreconciled_bank_items', tx).some(l => /AccountsPayable/.test(l.url)), 'opens under Accounts Payable');
});

test('the number of payments in a batch is kept on the finding (F5)', () => {
  const [agg] = selectAuthorisedUnreconciled([], [pay('p1', 'b1'), pay('p2', 'b1')], ids, [batch('b1', false)]);
  const f = JSON.parse(JSON.stringify(toUnreconciledFinding(agg)));
  assert.equal(f.partCount, 2);
});
