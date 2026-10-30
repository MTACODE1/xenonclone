// Undocumented Bills (accountant, 29 Oct 2026): "bills with a missing attachment should be flagged", paid ones included.
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectUndocumentedBills } = require('../src/services/checkRules');

const bill = (id, status, extra = {}) => ({ invoiceID: id, type: 'ACCPAY', status, hasAttachments: false, ...extra });

test('authorised and paid bills with no attachment are flagged', () => {
  const out = selectUndocumentedBills([bill('a', 'AUTHORISED'), bill('b', 'PAID'), bill('c', 'PAID', { hasAttachments: true })]);
  assert.deepEqual(out.map(b => b.invoiceID), ['a', 'b']);
});

test('drafts, submitted, voided and deleted bills are not flagged', () => {
  const out = selectUndocumentedBills(['DRAFT', 'SUBMITTED', 'VOIDED', 'DELETED'].map((s, i) => bill(`x${i}`, s)));
  assert.deepEqual(out, []);
});

test('only supplier bills count, and a missing flag is treated as no attachment as before', () => {
  const out = selectUndocumentedBills([bill('a', 'PAID', { hasAttachments: undefined }), { ...bill('b', 'PAID'), type: 'ACCREC' }]);
  assert.deepEqual(out.map(b => b.invoiceID), ['a']);
});
