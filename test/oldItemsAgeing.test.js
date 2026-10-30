// Old Unpaid Invoices and the credit checks (accountant's round 3, 30 Oct 2026): "Does not match" Xero's Aged Receivables
// and Aged Payables, which age by DUE date as at the end of the month and show foreign amounts in GBP. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectOldUnpaidInvoices, amountInBase, endOfMonth, isOldDocument } = require('../src/services/checkRules');

const inv = (id, date, dueDate, extra = {}) => ({ invoiceID: id, type: 'ACCREC', status: 'AUTHORISED', date, dueDate, amountDue: 100, currencyRate: 1, ...extra });
const asOf = new Date(`${endOfMonth('2026-10-30')}T00:00:00.000Z`);

test('an invoice dated long ago but only just due is not old (Xero ages by due date)', () => {
  const out = selectOldUnpaidInvoices([inv('a', '2026-08-03', '2026-10-17'), inv('b', '2026-06-01', '2026-07-01')], asOf);
  assert.deepEqual(out.map(i => i.invoiceID), ['b']);
});

test('over 60 days past due at month end: due 31 Aug is old, due 1 Sep is not', () => {
  const out = selectOldUnpaidInvoices([inv('aug31', '2026-08-01', '2026-08-31'), inv('sep1', '2026-08-01', '2026-09-01')], asOf);
  assert.deepEqual(out.map(i => i.invoiceID), ['aug31']);
});

test('no due date falls back to the invoice date; paid and zero-balance invoices are left out', () => {
  const noDue = inv('a', '2026-01-01', undefined);
  const paid = inv('b', '2026-01-01', '2026-01-31', { status: 'PAID', amountDue: 0 });
  const zero = inv('c', '2026-01-01', '2026-01-31', { amountDue: 0 });
  assert.deepEqual(selectOldUnpaidInvoices([noDue, paid, zero], asOf).map(i => i.invoiceID), ['a']);
});

test('foreign amounts are shown in GBP, not added up as pounds', () => {
  assert.equal(Math.round(amountInBase(4666.69, { currencyRate: 1.15696 }) * 100) / 100, 4033.58);
  assert.equal(amountInBase(100, { currencyRate: 1 }), 100);
  assert.equal(amountInBase(100, {}), 100, 'no rate: already pounds');
  assert.equal(amountInBase(100, { currencyRate: 0 }), 100, 'a zero rate is never divided by');
  assert.equal(amountInBase(undefined, { currencyRate: 2 }), 0);
});

test('credit notes are aged at month end too (credit date, as before)', () => {
  assert.equal(isOldDocument({ date: '2026-08-31' }, asOf), true);
  assert.equal(isOldDocument({ date: '2026-09-01' }, asOf), false);
});
