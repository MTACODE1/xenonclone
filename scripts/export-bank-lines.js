// Pulls every bank transaction since each client's lock date straight from Xero (read-only), one row
// per LINE ITEM, including the chart-of-accounts account the line was coded to (code + name), tax type
// and amounts. Writes one JSON file per client into the output folder (argv[2]); a separate step builds
// the xlsx. Safe to re-run: clients that already have a file are skipped.
// Usage: node scripts/export-bank-lines.js <outDir> [client name part]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { apiCall } = require('../src/services/xeroClient');
const { getAllOrganisations } = require('../src/db/queries');

const outDir = process.argv[2];
const only = process.argv[3] ? process.argv[3].toLowerCase() : null;
fs.mkdirSync(outDir, { recursive: true });

const iso = d => {
  if (!d) return null;
  if (typeof d === 'string') { const m = d.match(/^(\d{4}-\d{2}-\d{2})/); if (m) return m[1]; const j = d.match(/\/Date\((\d+)/); return j ? new Date(Number(j[1])).toISOString().slice(0, 10) : null; }
  return new Date(d).toISOString().slice(0, 10);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const slug = s => s.replace(/[^a-z0-9]+/gi, '_').slice(0, 60);

async function exportOrg(org) {
  const tid = org.xero_tenant_id;
  const info = await apiCall(tid, async (xero, t) => (await xero.accountingApi.getOrganisations(t)).body.organisations[0]);
  const lock = [iso(info.periodLockDate), iso(info.endOfYearLockDate)].filter(Boolean).sort().reverse()[0] || null;
  const since = lock || '2000-01-01';
  const [y, m, d] = since.split('-').map(Number);
  const where = lock ? `Date >= DateTime(${y}, ${m}, ${d})` : undefined;

  const accounts = await apiCall(tid, async (xero, t) => (await xero.accountingApi.getAccounts(t)).body.accounts || []);
  const acct = new Map(accounts.filter(a => a.code).map(a => [String(a.code), a]));

  const rows = [];
  let txns = 0;
  for (let page = 1; ; page++) {
    const batch = await apiCall(tid, async (xero, t) =>
      (await xero.accountingApi.getBankTransactions(t, undefined, where, 'Date ASC', page)).body.bankTransactions || []);
    for (const b of batch) {
      txns++;
      const base = {
        id: b.bankTransactionID, date: iso(b.date), type: b.type, status: b.status, reconciled: !!b.isReconciled,
        contact: b.contact?.name || null, reference: b.reference || null, currency: b.currencyCode,
        bankAccount: b.bankAccount?.name || null, amountTypes: b.lineAmountTypes || null, txnTotal: b.total,
      };
      const lines = b.lineItems || [];
      // A transaction with no lines (rare) still gets one row so it is not silently dropped.
      for (const l of lines.length ? lines : [{}]) {
        const code = l.accountCode ? String(l.accountCode) : null;
        rows.push({
          ...base,
          accountCode: code, accountName: code ? (acct.get(code)?.name || null) : null,
          accountType: code ? (acct.get(code)?.type || null) : null,
          description: l.description || null, taxType: l.taxType || null,
          lineAmount: l.lineAmount ?? null, taxAmount: l.taxAmount ?? null,
        });
      }
    }
    if (batch.length < 100) break;
    await sleep(Number(process.env.PAGE_DELAY_MS) || 300);
  }
  fs.writeFileSync(path.join(outDir, `${slug(org.name)}.json`), JSON.stringify({ name: org.name, since, txns, rows }));
  return { txns, lines: rows.length };
}

(async () => {
  const orgs = (await getAllOrganisations()).filter(o => o.connection_status === 'connected' && o.xero_tenant_id)
    .filter(o => !only || o.name.toLowerCase().includes(only));
  console.log(`${orgs.length} clients`);
  let i = 0;
  for (const org of orgs) {
    i++;
    const file = path.join(outDir, `${slug(org.name)}.json`);
    if (fs.existsSync(file)) { console.log(`[${i}/${orgs.length}] ${org.name}: already done`); continue; }
    try { const r = await exportOrg(org); console.log(`[${i}/${orgs.length}] ${org.name}: ${r.txns} transactions, ${r.lines} lines`); }
    catch (err) { console.log(`[${i}/${orgs.length}] ${org.name}: FAILED ${err.message}`); }
  }
  process.exit(0);
})();
