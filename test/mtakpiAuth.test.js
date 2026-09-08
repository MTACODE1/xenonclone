// Unit tests for the pure row-selection logic in src/services/mtakpiAuth.js. The actual MySQL
// query (findMtakpiStaffByName/verifyMtakpiLogin) needs a live read-only connection to MTAKPI's
// database and is exercised manually/in staging once MTAKPI_DB_* credentials exist — see
// werkzeugPassword.test.js for the password-hash verification half of the login flow, which is
// fully unit-tested against real werkzeug-generated hashes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePreferredStaffRow } = require('../src/services/mtakpiAuth');

test('returns null for no rows (unknown staff_name)', () => {
  assert.equal(resolvePreferredStaffRow([]), null);
});

test('returns the single row when there is only one match', () => {
  const row = { id: 1, staff_name: 'Solo Person', disabled: 0 };
  assert.equal(resolvePreferredStaffRow([row]), row);
});

test('prefers an enabled row over a disabled duplicate, regardless of order', () => {
  const disabled = { id: 1, staff_name: 'Dup Person', disabled: 1 };
  const enabled = { id: 2, staff_name: 'Dup Person', disabled: 0 };
  assert.equal(resolvePreferredStaffRow([disabled, enabled]), enabled);
  assert.equal(resolvePreferredStaffRow([enabled, disabled]), enabled);
});

test('falls back to the first row when every duplicate is disabled (mirrors MTAKPI\'s own behavior)', () => {
  const first = { id: 1, staff_name: 'All Disabled', disabled: 1 };
  const second = { id: 2, staff_name: 'All Disabled', disabled: 1 };
  assert.equal(resolvePreferredStaffRow([first, second]), first);
});
