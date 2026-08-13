// Xenon parity regression suite.
//
// Every test here runs the REAL production check logic (checkRules.js, unmodified) against a
// FROZEN snapshot of one client's cached Xero data (test/fixtures/xenonParity/*.json), captured
// 13 Aug 2026. Fixtures carry an already-filtered candidate pool per check (not the raw client
// cache), trimmed to the fields each function actually reads.
//
// What "locked" means here, precisely: the fixture and its period are frozen, so a test failure
// can only mean the ALGORITHM changed — never that time passed or a client re-synced. This is
// deliberately narrower than "matches Xenon forever": old_unpaid_invoices/old_unpaid_bills and any
// other check whose count depends on "today's date" are NOT locked here, because their Xenon
// comparison is inherently a snapshot-in-time question (see XENON_ROW_LEVEL_EVIDENCE.md and
// XENON_PARITY_MATRIX.md) — freezing "today" inside a fixture would silently stop testing what
// actually matters (the 60-day boundary logic) and just re-assert today's arbitrary count forever.
//
// Only checks fully computable from checkRules.js's pure, exported functions are locked here.
// Checks whose logic lives inline in xeroSync.js (multi_account_suppliers, purchase_tax_missing,
// capital_item_review, etc.) are NOT covered by hard locks in this pass — see
// XENON_PARITY_MATRIX.md's "Locked by regression test" column for exactly which (client, check)
// pairs this file guards.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  findDuplicates, selectOldCredits, selectAuthorisedUnreconciled, sumAbsoluteExposure,
  CHECK_DEFAULTS,
} = require('../src/services/checkRules');

const FIXTURE_DIR = path.join(__dirname, 'fixtures/xenonParity');
function loadFixture(slug) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${slug}.json`), 'utf8'));
}

// Rounds the way the app's own headline £ figures are rendered, so a test failure threshold
// matches what a human would actually notice on screen.
function pounds(value) {
  return Math.round(value * 100) / 100;
}

// --- Duplicate Invoices — locked across all 5 clients with a Xenon fixture ---
// 4X4 and MBX are row-level proven exact against Xenon's own pasted export (see
// XENON_ROW_LEVEL_EVIDENCE.md section 1.1 / the duplicate-invoice deep-dive). The others lock the
// current, verified-against-production value, whether that's a real count or a confirmed-clean 0 —
// a silent regression from 0 to nonzero (or vice versa) is exactly the kind of change this must catch.

test('Duplicate Invoices — 4X4&MORE LTD: 31 groups, £3,509.90 (row-exact vs Xenon £3,510)', () => {
  const fx = loadFixture('4x4');
  const groups = findDuplicates(fx.duplicateInvoicePool);
  assert.equal(groups.length, 31);
  assert.equal(pounds(sumAbsoluteExposure(groups)), 3509.90);
});

test('Duplicate Invoices — HANDYMANZ LTD: confirmed clean (0 groups)', () => {
  const fx = loadFixture('handymanz');
  const groups = findDuplicates(fx.duplicateInvoicePool);
  assert.equal(groups.length, 0);
});

test('Duplicate Invoices — Fast Track Excavations: 1 group, £8,880 (exact vs Xenon)', () => {
  const fx = loadFixture('fast-track');
  const groups = findDuplicates(fx.duplicateInvoicePool);
  assert.equal(groups.length, 1);
  assert.equal(pounds(sumAbsoluteExposure(groups)), 8880);
});

test('Duplicate Invoices — ROSE AND CARAMEL LIMITED: confirmed clean (0 groups)', () => {
  const fx = loadFixture('rose');
  const groups = findDuplicates(fx.duplicateInvoicePool);
  assert.equal(groups.length, 0);
});

test('Duplicate Invoices — MBX GRAFFIX LIMITED: confirmed clean (0 groups)', () => {
  const fx = loadFixture('mbx');
  const groups = findDuplicates(fx.duplicateInvoicePool);
  assert.equal(groups.length, 0);
});

// --- Duplicate Bills — locked across all 5 clients ---
// 4X4 (£492.63) and MBX (£943.57) are the two clients XENON_PARITY_SPEC.md documents as row-exact
// for this check ("Row-exact on 4X4 and MBX View Issues").

test('Duplicate Bills — 4X4&MORE LTD: 6 groups, £492.63 (row-exact vs Xenon £493)', () => {
  const fx = loadFixture('4x4');
  const groups = findDuplicates(fx.duplicateBillPool, CHECK_DEFAULTS.duplicateBillWindowDays, { requireUnpaidPair: true });
  assert.equal(groups.length, 6);
  assert.equal(pounds(sumAbsoluteExposure(groups)), 492.63);
});

test('Duplicate Bills — MBX GRAFFIX LIMITED: 10 groups, £943.57 (row-exact vs Xenon £944)', () => {
  const fx = loadFixture('mbx');
  const groups = findDuplicates(fx.duplicateBillPool, CHECK_DEFAULTS.duplicateBillWindowDays, { requireUnpaidPair: true });
  assert.equal(groups.length, 10);
  assert.equal(pounds(sumAbsoluteExposure(groups)), 943.57);
});

test('Duplicate Bills — HANDYMANZ LTD: confirmed clean (0 groups)', () => {
  const fx = loadFixture('handymanz');
  const groups = findDuplicates(fx.duplicateBillPool, CHECK_DEFAULTS.duplicateBillWindowDays, { requireUnpaidPair: true });
  assert.equal(groups.length, 0);
});

test('Duplicate Bills — ROSE AND CARAMEL LIMITED: confirmed clean (0 groups)', () => {
  const fx = loadFixture('rose');
  const groups = findDuplicates(fx.duplicateBillPool, CHECK_DEFAULTS.duplicateBillWindowDays, { requireUnpaidPair: true });
  assert.equal(groups.length, 0);
});

test('Duplicate Bills — Fast Track Excavations: confirmed clean (0 groups)', () => {
  const fx = loadFixture('fast-track');
  const groups = findDuplicates(fx.duplicateBillPool, CHECK_DEFAULTS.duplicateBillWindowDays, { requireUnpaidPair: true });
  assert.equal(groups.length, 0);
});

// --- Old Sales Credits — Rose (check-type diversity beyond duplicates) ---

test('Old Sales Credits — ROSE AND CARAMEL LIMITED: 1 credit, £943.69 (exact vs Xenon £944)', () => {
  const fx = loadFixture('rose');
  const asOf = new Date(`${fx.period.end}T00:00:00.000Z`);
  const credits = selectOldCredits(fx.salesCreditPool, asOf);
  assert.equal(credits.length, 1);
  assert.equal(pounds(sumAbsoluteExposure(credits, c => c.remainingCredit)), 943.69);
});

// --- Unreconciled Bank Items — Fast Track (check-type diversity beyond duplicates) ---

test('Unreconciled Bank Items — Fast Track Excavations: 167 items, £177,956.58 (exact vs Xenon £177,957)', () => {
  const fx = loadFixture('fast-track');
  const bankAccountIds = new Set(fx.accounts.filter(a => a.type === 'BANK').map(a => a.accountID));
  const items = selectAuthorisedUnreconciled(fx.unreconciledBankTransactions, fx.unreconciledPayments, bankAccountIds);
  assert.equal(items.length, 167);
  assert.equal(pounds(sumAbsoluteExposure(items, x => x.total ?? x.amount)), 177956.58);
});
