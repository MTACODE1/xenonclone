// An account renumbered in Xero after its documents were cached: each cached line keeps the old code, but its
// accountID still names the account, so the account's current code wins. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAccountCodeCanonicaliser, canonicaliseAccountCodes } = require('../src/services/checkRules');

const chart = [
  { accountID: 'acc-sales', code: '220', name: 'Contract Fees' },
  { accountID: 'acc-consult', code: '230', name: 'Consultancy' },
  { accountID: 'acc-old', code: '201', name: 'Account that took over an old number' },
  { accountID: 'acc-bank', code: '', name: 'Bank account without a code' },
  { accountID: 'acc-mixed', code: '264a', name: 'Mixed case code' },
];

test('the account ID wins over a stale or conflicting code', () => {
  const canonical = buildAccountCodeCanonicaliser(chart);
  assert.equal(canonical('202', 'acc-consult'), '230', 'stale code that no longer exists');
  assert.equal(canonical('201', 'acc-sales'), '220', 'stale code now used by another account');
  assert.equal(canonical(undefined, 'acc-sales'), '220', 'no code on the line');
  assert.equal(canonical('', 'acc-sales'), '220');
});

test('without a usable account ID the case-only behaviour is unchanged', () => {
  const canonical = buildAccountCodeCanonicaliser(chart);
  assert.equal(canonical('264A'), '264a');
  assert.equal(canonical('264A', 'acc-unknown'), '264a', 'deleted or unknown account');
  assert.equal(canonical('999', 'acc-bank'), '999', 'account without a code keeps the line code');
  assert.equal(canonical('999'), '999');
  assert.equal(canonical(null), null);
  assert.equal(canonical(''), '');
  assert.equal(canonical(undefined), undefined);
});

test('documents, bank transactions and manual journals take the current code; contacts stay case-only', () => {
  const canonical = buildAccountCodeCanonicaliser(chart);
  const invoice = { lineItems: [{ accountCode: '201', accountID: 'acc-sales' }, { accountCode: '202', accountID: 'acc-consult' }, { description: 'text line' }] };
  const bank = { lineItems: [{ accountCode: '264A', accountID: 'acc-mixed' }] };
  const journal = { journalLines: [{ accountCode: '202', accountID: 'acc-consult' }, { accountCode: '201' }] };
  const contact = { salesDefaultAccountCode: '264A', purchasesDefaultAccountCode: '202' };
  canonicaliseAccountCodes(canonical, { documents: [invoice, bank], journals: [journal], contacts: [contact] });
  assert.deepEqual(invoice.lineItems.map(l => l.accountCode), ['220', '230', undefined]);
  assert.equal(bank.lineItems[0].accountCode, '264a');
  assert.deepEqual(journal.journalLines.map(l => l.accountCode), ['230', '201'], 'no accountID: keeps its code');
  assert.deepEqual([contact.salesDefaultAccountCode, contact.purchasesDefaultAccountCode], ['264a', '202']);
  canonicaliseAccountCodes(canonical, { documents: [invoice] });
  assert.deepEqual(invoice.lineItems.map(l => l.accountCode), ['220', '230', undefined], 'running it twice changes nothing');
});

test('a bank transaction on a renumbered account takes the new code; chart lookups stay separate', () => {
  const bank = { lineItems: [{ accountCode: '202', accountID: 'acc-consult', lineAmount: 50 }] };
  canonicaliseAccountCodes(buildAccountCodeCanonicaliser(chart), { documents: [bank] });
  assert.equal(bank.lineItems[0].accountCode, '230');
  const other = buildAccountCodeCanonicaliser([{ accountID: 'acc-consult', code: '999' }]);
  assert.equal(other('202', 'acc-consult'), '999', 'each client has its own chart');
  assert.equal(buildAccountCodeCanonicaliser(chart)('202', 'acc-consult'), '230');
  assert.equal(buildAccountCodeCanonicaliser([{ accountID: 'x', code: null }])('abc', 'x'), 'abc', 'account with a null code');
});

test('an empty chart changes nothing', () => {
  const canonical = buildAccountCodeCanonicaliser([]);
  assert.equal(canonical('201', 'acc-sales'), '201');
});
