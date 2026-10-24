const { balanceSheetNeeded } = require('./checkRules');

// A number Xero could have written in a Balance Sheet cell: "0.00", "-1,234.50", "(12.00)", "£1,000". A blank cell is a
// nil balance. Anything else ("n/a", "unreadable") cannot be trusted, and the check code would silently read it as 0.
function isReadableAmount(value) {
  if (value == null) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  const text = String(value).replace(/[£,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  return text === '' || /^-?\d+(\.\d+)?$/.test(text);
}

// A Balance Sheet we can read checks from: it has report sections, and every account row's value is a readable number.
// An empty, header-only or garbled report must never be treated as "nothing wrong": that would replace a real Suspense
// or Director's Loan finding with a false zero. A report whose sections hold no matching accounts is a genuine zero.
function assertUsableBalanceSheet(report) {
  const rows = report && report.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Xero returned no usable Balance Sheet');
  let sections = 0;
  const walk = list => {
    if (list != null && !Array.isArray(list)) throw new Error('Xero Balance Sheet has an unreadable section');
    for (const row of list || []) {
      if (row.rowType === 'Section') {
        sections += 1;
        walk(row.rows);
      } else if (row.rowType === 'Row' && Array.isArray(row.cells) && row.cells.length > 0) {
        const label = String(row.cells[0] && row.cells[0].value != null ? row.cells[0].value : '').trim();
        if (!label) continue;                      // an unlabelled row is not an account
        if (row.cells.length < 2) throw new Error('Xero Balance Sheet has an unreadable account row (no value)');
        if (!isReadableAmount(row.cells[1] && row.cells[1].value)) throw new Error('Xero Balance Sheet has an unreadable value');
      }
    }
  };
  walk(rows);
  if (sections === 0) throw new Error('Xero returned no usable Balance Sheet');
  return report;
}

// The one Xero call behind Suspense, Director's Loan and Motor Vehicle: the Balance Sheet as at the end of the review
// period. Returns null when this run does not need it. Throws when Xero fails or answers with something unusable, so
// the caller leaves those checks unproduced and the previous results stay in force. `callApi` is passed in so this
// file needs no database or Xero client of its own.
async function loadReviewBalanceSheet(tenantId, periodEnd, options, callApi) {
  if (!balanceSheetNeeded(options)) return null;
  const response = await callApi(tenantId, async (xero, tid) =>
    xero.accountingApi.getReportBalanceSheet(tid, periodEnd, undefined, undefined, undefined, undefined, true, false));
  return assertUsableBalanceSheet(response?.body?.reports?.[0]);
}

module.exports = { loadReviewBalanceSheet, assertUsableBalanceSheet };
