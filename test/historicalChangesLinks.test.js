// Historical Changes findings must open the document in Xero. A supplier bill and a sales invoice open on different Xero
// pages, so the finding carries the document type and its id. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { historicalChanges } = require('../src/services/journalChecks');
const { xeroLinks } = require('../src/services/xeroLinks');
const { addFindingKeys } = require('../src/services/checkRules');

const base = { madeUpTo: '2025-03-31', filingDate: '2025-12-17' };
const doc = (extra) => ({ date: '2025-01-10', updatedDateUTC: '2026-07-30T10:00:00', status: 'AUTHORISED', total: 35.59, amountPaid: 0, contact: { name: 'Supplier' }, ...extra });
const run = (invoices = [], creditNotes = [], bankTransactions = []) => historicalChanges({ journals: [], invoices, creditNotes, bankTransactions, ...base });

test('a changed supplier bill opens on the Accounts Payable page', () => {
  const [item] = run([doc({ invoiceID: 'inv-1', invoiceNumber: '9617', type: 'ACCPAY' })]);
  assert.equal(item.invoiceId, 'inv-1');
  assert.equal(item.type, 'ACCPAY');
  const links = xeroLinks('historical_changes', item);
  assert.deepEqual(links.map(l => l.label), ['Open bill']);
  assert.match(links[0].url, /AccountsPayable\/View\.aspx\?InvoiceID=inv-1/);
});

test('a changed sales invoice opens on the Accounts Receivable page', () => {
  const [item] = run([doc({ invoiceID: 'inv-2', invoiceNumber: 'INV-2', type: 'ACCREC' })]);
  const links = xeroLinks('historical_changes', item);
  assert.deepEqual(links.map(l => l.label), ['Open invoice']);
  assert.match(links[0].url, /AccountsReceivable\/View\.aspx\?InvoiceID=inv-2/);
});

test('credit notes open on the right side, and a deleted bank transaction opens as a bank transaction', () => {
  const [pc] = run([], [doc({ creditNoteID: 'cn-1', creditNoteNumber: 'CN-1', type: 'ACCPAYCREDIT' })]);
  assert.match(xeroLinks('historical_changes', pc)[0].url, /AccountsPayable\/ViewCreditNote\.aspx\?creditNoteID=cn-1/);
  const [sc] = run([], [doc({ creditNoteID: 'cn-2', creditNoteNumber: 'CN-2', type: 'ACCRECCREDIT' })]);
  assert.match(xeroLinks('historical_changes', sc)[0].url, /AccountsReceivable\/ViewCreditNote\.aspx\?creditNoteID=cn-2/);
  const [bt] = run([], [], [doc({ bankTransactionID: 'bt-1', status: 'DELETED', type: 'SPEND' })]);
  assert.match(xeroLinks('historical_changes', bt)[0].url, /Bank\/ViewTransaction\.aspx\?bankTransactionID=bt-1/);
});

test('an old saved finding with no document type still falls back to a search, never a guessed page', () => {
  const legacy = { documentId: 'inv-3', number: '9617', source: 'invoice', contact: 'Supplier', description: 'x', amount: 1 };
  const links = xeroLinks('historical_changes', legacy);
  assert.deepEqual(links.map(l => l.label), ['Search in Xero']);
});

test('the new fields do not change the finding key, so review states are kept', () => {
  const keyOf = item => addFindingKeys('historical_changes', [item])[0].finding_key;
  const [item] = run([doc({ invoiceID: 'inv-1', invoiceNumber: '9617', type: 'ACCPAY' })]);
  const { invoiceId, type, ...old } = item;
  assert.equal(keyOf(item), keyOf(old));
});

test('item type wins over the producer label when the two disagree', () => {
  const { directionOf } = require('../src/services/xeroLinks');
  assert.equal(directionOf({ source: 'invoice', type: 'ACCPAY' }), 'payable');
  assert.equal(directionOf({ source: 'invoice' }), 'receivable', 'unchanged without a type');
  assert.equal(directionOf({ source: 'bill' }), 'payable');
});
