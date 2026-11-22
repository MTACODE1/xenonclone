// Transaction counts and turnover per day, so the Transactions pages can show ANY period (previous month, a
// financial year, custom dates) straight away. Before this, only the one period the last sync ran with was
// stored, and choosing another period meant running a sync again, which also replaced the client's live
// health-check results.
//
// buildDailyActivity applies exactly the rules of the sync's own transaction-count step (xeroSync.js), but
// files every document under its own date instead of testing it against one period. Adding the days of a
// period back up (sumActivity) therefore gives the same figures the sync would have stored for that period;
// test/transactionActivity.test.js holds that equality.
const { toDateString, countsAsBankProcessed, turnoverAdjustmentFromPayments } = require('./checkRules');
const { isWithinPeriod } = require('./periodResolver');

// What each column counts, matched to Xenon's Transaction Counts on 21 Nov 2026 (85 clients, Oct 2026):
//   customer_invoices / supplier_bills / credit notes : every document that is not voided or deleted, drafts and
//       "awaiting approval" included (Xenon's figure = approved + unapproved on all 11 clients checked);
//   bank_processed  : customer payments + supplier payments + direct deposits + direct payments + transfers
//       (Xenon's own "Expand" breakdown); a transfer counts once on each side, as in Xenon;
//   manual_journals : posted manual journals, the "Journals" column, and part of the total;
//   journals        : Xero's system journals. Kept for reference only: every document already creates one, so
//       it is not part of the total.
// Turnover comes from Xero's journals on revenue accounts, as Xero's Profit & Loss does. Only when the journals
// are not available is it built from approved and paid documents instead.
const COUNT_FIELDS = ['customer_invoices', 'supplier_bills', 'credit_notes_sales', 'credit_notes_purchase',
  'customer_payments', 'supplier_payments', 'other_payments', 'direct_deposits', 'direct_payments', 'transfers',
  'bank_processed', 'manual_journals', 'journals'];
const COUNTED_DOCUMENT_STATUSES = new Set(['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID']); // not VOIDED, not DELETED
const POSTED_DOCUMENT_STATUSES = new Set(['AUTHORISED', 'PAID']);                           // these reach the P&L
const emptyDay = day => ({ day, ...Object.fromEntries(COUNT_FIELDS.map(field => [field, 0])), turnover: 0 });

function turnoverSets(chartOfAccounts) {
  const revenue = (chartOfAccounts || []).filter(a => a._class === 'REVENUE' && ['REVENUE', 'SALES'].includes(a.type));
  return {
    codes: new Set(revenue.map(a => a.code).filter(Boolean).map(code => String(code).toUpperCase())),
    ids: new Set(revenue.map(a => a.accountID).filter(Boolean)),
  };
}

// datasets: everything the sync already holds for the client, for ALL dates.
//   invoices (sales and purchase), credits (credit notes only), bankTransactions, manualJournals, payments,
//   journals (Xero's system journals, or null when that download was skipped or timed out), chartOfAccounts.
function buildDailyActivity({ invoices = [], credits = [], bankTransactions = [], manualJournals = [], payments = [], journals = null, chartOfAccounts = [] } = {}) {
  const { codes, ids } = turnoverSets(chartOfAccounts);
  const days = new Map();
  const at = value => {
    const day = toDateString(value);
    if (!day) return null;
    if (!days.has(day)) days.set(day, emptyDay(day));
    return days.get(day);
  };
  const netBase = (line, doc) => {
    const net = doc.lineAmountTypes === 'Inclusive' ? (line.lineAmount || 0) - (line.taxAmount || 0) : (line.lineAmount || 0);
    return net / (doc.currencyRate || 1); // manual journals carry no rate: always base currency
  };
  const turnoverOf = doc => (doc.lineItems || []).reduce((sum, line) =>
    sum + (line.accountCode && codes.has(String(line.accountCode).toUpperCase()) ? netBase(line, doc) : 0), 0);

  for (const invoice of invoices) {
    if (!COUNTED_DOCUMENT_STATUSES.has(invoice.status)) continue;
    const sales = invoice.type === 'ACCREC';
    if (!sales && invoice.type !== 'ACCPAY') continue;
    const day = at(invoice.date);
    if (!day) continue; // a draft with no date cannot be placed in any period
    if (sales) { day.customer_invoices += 1; if (POSTED_DOCUMENT_STATUSES.has(invoice.status)) day.turnover += turnoverOf(invoice); }
    else day.supplier_bills += 1;
  }
  for (const credit of credits) {
    if (!COUNTED_DOCUMENT_STATUSES.has(credit.status)) continue;
    const sales = credit.type === 'ACCRECCREDIT';
    if (!sales && credit.type !== 'ACCPAYCREDIT') continue;
    const day = at(credit.date);
    if (!day) continue;
    // a sales credit note reverses revenue once it is approved
    if (sales) { day.credit_notes_sales += 1; if (POSTED_DOCUMENT_STATUSES.has(credit.status)) day.turnover -= turnoverOf(credit); }
    else day.credit_notes_purchase += 1;
  }
  for (const transaction of bankTransactions) {
    if (transaction.status !== 'AUTHORISED') continue; // Xero also returns DELETED bank transactions
    const day = at(transaction.date);
    if (!day) continue;
    const type = String(transaction.type || '');
    // £0.00 transactions are left out, as Xero's Account Transactions report leaves them out.
    if (countsAsBankProcessed(transaction)) {
      if (/-TRANSFER$/.test(type)) day.transfers += 1;
      else if (/^RECEIVE/.test(type)) day.direct_deposits += 1;
      else if (/^SPEND/.test(type)) day.direct_payments += 1;
    }
    // Money received on a revenue account is a cash sale; money spent from one is a refund against it.
    if (type === 'RECEIVE') day.turnover += turnoverOf(transaction);
    else if (type === 'SPEND') day.turnover -= turnoverOf(transaction);
  }
  for (const journal of manualJournals) {
    if (journal.status !== 'POSTED') continue;
    const day = at(journal.date);
    if (!day) continue;
    day.manual_journals += 1;
    for (const line of (journal.journalLines || [])) {
      if (!line.accountCode || !codes.has(String(line.accountCode).toUpperCase())) continue;
      const net = journal.lineAmountTypes === 'Inclusive' ? (line.lineAmount || 0) - (line.taxAmount || 0) : (line.lineAmount || 0);
      day.turnover += -net; // a credit (negative) to a revenue account is revenue
    }
  }
  // Payments against invoices and bills, and cash refunds of credit notes, overpayments and prepayments: each is
  // a line on the bank statement. Xenon counts a customer refund (ARCREDITPAYMENT) as a Customer Payment (checked
  // against Xenon's Client Panorama, 22 Nov 2026); supplier-side refunds (AP...) follow the same rule. Anything
  // else is still counted apart.
  for (const payment of payments) {
    if (payment.status !== 'AUTHORISED') continue;
    const day = at(payment.date);
    if (!day) continue;
    const kind = paymentSide(payment.paymentType);
    if (kind === 'customer') day.customer_payments += 1;
    else if (kind === 'supplier') day.supplier_payments += 1;
    else day.other_payments += 1;
  }
  // Payments made out of a revenue account: the sync's own rule, applied one day at a time.
  const paymentsByDay = new Map();
  for (const payment of payments) {
    const date = toDateString(payment.date);
    if (!date) continue;
    if (!paymentsByDay.has(date)) paymentsByDay.set(date, []);
    paymentsByDay.get(date).push(payment);
  }
  for (const [date, list] of paymentsByDay) {
    const adjustment = turnoverAdjustmentFromPayments(list, {
      revenueAccountIds: ids, revenueAccountCodes: codes, period: { type: 'custom', start: date, end: date },
    });
    if (adjustment) at(date).turnover += adjustment;
  }
  const turnoverFromJournals = Array.isArray(journals) && journals.length > 0;
  if (Array.isArray(journals)) {
    // Turnover the way Xero's Profit and Loss works it out: every journal line posted to a revenue account,
    // net of tax and in base currency, on the journal's date. Building it from documents (above) missed postings
    // that are not sales documents: conversion balances, supplier bills or bill credits coded to a revenue
    // account, prepayments and overpayments, and line amounts Xero rounds differently (4-decimal unit prices,
    // tax-inclusive lines). Checked on 22 Nov 2026 against Xero's Profit and Loss for 103 clients and 5 periods.
    // The document figures are kept only for a sync whose journal download was skipped or timed out.
    const journalTurnover = new Map();
    for (const journal of journals) {
      const day = at(journal.journalDate);
      if (!day) continue;
      day.journals += 1;
      for (const line of journal.journalLines || []) {
        // Matched on the account's ID, which never changes: a journal keeps the account code it was posted with,
        // so after an account's code is changed in Xero the code no longer matches (seen 22 Nov 2026: revenue
        // posted to a code that was later renamed was left out). The code is the fallback when there is no ID.
        const onRevenue = line.accountID
          ? ids.has(line.accountID)
          : !!line.accountCode && codes.has(String(line.accountCode).toUpperCase());
        if (!onRevenue) continue;
        // a credit (negative) to a revenue account is revenue
        journalTurnover.set(day.day, (journalTurnover.get(day.day) || 0) - (Number(line.netAmount) || 0));
      }
    }
    // An empty list is not proof of no revenue: a recalculation from stored data returns [] for a client whose
    // journals were never downloaded. Turnover then stays as worked out from the documents.
    if (turnoverFromJournals) for (const day of days.values()) day.turnover = journalTurnover.get(day.day) || 0;
  }
  const rows = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  for (const row of rows) row.bank_processed = bankProcessedOf(row);
  return { rows, journalsKnown: Array.isArray(journals), turnoverFromJournals };
}

// Which side of the business a Xero payment is on: customer (money in from, or refunded to, a customer) or supplier.
const CUSTOMER_PAYMENT_TYPES = new Set(['ACCRECPAYMENT', 'ARCREDITPAYMENT', 'AROVERPAYMENTPAYMENT', 'ARPREPAYMENTPAYMENT']);
const SUPPLIER_PAYMENT_TYPES = new Set(['ACCPAYPAYMENT', 'APCREDITPAYMENT', 'APOVERPAYMENTPAYMENT', 'APPREPAYMENTPAYMENT']);
function paymentSide(type) {
  if (CUSTOMER_PAYMENT_TYPES.has(type)) return 'customer';
  if (SUPPLIER_PAYMENT_TYPES.has(type)) return 'supplier';
  return 'other';
}

const bankProcessedOf = row => (Number(row.customer_payments) || 0) + (Number(row.supplier_payments) || 0)
  + (Number(row.direct_deposits) || 0) + (Number(row.direct_payments) || 0) + (Number(row.transfers) || 0);

// Adds up the days inside a period with the same boundary rule the sync uses (isWithinPeriod: a "since lock
// date" period leaves out the lock date itself; every other period includes both ends).
function sumActivity(rows, period, { journalsKnown = true } = {}) {
  const total = emptyDay(null);
  for (const row of rows || []) {
    if (!isWithinPeriod(row.day, period)) continue;
    for (const field of COUNT_FIELDS) total[field] += Number(row[field]) || 0;
    total.turnover += Number(row.turnover) || 0;
  }
  const { day, ...sums } = total;
  sums.bank_processed = bankProcessedOf(sums);
  return {
    ...sums,
    journals: journalsKnown ? sums.journals : null,
    total_transactions: sums.customer_invoices + sums.supplier_bills + sums.credit_notes_sales + sums.credit_notes_purchase
      + sums.bank_processed + sums.manual_journals,
    period: period.type, period_start: period.start, period_end: period.end, months_covered: period.monthsCovered,
  };
}

module.exports = { buildDailyActivity, sumActivity, COUNT_FIELDS, bankProcessedOf, paymentSide };
