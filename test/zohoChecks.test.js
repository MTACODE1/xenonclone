// The Zoho Books checks (zohoChecks.js) and the UAE rules (uaeRules.js), on made-up Zoho data mapped through the
// real Zoho mappers (zoho/mapping.js), so the fixtures have exactly the shapes the sync hands the checks.
// No ledger, Zoho or database is called here. Every name and figure is invented.
const test = require('node:test');
const assert = require('node:assert/strict');

const mapping = require('../src/services/ledgers/zoho/mapping');
const zoho = require('../src/services/ledgers/zoho');
const { runZohoChecks, LABELS, unreconciledTotals } = require('../src/services/zohoChecks');
const uae = require('../src/services/uaeRules');
const { resolvePeriod } = require('../src/services/periodResolver');
const { resolveCheckDisplayStatus } = require('../src/services/checkRules');
const { checkDescriptionsFor, checkLabelFor } = require('../src/data/checkDescriptionsUae');
const baseDescriptions = require('../src/data/checkDescriptions');

const NOW = new Date('2026-11-10T12:00:00.000Z');
const PERIOD = resolvePeriod({ type: 'since_lock_date' }, { lockDate: '2026-06-30', asOf: '2026-11-10', ledgerName: 'Zoho Books' });

// ---------------- fixtures (invented) ----------------
const RAW_ACCOUNTS = [
  ['a-bank', 'Main Bank Account', 'bank'], ['a-card', 'Company Card', 'credit_card'], ['a-cash', 'Petty Cash', 'cash'],
  ['a-sales', 'Sales', 'income'], ['a-geninc', 'General Income', 'income'],
  ['a-office', 'Office Supplies', 'expense'], ['a-general', 'General Expenses', 'expense'], ['a-rent', 'Office Rent', 'expense'],
  ['a-salary', 'Salaries and Wages', 'expense'], ['a-meals', 'Meals and Entertainment', 'expense'],
  ['a-vehicle', 'Vehicle Running Costs', 'expense'], ['a-repairs', 'Repairs and Maintenance', 'expense'],
  ['a-equip', 'Office Equipment', 'fixed_asset'], ['a-input', 'Input VAT', 'other_current_asset'],
  ['a-output', 'Output VAT', 'other_current_liability'], ['a-suspense', 'Suspense', 'other_current_liability'],
];
const rawAccount = ([id, name, type], extra = {}) => ({ account_id: id, account_name: name, account_type: type, is_active: true, account_code: '', ...extra });
const ACCOUNTS = RAW_ACCOUNTS.map(row => mapping.mapAccount(rawAccount(row)));
const TAX_RATES = [
  mapping.mapTaxRate({ tax_id: 't-std', tax_name: 'Standard Rate', tax_percentage: 5, tax_type: 'tax', country_code: 'AE', tax_authority_name: 'FTA' }),
  mapping.mapTaxRate({ tax_id: 't-zero', tax_name: 'Zero Rate', tax_percentage: 0, tax_type: 'tax', country_code: 'AE', tax_authority_name: 'FTA' }),
];
const UK_RATES = [mapping.mapTaxRate({ tax_id: 'u-20', tax_name: 'Standard 20%', tax_percentage: 20, tax_type: 'tax', country_code: 'GB' })];

const line = (account, amount, { tax = null, pct = null, taxAmount = null, ...extra } = {}) => ({
  line_item_id: `${account}-${amount}`, account_id: account, item_total: amount, description: `${account} line`,
  tax_id: tax || '', tax_percentage: pct, ...(taxAmount != null ? { tax_amount: taxAmount } : {}), ...extra,
});
// A bill or invoice mapped from its list row plus its one-document read (with lines).
function bill(id, date, vendor, lines, extra = {}) {
  const raw = { bill_id: id, bill_number: `B-${id}`, status: 'paid', date, due_date: date, total: 1, balance: 0, vendor_id: vendor,
    vendor_name: `Supplier ${vendor}`, currency_code: 'AED', exchange_rate: 1, has_attachment: true, last_modified_time: `${date}T10:00:00+0400`, ...extra };
  return { ...zoho.mapBill(raw), ...mapping.documentDetail({ ...raw, line_items: lines }) };
}
function invoice(id, date, customer, lines, extra = {}) {
  const raw = { invoice_id: id, invoice_number: `I-${id}`, status: 'paid', date, due_date: date, total: 1, balance: 0, customer_id: customer,
    customer_name: `Customer ${customer}`, currency_code: 'AED', exchange_rate: 1, last_modified_time: `${date}T10:00:00+0400`, ...extra };
  return { ...zoho.mapInvoice(raw), ...mapping.documentDetail({ ...raw, line_items: lines }) };
}
function journal(id, date, lines) {
  return mapping.mapManualJournal({ journal_id: id, entry_number: `MJ-${id}`, journal_date: date, status: 'published', currency_code: 'AED',
    exchange_rate: 1, last_modified_time: `${date}T10:00:00+0400`, line_items: lines });
}
const jl = (account, side, amount, extra = {}) => ({ line_id: `${account}-${side}`, account_id: account, debit_or_credit: side, amount, bcy_amount: amount, ...extra });
function expense(id, date, vendor, account, amount, extra = {}) {
  return mapping.mapExpense({ expense_id: id, date, vendor_id: vendor, vendor_name: `Supplier ${vendor}`, account_id: account,
    amount, total: amount, currency_code: 'AED', exchange_rate: 1, paid_through_account_id: 'a-bank', paid_through_account_name: 'Main Bank Account',
    last_modified_time: `${date}T10:00:00+0400`, ...extra }, { detail: true });
}

// The money helpers ledgerChecks hands over, for an AED client with conversion on (same rules as ledgerChecks.js).
function money(base = 'AED') {
  const foreignCode = doc => { const c = String(doc?.currencyCode || '').toUpperCase(); return /^[A-Z]{3}$/.test(c) && c !== base ? c : null; };
  const hasRate = doc => Number(doc?.currencyRate) > 0;
  const converted = (amount, doc) => (foreignCode(doc) ? Math.round((amount / doc.currencyRate) * 100) / 100 : amount);
  return {
    base, converts: true, foreignCode, noRate: doc => Boolean(foreignCode(doc)) && !hasRate(doc), converted,
    inBase: (amount, doc) => (foreignCode(doc) && !hasRate(doc) ? 0 : converted(amount, doc)),
    currencyFields: (doc, amount) => {
      const code = foreignCode(doc);
      if (!code) return {};
      if (!hasRate(doc)) return { currency: code, noExchangeRate: true, potentialValue: 0 };
      const value = converted(amount, doc);
      return { currency: code, baseAmount: value, potentialValue: value };
    },
  };
}

function run({ invoices = [], credits = [], contacts = [], accounts = ACCOUNTS, taxRates = TAX_RATES, journals = [], bankTransactions = [],
  readStatus = { permissions: { banking: true, expenses: true } }, region = 'AE', taxProfile = { isTaxRegistered: true }, bankReading = null,
  org = { id: 1 }, base = 'AED', period = PERIOD } = {}) {
  const { issues, notes } = runZohoChecks({
    org, period, region, taxProfile, invoices, credits, contacts, bankReading, now: NOW, money: money(base),
    accounting: { accounts, taxRates, manualJournals: journals, bankTransactions, readStatus },
  });
  const byType = Object.fromEntries(issues.map(issue => [issue.check_type, { ...issue, items: JSON.parse(issue.detail_json) }]));
  return { byType, issues, notes };
}
const counted = check => check.items.filter(item => !item.displayOnly);
const status = check => resolveCheckDisplayStatus(check);

// ---------------- UAE rules ----------------

test('regionOf: AED, an AE/FTA tax rate or the TRN label make a UAE client; a GBP client with UK rates is not', () => {
  assert.equal(uae.regionOf({ baseCurrency: 'AED' }), 'AE');
  assert.equal(uae.regionOf({ baseCurrency: 'GBP', taxRates: TAX_RATES }), 'AE', 'FTA rates');
  assert.equal(uae.regionOf({ taxProfile: { taxRegNoLabel: 'TRN' } }), 'AE');
  assert.equal(uae.regionOf({ baseCurrency: 'GBP', taxRates: UK_RATES }), null);
  assert.equal(uae.regionOf({}), null, 'nothing known: not guessed');
});

test('VAT registration: Zoho\'s flag wins; unknown falls back to an active rate above 0%, never to "registered" from nothing', () => {
  assert.equal(uae.isVatRegistered({ isTaxRegistered: false }, TAX_RATES), false);
  assert.equal(uae.isVatRegistered({ isTaxRegistered: true }, []), true);
  assert.equal(uae.isVatRegistered(null, TAX_RATES), true);
  assert.equal(uae.isVatRegistered(null, [TAX_RATES[1]]), false, 'a zero rate only');
  assert.equal(uae.isVatRegistered(null, []), false);
});

test('UAE thresholds: mandatory, amber, voluntary and deregistration bands at their exact edges', () => {
  const rules = (supplies, registered) => uae.evaluateUaeThresholds({ taxableSupplies: supplies, registered }).map(i => `${i.rule}:${i.level}`);
  assert.deepEqual(rules(375000.01, false), ['uae_vat_mandatory:red']);
  assert.deepEqual(rules(375000, false), ['uae_vat_mandatory:amber'], 'at the limit is not over it');
  assert.deepEqual(rules(337500, false), ['uae_vat_mandatory:amber'], '90% starts amber');
  assert.deepEqual(rules(337499.99, false), ['uae_vat_voluntary:info']);
  assert.deepEqual(rules(187500, false), ['uae_vat_voluntary:info']);
  assert.deepEqual(rules(187499.99, false), []);
  assert.deepEqual(rules(187499.99, true), ['uae_vat_deregistration:info']);
  assert.deepEqual(rules(187500, true), []);
  const item = uae.evaluateUaeThresholds({ taxableSupplies: 342100, registered: false })[0];
  assert.match(item.description, /AED 342,100 against the AED 375,000 mandatory registration limit/);
});

test('Small Business Relief: amber from 90% of AED 3m, red over it; "review" for a free zone company; not after 2029', () => {
  const sbr = extra => uae.evaluateUaeThresholds({ taxableSupplies: 500000, registered: true, periodEnd: '2026-11-10', ...extra })
    .filter(i => i.rule === 'uae_sbr_revenue').map(i => i.level);
  assert.deepEqual(sbr({ revenue: 3000000.01 }), ['red']);
  assert.deepEqual(sbr({ revenue: 3000000 }), ['amber']);
  assert.deepEqual(sbr({ revenue: 2700000 }), ['amber']);
  assert.deepEqual(sbr({ revenue: 2699999 }), []);
  // Only a Qualifying Free Zone Person is excluded, and not every free zone company is one: shown for review.
  assert.deepEqual(sbr({ revenue: 3500000, isFreeZone: true }), ['review']);
  assert.deepEqual(sbr({ revenue: 3500000, periodEnd: '2030-03-31' }), [], 'after the last period the relief covers');
  // The tax period is the financial year: a year ending after 2029 is out even while the review period is in 2029.
  assert.deepEqual(sbr({ revenue: 3500000, periodEnd: '2029-11-30', fyEnd: '2030-03-31' }), []);
  assert.deepEqual(sbr({ revenue: 3500000, periodEnd: '2029-11-30', fyEnd: '2029-12-31' }), ['red']);
  // Relief is lost for good once an earlier year went over AED 3m (Ministerial Decision 73 of 2023, Art. 2).
  const earlier = uae.evaluateUaeThresholds({ taxableSupplies: 500000, registered: true, revenue: 1000000, fyEnd: '2026-12-31',
    priorRevenue: [{ fyEnd: '2025-12-31', revenue: 3200000 }, { fyEnd: '2024-12-31', revenue: 900000 }] }).find(i => i.rule === 'uae_sbr_revenue');
  assert.equal(earlier.level, 'red');
  assert.match(earlier.description, /earlier financial year to 31\/12\/2025 .*not available for this or any later tax period/);
  const over = uae.evaluateUaeThresholds({ taxableSupplies: 500000, registered: true, revenue: 3100000 }).find(i => i.rule === 'uae_sbr_revenue');
  assert.match(over.description, /that tax period or any later one/);
  assert.deepEqual(sbr({ revenue: null }), [], 'revenue not known: nothing said');
});

test('exempt / out of scope and reverse charge lines are told apart from a missing rate', () => {
  assert.equal(uae.isExemptLine({ taxExemptionID: 'x1' }), true);
  assert.equal(uae.isExemptLine({ taxExemptionCode: 'EXEMPT' }), true);
  assert.equal(uae.isExemptLine({ taxTreatmentCode: 'out_of_scope' }), true);
  assert.equal(uae.isExemptLine({ taxType: 'NONE' }), false);
  assert.equal(uae.isReverseChargeLine({ isReverseChargeApplied: true }, {}), true);
  assert.equal(uae.isReverseChargeLine({}, { isReverseCharge: true }), true);
  assert.equal(uae.isImportDocument({ taxTreatment: 'non_gcc' }), true);
  assert.equal(uae.isImportDocument({ taxTreatment: 'gcc_vat_registered' }), true);
  assert.equal(uae.isImportDocument({ taxTreatment: 'vat_registered' }), false);
});

test('the Zoho mappers keep the UAE fields the checks need (exemption, ITC eligibility, treatment, emirate)', () => {
  const doc = bill('m1', '2026-08-01', 'v1', [line('a-office', 100, { tax_exemption_id: 'x1', tax_exemption_code: 'EXEMPT', itc_eligibility: 'eligible' })],
    { tax_treatment: 'non_gcc', place_of_supply: 'DU', filed_in_vat_return_id: '' });
  assert.equal(doc.lineItems[0].taxExemptionID, 'x1');
  assert.equal(doc.lineItems[0].itcEligibility, 'eligible');
  assert.equal(doc.taxTreatment, 'non_gcc');
  assert.equal(doc.placeOfSupply, 'DU');
  assert.equal(doc.filedInVatReturnID, null, 'an empty id is "not filed"');
  assert.ok(mapping.DETAIL_FIELDS.includes('taxTreatment'), 'carried forward with the cached lines');
  const profile = mapping.taxProfileOf({ currency_code: 'AED', is_free_zone: false, tax_settings: { is_tax_registered: true, tax_reg_no: '100000000000003', tax_reg_no_label: 'TRN', tax_registered_date: '2020-01-01' } });
  assert.deepEqual([profile.isTaxRegistered, profile.taxRegNoLabel, profile.isFreeZone, profile.isDesignatedZone], [true, 'TRN', false, null]);
});

// ---------------- coding checks ----------------

test('Purchase Tax Missing (UAE): flags a blank rate on an expense account; exempt, reverse charge, payroll and tiny lines are left out; rent stays in', () => {
  const { byType } = run({ invoices: [
    bill('p1', '2026-08-01', 'v1', [
      line('a-office', 100),                                        // flagged
      line('a-rent', 5000),                                         // flagged: commercial rent is standard-rated in the UAE
      line('a-office', 80, { tax: 't-std', pct: 5 }),               // has a rate
      line('a-office', 70, { tax_exemption_id: 'x1' }),             // exempt on purpose
      line('a-salary', 9000),                                       // payroll: no VAT
      line('a-office', 0.99),                                       // under 1
    ]),
    bill('p2', '2026-08-02', 'v2', [line('a-office', 60)], { is_reverse_charge_applied: true }),
    bill('p3', '2026-06-30', 'v1', [line('a-office', 55)]),         // the lock date itself is outside the period
  ] });
  const check = byType.purchase_tax_missing;
  assert.equal(check.count, 2);
  assert.deepEqual(counted(check).map(i => [i.accountCode, i.amount]), [['Office Supplies', 100], ['Office Rent', 5000]]);
  assert.equal(check.potential_value_gbp, 5100);
  assert.ok(check.items.some(i => i.displayOnly && i.amount === 55), 'the lock-date bill is listed with the previous months only');
});

test('Purchase Tax Missing (UK Zoho client) keeps the Xero noise rules: rent and bank fees are skipped', () => {
  const accounts = [...ACCOUNTS, mapping.mapAccount(rawAccount(['a-fees', 'Bank Fees', 'expense']))];
  const { byType } = run({ region: null, base: 'GBP', taxRates: UK_RATES, accounts, invoices: [
    bill('k1', '2026-08-01', 'v1', [line('a-rent', 500), line('a-fees', 20), line('a-office', 30)], { currency_code: 'GBP' }),
  ] });
  assert.deepEqual(counted(byType.purchase_tax_missing).map(i => i.accountCode), ['Office Supplies']);
});

test('Sales / Purchase Tax Missing: not VAT registered is "not applicable"; no chart read leaves them "Not synced"', () => {
  const docs = [invoice('s1', '2026-08-01', 'c1', [line('a-sales', 100)])];
  const off = run({ invoices: docs, taxProfile: { isTaxRegistered: false } }).byType;
  assert.equal(off.sales_tax_missing.period_checked, 'not_vat_registered');
  assert.equal(status(off.sales_tax_missing), 'not_applicable');
  const noChart = run({ invoices: docs, accounts: [] }).byType;
  assert.equal(noChart.sales_tax_missing, undefined, 'never a false OK');
  assert.equal(noChart.purchase_tax_missing, undefined);
});

test('Sales Tax Missing (UAE): a blank-rate export is a finding (it should carry Zero Rate); zero-rated and exempt lines are not', () => {
  const { byType } = run({ invoices: [
    invoice('s1', '2026-08-01', 'c1', [line('a-sales', 1000)], { tax_treatment: 'non_gcc' }),
    invoice('s2', '2026-08-02', 'c1', [line('a-sales', 900, { tax: 't-zero', pct: 0 })], { tax_treatment: 'non_gcc' }),
    invoice('s3', '2026-08-03', 'c1', [line('a-sales', 800, { tax_treatment_code: 'out_of_scope' })]),
    invoice('s4', '2026-08-04', 'c1', [line('a-office', 700)]),   // not an income account
  ] });
  assert.deepEqual(counted(byType.sales_tax_missing).map(i => [i.invoiceId, i.amount]), [['s1', 1000]]);
});

test('a USD bill with no exchange rate is listed but kept out of the money total; a USD bill with a rate is converted', () => {
  const { byType } = run({ invoices: [
    bill('f1', '2026-08-01', 'v1', [line('a-office', 100)], { currency_code: 'USD', exchange_rate: 3.6725 }),
    bill('f2', '2026-08-02', 'v1', [line('a-office', 50)], { currency_code: 'USD', exchange_rate: '' }),
  ] });
  const rows = counted(byType.purchase_tax_missing);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => [r.currency, r.amount, r.baseAmount ?? null, Boolean(r.noExchangeRate)]),
    [['USD', 100, 367.25, false], ['USD', 50, null, true]]);
  assert.equal(byType.purchase_tax_missing.potential_value_gbp, 367.25);
});

test('Low Cost Fixed Assets: AED 10,000 for a UAE client (at the limit flagged, just over not); GBP 2,000 for a UK one', () => {
  const docs = [bill('l1', '2026-08-01', 'v1', [line('a-equip', 10000), line('a-equip', 10000.01), line('a-equip', 1500)])];
  const ae = run({ invoices: docs }).byType.low_cost_fixed_assets;
  assert.deepEqual(counted(ae).map(i => i.amount), [10000, 1500]);
  assert.equal(ae.period_checked, 'fixed_asset_accounts_lte_10000_since_lock_date');
  const uk = run({ invoices: docs, region: null, base: 'AED' }).byType.low_cost_fixed_assets;
  assert.deepEqual(counted(uk).map(i => i.amount), [1500]);
});

test('Capital Item Review: an expense line at or over the threshold on a watched account; wages never; a low-cost fixed asset line not twice', () => {
  const { byType } = run({ invoices: [bill('c1', '2026-08-01', 'v1', [
    line('a-repairs', 10000), line('a-repairs', 9999.99), line('a-salary', 50000), line('a-office', 12000),
  ])] });
  assert.deepEqual(counted(byType.capital_item_review).map(i => [i.accountCode, i.amount]).sort(), [['Office Supplies', 12000], ['Repairs and Maintenance', 10000]]);
  const none = run({ accounts: ACCOUNTS.filter(a => a._class !== 'EXPENSE') }).byType.capital_item_review;
  assert.equal(none.period_checked, 'not_configured', 'no account to watch: "Not configured", not a false OK');
  assert.equal(none.count, null);
});

test('Misallocated Items: lines on "General Expenses" and "General Income" from 1 up', () => {
  const { byType } = run({ invoices: [
    bill('g1', '2026-08-01', 'v1', [line('a-general', 1), line('a-general', 0.5), line('a-office', 500)]),
    invoice('g2', '2026-08-01', 'c1', [line('a-geninc', 250, { tax: 't-std', pct: 5 })]),
  ], bankTransactions: [expense('e1', '2026-08-03', 'v3', 'a-general', 40)] });
  assert.deepEqual(counted(byType.misallocated_items).map(i => [i.source, i.accountCode, i.amount]),
    [['bill', 'General Expenses', 1], ['invoice', 'General Income', 250], ['expense', 'General Expenses', 40]]);
  assert.equal(counted(byType.misallocated_items)[2].bankTransactionId, 'exp-e1');
});

test('Multi-Account Suppliers: a supplier on two expense accounts is flagged with the smaller account\'s value; one account is not', () => {
  const { byType } = run({ invoices: [
    bill('m1', '2026-08-01', 'v1', [line('a-office', 300)]),
    bill('m2', '2026-08-05', 'v1', [line('a-general', 40)]),
    bill('m3', '2026-08-06', 'v2', [line('a-office', 10), line('a-office', 20)]),
    bill('m4', '2026-08-07', 'v1', [line('a-equip', 900)]),      // a fixed asset line is not an expense coding
  ], bankTransactions: [expense('e1', '2026-08-08', 'v1', 'a-office', 5)] });
  const check = byType.multi_account_suppliers;
  assert.equal(check.count, 1);
  assert.equal(check.items[0].contactId, 'v1');
  assert.deepEqual(check.items[0].accountCodes.sort(), ['General Expenses', 'Office Supplies']);
  assert.equal(check.potential_value_gbp, 40);
  assert.ok(check.items[0].transactions.some(t => t.source === 'expense'), 'expenses count as supplier spending');
});

test('Multi-Tax Code Suppliers: 5% and no VAT on one supplier is flagged; the "No VAT" amount adds no value', () => {
  const { byType } = run({ invoices: [
    bill('t1', '2026-08-01', 'v1', [line('a-office', 1000, { tax: 't-std', pct: 5 })]),
    bill('t2', '2026-08-02', 'v1', [line('a-office', 200)]),
    bill('t3', '2026-08-03', 'v1', [line('a-office', 300, { tax: 't-zero', pct: 0 })]),
    bill('t4', '2026-08-04', 'v2', [line('a-office', 100, { tax: 't-std', pct: 5 })]),
  ] });
  const check = byType.multi_tax_suppliers;
  assert.equal(check.count, 1);
  assert.deepEqual(check.items[0].taxCodes.sort(), ['No VAT', 'Standard Rate', 'Zero Rate']);
  assert.equal(check.items[0].dominantTax, 'Standard Rate');
  assert.equal(check.potential_value_gbp, 300);
});

test('Sales Tax on Bills, Purchase Tax on Invoices, Unexpected Account / Tax Code: not applicable, with the right label', () => {
  const ae = run().byType;
  assert.equal(ae.sales_tax_on_bills.period_checked, LABELS.notApplicableUae);
  assert.equal(ae.purchase_tax_on_invoices.period_checked, LABELS.notApplicableUae);
  assert.equal(ae.unexpected_account_used.period_checked, LABELS.notApplicableZoho);
  assert.equal(ae.unexpected_tax_code_used.period_checked, LABELS.notApplicableZoho);
  for (const type of ['sales_tax_on_bills', 'unexpected_account_used']) assert.equal(status(ae[type]), 'not_applicable');
  assert.equal(run({ region: null }).byType.sales_tax_on_bills.period_checked, LABELS.notApplicableZoho);
});

test('Bill or Direct: an expense matching an unpaid bill from the same supplier within 30 days; refused expense access asks to reconnect', () => {
  const unpaid = bill('d1', '2026-08-01', 'v1', [line('a-office', 250)], { status: 'open', total: 250, balance: 250 });
  const { byType } = run({ invoices: [unpaid], bankTransactions: [
    expense('e1', '2026-08-20', 'v1', 'a-office', 250), expense('e2', '2026-09-15', 'v1', 'a-office', 250),
  ] });
  assert.deepEqual(counted(byType.bill_or_direct).map(i => [i.bankTransactionId, i.invoiceId]), [['exp-e1', 'bill-d1']]);
  const refused = run({ invoices: [unpaid], readStatus: { permissions: { banking: false, expenses: false } } }).byType.bill_or_direct;
  assert.equal(refused.period_checked, LABELS.expenseAccess);
  assert.equal(status(refused), 'not_configured');
  // Invoice or Direct now reads the categorised deposits (tested below); none read yet asks for a sync.
  assert.equal(run().byType.invoice_or_direct.period_checked, 'needs_sync');
});

// ---------------- journal checks ----------------

test('VAT Control Journals: a journal to Input VAT, and one with a 5% rate on an expense line, are flagged; a plain journal is not', () => {
  const journals = [
    journal('j1', '2026-08-01', [jl('a-input', 'debit', 50), jl('a-suspense', 'credit', 50)]),
    journal('j2', '2026-08-02', [jl('a-office', 'debit', 100, { tax_id: 't-std', tax_percentage: 5 }), jl('a-bank', 'credit', 105)]),
    journal('j3', '2026-08-03', [jl('a-office', 'debit', 100), jl('a-suspense', 'credit', 100)]),
  ];
  const { byType } = run({ journals });
  const vat = counted(byType.journal_vat_control);
  assert.deepEqual(vat.map(i => [i.documentId, i.accountCode, i.amount]), [['j1', 'Input VAT', 50], ['j2', 'Input VAT', 5]]);
  assert.equal(vat[1].taxType, 'Standard Rate');
  assert.equal(vat[1].taxOnAccountCode, 'Office Supplies');
  assert.equal(vat[0].number, 'MJ-j1', 'Zoho\'s own journal number');
  assert.deepEqual(counted(byType.journal_to_bank).map(i => i.documentId), ['j2']);
  assert.equal(byType.journal_vat_control.importance, 'critical');
});

test('Revenue Journalled Against Expense and Fixed Asset Credited to Expense use the Xero rules on Zoho journals', () => {
  const { byType } = run({ journals: [
    journal('r1', '2026-08-01', [jl('a-sales', 'debit', 300), jl('a-office', 'credit', 300)]),
    journal('f1', '2026-08-02', [jl('a-office', 'debit', 900), jl('a-equip', 'credit', 900)]),
  ] });
  assert.deepEqual(counted(byType.journal_revenue_vs_expense).map(i => [i.accountCode, i.counterAccountCode]), [['Sales', 'Office Supplies']]);
  assert.deepEqual(counted(byType.journal_fixed_asset_to_expense).map(i => i.accountCode), ['Office Equipment']);
  const unread = run({ journals: [{ ...journal('u1', '2026-08-01', []), linesRead: false, journalLines: [] }] });
  assert.equal(unread.byType.journal_vat_control.count, 0);
  assert.match(unread.notes.join(' '), /1 Zoho Books document\(s\) in the period have no line items read yet/);
});

test('balance checks with no balance read are "unavailable", never a made-up figure; Unreconciled Bank asks for a sync', () => {
  const { byType } = run({ journals: [journal('s1', '2026-08-01', [jl('a-suspense', 'debit', 500), jl('a-bank', 'credit', 500)])] });
  for (const type of ['suspense_open_balance', 'directors_loan_overdrawn', 'opening_balance_differences', 'historical_changes']) {
    assert.equal(byType[type].period_checked, LABELS.unavailable, type);
    assert.equal(byType[type].count, null, type);
    assert.equal(status(byType[type]), 'unavailable', type);
  }
  assert.equal(byType.unreconciled_bank_items.period_checked, 'needs_sync', 'reconcile status not read yet');
  assert.equal(byType.unreconciled_bank_items.count, null);
  assert.equal(byType.directors_loan_overdrawn.importance, 'medium', 'UAE: review, not critical');
  assert.equal(run({ region: null }).byType.directors_loan_overdrawn.importance, 'critical');
  assert.equal(byType.dividend_status.period_checked, LABELS.notApplicableUae);
  assert.equal(run({ region: null }).byType.dividend_status.period_checked, LABELS.unavailable);
});

// ---------------- tax review and thresholds ----------------

test('Tax Review by Code (UAE): split by side and treatment, emirates shown, the three review flags raised', () => {
  const { byType } = run({ invoices: [
    invoice('x1', '2026-08-01', 'c1', [line('a-sales', 1000, { tax: 't-std', pct: 5 })], { place_of_supply: 'DU' }),
    invoice('x2', '2026-08-02', 'c1', [line('a-sales', 500, { tax: 't-std', pct: 5 })], { place_of_supply: '' }),
    invoice('x3', '2026-08-03', 'c2', [line('a-sales', 400, { tax: 't-zero', pct: 0 })], { tax_treatment: 'vat_registered' }),
    bill('x4', '2026-08-04', 'v1', [line('a-office', 300)], { is_reverse_charge_applied: true, tax_treatment: 'vat_registered' }),
  ] });
  const rows = counted(byType.tax_review_by_code);
  const std = rows.find(r => r.accountName === 'Sales' && r.accountCode === 'Standard Rate');
  assert.equal(std.amount, 1500);
  assert.equal(std.taxAmount, 75);
  assert.match(std.description, /By emirate: DU AED 1000\.00, not set AED 500\.00/);
  assert.match(std.description, /no place of supply/);
  assert.match(rows.find(r => r.accountCode === 'Zero Rate').description, /zero rate is unusual/);
  assert.match(rows.find(r => /reverse charge/.test(r.accountCode)).description, /Reverse charge on a bill from a UAE VAT-registered supplier/);
  assert.equal(byType.tax_review_by_code.potential_value_gbp, 0);
});

test('VAT & Corporate Tax thresholds: taxable supplies + imports less credit notes; exempt sales are not counted', () => {
  const big = (id, amount, extra = {}) => invoice(id, '2026-09-01', 'c1', [line('a-sales', amount, { tax: 't-std', pct: 5 })], extra);
  const docs = [big('v1', 300000), invoice('v2', '2026-09-02', 'c1', [line('a-sales', 900000, { tax_exemption_id: 'x1' })]),
    bill('v3', '2026-09-03', 'v9', [line('a-office', 50000)], { tax_treatment: 'non_gcc' })];
  const credit = { ...zoho.mapSalesCredit({ creditnote_id: 'cn1', status: 'closed', date: '2026-09-05', total: 1050, balance: 0, customer_id: 'c1', sub_total: 1000, currency_code: 'AED', exchange_rate: 1 }) };
  const notRegistered = run({ invoices: docs, credits: [credit], taxProfile: { isTaxRegistered: false, isFreeZone: false } }).byType.vat_scheme_threshold;
  // 300,000 + 50,000 imports - 1,000 credit = 349,000: amber against 375,000.
  assert.deepEqual(notRegistered.items.map(i => [i.rule, i.level, i.amount]), [['uae_vat_mandatory', 'amber', 349000]]);
  assert.match(notRegistered.items[0].description, /next 30 days/);
  const registeredSmall = run({ invoices: [big('v4', 1000)] }).byType.vat_scheme_threshold;
  assert.deepEqual(registeredSmall.items.map(i => i.rule), ['uae_vat_deregistration']);
  assert.equal(run({ region: null }).byType.vat_scheme_threshold.period_checked, LABELS.notApplicableZoho);
  assert.equal(run({ accounts: [] }).byType.vat_scheme_threshold, undefined, 'no chart: "Not synced", not a false OK');
});

// ---------------- motor vehicle and blocked VAT ----------------

test('Motor Vehicle & Entertainment VAT: vehicle costs with no vehicle asset, and 5% VAT claimed on meals or a car hire', () => {
  const accounts = [...ACCOUNTS, mapping.mapAccount(rawAccount(['a-carhire', 'Car Hire', 'expense']))];
  const { byType } = run({ accounts, invoices: [
    bill('mv1', '2026-08-01', 'v1', [line('a-vehicle', 400)]),
    bill('mv2', '2026-08-02', 'v2', [line('a-meals', 600, { tax: 't-std', pct: 5, itc_eligibility: 'eligible' })]),
    bill('mv3', '2026-08-03', 'v3', [line('a-carhire', 1000, { tax: 't-std', pct: 5 })]),
    bill('mv4', '2026-08-04', 'v2', [line('a-meals', 600, { tax: 't-std', pct: 5, itc_eligibility: 'ineligible' })]),  // already blocked
    bill('mv5', '2026-08-05', 'v2', [line('a-meals', 600)]),  // no VAT claimed
  ] });
  const rows = counted(byType.motor_vehicle_expenses);
  assert.deepEqual(rows.filter(r => r.rule === 'uae_blocked_input_vat').map(r => [r.accountCode, r.amount]).sort(), [['Car Hire', 50], ['Meals and Entertainment', 30]]);
  assert.deepEqual(rows.filter(r => !r.rule).map(r => r.accountCode), ['Vehicle Running Costs']);
  // A vehicle asset posted to (a fixed asset named "Motor Vehicles") clears the no-vehicle rule; the UK client gets no VAT rule.
  const withVehicle = [...accounts, mapping.mapAccount(rawAccount(['a-mv', 'Motor Vehicles', 'fixed_asset']))];
  const uk = run({ region: null, accounts: withVehicle, invoices: [bill('mv6', '2025-01-01', 'v1', [line('a-mv', 30000)]),
    bill('mv7', '2026-08-01', 'v1', [line('a-vehicle', 400)]), bill('mv8', '2026-08-02', 'v2', [line('a-meals', 600, { tax: 't-std', pct: 5 })])] });
  assert.equal(uk.byType.motor_vehicle_expenses.count, 0);
});

// ---------------- bank checks ----------------

const BANK_ROWS = [
  { account_id: 'a-bank', account_name: 'Main Bank Account', account_type: 'bank', currency_code: 'AED', balance: 1000, bcy_balance: 1000, bank_balance: 1200, uncategorized_transactions: 2, is_feeds_active: true },
  { account_id: 'a-card', account_name: 'Company Card', account_type: 'credit_card', currency_code: 'AED', balance: -300, bcy_balance: -300, bank_balance: 0, uncategorized_transactions: 0 },
  { account_id: 'a-cash', account_name: 'Petty Cash', account_type: 'cash', currency_code: 'AED', balance: -50, bcy_balance: -50, bank_balance: 0, uncategorized_transactions: 0, is_feeds_active: false },
];
const bankLine = (id, amount, type) => mapping.mapUncategorisedLine({ transaction_id: id, date: '2026-10-01', amount, transaction_type: type,
  account_id: 'a-bank', account_name: 'Main Bank Account', payee: 'Someone', currency_code: 'AED' });

test('Bank checks from Zoho\'s bank data: feed difference, overdrawn bank account, uncategorised lines, statements reminder', () => {
  const accounts = mapping.mergeBankAccounts(ACCOUNTS, BANK_ROWS);
  const { byType } = run({ accounts, bankTransactions: [bankLine('u1', 120, 'deposit'), bankLine('u2', 80, 'withdrawal')] });
  const balance = byType.bank_balance;
  assert.deepEqual(balance.items.map(i => [i.name, i.rule, i.amount]), [
    ['Main Bank Account', 'bank_feed_difference', 200], ['Petty Cash', 'negative_bank_balance', 50],
  ], 'the card (normally negative, no feed) is not listed');
  assert.equal(balance.potential_value_gbp, 200, 'the overdrawn flag adds no value');
  assert.equal(byType.unprocessed_bank.count, 2);
  assert.equal(byType.unprocessed_bank.potential_value_gbp, 200);
  assert.deepEqual(byType.bank_statements_review.items.map(i => i.accountCode), ['Main Bank Account'], 'accounts known to be clear are not listed');
});

test('Bank checks with banking refused: "Reconnect Zoho Books" unless a recent Banking page reading is there', () => {
  const refused = { permissions: { banking: false, expenses: false } };
  const off = run({ readStatus: refused }).byType;
  for (const type of ['bank_balance', 'unprocessed_bank']) {
    assert.equal(off[type].period_checked, LABELS.bankAccess, type);
    assert.equal(status(off[type]), 'not_configured', type);
  }
  assert.equal(off.bank_statements_review.count, 3, 'one reminder per bank, card and cash account');
  assert.match(off.bank_statements_review.items[0].description, /Open Banking in Zoho Books and confirm/);

  const reading = { readAt: new Date('2026-11-08T09:00:00Z'), accounts: [
    { accountName: 'Main Bank Account', uncategorised: 4, currency: 'AED', amountInBank: 900, amountInBooks: 1000 },
    { accountName: 'Company Card', uncategorised: 0, currency: 'AED', amountInBank: 0, amountInBooks: -20 },
  ] };
  const viaPage = run({ readStatus: refused, bankReading: reading }).byType;
  assert.deepEqual(viaPage.bank_balance.items.map(i => [i.name, i.amount, i.source]), [['Main Bank Account', 100, 'zoho_banking_page']]);
  assert.equal(viaPage.bank_balance.period_checked, 'statement_comparison_as_of_2026-11-08');
  assert.equal(viaPage.unprocessed_bank.count, 1, 'one finding per account, as for Xero\'s Bank accounts page');
  assert.equal(viaPage.unprocessed_bank.items[0].itemsToReconcile, 4);
  assert.deepEqual(viaPage.bank_statements_review.items.map(i => i.accountCode), ['Main Bank Account', 'Petty Cash']);

  const stale = run({ readStatus: refused, bankReading: { ...reading, readAt: new Date('2026-10-01T09:00:00Z') } }).byType;
  assert.equal(stale.bank_balance.period_checked, LABELS.bankAccess, 'a reading over 7 days old is not used');
});

test('Bank Balance with no account on a feed is "Not configured", not OK', () => {
  const rows = BANK_ROWS.map(r => ({ ...r, bank_balance: 0, is_feeds_active: false, balance: 10, bcy_balance: 10 }));
  const { byType } = run({ accounts: mapping.mergeBankAccounts(ACCOUNTS, rows) });
  assert.equal(byType.bank_balance.period_checked, 'not_configured');
  assert.equal(byType.bank_balance.count, null);
});

// ---------------- contacts ----------------

test('Inactive Contacts: 24 months, activity from documents, journals and bank rows; inactive contacts are skipped', () => {
  const contacts = ['c1', 'c2', 'c3', 'c4', 'c5'].map(id => ({ contactID: id, name: `Contact ${id}`, contactStatus: id === 'c5' ? 'ARCHIVED' : 'ACTIVE' }));
  const { byType } = run({ contacts, invoices: [invoice('n1', '2024-11-11', 'c1', []), invoice('n2', '2024-11-09', 'c2', [])],
    journals: [journal('n3', '2026-01-01', [jl('a-office', 'debit', 1, { customer_id: 'c3' }), jl('a-bank', 'credit', 1)])] });
  // Cut-off 10 Nov 2024: c1 (11 Nov 2024) and c3 (journal) are active; c2 (9 Nov 2024) and c4 (never) are listed.
  assert.deepEqual(byType.inactive_contacts.items.map(i => [i.id, i.lastTransaction]), [['c2', '2024-11-09'], ['c4', 'Never']]);
  assert.equal(byType.inactive_contacts.period_checked, 'no_transaction_in_24_months_before_2026-11-10');
});

// ---------------- wording ----------------

test('UAE wording: FTA not HMRC, AED not £, Zoho Books not Xero, and UAE names for the three changed checks', () => {
  const ae = checkDescriptionsFor({ ledger: 'zoho', region: 'AE' });
  assert.match(ae.duplicate_bills.soWhat, /the FTA \(Federal Tax Authority\)/);
  assert.doesNotMatch(JSON.stringify(ae), /HMRC|£|\bXero\b/);
  assert.match(ae.low_cost_fixed_assets.issue, /AED 10,000/);
  assert.equal(checkLabelFor('vat_scheme_threshold', { ledger: 'zoho', region: 'AE' }), 'VAT & Corporate Tax Thresholds');
  assert.equal(checkLabelFor('directors_loan_overdrawn', { ledger: 'zoho', region: 'AE' }), 'Shareholder & Related Party Balances');
  assert.equal(checkLabelFor('vat_scheme_threshold', { ledger: 'zoho', region: null }), null);
  const zohoUk = checkDescriptionsFor({ ledger: 'zoho', region: null });
  assert.doesNotMatch(JSON.stringify(zohoUk), /\bXero\b/);
  assert.match(zohoUk.duplicate_bills.soWhat, /HMRC/, 'a UK Zoho client keeps HMRC');
  assert.equal(checkDescriptionsFor({ ledger: null }), baseDescriptions, 'Xero clients get the original object, unchanged');
});

// ---------------- review fixes (regression tests) ----------------

test('VAT thresholds: a client that is not registered (no VAT rates at all) is still measured on its sales', () => {
  // Twelve untaxed invoices of AED 50,000 in the rolling year: AED 600,000, over the mandatory limit.
  const docs = Array.from({ length: 12 }, (_, i) => invoice(`nr${i}`, `2026-${String((i % 10) + 1).padStart(2, '0')}-15`, 'c1', [line('a-sales', 50000)]));
  const exempt = invoice('nrx', '2026-05-01', 'c1', [line('a-sales', 900000, { tax_exemption_id: 'x1' })]);
  const check = run({ invoices: [...docs, exempt], taxRates: [], taxProfile: { isTaxRegistered: false, isFreeZone: false } }).byType.vat_scheme_threshold;
  assert.deepEqual(check.items.map(i => [i.rule, i.level, i.amount]), [['uae_vat_mandatory', 'red', 600000]], 'exempt lines still left out');
});

test('VAT thresholds: invoices whose lines are not read yet are counted at their list total, and said so', () => {
  const read = Array.from({ length: 5 }, (_, i) => invoice(`rd${i}`, `2026-0${i + 5}-10`, 'c1', [line('a-sales', 80000)]));
  const unread = ['2026-02-10', '2026-03-10', '2026-04-10'].map((date, i) => zoho.mapInvoice({
    invoice_id: `un${i}`, invoice_number: `I-un${i}`, status: 'paid', date, due_date: date, total: 80000, sub_total: 80000, balance: 0,
    customer_id: 'c1', customer_name: 'Customer c1', currency_code: 'AED', exchange_rate: 1, last_modified_time: `${date}T10:00:00+0400`,
  }));
  assert.equal(unread[0].lineItemsRead, false);
  const check = run({ invoices: [...read, ...unread], taxRates: [], taxProfile: { isTaxRegistered: false, isFreeZone: false } }).byType.vat_scheme_threshold;
  assert.equal(check.items[0].amount, 640000);
  assert.match(check.items[0].description, /3 invoice\(s\) or bill\(s\) whose lines Akrio has not read yet were counted at their total/);
});

test('VAT thresholds: credit notes taken off are shown on the finding; an earlier year over AED 3m ends Small Business Relief', () => {
  const credit = zoho.mapSalesCredit({ creditnote_id: 'cn9', status: 'closed', date: '2026-09-05', total: 100000, balance: 0, customer_id: 'c1', sub_total: 100000, currency_code: 'AED', exchange_rate: 1 });
  const thisYear = invoice('ty1', '2026-09-01', 'c1', [line('a-sales', 360000, { tax: 't-std', pct: 5 })]);
  const lastYear = invoice('ly1', '2025-06-01', 'c1', [line('a-sales', 3200000, { tax: 't-std', pct: 5 })]);
  const check = run({ invoices: [thisYear, lastYear], credits: [credit], taxProfile: { isTaxRegistered: false, isFreeZone: false } }).byType.vat_scheme_threshold;
  const vat = check.items.find(i => i.rule === 'uae_vat_voluntary');
  assert.match(vat.description, /Sales credit notes of AED 100,000 were taken off in full/);
  const sbr = check.items.find(i => i.rule === 'uae_sbr_revenue');
  assert.equal(sbr.level, 'red');
  assert.match(sbr.description, /earlier financial year to 31\/12\/2025/);
});

test('Undeposited Funds (Zoho cash type, system account) is a clearing account, not a bank', () => {
  const undeposited = mapping.mapAccount(rawAccount(['a-undep', 'Undeposited Funds', 'cash'], { is_system_account: true }));
  assert.deepEqual([undeposited.type, undeposited._class, undeposited.bankAccountType], ['CURRENT', 'ASSET', null]);
  assert.equal(mapping.mapAccount(rawAccount(['a-pc', 'Petty Cash', 'cash'], { is_system_account: true })).type, 'BANK');
  const accounts = [...ACCOUNTS, undeposited];
  const { byType } = run({ accounts, journals: [journal('ud1', '2026-08-01', [jl('a-undep', 'debit', 500), jl('a-sales', 'credit', 500)])] });
  assert.equal(byType.journal_to_bank.count, 0);
  assert.ok(!byType.bank_statements_review.items.some(i => i.accountCode === 'Undeposited Funds'));
});

test('Purchase Tax Missing (UAE): an unregistered supplier is not a finding; a non-GCC import with no VAT is review only', () => {
  const { byType } = run({ invoices: [
    bill('pt1', '2026-08-01', 'v1', [line('a-office', 800)], { tax_treatment: 'vat_not_registered' }),
    bill('pt2', '2026-08-02', 'v2', [line('a-office', 900)], { tax_treatment: 'dz_vat_not_registered' }),
    bill('pt3', '2026-08-03', 'v3', [line('a-office', 1000)], { tax_treatment: 'non_gcc' }),
    bill('pt4', '2026-08-04', 'v4', [line('a-office', 1100)], { tax_treatment: 'vat_registered' }),
  ] });
  const rows = counted(byType.purchase_tax_missing);
  assert.deepEqual(rows.map(r => [r.number, r.rule || null, r.level || null]).sort(), [['B-pt3', 'uae_import_no_vat', 'review'], ['B-pt4', null, null]]);
  assert.equal(byType.purchase_tax_missing.potential_value_gbp, 1100, 'the import adds no value');
});

test('Bank Balance from a Banking page reading: a "$" account is foreign (from the chart), never added to the AED total', () => {
  const usd = mapping.mapAccount(rawAccount(['a-usd', 'USD Account', 'bank'], { currency_code: 'USD' }));
  const reading = { readAt: new Date('2026-11-08T09:00:00Z'), accounts: [
    { accountName: 'USD Account', uncategorised: 0, currency: '$', amountInBank: 10000, amountInBooks: 60000 },
    { accountName: 'Main Bank Account', uncategorised: 0, currency: 'AED', amountInBank: 900, amountInBooks: 1000 },
    { accountName: 'Unknown Dollar Account', uncategorised: 0, currency: '$', amountInBank: 5, amountInBooks: 10 },
  ] };
  const { byType } = run({ accounts: [...ACCOUNTS, usd], readStatus: { permissions: { banking: false, expenses: false } }, bankReading: reading });
  const rows = byType.bank_balance.items;
  assert.deepEqual(rows.find(r => r.name === 'USD Account').currency, 'USD');
  assert.equal(rows.find(r => r.name === 'USD Account').potentialValue, 0);
  assert.equal(rows.find(r => r.name === 'Unknown Dollar Account').currency, 'USD');
  assert.equal(byType.bank_balance.potential_value_gbp, 100, 'only the AED account counts');
});

// ---------------- 25 Nov 2026 rule fixes ----------------

test('Multi-Tax Code Suppliers: two 5% rates with different names are one code; zero-rated stays apart from exempt and No VAT', () => {
  const rates = [...TAX_RATES, mapping.mapTaxRate({ tax_id: 't-vat', tax_name: 'VAT', tax_percentage: 5, tax_type: 'tax', country_code: 'AE', tax_authority_name: 'FTA' })];
  const { byType } = run({ taxRates: rates, invoices: [
    bill('r1', '2026-08-01', 'v1', [line('a-office', 1000, { tax: 't-std', pct: 5 })]),
    bill('r2', '2026-08-02', 'v1', [line('a-office', 600, { tax: 't-vat', pct: 5 })]),     // same rate, other name: not a second code
    bill('r3', '2026-08-03', 'v2', [line('a-office', 500, { tax: 't-std', pct: 5 })]),
    bill('r4', '2026-08-04', 'v2', [line('a-office', 200, { tax: 't-zero', pct: 0 })]),    // zero-rated: a real second code
    bill('r5', '2026-08-05', 'v3', [line('a-office', 300, { tax: 't-zero', pct: 0 })]),
    bill('r6', '2026-08-06', 'v3', [line('a-office', 90, { tax_exemption_id: 'x1' })]),    // exempt: not the same as zero-rated
  ] });
  const check = byType.multi_tax_suppliers;
  assert.deepEqual(check.items.map(i => i.contactId).sort(), ['v2', 'v3'], 'v1 used one VAT treatment under two names');
  const v2 = check.items.find(i => i.contactId === 'v2');
  assert.deepEqual(v2.taxCodes.sort(), ['Standard Rate', 'Zero Rate']);
  assert.equal(check.potential_value_gbp, 200, 'the zero-rated 200; exempt adds no value');
  const merged = run({ taxRates: rates, invoices: [
    bill('m1', '2026-08-01', 'v1', [line('a-office', 1000, { tax: 't-std', pct: 5 })]),
    bill('m2', '2026-08-02', 'v1', [line('a-office', 600, { tax: 't-vat', pct: 5 })]),
    bill('m3', '2026-08-03', 'v1', [line('a-office', 100, { tax: 't-zero', pct: 0 })]),
  ] }).byType.multi_tax_suppliers.items[0];
  assert.equal(merged.dominantTax, 'Standard Rate / VAT', 'the merged code shows both names');
  assert.deepEqual(merged.transactions.map(t => t.taxCode).sort(), ['Standard Rate', 'VAT', 'Zero Rate'], 'each line keeps its own rate name');
});

test('Journals to Bank (Zoho): one row per journal; a bank-to-cash transfer counted once; petty cash lower risk; a reversed pair nets to 0', () => {
  const { byType } = run({ journals: [
    journal('t1', '2026-08-01', [jl('a-bank', 'debit', 3000), jl('a-cash', 'credit', 3000)]),        // transfer: value 3000, not 6000
    journal('p1', '2026-08-02', [jl('a-cash', 'debit', 600), jl('a-suspense', 'credit', 600)]),       // petty cash only
    journal('b1', '2026-08-03', [jl('a-office', 'debit', 400), jl('a-bank', 'credit', 250), jl('a-card', 'credit', 150)]), // two bank lines, one row
    { ...journal('o1', '2026-08-04', [jl('a-suspense', 'debit', 100), jl('a-cash', 'credit', 100)]), entryNumber: 'MJ-2026-020' },
    { ...journal('o2', '2026-08-20', [jl('a-suspense', 'credit', 100), jl('a-cash', 'debit', 100)]), entryNumber: 'REV - MJ-2026-20', narration: 'Reverse entry of MJ-2026-020' },
  ] });
  const check = byType.journal_to_bank;
  assert.deepEqual(check.items.map(i => i.documentId), ['t1', 'p1', 'b1', 'o1', 'o2'], 'one row per journal');
  const row = id => check.items.find(i => i.documentId === id);
  assert.equal(row('t1').amount, 3000);
  assert.match(row('t1').description, /Transfer between bank \/ cash accounts: counted once/);
  assert.equal(row('p1').level, 'review');
  assert.match(row('p1').description, /Petty cash \(Cash account\) journal: lower risk/);
  assert.equal(row('b1').amount, 400, 'the larger side, once');
  for (const id of ['o1', 'o2']) {
    assert.equal(row(id).amount, 0, id);
    assert.equal(row(id).displayOnly, true, `${id} listed, not counted`);
    assert.equal(row(id).level, 'reversed');
  }
  assert.match(row('o1').description, /Reversed by REV - MJ-2026-20/);
  assert.match(row('o2').description, /Reversal of MJ-2026-020/);
  assert.equal(check.count, 3);
  assert.equal(check.potential_value_gbp, 3000 + 600 + 400);
  // A "reversal" that does not cancel the original out is not treated as one.
  const partial = run({ journals: [
    { ...journal('q1', '2026-08-04', [jl('a-suspense', 'debit', 100), jl('a-bank', 'credit', 100)]), entryNumber: 'MJ-7' },
    { ...journal('q2', '2026-08-05', [jl('a-suspense', 'credit', 60), jl('a-bank', 'debit', 60)]), entryNumber: 'REV - MJ-7' },
  ] }).byType.journal_to_bank;
  assert.equal(partial.count, 2);
  assert.equal(partial.potential_value_gbp, 160);
});

test('VAT Control Journals (Zoho): each journal valued once at the larger of VAT debits or credits; a VAT offset journal is "review"', () => {
  const { byType } = run({ journals: [
    journal('v1', '2026-08-31', [jl('a-output', 'debit', 1200), jl('a-input', 'credit', 1000), jl('a-vatpay', 'credit', 200)]),
    journal('v2', '2026-08-15', [jl('a-input', 'debit', 50), jl('a-suspense', 'credit', 50)]),
  ], accounts: [...ACCOUNTS, mapping.mapAccount(rawAccount(['a-vatpay', 'VAT Payable', 'other_current_liability']))] });
  const check = byType.journal_vat_control;
  assert.deepEqual(check.items.map(i => [i.documentId, i.amount]), [['v1', 1200], ['v2', 50]], 'one row each; 1200 not 2400');
  const offset = check.items.find(i => i.documentId === 'v1');
  assert.equal(offset.level, 'review');
  assert.match(offset.description, /Review: period-end VAT offset journal/);
  assert.equal(check.potential_value_gbp, 1250);
  assert.equal(check.count, 2);
});

test('Capital Item Review (Zoho): commission, fees, charges, salaries, rent, utilities and subscriptions are never watched', () => {
  const extra = [['a-comm', 'Commission Given', 'expense'], ['a-fees', 'Professional Fees', 'expense'], ['a-chg', 'Bank Charges', 'expense'],
    ['a-util', 'Electricity and Water', 'expense'], ['a-sub', 'Software Subscriptions', 'expense'], ['a-sal', 'Staff Salary', 'expense'],
    ['a-lic', 'Trade Licence Renewal', 'expense']].map(row => mapping.mapAccount(rawAccount(row)));
  const { byType } = run({ accounts: [...ACCOUNTS, ...extra], invoices: [bill('k1', '2026-08-01', 'v1', [
    ...extra.map(a => line(a.accountID, 20000)), line('a-repairs', 20000),
  ])] });
  assert.deepEqual(counted(byType.capital_item_review).map(i => i.accountCode), ['Repairs and Maintenance']);
  // The Xero default list itself is unchanged: commission is still a Xero candidate.
  const { isCapitalDefaultAccount } = require('../src/services/checkRules');
  assert.equal(isCapitalDefaultAccount({ type: 'EXPENSE', name: 'Commission Given' }), true);
});

const withBalance = (row, amount, extra = {}) => ({ ...mapping.mapAccount(rawAccount(row)), ledgerBalance: { amount, side: null, source: 'chart_list', readAt: '2026-11-09T10:00:00.000Z', ...extra } });

test('Suspense & Clearing and Shareholder balances (Zoho): from the current balances; unavailable only when none could be read', () => {
  const accounts = [
    ...ACCOUNTS.filter(a => a.accountID !== 'a-suspense'),
    withBalance(['a-suspense', 'Suspense', 'other_current_liability'], -250),
    withBalance(['a-clear', 'Card Clearing', 'other_current_asset'], 0.5),
    withBalance(['a-sh1', 'Shareholder Loan Account - Made Up', 'other_current_asset'], 4000),   // asset, debit: owner owes the company
    withBalance(['a-sh2', 'Made Up Partner Current Account', 'equity'], 900),                     // equity, credit: company owes the owner
    withBalance(['a-sh3', 'Due from Related Party', 'other_current_liability'], -1500),           // liability overdrawn
  ];
  const { byType } = run({ accounts, readStatus: { permissions: { banking: true, expenses: true }, sections: { balances: { read: true } } } });
  const suspense = byType.suspense_open_balance;
  assert.deepEqual(suspense.items.map(i => [i.accountCode, i.amount]), [['Suspense', 250]], 'under 1 is left out');
  assert.match(suspense.items[0].description, /on 2026-11-09 \(the current balance/);
  const related = byType.directors_loan_overdrawn;
  assert.deepEqual(related.items.map(i => [i.accountCode, i.amount]).sort(), [['Due from Related Party', 1500], ['Shareholder Loan Account - Made Up', 4000]]);
  assert.equal(related.importance, 'medium', 'UAE: review');
  assert.equal(status(related), 'issues');
  // UK Zoho client: the Xero director's loan names only.
  const uk = run({ region: null, base: 'GBP', taxRates: UK_RATES, accounts: [...ACCOUNTS, withBalance(['a-dla', "Director's Loan Account", 'other_current_liability'], -75), withBalance(['a-sh9', 'Shareholder Loan', 'other_current_asset'], 10)] }).byType.directors_loan_overdrawn;
  assert.deepEqual(uk.items.map(i => i.accountCode), ["Director's Loan Account"]);
  assert.match(uk.items[0].description, /overdrawn by £75/);
  // Candidates, but no balance read for any of them: unavailable, not a false OK.
  const none = run({ accounts: [...ACCOUNTS] }).byType;
  assert.equal(none.suspense_open_balance.period_checked, LABELS.unavailable);
});

test('Unreconciled Bank (Zoho): unreconciled recorded transactions in the period, from Zoho\'s reconcile status; cash accounts left out', () => {
  const recon = (unreconciled, extra = {}) => ({ readAt: '2026-11-10T00:00:00Z', from: '2026-07-01', to: '2026-11-10', complete: true, rows: 5, reconciled: 3, unknown: 0, unreconciled, ...extra });
  const tx = (id, date, amount) => ({ transactionID: id, date, amount, reconcileState: 'unreconciled', transactionType: 'expense', payee: 'Made-up Payee' });
  const accounts = ACCOUNTS.map(a => (a.accountID === 'a-bank' ? { ...a, reconciliation: recon([tx('u1', '2026-08-01', -120), tx('u2', '2026-09-01', 80), tx('u3', '2026-06-01', 5)]) }
    : a.accountID === 'a-card' ? { ...a, reconciliation: recon([]) } : a));
  const { byType } = run({ accounts });
  const check = byType.unreconciled_bank_items;
  assert.deepEqual(check.items.map(i => [i.id, i.amount]), [['zoho-unreconciled:a-bank:u1', 120], ['zoho-unreconciled:a-bank:u2', 80]], 'only the review period');
  assert.equal(check.count, 2);
  assert.equal(check.potential_value_gbp, 200);
  // Zoho gave no status on any row: unavailable rather than a false OK.
  const unknown = ACCOUNTS.map(a => (a.type === 'BANK' && a.zohoAccountType !== 'cash' ? { ...a, reconciliation: recon([], { unknown: 5, reconciled: 0 }) } : a));
  assert.equal(run({ accounts: unknown }).byType.unreconciled_bank_items.period_checked, LABELS.unavailable);
});

test('Shareholder & Related Party (Zoho): an expense or income account named for a director or partner is not a loan account', () => {
  const accounts = [
    ...ACCOUNTS.filter(a => a.accountID !== 'a-suspense'),
    withBalance(['a-suspense', 'Suspense', 'other_current_liability'], -250),
    withBalance(['a-rem', 'Directors Remuneration', 'expense'], 48000),          // a cost, not money owed to the company
    withBalance(['a-pcom', 'Partner Commission', 'expense'], 12000),
    withBalance(['a-dinc', 'Director Fee Income', 'income'], -3000),
    withBalance(['a-sh1', 'Shareholder Loan Account - Made Up', 'other_current_asset'], 700),
    { ...mapping.mapAccount(rawAccount(['a-cust', 'Customs Clearing Charges', 'expense'])) },   // a cost, no balance read
  ];
  const byName = name => accounts.find(a => a.name === name);
  const related = run({ accounts, readStatus: { permissions: { banking: true, expenses: true }, sections: { balances: { read: true } } } }).byType.directors_loan_overdrawn;
  assert.deepEqual(related.items.map(i => i.accountCode), ['Shareholder Loan Account - Made Up']);
  const suspense = run({ accounts, readStatus: { permissions: { banking: true, expenses: true }, sections: { balances: { read: true } } } }).byType.suspense_open_balance;
  assert.deepEqual(suspense.items.map(i => i.accountCode), ['Suspense']);
  assert.doesNotMatch(suspense.items[0].description, /not checked/, 'an expense "Clearing" account is not a candidate left unread');
  assert.equal(uae.isBalanceCheckAccount(byName('Customs Clearing Charges')), false);
  // Nor are they read one by one for their balance.
  assert.equal(uae.isBalanceCheckAccount(byName('Directors Remuneration')), false);
  assert.equal(uae.isBalanceCheckAccount(byName('Partner Commission')), false);
  assert.equal(uae.isBalanceCheckAccount(byName('Director Fee Income')), false);
  assert.equal(uae.isBalanceCheckAccount(byName('Shareholder Loan Account - Made Up')), true);
  assert.equal(uae.isBalanceCheckAccount(byName('Suspense')), true);
});

test('Capital Item Review (Zoho): IT, internet, phone, software licence and loan-named expense accounts stay watched', () => {
  const extra = [['a-it', 'IT and Internet Expenses', 'expense'], ['a-mob', 'Mobile Handsets', 'expense'], ['a-tel', 'Telephone Expense', 'expense'],
    ['a-swl', 'Software Licences', 'expense'], ['a-carl', 'Made Up Bank Car Loan A/C', 'expense'], ['a-chg2', 'Bank Charges', 'expense']]
    .map(row => mapping.mapAccount(rawAccount(row)));
  const { byType } = run({ accounts: [...ACCOUNTS, ...extra], invoices: [bill('k2', '2026-08-01', 'v1', extra.map(a => line(a.accountID, 20000)))] });
  assert.deepEqual(counted(byType.capital_item_review).map(i => i.accountCode).sort(),
    ['IT and Internet Expenses', 'Made Up Bank Car Loan A/C', 'Mobile Handsets', 'Software Licences', 'Telephone Expense']);
});

test('Unreconciled Bank (Zoho): a foreign-currency account\'s rows read in the base currency (bcy) count in the total; others are listed only', () => {
  const usd = mapping.mapAccount(rawAccount(['a-usd', 'Made Up USD Bank', 'bank'], { currency_code: 'USD' }));
  const base = mapping.mapAccountTransaction({ transaction_id: 'f1', date: '2026-08-01', bcy_debit: 367.3, debit_amount: 100, reconcile_status: 'unreconciled', currency_code: 'USD' }, usd);
  const foreign = mapping.mapAccountTransaction({ transaction_id: 'f2', date: '2026-08-02', debit_amount: 50, reconcile_status: 'unreconciled', currency_code: 'USD' }, usd);
  assert.equal(base.amountInBaseCurrency, true);
  assert.equal(foreign.amountInBaseCurrency, false);
  const recon = { readAt: '2026-11-10T00:00:00Z', from: '2026-07-01', to: '2026-11-10', complete: true, rows: 2, reconciled: 0, unknown: 0, unreconciled: [base, foreign] };
  const check = run({ accounts: [...ACCOUNTS, { ...usd, reconciliation: recon }] }).byType.unreconciled_bank_items;
  const row = id => check.items.find(i => i.id === `zoho-unreconciled:a-usd:${id}`);
  assert.equal(row('f1').amount, 367.3);
  assert.equal(row('f1').currency, undefined, 'already in AED: not labelled USD');
  assert.equal(row('f2').currency, 'USD');
  assert.equal(row('f2').potentialValue, 0);
  assert.equal(check.potential_value_gbp, 367.3, 'the USD-only row is not added to the AED total');
});

test('Unreconciled Bank (Zoho): a /chartofaccounts/transactions row (debit_amount in base, fcy_ in the account currency) shows the account currency with the base amount beside it', () => {
  const usd = mapping.mapAccount(rawAccount(['a-usd', 'Made Up USD Bank', 'bank'], { currency_code: 'USD' }));
  const inRow = mapping.mapAccountTransaction({ transaction_id: 'g1', transaction_date: '2026-09-06', debit_amount: 897.02, credit_amount: 0,
    fcy_debit_amount: 244.42, fcy_credit_amount: 0, reconcile_status: 'unreconciled', currency_code: 'USD' }, usd);
  const outRow = mapping.mapAccountTransaction({ transaction_id: 'g2', transaction_date: '2026-09-07', debit_amount: 0, credit_amount: 220.2,
    fcy_debit_amount: 0, fcy_credit_amount: 60, reconcile_status: 'unreconciled', currency_code: 'USD' }, usd);
  assert.equal(inRow.amountInBaseCurrency, true);
  assert.equal(inRow.amount, 897.02);
  assert.equal(inRow.accountAmount, 244.42);
  assert.equal(outRow.direction, 'out');
  const recon = { readAt: '2026-11-10T00:00:00Z', from: '2026-07-01', to: '2026-11-10', complete: true, rows: 2, reconciled: 0, unknown: 0, unreconciled: [inRow, outRow] };
  const check = run({ accounts: [...ACCOUNTS, { ...usd, reconciliation: recon }] }).byType.unreconciled_bank_items;
  const row = id => check.items.find(i => i.id === `zoho-unreconciled:a-usd:${id}`);
  assert.equal(row('g1').amount, 244.42, 'shown in USD, as in Zoho');
  assert.equal(row('g1').currency, 'USD');
  assert.equal(row('g1').baseAmount, 897.02);
  assert.equal(row('g2').amount, 60);
  assert.equal(row('g2').direction, 'Money out');
  assert.equal(check.potential_value_gbp, 1117.22);
});

test('Journals to Bank (Zoho): a reversal dated after the period end does not cancel the original inside the period', () => {
  const period = resolvePeriod({ type: 'custom', from: '2026-07-01', to: '2026-09-30' }, { asOf: '2026-11-10', ledgerName: 'Zoho Books' });
  const journals = [
    { ...journal('r1', '2026-09-20', [jl('a-suspense', 'debit', 100), jl('a-bank', 'credit', 100)]), entryNumber: 'MJ-9' },
    { ...journal('r2', '2026-10-05', [jl('a-suspense', 'credit', 100), jl('a-bank', 'debit', 100)]), entryNumber: 'REV - MJ-9' },
  ];
  const check = run({ period, journals }).byType.journal_to_bank;
  const row = check.items.find(i => i.documentId === 'r1');
  assert.equal(row.amount, 100, 'unreversed at the period end');
  assert.notEqual(row.level, 'reversed');
  assert.equal(check.count, 1);
  assert.equal(check.potential_value_gbp, 100);
  // Both inside the period: still a reversed pair at 0.
  const inside = run({ period, journals: [journals[0], { ...journals[1], date: '2026-09-25' }] }).byType.journal_to_bank;
  assert.equal(inside.count, 0);
});

test('Invoice or Direct (Zoho): a deposit categorised to income matching an unpaid invoice; a deposit to a non-income account is not', () => {
  const unpaid = invoice('i1', '2026-08-01', 'c1', [line('a-sales', 500)], { status: 'sent', total: 500, balance: 500 });
  const receipt = (id, date, amount, extra = {}) => ({ ...mapping.mapCategorisedReceipt({ transaction_id: id, date, amount, transaction_type: 'sales_without_invoices', customer_id: 'c1', customer_name: 'Customer c1', account_id: 'a-bank', ...extra }) });
  const readStatus = { permissions: { banking: true, expenses: true }, sections: { categorisedReceipts: { read: true } } };
  const { byType } = run({ invoices: [unpaid], readStatus, bankTransactions: [
    receipt('d1', '2026-08-10', 500),
    receipt('d2', '2026-08-11', 500, { transaction_type: 'deposit', offset_account_id: 'a-suspense' }),   // to a non-income account
  ] });
  assert.deepEqual(counted(byType.invoice_or_direct).map(i => [i.bankTransactionId, i.invoiceId]), [['zrc-d1', 'i1']]);
  assert.equal(byType.invoice_or_direct.potential_value_gbp, 500);
  const refused = run({ invoices: [unpaid], readStatus: { permissions: { banking: false, expenses: true } } }).byType.invoice_or_direct;
  assert.equal(refused.period_checked, LABELS.bankAccess);
});

test('the line-item checks\' pages say how many documents in the period have no lines read yet', () => {
  const { unreadLinesNote, LINE_ITEM_CHECKS } = require('../src/services/zohoChecks');
  const unread = { ...bill('n1', '2026-08-01', 'v1', []), lineItemsRead: false, lineItems: [] };
  const { coverage } = runZohoChecks({ org: { id: 1 }, period: PERIOD, region: 'AE', taxProfile: { isTaxRegistered: true }, invoices: [unread],
    now: NOW, money: money(), accounting: { accounts: ACCOUNTS, taxRates: TAX_RATES, manualJournals: [], bankTransactions: [], readStatus: null } });
  assert.equal(coverage.unreadInPeriod, 1);
  assert.match(unreadLinesNote('purchase_tax_missing', coverage), /^1 Zoho Books document in the period has not had its lines read yet/);
  assert.equal(unreadLinesNote('old_unpaid_invoices', coverage), null, 'not a line-item check');
  assert.equal(unreadLinesNote('purchase_tax_missing', { unreadInPeriod: 0, staleInPeriod: 0 }), null);
  assert.ok(LINE_ITEM_CHECKS.has('journal_to_bank'));
});

// ---- Unreconciled Bank, round 2 of the live checks (invented rows) ----
const reconOf = unreconciled => ({ readAt: '2026-11-10T00:00:00Z', from: '2000-01-01', to: '2026-11-10', complete: true, rows: unreconciled.length, reconciled: 0, unknown: 0, unreconciled });
const accountRow = (raw, account) => mapping.mapAccountTransaction({ reconcile_status: 'unreconciled', ...raw }, account);
const bankAccount = () => ACCOUNTS.find(a => a.accountID === 'a-bank');

test('Unreconciled Bank (Zoho): every unreconciled row counts, matched to a statement line or not (Zoho\'s report lists them all; checked live)', () => {
  const bank = bankAccount();
  const rows = [
    accountRow({ transaction_id: 'm1', transaction_date: '2026-08-01', transaction_type: 'customer_payment', debit_amount: 500, credit_amount: 0 }, bank),
    accountRow({ transaction_id: 'm2', transaction_date: '2026-08-02', transaction_type: 'transfer_fund', debit_amount: 0, credit_amount: 70, imported_transaction_id: '90000001' }, bank),
    accountRow({ transaction_id: 'm3', transaction_date: '2026-08-03', transaction_type: 'owner_drawings', debit_amount: 0, credit_amount: 30, transaction_status: 'matched' }, bank),
    accountRow({ transaction_id: 'm4', transaction_date: '2026-08-04', transaction_type: 'expense', debit_amount: 0, credit_amount: 20, imported_transaction_id: '0', transaction_status: 'manually_added' }, bank),
  ];
  assert.deepEqual(rows.map(r => r.statementLinked), [false, true, true, false], 'imported_transaction_id 0 or blank is no link');
  const accounts = ACCOUNTS.map(a => (a.accountID === 'a-bank' ? { ...a, reconciliation: reconOf(rows) } : a));
  const check = run({ accounts }).byType.unreconciled_bank_items;
  assert.deepEqual(check.items.map(i => i.id), ['zoho-unreconciled:a-bank:m1', 'zoho-unreconciled:a-bank:m2', 'zoho-unreconciled:a-bank:m3', 'zoho-unreconciled:a-bank:m4']);
  assert.equal(check.count, 4);
  assert.equal(check.potential_value_gbp, 620, 'the stored value stays the gross amount');
  // Rows cached before the link was read have no statementLinked: counted, exactly as before.
  const old = rows.map(({ statementLinked, ...rest }) => rest);
  assert.equal(run({ accounts: ACCOUNTS.map(a => (a.accountID === 'a-bank' ? { ...a, reconciliation: reconOf(old) } : a)) }).byType.unreconciled_bank_items.count, 4);
});

test('Unreconciled Bank (Zoho): each row says money in or out, and the headline is Zoho\'s net (money in minus money out)', () => {
  const bank = bankAccount();
  const card = ACCOUNTS.find(a => a.accountID === 'a-card');
  const rows = [
    accountRow({ transaction_id: 'd1', transaction_date: '2026-08-01', transaction_type: 'customer_payment', debit_amount: 1000, credit_amount: 0 }, bank),
    accountRow({ transaction_id: 'd2', transaction_date: '2026-08-02', transaction_type: 'vendor_payment', debit_amount: 0, credit_amount: 250.5 }, bank),
    // Only an amount and Zoho's side: a credit is money out.
    accountRow({ transaction_id: 'd3', transaction_date: '2026-08-03', transaction_type: 'expense', amount: 49.5, debit_or_credit: 'credit' }, bank),
  ];
  const cardRows = [accountRow({ transaction_id: 'c1', transaction_date: '2026-08-05', transaction_type: 'expense', debit_amount: 0, credit_amount: 100 }, card)];
  assert.deepEqual(rows.map(r => r.direction), ['in', 'out', 'out']);
  const accounts = ACCOUNTS.map(a => (a.accountID === 'a-bank' ? { ...a, reconciliation: reconOf(rows) } : a.accountID === 'a-card' ? { ...a, reconciliation: reconOf(cardRows) } : a));
  const check = run({ accounts }).byType.unreconciled_bank_items;
  assert.deepEqual(check.items.map(i => [i.direction, i.amount]), [['Money in', 1000], ['Money out', 250.5], ['Money out', 49.5], ['Money out', 100]]);
  assert.equal(check.potential_value_gbp, 1400, 'gross (score and finding values), as on the Xero rows');
  const totals = unreconciledTotals(check.detail_json);
  assert.deepEqual({ count: totals.count, moneyIn: totals.moneyIn, moneyOut: totals.moneyOut, net: totals.net, gross: totals.gross },
    { count: 4, moneyIn: 1000, moneyOut: 400, net: 600, gross: 1400 });
  assert.deepEqual(totals.accounts.map(a => [a.account, a.count, a.net]), [['Main Bank Account', 3, 700], ['Company Card', 1, -100]]);
  // Rows cached before the direction was kept: their signed amount says it.
  const legacy = rows.map(({ direction, ...rest }) => rest);
  const again = run({ accounts: ACCOUNTS.map(a => (a.accountID === 'a-bank' ? { ...a, reconciliation: reconOf(legacy) } : a)) }).byType.unreconciled_bank_items;
  assert.deepEqual(again.items.map(i => i.direction), ['Money in', 'Money out', 'Money out']);
  // Previous-months (display only) rows, rows in another currency and rows with no direction are left out; nothing to add up gives null.
  assert.equal(unreconciledTotals([{ direction: 'Money in', amount: 5, displayOnly: true }, { direction: 'Money out', amount: 9, currency: 'USD' }, { amount: 3 }]), null);
  assert.equal(unreconciledTotals('not json'), null);
});

test('Unreconciled Bank (Zoho) totals: rows in another currency are counted as left out, so the page can say why its count is below the issue count', () => {
  const totals = unreconciledTotals([
    { account: 'Main Bank Account', direction: 'Money in', amount: 100 },
    { account: 'Made Up USD Bank', direction: 'Money out', amount: 9, currency: 'USD', potentialValue: 0 },
    { account: 'Made Up USD Bank', direction: 'Money in', amount: 4, currency: 'USD', potentialValue: 0 },
    { account: 'Main Bank Account', direction: 'Money in', amount: 7, displayOnly: true },
  ]);
  assert.equal(totals.count, 1);
  assert.equal(totals.otherCurrency, 2, 'the two USD rows are listed but not added');
  assert.deepEqual(totals.accounts.map(a => a.account), ['Main Bank Account']);
  assert.equal(unreconciledTotals([{ account: 'Main Bank Account', direction: 'Money in', amount: 1 }]).otherCurrency, 0);
});

test('Unreconciled Bank (Zoho): the row shows the bank account, the payee (or the contact its id names) and Zoho\'s description, never the offset account', () => {
  const bank = bankAccount();
  const rows = [
    // An expense with VAT: Zoho names the tax account as the offset account. No payee on the row, but a vendor id.
    accountRow({ transaction_id: 'e1', transaction_date: '2026-08-01', transaction_type: 'expense', debit_amount: 0, credit_amount: 105, offset_account_name: 'Tax Payable', vendor_id: 'v-9' }, bank),
    accountRow({ transaction_id: 'e2', transaction_date: '2026-08-02', transaction_type: 'customer_payment', debit_amount: 60, credit_amount: 0, payee: 'Made-up Customer', description: 'Made-up receipt' }, bank),
    accountRow({ transaction_id: 'e3', transaction_date: '2026-08-03', transaction_type: 'transfer_fund', debit_amount: 0, credit_amount: 10, offset_account_name: 'Company Card' }, bank),
  ];
  const contacts = [{ contactID: 'v-9', name: 'Made-up Fuel Supplier' }];
  const accounts = ACCOUNTS.map(a => (a.accountID === 'a-bank' ? { ...a, reconciliation: reconOf(rows) } : a));
  const check = run({ accounts, contacts }).byType.unreconciled_bank_items;
  const [e1, e2, e3] = check.items;
  assert.deepEqual([e1.account, e1.contact, e1.description, e1.type], ['Main Bank Account', 'Made-up Fuel Supplier', null, 'Expense']);
  assert.deepEqual([e2.contact, e2.description, e2.type], ['Made-up Customer', 'Made-up receipt', 'Customer payment']);
  assert.deepEqual([e3.contact, e3.description, e3.type], [null, null, 'Transfer fund']);
  assert.ok(!JSON.stringify(check.items).includes('Tax Payable'), 'the offset account is never shown');
  // The Zoho ids are not columns: the identity is "id" and the bank account is bankAccountId (both hidden on the page).
  for (const key of ['documentId', 'accountId', 'accountName', 'transactionId']) assert.ok(!(key in e1), key);
  assert.equal(e1.bankAccountId, 'a-bank');
  // Two rows with no description on the same account get different finding keys from their own ids, whatever their order.
  const { addFindingKeys } = require('../src/services/checkRules');
  const keys = items => Object.fromEntries(addFindingKeys('unreconciled_bank_items', items).map(i => [i.id, i.finding_key]));
  const forward = keys([e1, e3]);
  const backward = keys([e3, e1]);
  assert.equal(forward[e1.id], backward[e1.id]);
  assert.notEqual(forward[e1.id], forward[e3.id]);
});

test('Suspense & Clearing and Shareholder balances (Zoho): rows name the account, never show its Zoho id, and keep their finding keys', () => {
  const accounts = [
    ...ACCOUNTS.filter(a => a.accountID !== 'a-suspense'),
    withBalance(['a-suspense', 'Suspense', 'other_current_liability'], -250),
    withBalance(['a-sh1', 'Shareholder Loan Account - Made Up', 'other_current_asset'], 4000),
  ];
  const { byType } = run({ accounts, readStatus: { permissions: { banking: true, expenses: true }, sections: { balances: { read: true } } } });
  for (const [checkType, id, name, amount] of [['suspense_open_balance', 'zoho-balance:a-suspense', 'Suspense', 250], ['directors_loan_overdrawn', 'dla:a-sh1', 'Shareholder Loan Account - Made Up', 4000]]) {
    const row = byType[checkType].items[0];
    assert.equal(row.id, id);
    assert.equal(row.accountCode, name, 'the account name, shown in the account column');
    assert.equal(row.amount, amount);
    for (const key of ['documentId', 'accountID', 'number']) assert.ok(!(key in row), `${checkType}: no ${key}`);
    assert.ok(!Object.values(row).some(v => typeof v === 'string' && /^a-/.test(v)), 'no account id in any shown field');
    // The finding key is the one the earlier shape (documentId, number, accountID) gave, so review states carry over.
    const { addFindingKeys } = require('../src/services/checkRules');
    const { id: rowId, ...rest } = row;
    const earlier = { documentId: rowId, number: null, ...rest, accountID: rowId.split(':')[1] };
    assert.equal(addFindingKeys(checkType, [row])[0].finding_key, addFindingKeys(checkType, [earlier])[0].finding_key);
  }
});
