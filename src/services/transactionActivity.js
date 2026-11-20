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

const COUNT_FIELDS = ['customer_invoices', 'supplier_bills', 'credit_notes_sales', 'credit_notes_purchase', 'bank_processed', 'journals'];
const COUNTED_DOCUMENT_STATUSES = new Set(['AUTHORISED', 'PAID']); // VOIDED is fetched but never counted
const emptyDay = day => ({ day, customer_invoices: 0, supplier_bills: 0, credit_notes_sales: 0, credit_notes_purchase: 0, bank_processed: 0, journals: 0, turnover: 0 });

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
    if (!day) continue;
    if (sales) { day.customer_invoices += 1; day.turnover += turnoverOf(invoice); }
    else day.supplier_bills += 1;
  }
  for (const credit of credits) {
    if (!COUNTED_DOCUMENT_STATUSES.has(credit.status)) continue;
    const sales = credit.type === 'ACCRECCREDIT';
    if (!sales && credit.type !== 'ACCPAYCREDIT') continue;
    const day = at(credit.date);
    if (!day) continue;
    if (sales) { day.credit_notes_sales += 1; day.turnover -= turnoverOf(credit); } // a sales credit note reverses revenue
    else day.credit_notes_purchase += 1;
  }
  for (const transaction of bankTransactions) {
    if (transaction.status !== 'AUTHORISED') continue; // Xero also returns DELETED bank transactions
    const day = at(transaction.date);
    if (!day) continue;
    if (countsAsBankProcessed(transaction)) day.bank_processed += 1;
    // Money received on a revenue account is a cash sale; money spent from one is a refund against it.
    if (transaction.type === 'RECEIVE') day.turnover += turnoverOf(transaction);
    else if (transaction.type === 'SPEND') day.turnover -= turnoverOf(transaction);
  }
  for (const journal of manualJournals) {
    if (journal.status !== 'POSTED') continue;
    const day = at(journal.date);
    if (!day) continue;
    for (const line of (journal.journalLines || [])) {
      if (!line.accountCode || !codes.has(String(line.accountCode).toUpperCase())) continue;
      const net = journal.lineAmountTypes === 'Inclusive' ? (line.lineAmount || 0) - (line.taxAmount || 0) : (line.lineAmount || 0);
      day.turnover += -net; // a credit (negative) to a revenue account is revenue
    }
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
  if (Array.isArray(journals)) {
    for (const journal of journals) {
      const day = at(journal.journalDate);
      if (day) day.journals += 1;
    }
  }
  return {
    rows: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    journalsKnown: Array.isArray(journals),
  };
}

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
  return {
    ...sums,
    journals: journalsKnown ? sums.journals : null,
    total_transactions: sums.customer_invoices + sums.supplier_bills + sums.credit_notes_sales + sums.credit_notes_purchase + sums.bank_processed,
    period: period.type, period_start: period.start, period_end: period.end, months_covered: period.monthsCovered,
  };
}

module.exports = { buildDailyActivity, sumActivity, COUNT_FIELDS };
