// Small display helpers for the client and check pages, kept out of the templates so they can be tested.

// Turnover with pence ("£181,990.37"), so it can be compared with Xero to the penny. A negative figure reads
// "-£50.00", not "£-50".
function formatTurnoverGbp(value) {
  const number = Number(value);
  const amount = Number.isFinite(number) ? number : 0;
  const text = Math.abs(amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${amount < 0 && Number(text.replace(/,/g, '')) !== 0 ? '-' : ''}£${text}`;
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
