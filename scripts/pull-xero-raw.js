// Read-only: pulls each client's raw Xero data (independent of the Akrio sync) into JSON files so the
// checks can be recomputed from first principles. Resumable (skips finished clients). Usage:
//   node scripts/pull-xero-raw.js <outDir> [name part]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { apiCall } = require('../src/services/xeroClient');
const { getAllOrganisations } = require('../src/db/queries');

const outDir = process.argv[2];
const only = process.argv[3] && process.argv[3] !== '-' ? process.argv[3].toLowerCase() : null;
// optional shard "k/n" so several workers can run in parallel on different clients
const shard = (process.argv[4] || '0/1').split('/').map(Number);
fs.mkdirSync(outDir, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = d => { if (!d) return null; if (typeof d === 'string') { const m = d.match(/^(\d{4}-\d{2}-\d{2})/); if (m) return m[1]; const j = d.match(/\/Date\((\d+)/); return j ? new Date(Number(j[1])).toISOString().slice(0, 10) : null; } return new Date(d).toISOString().slice(0, 10); };
const slug = s => s.replace(/[^a-z0-9]+/gi, '_').slice(0, 60);
const lines = ls => (ls || []).map(l => ({ a: l.accountCode, t: l.taxType, n: l.lineAmount, x: l.taxAmount, d: (l.description || '').slice(0, 60) }));

async function pages(tid, fetchPage) {
  const out = [];
  for (let p = 1; ; p++) {
    const b = await apiCall(tid, async (x, t) => fetchPage(x, t, p));
    out.push(...b);
    if (b.length < 100) break;
    await sleep(700);
  }
  return out;
}

async function pull(org) {
  const tid = org.xero_tenant_id;
  const acc = x => x.accountingApi;
  const info = await apiCall(tid, async (x, t) => (await acc(x).getOrganisations(t)).body.organisations[0]);
  const accounts = await apiCall(tid, async (x, t) => (await acc(x).getAccounts(t)).body.accounts || []);
  const taxRates = await apiCall(tid, async (x, t) => (await acc(x).getTaxRates(t)).body.taxRates || []);
  const contacts = await pages(tid, async (x, t, p) => (await acc(x).getContacts(t, undefined, undefined, 'UpdatedDateUTC ASC', undefined, p, true)).body.contacts || []);
  const invoices = await pages(tid, async (x, t, p) => (await acc(x).getInvoices(t, undefined, undefined, 'UpdatedDateUTC ASC', undefined, undefined, undefined, undefined, p, true, undefined, undefined, false)).body.invoices || []);
  const credits = await pages(tid, async (x, t, p) => (await acc(x).getCreditNotes(t, undefined, undefined, 'UpdatedDateUTC ASC', p)).body.creditNotes || []);
  const bank = await pages(tid, async (x, t, p) => (await acc(x).getBankTransactions(t, undefined, undefined, 'UpdatedDateUTC ASC', p)).body.bankTransactions || []);
  const payments = await pages(tid, async (x, t, p) => (await acc(x).getPayments(t, undefined, undefined, 'UpdatedDateUTC ASC', p)).body.payments || []);
  const journals = await pages(tid, async (x, t, p) => (await acc(x).getManualJournals(t, undefined, undefined, 'UpdatedDateUTC ASC', p)).body.manualJournals || []);
  const data = {
    name: org.name, pulledAt: new Date().toISOString(),
    org: { lock: iso(info.periodLockDate), eoyLock: iso(info.endOfYearLockDate), basis: info.salesTaxBasis, period: info.salesTaxPeriod, type: info.organisationEntityType, country: info.countryCode, fyDay: info.financialYearEndDay, fyMonth: info.financialYearEndMonth },
    accounts: accounts.map(a => ({ id: a.accountID, code: a.code, name: a.name, type: a.type, cls: a._class, status: a.status, tax: a.taxType, sys: a.systemAccount, bank: a.bankAccountNumber ? 1 : 0 })),
    taxRates: taxRates.map(r => ({ type: r.taxType, name: r.name, rate: r.effectiveRate, rev: r.canApplyToRevenue, exp: r.canApplyToExpenses, status: r.status })),
    contacts: contacts.map(c => ({ id: c.contactID, name: c.name, status: c.contactStatus, cust: c.isCustomer, supp: c.isSupplier, acc: c.purchasesDefaultAccountCode, sacc: c.salesDefaultAccountCode, pt: c.accountsPayableTaxType, rt: c.accountsReceivableTaxType })),
    invoices: invoices.map(i => ({ id: i.invoiceID, no: i.invoiceNumber, type: i.type, st: i.status, d: iso(i.date), due: iso(i.dueDate), tot: i.total, due$: i.amountDue, paid: i.amountPaid, att: i.hasAttachments, c: i.contact?.name, cid: i.contact?.contactID, ref: i.reference, cur: i.currencyCode, l: lines(i.lineItems), upd: iso(i.updatedDateUTC) })),
    credits: credits.map(i => ({ id: i.creditNoteID, no: i.creditNoteNumber, type: i.type, st: i.status, d: iso(i.date), tot: i.total, rem: i.remainingCredit, c: i.contact?.name, l: lines(i.lineItems) })),
    bank: bank.map(b => ({ id: b.bankTransactionID, type: b.type, st: b.status, d: iso(b.date), rec: !!b.isReconciled, tot: b.total, c: b.contact?.name, cid: b.contact?.contactID, acct: b.bankAccount?.accountID, acctName: b.bankAccount?.name, att: b.hasAttachments, l: lines(b.lineItems) })),
    payments: payments.map(p => ({ id: p.paymentID, st: p.status, d: iso(p.date), rec: !!p.isReconciled, amt: p.amount, type: p.paymentType, acct: p.account?.accountID })),
    journals: journals.map(j => ({ id: j.manualJournalID, st: j.status, d: iso(j.date), l: (j.journalLines || []).map(l => ({ a: l.accountCode, n: l.lineAmount })) })),
  };
  fs.writeFileSync(path.join(outDir, `${slug(org.name)}.json`), JSON.stringify(data));
  return `${invoices.length} inv, ${bank.length} bank, ${contacts.length} contacts`;
}

(async () => {
  const orgs = (await getAllOrganisations()).filter(o => o.xero_tenant_id).filter(o => !only || o.name.toLowerCase().includes(only)).reverse()
    // Rose and Caramel is huge and keeps hitting Xero's rate limit while the sync runs — do it last.
    .sort((a, b) => (/rose and caramel/i.test(a.name) ? 1 : 0) - (/rose and caramel/i.test(b.name) ? 1 : 0));
  const mine = orgs.filter((_, idx) => idx % shard[1] === shard[0]);
  orgs.length = 0; orgs.push(...mine);
  console.log(`${orgs.length} clients (shard ${shard.join('/')})`);
  let i = 0;
  for (const org of orgs) {
    i++;
    const file = path.join(outDir, `${slug(org.name)}.json`);
    if (fs.existsSync(file)) { console.log(`[${i}/${orgs.length}] ${org.name}: already done`); continue; }
    try { console.log(`[${i}/${orgs.length}] ${org.name}: ${await pull(org)}`); }
    catch (err) { console.log(`[${i}/${orgs.length}] ${org.name}: FAILED ${err?.response?.body?.Message || err.message}`); }
  }
  console.log('ALL DONE');
  process.exit(0);
})();
