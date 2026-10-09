// Read-only: runs the new review checks live against one client's Xero data and prints the result.
// Writes nothing to Akrio. Usage: node scripts/try-review-checks.js "<client name part>"
require('dotenv').config();
const { apiCall } = require('../src/services/xeroClient');
const { getAllOrganisations } = require('../src/db/queries');
const jc = require('../src/services/journalChecks');
const iso = d => { if (!d) return null; if (typeof d === 'string') return (d.match(/^\d{4}-\d{2}-\d{2}/) || [null])[0] || (d.match(/\/Date\((\d+)/) ? new Date(Number(d.match(/\/Date\((\d+)/)[1])).toISOString().slice(0, 10) : null); return new Date(d).toISOString().slice(0, 10); };
const pages = async (tid, fn) => { const out = []; for (let p = 1; ; p++) { const b = await apiCall(tid, async (x, t) => fn(x, t, p)); out.push(...b); if (b.length < 100) break; await new Promise(r => setTimeout(r, 400)); } return out; };

(async () => {
  const part = process.argv[2].toLowerCase();
  const org = (await getAllOrganisations()).find(o => o.xero_tenant_id && o.name.toLowerCase().includes(part));
  if (!org) { console.log('client not found'); process.exit(1); }
  const tid = org.xero_tenant_id;
  const info = await apiCall(tid, async (x, t) => (await x.accountingApi.getOrganisations(t)).body.organisations[0]);
  const lock = [iso(info.periodLockDate), iso(info.endOfYearLockDate)].filter(Boolean).sort().reverse()[0] || '2000-01-01';
  const today = new Date().toISOString().slice(0, 10);
  const inPeriod = d => d && d >= lock && d <= today;
  console.log(`== ${org.name} | ${info.organisationEntityType} | period ${lock} to ${today}`);
  const accounts = await apiCall(tid, async (x, t) => (await x.accountingApi.getAccounts(t, undefined, undefined, 'Code ASC')).body.accounts || []);
  console.log('accounts named like a director loan:', accounts.filter(a => /director[s'’\s]{0,3}(loan|current)|\bdla\b|\bdrawings?\b/i.test(a.name)).map(a => `${a.code} ${a.name} [${a.type}]`).join('; ') || 'none');

  const mj = (await pages(tid, (x, t, p) => x.accountingApi.getManualJournals(t, undefined, undefined, 'UpdatedDateUTC ASC', p).then(r => r.body.manualJournals || [])))
    .filter(j => j.status === 'POSTED' && inPeriod(iso(j.date)));
  const unusual = jc.detectUnusualJournals({ journals: mj, accounts });
  for (const [k, items] of Object.entries(unusual)) console.log(`${k}: ${items.length}`, items.slice(0, 3).map(i => `${i.date} £${i.amount} ${i.description || ''}`.slice(0, 160)));

  const bs = (await apiCall(tid, async (x, t) => x.accountingApi.getReportBalanceSheet(t, today, undefined, undefined, undefined, undefined, true, false))).body.reports[0];
  const dla = info.organisationEntityType === 'COMPANY' ? jc.directorsLoanAlerts(bs, { asOf: today }) : [];
  console.log(`directors_loan_overdrawn: ${dla.length}`, dla.map(i => `${i.accountName} £${Math.round(i.amount)} ${i.level}`));
  console.log(`suspense_open_balance: ${jc.suspenseOpenBalances(bs, { asOf: today }).length}`);

  const payments = (await pages(tid, (x, t, p) => x.accountingApi.getPayments(t, undefined, undefined, 'UpdatedDateUTC ASC', p).then(r => r.body.payments || [])))
    .filter(p => inPeriod(iso(p.date)));
  const bank = (await pages(tid, (x, t, p) => x.accountingApi.getBankTransactions(t, undefined, undefined, 'Date ASC', p).then(r => r.body.bankTransactions || [])))
    .filter(b => b.type === 'SPEND' && b.status === 'AUTHORISED' && inPeriod(iso(b.date)));
  const sp = jc.supplierPaymentSources({ payments, bankSpend: bank, accounts });
  console.log(`supplier_payment_accounts: ${sp.length}`, sp.slice(0, 4).map(i => (i.contact || i.name || '') + ' ' + (i.description || '')).map(s => s.slice(0, 160)));
  process.exit(0);
})().catch(e => { console.log('ERROR', e?.response?.body?.Message || e.message); process.exit(1); });
