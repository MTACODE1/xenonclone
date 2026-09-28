#!/usr/bin/env node
// One-time, per-client import of Xenon Connect's already-dismissed items into our own
// finding_review_states table, so our issue counts stop re-showing things a human already
// reviewed and okayed in Xenon.
//
// This does NOT log into Xenon itself. You collect the dismissed items' real Xero transaction
// IDs from Xenon yourself (in a browser, logged in as normal) using the paired
// extract-xenon-dismissed.js browser snippet, save that as a JSON file, then run this script
// against it. Matching is by exact Xero transaction ID only — if an ID doesn't match anything
// in our own data for that org/check, it is skipped and reported, never guessed by date/amount.
//
// Usage:
//   node scripts/import-xenon-dismissals.js <org_id> <check_type> <path-to-xero-ids.json>
//
// <path-to-xero-ids.json> must be a JSON array of Xero transaction/invoice GUIDs, e.g.
//   ["344605e2-76db-4eaf-bb2f-5614514d147d", "..."]

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getDb } = require('../src/db/schema');
const { setFindingReviewStates } = require('../src/db/queries');

async function main() {
  const [orgIdArg, checkType, jsonPath] = process.argv.slice(2);
  if (!orgIdArg || !checkType || !jsonPath) {
    console.error('Usage: node scripts/import-xenon-dismissals.js <org_id> <check_type> <path-to-xero-ids.json>');
    process.exit(1);
  }
  const orgId = Number(orgIdArg);
  const xeroIds = JSON.parse(fs.readFileSync(path.resolve(jsonPath), 'utf8'));
  if (!Array.isArray(xeroIds) || !xeroIds.length) {
    console.error('Input file must be a non-empty JSON array of Xero transaction IDs.');
    process.exit(1);
  }

  const db = getDb();
  const issue = db.prepare(
    `SELECT id FROM issues WHERE org_id = ? AND check_type = ? AND is_active = 1`
  ).get(orgId, checkType);
  if (!issue) {
    console.error(`No active "${checkType}" issue found for org_id ${orgId} — sync this client first.`);
    process.exit(1);
  }

  const findings = db.prepare(
    `SELECT finding_key, detail_json FROM issue_findings WHERE issue_id = ?`
  ).all(issue.id);

  // The Xero transaction ID lives under different keys depending on the check's own finding
  // shape (invoiceId is used for both actual invoices and bank transactions across the tax
  // checks — see checkRules.js/xeroSync.js taxMissingLines construction).
  const byXeroId = new Map();
  for (const f of findings) {
    let detail;
    try { detail = JSON.parse(f.detail_json); } catch { continue; }
    const xeroId = detail.invoiceId || detail.id1 || detail.id2 || detail.bankTransactionId;
    if (xeroId) byXeroId.set(xeroId, f.finding_key);
  }

  const matchedKeys = [];
  const unmatched = [];
  for (const xeroId of xeroIds) {
    const key = byXeroId.get(xeroId);
    if (key) matchedKeys.push(key);
    else unmatched.push(xeroId);
  }

  if (matchedKeys.length) {
    const changed = await setFindingReviewStates(
      orgId, checkType, matchedKeys, 'dismissed',
      'Imported from Xenon Connect’s own dismissed-items list (exact Xero transaction ID match).'
    );
    console.log(`Dismissed ${changed} finding(s) for org ${orgId} / ${checkType}.`);
  } else {
    console.log('No matching findings to dismiss.');
  }
  if (unmatched.length) {
    console.log(`${unmatched.length} Xero ID(s) had no matching finding in our data — left untouched:`);
    unmatched.forEach(id => console.log(`  ${id}`));
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
