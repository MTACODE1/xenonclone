// Pure detection logic for the "unusual journal" checks, the Tax Review by Code check and the VAT
// scheme monitor. Nothing here touches Xero or the database, so it can be unit-tested directly.
//
// Manual journal lines carry a signed LineAmount: positive = debit, negative = credit (the same
// convention the Turnover calculation relies on).

const CHECK_TYPES = Object.freeze({
  revenueVsExpense: 'journal_revenue_vs_expense',
  vatControl: 'journal_vat_control',
  bankJournal: 'journal_to_bank',
  fixedAssetToExpense: 'journal_fixed_asset_to_expense',
  suspenseOpen: 'suspense_open_balance',
  taxReview: 'tax_review_by_code',
  vatScheme: 'vat_scheme_threshold',
});

const DISPOSAL_NAME = /disposal|gain on|loss on|profit on|sale of|sold/i;
const SUSPENSE_NAME = /suspense|clearing/i;

function indexAccounts(accounts) {
  const byCode = new Map();
  for (const account of accounts || []) {
    if (!account || !account.code) continue;
    byCode.set(String(account.code).toUpperCase(), {
      code: account.code,
      name: account.name || '',
      type: account.type || '',
      class: account._class || account.class || '',
      systemAccount: account.systemAccount || '',
      status: account.status || '',
    });
  }
  return byCode;
}

const isRevenue = a => a && a.class === 'REVENUE';
const isExpense = a => a && a.class === 'EXPENSE';
const isBank = a => a && a.type === 'BANK';
const isFixedAsset = a => a && a.type === 'FIXED';
const isVatControl = a => a && (
  a.systemAccount === 'GST' ||
  (a.class === 'LIABILITY' && /\b(vat|gst)\b/i.test(a.name) && /control|liabilit|payable|account/i.test(a.name))
);

function lineAccount(index, line) {
  return line && line.accountCode ? index.get(String(line.accountCode).toUpperCase()) : undefined;
}

function toIsoDate(value) {
  if (!value) return null;
  const text = String(value);
  const ms = /^\/Date\((\d+)/.exec(text);
  if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
  return text.slice(0, 10);
}

function journalLines(journal) {
  return (journal.journalLines || []).map(line => ({
    ...line,
    signed: Number(line.lineAmount) || 0,
  }));
}

function baseItem(journal, line, account, extra = {}) {
  return {
    documentId: journal.manualJournalID,
    number: journal.manualJournalID ? String(journal.manualJournalID).slice(0, 8) : null,
    date: toIsoDate(journal.date),
    source: 'manual_journal',
    accountCode: line.accountCode,
    accountName: account ? account.name : null,
    description: line.description || journal.narration || null,
    narration: journal.narration || null,
    amount: Math.abs(line.signed),
    ...extra,
  };
}

// Revenue debited against an expense, e.g. "Dr Sales, Cr Wages" — usually someone forcing a figure.
function revenueDebitedAgainstExpense(journals, index) {
  const items = [];
  for (const journal of journals) {
    const lines = journalLines(journal);
    const expenseCredit = lines.find(l => l.signed < 0 && isExpense(lineAccount(index, l)));
    if (!expenseCredit) continue;
    for (const line of lines) {
      const account = lineAccount(index, line);
      if (line.signed > 0 && isRevenue(account)) {
        items.push(baseItem(journal, line, account, { counterAccountCode: expenseCredit.accountCode }));
      }
    }
  }
  return items;
}

// Any manual journal touching the VAT control account sits outside the normal VAT return posting.
function vatControlManualJournals(journals, index) {
  const items = [];
  for (const journal of journals) {
    for (const line of journalLines(journal)) {
      const account = lineAccount(index, line);
      if (isVatControl(account) && line.signed !== 0) items.push(baseItem(journal, line, account));
    }
  }
  return items;
}

// Bank lines should come from feeds or reconciliations, not manual journals.
function journalsPostedToBank(journals, index) {
  const items = [];
  for (const journal of journals) {
    for (const line of journalLines(journal)) {
      const account = lineAccount(index, line);
      if (isBank(account) && line.signed !== 0) items.push(baseItem(journal, line, account));
    }
  }
  return items;
}

// Fixed asset cost credited straight to an expense with no disposal, gain or loss line.
function fixedAssetCreditedToExpense(journals, index) {
  const items = [];
  for (const journal of journals) {
    const lines = journalLines(journal);
    const hasDisposal = lines.some(l => DISPOSAL_NAME.test((lineAccount(index, l) || {}).name || ''));
    if (hasDisposal) continue;
    const expenseDebit = lines.find(l => l.signed > 0 && isExpense(lineAccount(index, l)));
    if (!expenseDebit) continue;
    for (const line of lines) {
      const account = lineAccount(index, line);
      if (line.signed < 0 && isFixedAsset(account)) {
        items.push(baseItem(journal, line, account, { counterAccountCode: expenseDebit.accountCode }));
      }
    }
  }
  return items;
}

function detectUnusualJournals({ journals, accounts }) {
  const index = indexAccounts(accounts);
  const posted = (journals || []).filter(j => j && j.status === 'POSTED');
  return {
    [CHECK_TYPES.revenueVsExpense]: revenueDebitedAgainstExpense(posted, index),
    [CHECK_TYPES.vatControl]: vatControlManualJournals(posted, index),
    [CHECK_TYPES.bankJournal]: journalsPostedToBank(posted, index),
    [CHECK_TYPES.fixedAssetToExpense]: fixedAssetCreditedToExpense(posted, index),
  };
}

// Trial Balance report rows -> suspense/clearing accounts with a balance left open at period end.
function suspenseOpenBalances(report, { asOf, minBalance = 1 } = {}) {
  const items = [];
  const walk = rows => {
    for (const row of rows || []) {
      if (row.rows) walk(row.rows);
      if (row.rowType !== 'Row' || !row.cells || row.cells.length < 3) continue;
      const label = String(row.cells[0].value || '');
      if (!SUSPENSE_NAME.test(label)) continue;
      const codeMatch = /\(([^)]+)\)\s*$/.exec(label);
      const num = v => parseFloat(String(v ?? '').replace(/[£,\s]/g, '')) || 0;
      const net = num(row.cells[1].value) - num(row.cells[2].value);
      if (Math.abs(net) < minBalance) continue;
      const code = codeMatch ? codeMatch[1] : label;
      items.push({
        documentId: `trial-balance:${code}`,
        number: null,
        date: asOf || null,
        source: 'trial_balance',
        accountCode: code,
        accountName: label.replace(/\s*\([^)]*\)\s*$/, ''),
        description: `Balance left open on ${label.replace(/\s*\([^)]*\)\s*$/, '')} at period end`,
        amount: Math.abs(net),
      });
    }
  };
  walk(report && report.rows);
  return items;
}

// Tax Review by Code: every line in the period grouped by tax code, with a minimum-value filter.
function taxReviewByCode({ documents, taxRates, minValue = 0 }) {
  const nameByType = new Map((taxRates || []).map(r => [r.taxType, r.name || r.taxType]));
  const groups = new Map();
  for (const doc of documents || []) {
    const rate = doc.currencyRate || 1;
    for (const line of doc.lineItems || []) {
      const net = doc.lineAmountTypes === 'Inclusive'
        ? (Number(line.lineAmount) || 0) - (Number(line.taxAmount) || 0)
        : (Number(line.lineAmount) || 0);
      const key = line.taxType || 'NONE';
      const group = groups.get(key) || { taxType: key, count: 0, net: 0, tax: 0 };
      group.count += 1;
      group.net += Math.abs(net) / rate;
      group.tax += Math.abs(Number(line.taxAmount) || 0) / rate;
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .filter(g => g.net >= minValue)
    .sort((a, b) => b.net - a.net)
    .map(g => ({
      documentId: `tax-code:${g.taxType}`,
      number: null,
      date: null,
      source: 'tax_review',
      accountCode: g.taxType,
      accountName: nameByType.get(g.taxType) || g.taxType,
      description: `${g.count} line(s), net £${g.net.toFixed(2)}, tax £${g.tax.toFixed(2)}`,
      amount: g.net,
      lineCount: g.count,
      taxAmount: g.tax,
    }));
}

const VAT_LIMITS = Object.freeze({
  registration: 90000,
  deregistration: 88000,
  flatRateLeave: 230000,
  cashLeave: 1600000,
  annualLeave: 1600000,
  amberBand: 0.9,
});

function classifyVatScheme(salesTaxBasis, salesTaxPeriod) {
  const basis = String(salesTaxBasis || '').toUpperCase();
  const period = String(salesTaxPeriod || '').toUpperCase();
  if (!basis || basis === 'NONE') return 'unregistered';
  if (/FLATRATE/.test(basis)) return 'flat_rate';
  if (/ANNUAL|YEARLY/.test(period)) return 'annual';
  if (/PAYMENT|CASH/.test(basis)) return 'cash';
  return 'standard';
}

// Rolling 12-month taxable turnover (net, VAT-coded incl. zero-rated, excl. exempt/outside scope) and
// total income incl. VAT (for the Flat Rate exit test).
function rollingVatTurnover({ documents, taxRates, revenueCodes, from, to }) {
  const taxable = new Set();
  for (const r of taxRates || []) {
    const rate = Number(r.effectiveRate ?? r.displayTaxRate ?? 0);
    if (r.canApplyToRevenue === false) continue;
    if (rate > 0 || /ZERORATED|ECZR|ZERO/i.test(r.taxType || '')) taxable.add(r.taxType);
  }
  let taxableNet = 0;
  let grossIncome = 0;
  for (const doc of documents || []) {
    const date = toIsoDate(doc.date);
    if (!date || date < from || date > to) continue;
    const sign = doc.__sign === -1 ? -1 : 1;
    const rate = doc.currencyRate || 1;
    for (const line of doc.lineItems || []) {
      if (!line.accountCode || !revenueCodes.has(String(line.accountCode).toUpperCase())) continue;
      const net = doc.lineAmountTypes === 'Inclusive'
        ? (Number(line.lineAmount) || 0) - (Number(line.taxAmount) || 0)
        : (Number(line.lineAmount) || 0);
      const tax = Number(line.taxAmount) || 0;
      grossIncome += sign * (net + tax) / rate;
      if (taxable.has(line.taxType)) taxableNet += sign * net / rate;
    }
  }
  return { taxableNet, grossIncome };
}

function evaluateVatScheme({ scheme, taxableNet, grossIncome, limits = VAT_LIMITS }) {
  const money = v => `£${Math.round(v).toLocaleString('en-GB')}`;
  const band = (value, limit) => value > limit ? 'red' : value >= limit * limits.amberBand ? 'amber' : 'ok';
  let result;
  if (scheme === 'unregistered') {
    const level = band(taxableNet, limits.registration);
    result = { level, rule: 'registration', value: taxableNet, limit: limits.registration,
      message: `Rolling 12-month taxable turnover ${money(taxableNet)} against the £${limits.registration.toLocaleString('en-GB')} registration limit.` };
  } else if (scheme === 'flat_rate') {
    const level = band(grossIncome, limits.flatRateLeave);
    result = { level, rule: 'flat_rate_exit', value: grossIncome, limit: limits.flatRateLeave,
      message: `Rolling 12-month income including VAT ${money(grossIncome)} against the £${limits.flatRateLeave.toLocaleString('en-GB')} Flat Rate exit limit.` };
  } else if (scheme === 'cash' || scheme === 'annual') {
    const limit = scheme === 'cash' ? limits.cashLeave : limits.annualLeave;
    const level = band(taxableNet, limit);
    result = { level, rule: scheme === 'cash' ? 'cash_exit' : 'annual_exit', value: taxableNet, limit,
      message: `Rolling 12-month taxable turnover ${money(taxableNet)} against the £${limit.toLocaleString('en-GB')} ${scheme === 'cash' ? 'Cash Accounting' : 'Annual Accounting'} exit limit.` };
  } else {
    const level = taxableNet < limits.deregistration ? 'info' : 'ok';
    result = { level, rule: 'deregistration', value: taxableNet, limit: limits.deregistration,
      message: `Rolling 12-month taxable turnover ${money(taxableNet)} is below the £${limits.deregistration.toLocaleString('en-GB')} deregistration limit, so deregistration may suit this client.` };
  }
  return { scheme, ...result };
}

module.exports = {
  CHECK_TYPES, VAT_LIMITS, indexAccounts, detectUnusualJournals, suspenseOpenBalances,
  taxReviewByCode, classifyVatScheme, rollingVatTurnover, evaluateVatScheme,
};
