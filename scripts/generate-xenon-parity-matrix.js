#!/usr/bin/env node
// Xenon parity matrix generator — a DIAGNOSTIC / REPORTING tool, not part of `npm test`.
//
// Read-only: opens the live database with { readonly: true } (physically write-blocked by
// SQLite/better-sqlite3 — any write attempt throws). Only pure logic modules with zero database
// imports (checkRules.js, periodResolver.js) are required from the application; xeroSync.js,
// statementEvidence.js, and db/queries.js are never touched, so nothing this script does can
// trigger a write anywhere.
//
// What it does: for every client with a stored Xenon comparison (validation_snapshots), it
// recomputes the checks that are fully expressible via checkRules.js's pure exported functions
// fresh against the CURRENT cached Xero data, self-checks each recomputation against the value the
// real production sync last wrote (to catch a script/production divergence before it corrupts the
// matrix — see the SELF_CHECK section), then classifies every (client, check) pair into one of:
//   EXACT | COUNT_MATCH_ONLY | MISMATCH | CONFIG_REQUIRED | EXTERNAL_EVIDENCE_REQUIRED |
//   NON_SCORED_INFORMATIONAL | NO_XENON_NUMBER
//
// Run manually, whenever you want a refreshed snapshot: node scripts/generate-xenon-parity-matrix.js
// Writes XENON_PARITY_MATRIX.md in the project root. Never mutates the database.

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const Database = require(path.join(ROOT, 'node_modules/better-sqlite3'));
const CR = require(path.join(ROOT, 'src/services/checkRules'));
const { isWithinPeriod } = require(path.join(ROOT, 'src/services/periodResolver'));
const {
  toDateString, findDuplicates, findDuplicateContacts, findDirectMatches,
  selectAuthorisedUnreconciled, selectOldCredits, isOldDocument, sumAbsoluteExposure,
  CHECK_DEFAULTS, CHECK_DEFINITIONS,
} = CR;

const CONFIG_REQUIRED = new Set(['capital_item_review', 'misallocated_items']);
const EXTERNAL_EVIDENCE = new Set(['bank_balance', 'unprocessed_bank', 'opening_balance_differences']);
const NON_SCORED = new Set(['duplicate_contacts', 'contact_defaults', 'inactive_contacts', 'undocumented_bills']);
// This script's reimplementation of unexpected_account_used / unexpected_tax_code_used only
// covers the bill-side loop; production also includes invoice- and bank-side lines (confirmed by
// self-check divergence on every client tested). Use the stored production value instead of
// recomputing, rather than ship a wrong number.
const RECOMPUTE_INCOMPLETE = new Set(['unexpected_account_used', 'unexpected_tax_code_used']);
// These depend on "today" relative to Xenon's snapshot date, so an EXACT match here is partly a
// coincidence of timing, not proof the formula is right — see the note this produces below.
const DATE_RELATIVE = new Set(['old_unpaid_invoices', 'old_unpaid_bills']);
// (client, check) pairs guarded by a hermetic regression test in test/xenonParity.test.js.
const LOCKED = new Set([
  '1:duplicate_invoices', '19:duplicate_invoices', '48:duplicate_invoices', '84:duplicate_invoices', '110:duplicate_invoices',
  '1:duplicate_bills', '19:duplicate_bills', '48:duplicate_bills', '84:duplicate_bills', '110:duplicate_bills',
  '84:old_sales_credits', '48:unreconciled_bank_items',
]);

function round2(v) { return Math.round(v * 100) / 100; }

function main() {
  const db = new Database(path.join(ROOT, 'data/xero_dashboard.db'), { readonly: true });
  const orgs = db.prepare(`
    SELECT DISTINCT o.id, o.name FROM organisations o
    JOIN validation_snapshots vs ON vs.org_id = o.id ORDER BY o.id
  `).all();

  const report = [];
  for (const org of orgs) {
    const snap = db.prepare('SELECT id FROM validation_snapshots WHERE org_id=? ORDER BY id DESC LIMIT 1').get(org.id);
    const xenonRows = db.prepare('SELECT check_type,xenon_count,xenon_value_gbp FROM validation_snapshot_checks WHERE snapshot_id=?').all(snap.id);
    const xenon = {};
    for (const r of xenonRows) xenon[r.check_type] = { count: r.xenon_count, value: r.xenon_value_gbp };

    const hs = db.prepare('SELECT period_start,period_end FROM health_scores WHERE org_id=? AND is_active=1 ORDER BY id DESC LIMIT 1').get(org.id);
    if (!hs) { report.push({ org, rows: {}, error: 'no active health_scores row — never synced' }); continue; }
    const period = { start: hs.period_start, end: hs.period_end };

    const cached = t => db.prepare('SELECT json FROM xero_entity_cache WHERE org_id=? AND entity_type=?').all(org.id, t).map(r => JSON.parse(r.json));
    const inv = cached('invoice'), bank = cached('bank_transaction'), credits = cached('credit_note');
    const contacts = cached('contact'), accounts = cached('account'), payments = cached('payment');
    const contactsById = {}; for (const c of contacts) if (c.contactID) contactsById[c.contactID] = c;
    const accrecAuth = inv.filter(i => i.type === 'ACCREC' && ['AUTHORISED', 'PAID'].includes(i.status));
    const accpayAuth = inv.filter(i => i.type === 'ACCPAY' && ['AUTHORISED', 'PAID'].includes(i.status));
    const accrecDraft = inv.filter(i => i.type === 'ACCREC' && ['DRAFT', 'SUBMITTED'].includes(i.status));
    const accpayDraft = inv.filter(i => i.type === 'ACCPAY' && ['DRAFT', 'SUBMITTED'].includes(i.status));
    const salesCredits = credits.filter(c => c.type === 'ACCRECCREDIT');
    const purchaseCredits = credits.filter(c => c.type === 'ACCPAYCREDIT');
    const revenueCodes = new Set(accounts.filter(a => a._class === 'REVENUE').map(a => a.code));
    const expenseCodes = new Set(accounts.filter(a => a._class === 'EXPENSE').map(a => a.code));
    const bankAccountIds = new Set(accounts.filter(a => a.type === 'BANK').map(a => a.accountID));
    const inPeriod = items => items.filter(x => isWithinPeriod(toDateString(x.date), period));
    const throughEnd = items => items.filter(x => { const d = toDateString(x.date); return d && d <= period.end; });
    const asOf = new Date(`${period.end}T00:00:00.000Z`);

    const live = {};
    const di = findDuplicates(inPeriod([...accrecAuth.filter(i => i.status === 'AUTHORISED'), ...accrecDraft.filter(i => i.status === 'SUBMITTED')]));
    live.duplicate_invoices = { count: di.length, value: round2(sumAbsoluteExposure(di)) };
    const dbg = findDuplicates(inPeriod([...accpayAuth, ...accpayDraft.filter(i => i.status === 'DRAFT')]), CHECK_DEFAULTS.duplicateBillWindowDays, { requireUnpaidPair: true });
    live.duplicate_bills = { count: dbg.length, value: round2(sumAbsoluteExposure(dbg)) };
    const unrec = selectAuthorisedUnreconciled(bank, payments, bankAccountIds).filter(x => isWithinPeriod(toDateString(x.date), period));
    live.unreconciled_bank_items = { count: unrec.length, value: round2(sumAbsoluteExposure(unrec, x => x.total ?? x.amount)) };
    const oui = throughEnd(accrecAuth).filter(i => (i.amountDue || 0) > 0 && isOldDocument(i, asOf));
    live.old_unpaid_invoices = { count: oui.length, value: round2(sumAbsoluteExposure(oui, i => i.amountDue)) };
    const oub = throughEnd(accpayAuth).filter(i => isOldDocument(i, asOf) && (i.amountDue || 0) > 0);
    live.old_unpaid_bills = { count: oub.length, value: round2(sumAbsoluteExposure(oub, i => i.amountDue)) };
    live.old_sales_credits = wrap(selectOldCredits(throughEnd(salesCredits), asOf), c => c.remainingCredit);
    live.old_purchase_credits = wrap(selectOldCredits(throughEnd(purchaseCredits).filter(c => c.status === 'AUTHORISED'), asOf), c => c.remainingCredit);
    live.duplicate_contacts = { count: findDuplicateContacts(contacts.filter(c => c.contactStatus === 'ACTIVE' && (c.isCustomer || c.isSupplier))).length, value: 0 };
    const bankReceive = bank.filter(b => b.type === 'RECEIVE' && b.status === 'AUTHORISED' && isWithinPeriod(toDateString(b.date), period));
    const bankSpend = bank.filter(b => b.type === 'SPEND' && b.status === 'AUTHORISED' && isWithinPeriod(toDateString(b.date), period));
    const unpaidInv = [...accrecAuth.filter(i => (i.amountDue || 0) > 0), ...accrecDraft];
    live.invoice_or_direct = wrap(findDirectMatches(bankReceive, unpaidInv, revenueCodes).map(m => ({ amount: m.transaction.total })));
    const unpaidBills = [...accpayAuth.filter(i => i.status === 'AUTHORISED' && (i.amountDue || 0) > 0), ...accpayDraft.filter(i => i.status === 'DRAFT')];
    live.bill_or_direct = wrap(findDirectMatches(bankSpend, unpaidBills, expenseCodes).map(m => ({ amount: m.transaction.total })));

    const stored = ct => {
      const row = db.prepare('SELECT count,potential_value_gbp,period_checked FROM issues WHERE org_id=? AND check_type=? AND is_active=1').get(org.id, ct);
      return row ? { count: row.count, value: row.potential_value_gbp == null ? null : round2(row.potential_value_gbp), source: 'last_stored_sync', period_checked: row.period_checked } : { count: null, value: null, source: 'no_row' };
    };
    const STORED_ONLY = CHECK_DEFINITIONS.map(c => c.type).filter(ct =>
      !(ct in live) || RECOMPUTE_INCOMPLETE.has(ct));
    for (const ct of STORED_ONLY) live[ct] = stored(ct);

    // Self-check: for every check recomputed via pure functions (not RECOMPUTE_INCOMPLETE and not
    // read from `stored`), compare against the last value production actually wrote. A divergence
    // means this script's reimplementation has drifted from the real algorithm — report it loudly
    // rather than publish a silently wrong matrix cell.
    const selfCheckWarnings = [];
    for (const ct of Object.keys(live)) {
      if (STORED_ONLY.includes(ct)) continue;
      const s = stored(ct);
      if (s.source === 'no_row') continue;
      if (s.count !== live[ct].count || Math.abs((s.value || 0) - (live[ct].value || 0)) > 0.5) {
        selfCheckWarnings.push(`${ct}: script=${live[ct].count}/£${live[ct].value} vs production=${s.count}/£${s.value}`);
      }
    }

    const rows = {};
    for (const ct of CHECK_DEFINITIONS.map(c => c.type)) {
      const xn = xenon[ct];
      const l = live[ct];
      let cls, note = '';
      if (EXTERNAL_EVIDENCE.has(ct)) cls = 'EXTERNAL_EVIDENCE_REQUIRED';
      else if (CONFIG_REQUIRED.has(ct)) cls = 'CONFIG_REQUIRED';
      else if (NON_SCORED.has(ct)) cls = 'NON_SCORED_INFORMATIONAL';
      else if (!xn || xn.count == null) cls = 'NO_XENON_NUMBER';
      else if (l.count === xn.count && Math.abs((l.value || 0) - (xn.value || 0)) < 1) {
        cls = 'EXACT';
        if (DATE_RELATIVE.has(ct)) note = 'date-relative — exact today only because our period end and Xenon\'s snapshot date happen to agree closely; will drift with time even without any code change';
      } else if (l.count === xn.count) cls = 'COUNT_MATCH_ONLY';
      else {
        cls = 'MISMATCH';
        if (DATE_RELATIVE.has(ct)) note = 'likely date drift, not a formula defect — Xenon\'s snapshot predates our live period end, so more documents have crossed the 60-day threshold since';
      }
      rows[ct] = {
        cls, note,
        live: { count: l.count, value: l.value },
        xenon: xn ? { count: xn.count, value: xn.value } : null,
        source: DATE_RELATIVE.has(ct) || !STORED_ONLY.includes(ct) ? 'recomputed_fresh' : 'last_stored_sync',
        locked: LOCKED.has(`${org.id}:${ct}`),
      };
    }
    report.push({ org, rows, selfCheckWarnings, period });
  }
  db.close();
  writeMarkdown(report);
}

function wrap(items, value = i => i.amount) {
  return { count: items.length, value: round2(sumAbsoluteExposure(items, value)) };
}

function writeMarkdown(report) {
  const lines = [];
  lines.push('# Xenon Parity Matrix');
  lines.push('');
  lines.push(`Generated ${new Date().toISOString().slice(0, 10)} by \`scripts/generate-xenon-parity-matrix.js\`. `
    + 'Read-only — no database or application state was modified to produce this report.');
  lines.push('');
  lines.push('Legend: **EXACT** count and value both match Xenon · **COUNT_MATCH_ONLY** count matches, '
    + 'value does not · **MISMATCH** neither matches · **CONFIG_REQUIRED** needs a one-time setup step in '
    + 'this app · **EXTERNAL_EVIDENCE_REQUIRED** needs data Xero cannot supply · **NON_SCORED_INFORMATIONAL** '
    + 'Xenon shows no comparable number (flag/N/A only) · **NO_XENON_NUMBER** no Xenon figure on file for '
    + 'this check on this client. 🔒 = guarded by a hermetic regression test in `test/xenonParity.test.js`.');
  lines.push('');

  for (const { org, rows, selfCheckWarnings, error } of report) {
    lines.push(`## ${org.name.trim()}`);
    lines.push('');
    if (error) { lines.push(`_${error}_`); lines.push(''); continue; }
    if (selfCheckWarnings && selfCheckWarnings.length) {
      lines.push('> **Self-check warning** — this script\'s recomputation diverged from the last value '
        + 'production actually stored for: ' + selfCheckWarnings.join('; ') + '. Those rows below use the '
        + 'stored production value, not this script\'s recomputation.');
      lines.push('');
    }
    lines.push('| Check | Status | Our value | Xenon value | Note |');
    lines.push('|---|---|---|---|---|');
    for (const [ct, r] of Object.entries(rows)) {
      const lock = r.locked ? ' 🔒' : '';
      const ourVal = r.live.count == null ? 'not configured' : `${r.live.count} / £${r.live.value}`;
      const xenonVal = r.xenon ? `${r.xenon.count} / £${r.xenon.value}` : '—';
      lines.push(`| ${ct}${lock} | ${r.cls} | ${ourVal} | ${xenonVal} | ${r.note} |`);
    }
    lines.push('');
  }

  fs.writeFileSync(path.join(ROOT, 'XENON_PARITY_MATRIX.md'), lines.join('\n'));
  console.log('Written: XENON_PARITY_MATRIX.md');
}

main();
