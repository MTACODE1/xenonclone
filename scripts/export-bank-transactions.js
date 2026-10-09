// Pulls every bank transaction since each client's lock date straight from Xero (read-only) and
// writes one JSON file per client into the output folder (argv[2]). A separate step builds the xlsx.
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
  const rows = [];
  for (let page = 1; ; page++) {
    const batch = await apiCall(tid, async (xero, t) =>
      (await xero.accountingApi.getBankTransactions(t, undefined, where, 'Date ASC', page)).body.bankTransactions || []);
    for (const b of batch) {
      rows.push({
        id: b.bankTransactionID, type: b.type, date: iso(b.date), status: b.status, reconciled: !!b.isReconciled,
        contact: b.contact?.name || null, reference: b.reference || null,
        total: b.total, subTotal: b.subTotal, totalTax: b.totalTax, currency: b.currencyCode,
        bankAccount: b.bankAccount?.name || null, bankAccountCode: b.bankAccount?.code || null,
        lines: (b.lineItems || []).length,
        descriptions: (b.lineItems || []).map(l => l.description).filter(Boolean).join(' | '),
        updated: iso(b.updatedDateUTC),
      });
    }
    if (batch.length < 100) break;
    await sleep(Number(process.env.PAGE_DELAY_MS) || 300);
    if (process.env.PAGE_DELAY_MS) console.log('  page', page, rows.length);
  }
  fs.writeFileSync(path.join(outDir, `${slug(org.name)}.json`), JSON.stringify({ name: org.name, since, rows }));
  return rows.length;
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
    try { console.log(`[${i}/${orgs.length}] ${org.name}: ${await exportOrg(org)} transactions`); }
    catch (err) { console.log(`[${i}/${orgs.length}] ${org.name}: FAILED ${err.message}`); }
  }
  process.exit(0);
})();
