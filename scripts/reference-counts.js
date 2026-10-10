// Independent reference counts: Xenon's published definitions applied to raw Xero data pulled by
// scripts/pull-xero-raw.js. Shares NO code with the Akrio checks, so it can be used to judge them.
// Usage: node scripts/reference-counts.js <rawDir> [client name part] [--json]
const fs = require('fs');
const path = require('path');

const rawDir = process.argv[2];
const only = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3].toLowerCase() : null;
const asJson = process.argv.includes('--json');
// --scope=xenon reproduces Xenon's own default scope ("All transactions" from the client's start date).
const scopeArg = (process.argv.find(a => a.startsWith('--scope=')) || '--scope=lock').split('=')[1];
const startFile = process.env.XENON_START_DATES;
const START = startFile ? JSON.parse(fs.readFileSync(startFile, 'utf8')) : {};
const TODAY = process.env.REF_TODAY || new Date().toISOString().slice(0, 10);
// Clients whose Xenon low-cost / capital threshold is £2,000 rather than £200 (read from Xenon settings).
const HIGH_THRESHOLD = /rose and caramel|handymanz|bevilacqua|positive internet|arc renewables|harlow|pegesus|mnm automotive|1st corps/i;

const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
const abs = Math.abs;

function compute(d) {
  const lock = [d.org.lock, d.org.eoyLock].filter(Boolean).sort().reverse()[0] || null;
  const xenonStart = START[d.name.slice(0, 9).toUpperCase()] || null;
  const from = scopeArg === 'xenon' ? xenonStart : lock;
  const inPeriod = date => !!date && (from ? (scopeArg === 'xenon' ? date >= from : date > from) : true) && date <= TODAY;
  const acct = new Map(d.accounts.map(a => [a.code, a]));
  const byId = new Map(d.accounts.map(a => [a.id, a]));
  const bankIds = new Set(d.accounts.filter(a => a.type === 'BANK').map(a => a.id));
  const contacts = new Map(d.contacts.map(c => [c.id, c]));
  const out = {};

  const inv = d.invoices;
  const accrec = inv.filter(i => i.type === 'ACCREC');
  const accpay = inv.filter(i => i.type === 'ACCPAY');

  // Unreconciled bank: authorised, not reconciled, on a bank account, dated in the period.
  const bankUn = d.bank.filter(b => b.st === 'AUTHORISED' && !b.rec && bankIds.has(b.acct) && inPeriod(b.d)).length;
  const payUn = d.payments.filter(p => p.st === 'AUTHORISED' && !p.rec && bankIds.has(p.acct) && inPeriod(p.d)).length;
  out.unrec = bankUn + payUn;
  out.unrec_bankonly = bankUn;

  // Old unpaid (more than 60 days old by document date, still unpaid). No lower bound.
  const old = i => daysBetween(i.d, TODAY) > 60;
  out.oldinv = accrec.filter(i => i.st === 'AUTHORISED' && i['due$'] > 0 && old(i)).length;
  out.oldbill = accpay.filter(i => i.st === 'AUTHORISED' && i['due$'] > 0 && old(i)).length;
  const credits = d.credits;
  out.oldsc = credits.filter(c => c.type === 'ACCRECCREDIT' && c.st === 'AUTHORISED' && c.rem > 0 && daysBetween(c.d, TODAY) > 60).length;
  out.oldpc = credits.filter(c => c.type === 'ACCPAYCREDIT' && c.st === 'AUTHORISED' && c.rem > 0 && daysBetween(c.d, TODAY) > 60).length;

  // Unapproved: draft or submitted, in period.
  out.unappinv = accrec.filter(i => ['DRAFT', 'SUBMITTED'].includes(i.st) && inPeriod(i.d)).length;
  out.unappbill = accpay.filter(i => ['DRAFT', 'SUBMITTED'].includes(i.st) && inPeriod(i.d)).length;

  // Undocumented bills: no attachment (authorised, and authorised or paid as a variant).
  out.undoc_auth = accpay.filter(i => i.st === 'AUTHORISED' && !i.att && inPeriod(i.d)).length;
  out.undoc_authpaid = accpay.filter(i => ['AUTHORISED', 'PAID'].includes(i.st) && !i.att && inPeriod(i.d)).length;

  // Low cost assets: lines on a Fixed Asset account with net value <= threshold (bills and bank spend).
  const lowT = HIGH_THRESHOLD.test(d.name) ? 2000 : 200;
  const isFixed = code => { const a = acct.get(code); return a && a.type === 'FIXED'; };
  let low = 0;
  for (const i of accpay.filter(i => ['AUTHORISED', 'PAID'].includes(i.st) && inPeriod(i.d))) for (const l of i.l) if (l.n && abs(l.n) <= lowT && abs(l.n) > 0 && isFixed(l.a)) low++;
  for (const b of d.bank.filter(b => b.type === 'SPEND' && b.st === 'AUTHORISED' && inPeriod(b.d))) for (const l of b.l) if (l.n && abs(l.n) <= lowT && abs(l.n) > 0 && isFixed(l.a)) low++;
  out.lowcost = low;

  // Multi-account / multi-tax suppliers (bills and bank spend, 3 month lookback before the period start).
  const base = scopeArg === 'xenon' ? xenonStart : lock;
  const lookStart = base ? new Date(new Date(base + 'T00:00:00Z').setUTCMonth(new Date(base + 'T00:00:00Z').getUTCMonth() - 3)).toISOString().slice(0, 10) : '2000-01-01';
  const lookDoc = date => !!date && date >= lookStart && date <= TODAY;
  const supplierDocs = [];
  for (const i of accpay.filter(i => ['AUTHORISED', 'PAID'].includes(i.st))) supplierDocs.push({ c: i.cid || i.c, d: i.d, l: i.l });
  for (const c of credits.filter(c => c.type === 'ACCPAYCREDIT' && ['AUTHORISED', 'PAID'].includes(c.st))) supplierDocs.push({ c: c.c, d: c.d, l: c.l });
  for (const b of d.bank.filter(b => b.type === 'SPEND' && b.st === 'AUTHORISED')) supplierDocs.push({ c: b.cid || b.c, d: b.d, l: b.l });
  const accBy = new Map(), taxBy = new Map(), inPer = new Set();
  for (const doc of supplierDocs) {
    if (!doc.c || !lookDoc(doc.d)) continue;
    for (const l of doc.l) {
      if (!l.n) continue;
      if (!accBy.has(doc.c)) { accBy.set(doc.c, new Set()); taxBy.set(doc.c, new Set()); }
      if (l.a) accBy.get(doc.c).add(String(l.a).toUpperCase());
      taxBy.get(doc.c).add(l.t || 'NONE');
      if (inPeriod(doc.d)) inPer.add(doc.c);
    }
  }
  out.multiacc = [...accBy].filter(([c, s]) => s.size > 1 && inPer.has(c)).length;
  out.multitax = [...taxBy].filter(([c, s]) => s.size > 1 && inPer.has(c)).length;

  // Sales tax missing: revenue-class lines with no tax code (sales invoices + bank receipts), VAT-registered only.
  const registered = d.org.basis && d.org.basis !== 'NONE';
  const isRev = code => { const a = acct.get(code); return a && a.cls === 'REVENUE'; };
  let st = 0;
  if (registered) {
    for (const i of accrec.filter(i => ['AUTHORISED', 'PAID'].includes(i.st) && inPeriod(i.d))) for (const l of i.l) if ((!l.t || l.t === 'NONE') && l.n > 0 && isRev(l.a)) st++;
    for (const b of d.bank.filter(b => b.type === 'RECEIVE' && b.st === 'AUTHORISED' && inPeriod(b.d))) for (const l of b.l) if ((!l.t || l.t === 'NONE') && l.n > 0 && isRev(l.a)) st++;
  }
  out.stmiss = st;

  // Contacts
  const used = new Set();
  for (const i of inv) if (i.cid) used.add(i.cid);
  out.dupcon_pool = d.contacts.filter(c => c.status === 'ACTIVE' && (c.cust || c.supp)).length;
  out.condef = d.contacts.filter(c => c.status === 'ACTIVE' && ((c.supp && (!c.acc || !c.pt)) || (c.cust && (!c.sacc || !c.rt)))).length;

  out._meta = { lock, lowT, registered, nInv: inv.length, nBank: d.bank.length };
  return out;
}

const files = fs.readdirSync(rawDir).filter(f => f.endsWith('.json')).sort();
const all = {};
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8'));
  if (only && !d.name.toLowerCase().includes(only)) continue;
  all[d.name] = compute(d);
}
if (asJson) console.log(JSON.stringify(all));
else for (const [n, o] of Object.entries(all)) console.log(n.padEnd(40), JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => k !== '_meta'))), JSON.stringify(o._meta));
