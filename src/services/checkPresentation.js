// Small display helpers for the client and check pages, kept out of the templates so they can be tested.
const { formatMoney } = require('./money');

// Turnover with pence ("£181,990.37"), so it can be compared with Xero to the penny. A negative figure reads
// "-£50.00", not "£-50". The client's currency is optional: without one it is GBP, as it always was, and a
// client kept in another currency reads "AED 181,990.37" (see money.js).
function formatTurnoverGbp(value, currency) {
  return formatMoney(value, currency, { decimals: 2 });
}

// Multi-Account and Multi-Tax list each supplier's underlying transactions, including ones from the lookback window
// before the review period. When EVERY line carries a boolean inPeriod flag, split them into "in the review period"
// first and "earlier than the period" second (order within each group is kept). Results saved before the flag existed,
// or with only some lines flagged, are shown as one list exactly as before: a missing flag is never read as "outside".
function groupSupplierTransactions(transactions) {
  const rows = Array.isArray(transactions) ? transactions : [];
  const flagged = rows.length > 0 && rows.every(row => row && typeof row.inPeriod === 'boolean');
  if (!flagged) return { grouped: false, groups: [{ key: 'all', label: null, rows }] };
  const inPeriod = rows.filter(row => row.inPeriod);
  const earlier = rows.filter(row => !row.inPeriod);
  const groups = [];
  if (inPeriod.length) groups.push({ key: 'period', label: 'Within the review period', rows: inPeriod });
  if (earlier.length) groups.push({ key: 'earlier', label: 'Earlier than the review period (lookback only)', rows: earlier });
  return { grouped: true, groups };
}

module.exports = { formatTurnoverGbp, groupSupplierTransactions };
