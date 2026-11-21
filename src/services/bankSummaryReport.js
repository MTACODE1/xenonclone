// Xero's Bank Summary report. Its columns are Opening Balance, Cash Received, Cash Spent, Closing Balance, but an
// organisation with foreign-currency bank accounts gets an extra "FX Gain" column before the closing balance.
// Reading the closing balance from a fixed position therefore returned the FX gain for those organisations
// (0.00 for their sterling accounts, a small unrelated figure for the currency ones; seen on 56 accounts across
// 16 clients, 21 Nov 2026). The columns are found by their headings here; with no usable heading row the opening
// balance is the first figure and the closing balance the last, which is right in both layouts.
function bankSummaryColumns(report) {
  const rows = (report && report.rows) || [];
  const header = rows.find(row => row.rowType === 'Header');
  const titles = ((header && header.cells) || []).map(cell => String((cell && cell.value) || '').trim().toLowerCase());
  const find = pattern => titles.findIndex(title => pattern.test(title));
  const opening = find(/^opening balance/);
  const closing = find(/^closing balance/);
  return { opening: opening > 0 ? opening : 1, closing: closing > 0 ? closing : null };
}

const figure = cell => {
  const text = String((cell && cell.value) ?? '').replace(/,/g, '').trim();
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

// { opening, closing } for one row of the report (an account row or the Total row).
function bankSummaryRowBalances(row, columns) {
  const cells = (row && row.cells) || [];
  const closingIndex = columns.closing != null ? columns.closing : cells.length - 1;
  return { opening: figure(cells[columns.opening]), closing: closingIndex > 0 ? figure(cells[closingIndex]) : null };
}

module.exports = { bankSummaryColumns, bankSummaryRowBalances };
