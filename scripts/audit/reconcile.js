// Per-client, per-check three-way ledger: Akrio vs Xenon vs Xero reference.
// Inputs (JSON, all keyed by client name, then check_type):
//   akrio  - scripts/audit/akrio-counts.js
//   xenon  - { "Client": { "check_type": 12 | null } }  (null = Xenon shows "(!)", not computed)
//   xero   - optional, scripts/reference-counts.js --json output (Xero raw data + Xenon's definitions)
// Usage: node scripts/audit/reconcile.js <akrio.json> <xenon.json> [xero.json] <outPrefix>
// Optional env XENON_DISMISSED=<file>: same shape as the xenon file but holding Xenon's "Show dismissed (n)"
// counts. Xenon's sidebar count EXCLUDES dismissed items, Akrio's counts everything it has not been told is
// dismissed, so a row also matches when Akrio = Xenon active + Xenon dismissed (status DISMISSED_IN_XENON).
// Status per row: MATCH (Akrio = Xenon), AKRIO_OK (differs from Xenon but equals Xero),
//   DISMISSED_IN_XENON, FAIL, BLOCKED.
// The headline percentage counts only rows where both Akrio and Xenon have a number.
const fs = require('fs');
const args = process.argv.slice(2);
const outPrefix = args.pop();
const [akrioFile, xenonFile, xeroFile] = args;
const akrio = JSON.parse(fs.readFileSync(akrioFile, 'utf8'));
const xenon = JSON.parse(fs.readFileSync(xenonFile, 'utf8'));
const xero = xeroFile ? JSON.parse(fs.readFileSync(xeroFile, 'utf8')) : {};

const XERO_KEYS = {
  unreconciled_bank_items: 'unrec', old_unpaid_invoices: 'oldinv', old_unpaid_bills: 'oldbill',
  old_sales_credits: 'oldsc', old_purchase_credits: 'oldpc', unapproved_invoices: 'unappinv',
  unapproved_bills: 'unappbill', undocumented_bills: 'undoc_auth', low_cost_fixed_assets: 'lowcost',
  multi_account_suppliers: 'multiacc', multi_tax_suppliers: 'multitax', sales_tax_missing: 'stmiss',
  contact_defaults: 'condef',
};
// Checks that depend on bank statement lines, which Xero's API does not expose: never comparable.
// inactive_contacts / contact_defaults / duplicate_contacts: Xenon mostly shows "(!)" (not computed) and its
// 0s are not a computed result, so they cannot be used as a reference yet.
const NOT_COMPARABLE = new Set(['bank_balance', 'unprocessed_bank', 'inactive_contacts', 'contact_defaults']);
const norm = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const xenonByName = new Map(Object.entries(xenon).map(([k, v]) => [norm(k), v]));
const dism = process.env.XENON_DISMISSED ? JSON.parse(fs.readFileSync(process.env.XENON_DISMISSED, 'utf8')) : {};
const dismByName = new Map(Object.entries(dism).map(([k, v]) => [norm(k), v]));
const xeroByName = new Map(Object.entries(xero).map(([k, v]) => [norm(k), v]));

const rows = [];
const clients = {};
for (const [name, a] of Object.entries(akrio)) {
  const x = xenonByName.get(norm(name));
  const ref = xeroByName.get(norm(name));
  const client = clients[name] = { name, xenon: !!x, xero: !!ref, match: 0, akrioOk: 0, fail: 0, blocked: 0, status: '' };
  if (a.status !== 'connected' || !x) {
    client.status = a.status !== 'connected' ? 'BLOCKED (disconnected)' : 'BLOCKED (not in Xenon)';
    continue;
  }
  for (const [check, xv] of Object.entries(x)) {
    const ak = a.checks[check]?.count;
    const dv = dismByName.get(norm(name))?.[check];
    const xr = ref && XERO_KEYS[check] ? ref[XERO_KEYS[check]] : undefined;
    let status;
    if (NOT_COMPARABLE.has(check) || xv === null || ak === undefined || ak === null) status = 'BLOCKED';
    else if (ak === xv) status = 'MATCH';
    else if (xr !== undefined && xr === ak) status = 'AKRIO_OK';
    else if (dv > 0 && ak === xv + dv) status = 'DISMISSED_IN_XENON';
    else status = 'FAIL';
    rows.push({ client: name, check, xenon: xv, xenonDismissed: dv ?? '', akrio: ak ?? '', xero: xr ?? '', status, akrioSynced: a.checks[check]?.syncedAt || '' });
    client[{ MATCH: 'match', AKRIO_OK: 'akrioOk', DISMISSED_IN_XENON: 'akrioOk', FAIL: 'fail', BLOCKED: 'blocked' }[status]]++;
  }
  client.status = client.fail ? 'FAIL' : 'PASS';
}

const q = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
const csv = (cols, data) => [cols.join(','), ...data.map(r => cols.map(c => q(r[c])).join(','))].join('\n');
fs.writeFileSync(`${outPrefix}-ledger.csv`, csv(['client', 'check', 'xenon', 'xenonDismissed', 'akrio', 'xero', 'status', 'akrioSynced'], rows));
fs.writeFileSync(`${outPrefix}-clients.csv`, csv(['name', 'xenon', 'xero', 'match', 'akrioOk', 'fail', 'blocked', 'status'], Object.values(clients)));

const compared = rows.filter(r => r.status !== 'BLOCKED');
const matched = compared.filter(r => r.status !== 'FAIL');
const withXero = compared.filter(r => r.xero !== '');
const cl = Object.values(clients);
console.log(JSON.stringify({
  clients: cl.length, pass: cl.filter(c => c.status === 'PASS').length, fail: cl.filter(c => c.status === 'FAIL').length,
  blocked: cl.filter(c => c.status.startsWith('BLOCKED')).length,
  rowsCompared: compared.length, exactMatchWithXenon: compared.filter(r => r.status === 'MATCH').length,
  dismissedInXenon: compared.filter(r => r.status === 'DISMISSED_IN_XENON').length,
  matchPct: +(100 * matched.length / (compared.length || 1)).toFixed(1),
  rowsBlocked: rows.length - compared.length,
  xeroVerifiedRows: withXero.length, akrioEqualsXero: withXero.filter(r => r.akrio === r.xero).length,
}, null, 1));
