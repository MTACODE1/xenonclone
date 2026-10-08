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
  supplierPaymentAccounts: 'supplier_payment_accounts',
  directorsLoan: 'directors_loan_overdrawn',
  dividendStatus: 'dividend_status',
  historicalChanges: 'historical_changes',
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

const DLA_NAME = /director.?s?\s*(loan|current)|\bdla\b/i;

// Suppliers paid from BOTH a bank account and the director's loan account in the period. Only those
// two payment sources are considered; payments from any other account are ignored on purpose.
function supplierPaymentSources({ payments, bankSpend, accounts }) {
  const byCode = indexAccounts(accounts);
  const byId = new Map();
  for (const a of accounts || []) if (a && a.accountID) byId.set(a.accountID, a);
  const sourceOf = acct => {
    if (!acct) return null;
    const known = (acct.code && byCode.get(String(acct.code).toUpperCase())) || byId.get(acct.accountID) || {};
    const name = acct.name || known.name || '';
    const type = acct.type || known.type || '';
    if (DLA_NAME.test(name)) return 'dla';
    return type === 'BANK' ? 'bank' : null;
  };
  const contacts = new Map();
  const note = (contact, acct, amount, date, reference, kind) => {
    const contactId = contact && contact.contactID;
    const source = sourceOf(acct);
    if (!contactId || !source) return;
    const entry = contacts.get(contactId) || { contactId, name: contact.name || '', bank: { count: 0, amount: 0 }, dla: { count: 0, amount: 0 }, transactions: [] };
    entry[source].count += 1;
    entry[source].amount += Math.abs(Number(amount) || 0);
    entry.transactions.push({
      date: toIsoDate(date), reference: reference || null, amount: Math.abs(Number(amount) || 0),
      accountCode: source === 'dla' ? "Director's loan account" : 'Bank account',
      accountName: acct.name || null, source: kind,
    });
    contacts.set(contactId, entry);
  };
  for (const payment of payments || []) {
    if (payment.status !== 'AUTHORISED' || !/ACCPAY/i.test(payment.paymentType || '')) continue;
    note(payment.invoice && payment.invoice.contact, payment.account, payment.amount, payment.date,
      payment.reference || (payment.invoice && payment.invoice.invoiceNumber), 'payment');
  }
  for (const txn of bankSpend || []) {
    if (txn.status !== 'AUTHORISED' || txn.type !== 'SPEND') continue;
    note(txn.contact, txn.bankAccount, txn.total, txn.date, txn.reference, 'bank_spend');
  }
  return [...contacts.values()]
    .filter(c => c.bank.count > 0 && c.dla.count > 0)
    .map(c => ({
      contactId: c.contactId, name: c.name,
      accountCodes: ['Bank account', "Director's loan account"],
      bankPayments: c.bank.count, dlaPayments: c.dla.count,
      bankAmount: c.bank.amount, dlaAmount: c.dla.amount,
      potentialValue: Math.min(c.bank.amount, c.dla.amount),
      transactions: c.transactions.sort((a, b) => (b.date || '').localeCompare(a.date || '')),
    }));
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

const parseNumber = v => parseFloat(String(v ?? '').replace(/[£,\s]/g, '').replace(/^\((.*)\)$/, '-$1')) || 0;

// Balance Sheet rows with the section they sit in. Assets read positive when debit; liabilities and
// equity read positive when credit, so a director's loan can only be judged together with its section.
function balanceSheetRows(report) {
  const out = [];
  const walk = (rows, trail) => {
    for (const row of rows || []) {
      if (row.rowType === 'Section') {
        walk(row.rows, row.title ? [...trail, String(row.title)] : trail);
      } else if (row.rowType === 'Row' && row.cells && row.cells.length >= 2) {
        const label = String(row.cells[0].value || '').trim();
        if (!label) continue;
        const section = trail.join(' > ');
        out.push({ label, value: parseNumber(row.cells[1].value), section, isAsset: /asset/i.test(section) && !/liabilit/i.test(section) });
      }
    }
  };
  walk(report && report.rows, []);
  return out;
}

// Balance Sheet -> suspense/clearing accounts with a balance left open at the report date.
function suspenseOpenBalances(report, { asOf, minBalance = 1 } = {}) {
  return balanceSheetRows(report)
    .filter(r => SUSPENSE_NAME.test(r.label) && Math.abs(r.value) >= minBalance)
    .map(r => ({
      documentId: `balance-sheet:${r.label}`, number: null, date: asOf || null, source: 'balance_sheet',
      accountCode: r.label, accountName: r.label,
      description: `Balance left open on ${r.label} at period end`, amount: Math.abs(r.value),
    }));
}

// Director's loan overdrawn (the director owes the company): amber under £10,000, red above — a
// possible section 455 tax liability. In an asset section a positive balance is overdrawn; in a
// liability section a negative one is.
function directorsLoanAlerts(report, { asOf, redAbove = 10000, minOverdrawn = 1 } = {}) {
  const items = [];
  for (const r of balanceSheetRows(report)) {
    if (!DLA_NAME.test(r.label)) continue;
    const overdrawn = r.isAsset ? r.value : -r.value;
    if (overdrawn < minOverdrawn) continue;
    const level = overdrawn > redAbove ? 'red' : 'amber';
    items.push({
      documentId: `dla:${r.label}`, number: null, date: asOf || null, source: 'balance_sheet',
      accountCode: r.label, accountName: r.label, level, rule: 'dla_overdrawn', limit: redAbove,
      description: `${r.label} is overdrawn by £${Math.round(overdrawn).toLocaleString('en-GB')} (${level}). Possible section 455 tax liability if not cleared in time.`,
      amount: overdrawn,
    });
  }
  return items;
}

// Dividends: evidence that any dividend was declared or paid in the current financial year.
// Looks for lines on accounts named like a dividend (excluding income accounts) dated in the year.
function dividendStatus({ accounts, lines, fyStart, fyEnd }) {
  const dividendCodes = new Set();
  for (const a of accounts || []) {
    if (a && a.code && /dividend/i.test(a.name || '') && (a._class || a.class) !== 'REVENUE') dividendCodes.add(String(a.code).toUpperCase());
  }
  const postings = (lines || []).filter(l => l.accountCode && dividendCodes.has(String(l.accountCode).toUpperCase())
    && l.date && l.date >= fyStart && l.date <= fyEnd);
  if (postings.length > 0) return [];
  return [{
    documentId: 'dividends-current-fy', number: null, date: fyEnd, source: 'dividend_status', accountCode: null,
    level: 'info', rule: 'no_dividend_evidence', amount: 0,
    description: dividendCodes.size
      ? `No dividend postings found between ${fyStart} and ${fyEnd}.`
      : `No dividend account was found, and no dividend postings exist between ${fyStart} and ${fyEnd}.`,
  }];
}

// Historical changes: items dated inside an accounting period that has already been filed but created or
// changed after the filing date. Xero's last-updated date also moves for harmless reasons, so documents
// whose only likely change is a payment being applied are left out.
function historicalChanges({ journals, invoices, creditNotes, bankTransactions, madeUpTo, filingDate }) {
  if (!madeUpTo || !filingDate) return [];
  const after = v => { const d = toIsoDate(v); return d && d > filingDate ? d : null; };
  const inFiled = v => { const d = toIsoDate(v); return d && d <= madeUpTo ? d : null; };
  const items = [];
  const push = (kind, id, number, date, updated, amount, reason, contact) => items.push({
    documentId: id, number: number || null, date, source: kind, contact: contact || null,
    accountCode: null, description: reason, amount: Math.abs(Number(amount) || 0), updatedDate: updated, filingDate, madeUpTo,
  });
  for (const j of journals || []) {
    const date = inFiled(j.date), updated = after(j.updatedDateUTC);
    if (date && updated) push('manual_journal', j.manualJournalID, null, date, updated,
      (j.journalLines || []).reduce((s, l) => s + Math.max(0, Number(l.lineAmount) || 0), 0), `Manual journal changed or added after accounts for the period to ${madeUpTo} were filed on ${filingDate}.`);
  }
  for (const doc of [...(invoices || []), ...(creditNotes || [])]) {
    const date = inFiled(doc.date), updated = after(doc.updatedDateUTC);
    if (!date || !updated) continue;
    const gone = doc.status === 'VOIDED' || doc.status === 'DELETED';
    const explainedByPayment = !gone && (Number(doc.amountPaid) > 0 || doc.status === 'PAID');
    if (explainedByPayment) continue;
    push(doc.invoiceID ? 'invoice' : 'credit_note', doc.invoiceID || doc.creditNoteID, doc.invoiceNumber || doc.creditNoteNumber, date, updated, doc.total,
      gone ? `Document ${doc.status.toLowerCase()} after accounts for the period to ${madeUpTo} were filed on ${filingDate}.`
           : `Document changed or added after accounts for the period to ${madeUpTo} were filed on ${filingDate}.`, doc.contact && doc.contact.name);
  }
  for (const t of bankTransactions || []) {
    const date = inFiled(t.date), updated = after(t.updatedDateUTC);
    if (date && updated && t.status === 'DELETED') push('bank_transaction', t.bankTransactionID, t.reference, date, updated, t.total,
      `Bank transaction deleted after accounts for the period to ${madeUpTo} were filed on ${filingDate}.`, t.contact && t.contact.name);
  }
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
  flatRateJoin: 150000,
  flatRateLeave: 230000,
  cashJoin: 1350000,
  cashLeave: 1600000,
  annualJoin: 1350000,
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

// Joining tests look at expected turnover over the NEXT 12 months, which cannot be seen. The last 12
// months is the usual guide, so these are estimates, shown as information only. HMRC's other
// conditions (no recent exit from a scheme, not in a VAT group, returns and payments up to date) are
// not held in Xero and must be checked by the accountant.
function joiningEstimates({ scheme, taxableNet, limits = VAT_LIMITS }) {
  if (scheme !== 'standard') return [];
  const money = v => `£${Math.round(v).toLocaleString('en-GB')}`;
  const caveat = ' This is an estimate from the last 12 months. HMRC also requires no recent exit from a scheme, not being in a VAT group, and returns and payments up to date, which Xero cannot show.';
  const out = [];
  if (taxableNet <= limits.flatRateJoin) {
    out.push({ level: 'info', rule: 'flat_rate_join', value: taxableNet, limit: limits.flatRateJoin,
      message: `Rolling 12-month taxable turnover ${money(taxableNet)} is within the £${limits.flatRateJoin.toLocaleString('en-GB')} Flat Rate joining limit, so the client may be able to join.${caveat}` });
  }
  if (taxableNet <= limits.cashJoin) {
    out.push({ level: 'info', rule: 'cash_annual_join', value: taxableNet, limit: limits.cashJoin,
      message: `Rolling 12-month taxable turnover ${money(taxableNet)} is within the £${limits.cashJoin.toLocaleString('en-GB')} Cash Accounting and Annual Accounting joining limit, so the client may be able to join either.${caveat}` });
  }
  return out;
}

module.exports = {
  CHECK_TYPES, VAT_LIMITS, indexAccounts, detectUnusualJournals, suspenseOpenBalances, balanceSheetRows,
  directorsLoanAlerts, dividendStatus, historicalChanges,
  taxReviewByCode, supplierPaymentSources, joiningEstimates, classifyVatScheme, rollingVatTurnover, evaluateVatScheme,
};
