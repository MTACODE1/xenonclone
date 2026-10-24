// "Open in Xero" links. Misallocated Items mixes bills, invoices and bank lines, so the page a link opens (payable vs
// receivable) must follow what the item is, not just the name of the check (accountant v4: "transaction not available").
const test = require('node:test');
const assert = require('node:assert/strict');
const { xeroLinks } = require('../src/services/xeroLinks');

const urls = links => links.map(link => link.url);
const labels = links => links.map(link => link.label);
const PAYABLE = id => `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${id}`;
const RECEIVABLE = id => `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${id}`;
const BANK = id => `https://go.xero.com/Bank/ViewTransaction.aspx?bankTransactionID=${id}`;

test('Misallocated Items: a bill opens as a bill, an invoice as an invoice, bank lines as bank transactions', () => {
  assert.deepEqual(urls(xeroLinks('misallocated_items', { source: 'bill', invoiceId: 'b1' })), [PAYABLE('b1')]);
  assert.deepEqual(labels(xeroLinks('misallocated_items', { source: 'bill', invoiceId: 'b1' })), ['Open bill']);
  assert.deepEqual(urls(xeroLinks('misallocated_items', { source: 'invoice', invoiceId: 'i1' })), [RECEIVABLE('i1')]);
  assert.deepEqual(labels(xeroLinks('misallocated_items', { source: 'invoice', invoiceId: 'i1' })), ['Open invoice']);
  assert.deepEqual(urls(xeroLinks('misallocated_items', { source: 'bank_spend', invoiceId: 't1' })), [BANK('t1')]);
  assert.deepEqual(urls(xeroLinks('misallocated_items', { source: 'bank_receive', invoiceId: 't2' })), [BANK('t2')]);
});

test('what the item says it is wins over the check name; the Xero type is next; the check name is the last resort', () => {
  assert.deepEqual(urls(xeroLinks('purchase_tax_missing', { source: 'invoice', invoiceId: 'x' })), [RECEIVABLE('x')], 'source over check name');
  assert.deepEqual(urls(xeroLinks('sales_tax_missing', { source: 'bill', invoiceId: 'x' })), [PAYABLE('x')]);
  assert.deepEqual(urls(xeroLinks('misallocated_items', { type: 'ACCPAY', invoiceId: 'x' })), [PAYABLE('x')], 'Xero type');
  assert.deepEqual(urls(xeroLinks('misallocated_items', { type: 'ACCREC', invoiceId: 'x' })), [RECEIVABLE('x')]);
  assert.deepEqual(urls(xeroLinks('purchase_tax_missing', { invoiceId: 'x' })), [PAYABLE('x')], 'check name fallback, unchanged');
  assert.deepEqual(urls(xeroLinks('sales_tax_missing', { invoiceId: 'x' })), [RECEIVABLE('x')]);
});

test('credit notes open on the matching credit note page', () => {
  const credit = (dir, id) => `https://go.xero.com/${dir}/ViewCreditNote.aspx?creditNoteID=${id}`;
  assert.deepEqual(urls(xeroLinks('multi_account_suppliers', { source: 'credit_note', creditNoteId: 'c1', type: 'ACCPAYCREDIT' })), [credit('AccountsPayable', 'c1')]);
  assert.deepEqual(urls(xeroLinks('multi_account_suppliers', { source: 'credit_note', creditNoteId: 'c2', type: 'ACCRECCREDIT' })), [credit('AccountsReceivable', 'c2')]);
  assert.deepEqual(urls(xeroLinks('purchase_tax_missing', { source: 'credit_note', creditNoteId: 'c3' })), [credit('AccountsPayable', 'c3')], 'generic credit_note: check name decides');
  assert.deepEqual(urls(xeroLinks('sales_tax_missing', { source: 'credit_note', creditNoteId: 'c4' })), [credit('AccountsReceivable', 'c4')]);
  assert.deepEqual(urls(xeroLinks('old_purchase_credits', { id: 'c5' })), [credit('AccountsPayable', 'c5')], 'old-credit checks keep working');
  assert.deepEqual(urls(xeroLinks('old_sales_credits', { id: 'c6' })), [credit('AccountsReceivable', 'c6')]);
});

test('a purchase credit note in a supplier drill-down gets a credit note link and never a bill link', () => {
  const links = xeroLinks('multi_tax_suppliers', { source: 'credit_note', creditNoteId: 'c1', type: 'ACCPAYCREDIT', invoiceId: undefined });
  assert.deepEqual(labels(links), ['Open credit note']);
});

test('a bank, payment or journal identifier never turns into an invoice link', () => {
  assert.deepEqual(urls(xeroLinks('bill_or_direct', { source: 'bank', id: 'b9' })), [BANK('b9')]);
  assert.deepEqual(urls(xeroLinks('bill_or_direct', { source: 'bank_spend', id: 'b9' })), [BANK('b9')]);
  assert.deepEqual(urls(xeroLinks('duplicate_invoices_like_bill', { source: 'payment', id: 'p9' })), ['https://go.xero.com/Search/Default.aspx?searchTerm=p9']);
  assert.deepEqual(urls(xeroLinks('undocumented_bills', { source: 'manual_journal', id: 'j9', number: '5447' })), ['https://go.xero.com/Search/Default.aspx?searchTerm=5447']);
});

test('invoice and bill checks keep working from a plain id, duplicates open both documents', () => {
  assert.deepEqual(urls(xeroLinks('old_unpaid_bills', { id: 'b2' })), [PAYABLE('b2')]);
  assert.deepEqual(urls(xeroLinks('old_unpaid_invoices', { id: 'i2' })), [RECEIVABLE('i2')]);
  assert.deepEqual(urls(xeroLinks('duplicate_bills', { id1: 'd1', id2: 'd2' })), [PAYABLE('d1'), PAYABLE('d2')]);
  assert.deepEqual(urls(xeroLinks('duplicate_invoices', { id1: 'd1', id2: 'd2' })), [RECEIVABLE('d1'), RECEIVABLE('d2')]);
});

test('unreconciled items, contacts, encoding, de-duplication and the search fallback', () => {
  assert.deepEqual(urls(xeroLinks('unreconciled_bank_items', { source: 'bank', bankTransactionID: 'bt1' })), [BANK('bt1')]);
  assert.deepEqual(urls(xeroLinks('unreconciled_bank_items', { source: 'payment', paymentID: 'pay1' })), ['https://go.xero.com/Search/Default.aspx?searchTerm=pay1']);
  assert.deepEqual(urls(xeroLinks('multi_tax_suppliers', { contactId: 'k1' })), ['https://go.xero.com/Contacts/View/k1']);
  assert.deepEqual(urls(xeroLinks('duplicate_contacts', { id1: 'k1', id2: 'k2' })), ['https://go.xero.com/Contacts/View/k1', 'https://go.xero.com/Contacts/View/k2']);
  assert.deepEqual(urls(xeroLinks('misallocated_items', { source: 'bill', invoiceId: 'a b/c?d' })), [PAYABLE('a%20b%2Fc%3Fd')]);
  assert.deepEqual(urls(xeroLinks('multi_tax_suppliers', { contactId: 'k1', contactID: 'k1' })), ['https://go.xero.com/Contacts/View/k1']);
  assert.deepEqual(urls(xeroLinks('tax_review_by_code', { name: 'Some Item' })), ['https://go.xero.com/Search/Default.aspx?searchTerm=Some%20Item']);
});

test('REGRESSION: a generic id is read by what the item says it is (source, type) and never overrides an explicit other id', () => {
  // the real Motor Vehicle finding shape: source 'bill' with a generic id
  assert.deepEqual(urls(xeroLinks('motor_vehicle_expenses', { source: 'bill', id: 'bill-1', number: 'B001' })), [PAYABLE('bill-1')]);
  assert.deepEqual(urls(xeroLinks('motor_vehicle_expenses', { source: 'invoice', id: 'inv-1' })), [RECEIVABLE('inv-1')]);
  assert.deepEqual(urls(xeroLinks('unapproved_bills', { id: 'p1', paymentId: 'p1' })), ['https://go.xero.com/Search/Default.aspx?searchTerm=p1'], 'a payment id is not an invoice');
  assert.deepEqual(urls(xeroLinks('unapproved_bills', { id: 'b1', bankTransactionId: 'b1' })), [BANK('b1')], 'a bank transaction id is not an invoice');
  assert.deepEqual(urls(xeroLinks('unapproved_bills', { id: 'c1', creditNoteId: 'c1' })), ['https://go.xero.com/AccountsReceivable/ViewCreditNote.aspx?creditNoteID=c1'], 'an explicit credit note id');
  assert.deepEqual(urls(xeroLinks('unapproved_bills', { id: 'c1', type: 'ACCPAYCREDIT' })), ['https://go.xero.com/AccountsPayable/ViewCreditNote.aspx?creditNoteID=c1'], 'a credit type on a generic id');
  assert.deepEqual(urls(xeroLinks('unapproved_invoices', { id: 'c2', type: 'ACCRECCREDIT' })), ['https://go.xero.com/AccountsReceivable/ViewCreditNote.aspx?creditNoteID=c2']);
  assert.deepEqual(urls(xeroLinks('multi_tax_suppliers', { invoiceId: 'i1', bankTransactionId: 'b1' })), [PAYABLE('i1'), BANK('b1')].map(u => u), 'a genuine explicit invoice-and-bank pair keeps both links');
});

test('REGRESSION: a bare id is a document when its Xero type says so, a credit note when its source says so, and never a search for "undefined"', () => {
  assert.deepEqual(urls(xeroLinks('misallocated_items', { id: 'bill-1', type: 'ACCPAY' })), [PAYABLE('bill-1')]);
  assert.deepEqual(urls(xeroLinks('misallocated_items', { id: 'inv-1', type: 'ACCREC' })), [RECEIVABLE('inv-1')]);
  assert.deepEqual(urls(xeroLinks('sales_tax_missing', { id: 'credit-1', source: 'credit_note' })), ['https://go.xero.com/AccountsReceivable/ViewCreditNote.aspx?creditNoteID=credit-1']);
  assert.deepEqual(urls(xeroLinks('purchase_tax_missing', { id: 'credit-2', source: 'credit_note' })), ['https://go.xero.com/AccountsPayable/ViewCreditNote.aspx?creditNoteID=credit-2']);
  // an item that identifies nothing gets no link at all rather than a meaningless search
  assert.deepEqual(xeroLinks('misallocated_items', {}), []);
  assert.deepEqual(xeroLinks('misallocated_items', { description: 'x' }), []);
  // explicit other ids still win over a document type
  assert.deepEqual(urls(xeroLinks('misallocated_items', { id: 'x', type: 'ACCPAY', paymentId: 'x' })), ['https://go.xero.com/Search/Default.aspx?searchTerm=x']);
  assert.deepEqual(urls(xeroLinks('misallocated_items', { id: 'x', type: 'ACCPAY', source: 'bank_spend' })), [BANK('x')]);
});
