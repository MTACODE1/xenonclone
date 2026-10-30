// Round 3 (accountant, 30 Oct 2026): "hyperlinks in Akrio are inconsistent". Findings that carry no document id, or whose
// bill was labelled as a sales invoice, now open the right page. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { xeroLinks } = require('../src/services/xeroLinks');
const { addFindingKeys, toUnreconciledFinding } = require('../src/services/checkRules');

const urls = (check, item) => xeroLinks(check, item).map(l => `${l.label}: ${l.url}`);

test('a Capital Item Review line on a supplier bill opens the bill, not a sales invoice', () => {
  const item = { invoiceId: 'b1', contact: 'Supplier', date: '2026-01-01', accountCode: '473', amount: 2500, type: 'ACCPAY' };
  assert.deepEqual(urls('capital_item_review', item), ['Open bill: https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=b1']);
  const bank = { invoiceId: 't1', source: 'bank_spend', amount: 2500 };
  assert.match(urls('capital_item_review', bank)[0], /Bank\/ViewTransaction\.aspx\?bankTransactionID=t1/);
});

test('Unexpected Account / Tax Code findings open their bill, invoice or bank transaction', () => {
  const base = { contactId: 'c1', contact: 'Supplier', amount: 10 };
  assert.deepEqual(urls('unexpected_account_used', { ...base, source: 'bill', linkId: 'b1', linkType: 'ACCPAY' }),
    ['Open bill: https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=b1', 'Open contact: https://go.xero.com/Contacts/View/c1']);
  assert.match(urls('unexpected_tax_code_used', { ...base, source: 'invoice', linkId: 'i1', linkType: 'ACCREC' })[0], /AccountsReceivable\/View\.aspx\?InvoiceID=i1/);
  assert.match(urls('unexpected_account_used', { ...base, source: 'bank_spend', linkId: 't1', linkType: 'BANK' })[0], /Bank\/ViewTransaction\.aspx\?bankTransactionID=t1/);
  assert.deepEqual(urls('unexpected_account_used', { ...base, source: 'bill' }), ['Open contact: https://go.xero.com/Contacts/View/c1'], 'an old saved finding is unchanged');
});

test('adding link fields does not change finding keys (review states are kept)', () => {
  const keyOf = (check, item) => addFindingKeys(check, [item])[0].finding_key;
  const old = { contactId: 'c1', contact: 'S', date: '2026-01-01', accountCode: '400', expectedAccountCode: '300', description: 'x', amount: 10, source: 'bill' };
  assert.equal(keyOf('unexpected_account_used', { ...old, linkId: 'b1', linkType: 'ACCPAY' }), keyOf('unexpected_account_used', old));
  const cap = { invoiceId: 'b1', contact: 'S', date: '2026-01-01', accountCode: '473', description: 'x', amount: 2500 };
  assert.equal(keyOf('capital_item_review', { ...cap, type: 'ACCPAY' }), keyOf('capital_item_review', cap));
});

test('Contact Defaults and Inactive Contacts open the contact', () => {
  assert.deepEqual(urls('contact_defaults', { id: 'c1', name: 'Osome', missing: 'sales account' }), ['Open contact: https://go.xero.com/Contacts/View/c1']);
  assert.deepEqual(urls('inactive_contacts', { id: 'c2', name: 'Old Co', lastTransaction: '2024-01-01' }), ['Open contact: https://go.xero.com/Contacts/View/c2']);
});

test('an unreconciled payment opens the bill or invoice it pays', () => {
  const pay = { source: 'payment', paymentID: 'p1', status: 'AUTHORISED', date: '2026-10-16', amount: 50, paymentType: 'ACCPAYPAYMENT',
    account: { name: 'Bank' }, invoice: { invoiceID: 'b9', invoiceNumber: 'B9', type: 'ACCPAY', contact: { name: 'Supplier' } } };
  const f = toUnreconciledFinding(pay);
  assert.equal(f.linkId, 'b9');
  assert.equal(f.linkType, 'ACCPAY');
  assert.equal(f.id, 'p1', 'identity field unchanged');
  assert.match(urls('unreconciled_bank_items', f)[0], /AccountsPayable\/View\.aspx\?InvoiceID=b9/);
  const noDoc = toUnreconciledFinding({ ...pay, invoice: undefined });
  assert.equal(noDoc.linkId, undefined);
});
