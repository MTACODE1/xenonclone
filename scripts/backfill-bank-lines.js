// One-off: loads the per-client JSON written by scripts/export-bank-lines.js into akrio_bank_lines so
// the "Bank coding" page has data before the next full sync. Later syncs rewrite the same rows.
// Usage: node scripts/backfill-bank-lines.js <exportDir>
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getPool } = require('../src/db/mysqlPool');
const { getAllOrganisations } = require('../src/db/queries');
const { ensureTable, saveBankLines } = require('../src/db/bankLines');

(async () => {
  const dir = process.argv[2];
  await ensureTable();
  const orgs = new Map((await getAllOrganisations()).map(o => [o.name, o]));
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const org = orgs.get(d.name);
    if (!org) { console.log(`${d.name}: no matching client, skipped`); continue; }
    // Rebuild minimal Xero-shaped transactions from the flat export rows.
    const byId = new Map();
    const accounts = {};
    for (const r of d.rows) {
      if (r.accountCode) accounts[r.accountCode] = { name: r.accountName, type: r.accountType };
      if (!byId.has(r.id)) {
        byId.set(r.id, { bankTransactionID: r.id, type: r.type, status: r.status, isReconciled: r.reconciled, date: r.date,
          contact: { name: r.contact }, reference: r.reference, bankAccount: { name: r.bankAccount },
          currencyCode: r.currency, lineAmountTypes: r.amountTypes, lineItems: [] });
      }
      const t = byId.get(r.id);
      if (r.lineAmount !== null || r.accountCode) {
        t.lineItems.push({ accountCode: r.accountCode, description: r.description, taxType: r.taxType,
          lineAmount: r.lineAmount, taxAmount: r.taxAmount });
      }
    }
    const saved = await saveBankLines(org.id, [...byId.values()], accounts);
    console.log(`${d.name}: ${byId.size} transactions, ${saved} lines`);
  }
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
