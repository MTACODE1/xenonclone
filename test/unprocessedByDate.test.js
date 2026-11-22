const test = require('node:test');
const assert = require('node:assert/strict');
const { datedUnprocessed, unprocessedInPeriod } = require('../src/services/bankScreenReading');
const { isWithinPeriod, resolvePeriod } = require('../src/services/periodResolver');

const READ_AT = new Date('2026-11-21T18:42:48Z');
const reading = {
  readAt: READ_AT,
  accounts: [
    { accountName: 'Current account', itemsToReconcile: 3 },
    { accountName: 'Savings', itemsToReconcile: 1 },
    { accountName: 'Card', itemsToReconcile: null }, // reconciled: needs no list
    { accountName: 'Wallet', itemsToReconcile: 0 },
  ],
};
const list = (accountName, days, extra = {}) => ({ accountName, truncated: false, readAt: new Date(READ_AT.getTime() + 60000), days: new Map(Object.entries(days)), ...extra });
const CONTEXT = { asOf: '2026-11-22', financialYearEndDay: 31, financialYearEndMonth: 10, lockDate: '2025-10-31' };

test('with every list read, unprocessed lines are counted per period like Xenon', () => {
  const dated = datedUnprocessed(reading, [
    list('Current account', { '2026-10-03': 2, '2026-06-15': 1 }),
    list('Savings', { '2026-10-20': 1 }),
  ]);
  assert.equal(dated.complete, true);
  const count = type => unprocessedInPeriod(dated, resolvePeriod({ type }, CONTEXT), isWithinPeriod);
  assert.equal(count('previous_month'), 3);   // October
  assert.equal(count('current_month'), 0);    // November: none, as Xenon showed 0
  assert.equal(count('previous_fy'), 4);      // the whole year
});

test('a missing, cut-off or older list means the dates are not known', () => {
  assert.equal(datedUnprocessed(reading, [list('Current account', { '2026-10-03': 3 })]).complete, false);
  assert.equal(datedUnprocessed(reading, [list('Current account', { '2026-10-03': 3 }), list('Savings', { '2026-10-20': 1 }, { truncated: true })]).complete, false);
  const old = list('Savings', { '2026-10-20': 1 }, { readAt: new Date(READ_AT.getTime() - 60 * 60 * 1000) });
  assert.equal(datedUnprocessed(reading, [list('Current account', { '2026-10-03': 3 }), old]).complete, false);
  assert.equal(unprocessedInPeriod({ complete: false }, resolvePeriod({ type: 'current_month' }, CONTEXT), isWithinPeriod), null);
});

test('a client with nothing to reconcile has dates known and counts 0', () => {
  const dated = datedUnprocessed({ readAt: READ_AT, accounts: [{ accountName: 'Bank', itemsToReconcile: 0 }] }, []);
  assert.equal(unprocessedInPeriod(dated, resolvePeriod({ type: 'current_month' }, CONTEXT), isWithinPeriod), 0);
});
