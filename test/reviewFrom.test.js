// The review period starts from the later of the Xero lock date and the last signed accounts date (Abdur, 20 Oct 2026:
// Flyhighdigital reviewed from 31 Jul 2025, Cinch from 31 Aug 2025, although Xero's lock date is older or unset).
// The expected dates below are real clients' values from the 81-client measurement.
process.env.AKRIO_DB_HOST = process.env.AKRIO_DB_HOST || '127.0.0.1';
process.env.AKRIO_DB_USER = process.env.AKRIO_DB_USER || 'unit-test';
process.env.AKRIO_DB_PASSWORD = process.env.AKRIO_DB_PASSWORD || 'unit-test';
process.env.XERO_DASHBOARD_DB_PATH = process.env.XERO_DASHBOARD_DB_PATH || '/tmp/akrio-unit-test-never-created.db';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { reviewFromDate } = require('../src/services/checkRules');
const { getSignedAccountsDate, getReviewFrom } = require('../src/db/queries');
const { resolvePeriod, isWithinPeriod } = require('../src/services/periodResolver');

const ASOF = '2026-10-20';

test('signed accounts later than the lock date win', () => {
  assert.deepEqual(reviewFromDate('2024-08-31', '2025-08-31', ASOF), { date: '2025-08-31', source: 'signed_accounts' });   // Cinch Technology
  assert.deepEqual(reviewFromDate('2023-07-31', '2025-07-31', ASOF), { date: '2025-07-31', source: 'signed_accounts' });   // Flyhighdigital
  assert.deepEqual(reviewFromDate('2021-05-31', '2025-05-31', ASOF), { date: '2025-05-31', source: 'signed_accounts' });   // E4 Office
});

test('a client with no lock date still starts from its signed accounts', () => {
  assert.deepEqual(reviewFromDate(null, '2026-02-28', ASOF), { date: '2026-02-28', source: 'signed_accounts' });           // Minga
  assert.deepEqual(reviewFromDate(undefined, '2025-03-31', ASOF), { date: '2025-03-31', source: 'signed_accounts' });      // Hair of the Dog
});

test('a lock date that is later or equal keeps winning, because that data cannot change', () => {
  assert.deepEqual(reviewFromDate('2026-03-31', '2025-03-31', ASOF), { date: '2026-03-31', source: 'lock_date' });
  assert.deepEqual(reviewFromDate('2025-03-31', '2025-03-31', ASOF), { date: '2025-03-31', source: 'lock_date' });
});

test('neither date known leaves the period unbounded as before', () => {
  assert.deepEqual(reviewFromDate(null, null, ASOF), { date: null, source: null });
  assert.deepEqual(reviewFromDate('', 'not a date', ASOF), { date: null, source: null });
});

test('a future or malformed signed date is ignored instead of emptying the period', () => {
  assert.deepEqual(reviewFromDate('2025-03-31', '2027-03-31', ASOF), { date: '2025-03-31', source: 'lock_date' });
  assert.deepEqual(reviewFromDate(null, '2027-03-31', ASOF), { date: null, source: null });
  assert.deepEqual(reviewFromDate('2025-03-31', '31/03/2026', ASOF), { date: '2025-03-31', source: 'lock_date' });
});

test('Date objects and timestamps from the database are accepted', () => {
  assert.deepEqual(reviewFromDate(new Date('2024-08-31T00:00:00Z'), '2025-08-31T00:00:00.000Z', ASOF), { date: '2025-08-31', source: 'signed_accounts' });
});

test('the period starts after the review-from date and says where the date came from', () => {
  const from = reviewFromDate('2024-08-31', '2025-08-31', ASOF);
  const period = resolvePeriod({ type: 'since_lock_date' }, { lockDate: from.date, lockSource: from.source, asOf: ASOF });
  assert.equal(period.start, '2025-08-31');
  assert.equal(period.label, 'Since last signed accounts (2025-08-31)');
  assert.equal(period.key, 'since_lock_date:2025-08-31:2026-10-20');
  assert.equal(isWithinPeriod('2025-08-31', period), false, 'the signed year end itself is excluded, as the lock date is');
  assert.equal(isWithinPeriod('2025-09-01', period), true);
  assert.equal(isWithinPeriod('2025-06-30', period), false, 'an old item before the signed accounts is out of period');
});

test('the lock date label and the no-date label are unchanged', () => {
  assert.equal(resolvePeriod({ type: 'since_lock_date' }, { lockDate: '2026-03-31', lockSource: 'lock_date', asOf: ASOF }).label, 'Since lock date (2026-03-31)');
  assert.equal(resolvePeriod({ type: 'since_lock_date' }, { lockDate: '2026-03-31', asOf: ASOF }).label, 'Since lock date (2026-03-31)');
  assert.equal(resolvePeriod({ type: 'since_lock_date' }, { asOf: ASOF }).label, 'All activity to 2026-10-20');
});

test('other period types ignore the review-from date', () => {
  const period = resolvePeriod({ type: 'custom', from: '2025-07-31', to: '2026-10-20' }, { lockDate: '2025-08-31', lockSource: 'signed_accounts', asOf: ASOF });
  assert.equal(period.start, '2025-07-31');
  assert.equal(period.label, 'Custom (2025-07-31 to 2026-10-20)');
});

test('the signed accounts date comes from Companies House or an explicit made-up-to date, for that client only', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE filed_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER, filing_date TEXT, made_up_to TEXT, source TEXT NOT NULL DEFAULT 'manual')");
  db.exec('CREATE TABLE companies_house_profile (org_id INTEGER PRIMARY KEY, accounts_last_made_up_to TEXT)');
  const add = (org, filing, madeUpTo, source = 'companies_house') => db.prepare('INSERT INTO filed_accounts (org_id, filing_date, made_up_to, source) VALUES (?, ?, ?, ?)').run(org, filing, madeUpTo, source);
  add(1, '2025-12-10', '2025-03-31');
  add(1, '2024-12-10', '2024-03-31');
  add(2, '2026-01-10', '2026-03-31');
  add(3, '2025-06-30', '2025-06-30', 'manual');     // manual: made_up_to was defaulted to the filing date, so it is not a year end
  add(4, '2025-06-30', null, 'manual');
  add(5, '2025-12-01', '2025-03-31', 'manual');     // manual with an explicit year end
  assert.equal(getSignedAccountsDate(1, db), '2025-03-31', 'made-up-to, not the later filing date, is the signed year end');
  assert.equal(getSignedAccountsDate(2, db), '2026-03-31');
  assert.equal(getSignedAccountsDate(3, db), null, 'a defaulted manual filing date must not start the review late');
  assert.equal(getSignedAccountsDate(4, db), null);
  assert.equal(getSignedAccountsDate(5, db), '2025-03-31');
  assert.equal(getSignedAccountsDate(99, db), null);
  // Companies House profile: the last made-up-to date is known even where the filed figures could not be read.
  db.prepare('INSERT INTO companies_house_profile (org_id, accounts_last_made_up_to) VALUES (?, ?)').run(6, '2025-09-30');   // no filed_accounts row
  db.prepare('INSERT INTO companies_house_profile (org_id, accounts_last_made_up_to) VALUES (?, ?)').run(1, '2026-03-31');   // newer than the stored row
  db.prepare('INSERT INTO companies_house_profile (org_id, accounts_last_made_up_to) VALUES (?, ?)').run(2, '2025-03-31');   // older than the stored row
  db.prepare('INSERT INTO companies_house_profile (org_id, accounts_last_made_up_to) VALUES (?, ?)').run(7, null);
  assert.equal(getSignedAccountsDate(6, db), '2025-09-30', 'profile only');
  assert.equal(getSignedAccountsDate(1, db), '2026-03-31', 'the later of profile and filed rows');
  assert.equal(getSignedAccountsDate(2, db), '2026-03-31');
  assert.equal(getSignedAccountsDate(7, db), null);
  db.prepare('UPDATE companies_house_profile SET accounts_last_made_up_to = ? WHERE org_id = 1').run('2025-03-31');
  assert.deepEqual(getReviewFrom({ id: 1, lock_date: '2024-08-31' }, undefined, db), { date: '2025-03-31', source: 'signed_accounts' });
  assert.deepEqual(getReviewFrom({ id: 1, lock_date: '2026-03-31' }, undefined, db), { date: '2026-03-31', source: 'lock_date' });
  assert.deepEqual(getReviewFrom({ id: 1 }, '2025-09-30', db), { date: '2025-09-30', source: 'lock_date' }, 'an explicit lock date overrides the org row');
  assert.deepEqual(getReviewFrom({ id: 3, lock_date: '2025-01-31' }, undefined, db), { date: '2025-01-31', source: 'lock_date' });
});
