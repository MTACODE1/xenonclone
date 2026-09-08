const { apiCall } = require('./xeroClient');
const {
  saveInsightData, getInsightAccountMappings, getInsightCategorySettings, getAccountCheckConfigurationForOrg,
  getInsightCorpTaxRateBands, getInsightCorpTaxAdjustments,
} = require('../db/queries');

const CASH_HEALTH_CATEGORIES = [
  { key: 'cash_health_suppliers',   label: 'Suppliers' },
  { key: 'cash_health_net_wages',   label: 'Net Wages' },
  { key: 'cash_health_paye_nic',    label: 'PAYE & NIC' },
  { key: 'cash_health_pension',     label: 'Pension Contributions' },
  { key: 'cash_health_credit_cards',label: 'Credit Cards' },
  { key: 'cash_health_other_st',    label: 'Other S/T' },
  { key: 'cash_health_vat_bill',    label: 'VAT Bill' },
  { key: 'cash_health_corp_tax',    label: 'Corporation Tax' },
  { key: 'cash_health_loans_other', label: 'Loans & Other' },
];

// UK corporation tax (FY2023+, single company i.e. no associated companies): 19% up to the
// £50,000 lower limit, 25% from the £250,000 upper limit, with marginal relief tapering the
// effective rate between them — the exact formula HMRC and accounting software use, not a flat
// 25% guess.
function ukCorpTax(profit) {
  const p = Math.max(0, profit);
  const LOWER = 50000, UPPER = 250000, MARGINAL_FRACTION = 3 / 200;
  if (p <= LOWER) return p * 0.19;
  if (p >= UPPER) return p * 0.25;
  return p * 0.25 - (UPPER - p) * MARGINAL_FRACTION;
}

// Xenon's "Rate of Corporation Tax" table: a flat rate per effective-from date, most recent
// effective date not after the FY's end date wins. When the accountant has configured custom
// bands they replace the built-in marginal-relief calculation entirely (matching Xenon, whose
// table has no separate lower/upper limits — it's just a flat rate for the period).
function resolveCustomRate(rateBands, asOfDate) {
  const applicable = (rateBands || [])
    .filter(b => b.effective_date <= asOfDate)
    .sort((a, b) => b.effective_date.localeCompare(a.effective_date));
  return applicable.length ? applicable[0].rate_pct / 100 : null;
}

// Disallow/AddBack and Deduct Other Items: find the named account's total within this FY's P&L
// report and add/subtract the configured percentage of it, before tax is calculated.
function applyProfitAdjustments(report, netProfit, addbacks, deductions, codeToName) {
  const rows = report?.rows || [];
  const allRows = flattenRows(rows);
  let adjusted = netProfit;
  const detail = [];
  for (const adj of addbacks) {
    const name = codeToName[adj.account_code];
    if (!name) continue;
    const row = allRows.find(r => r.rowType === 'Row' && (r.cells || [])[0]?.value === name);
    if (!row) continue;
    const amount = rowValues(row, 0) || 0;
    const pct = (adj.pct ?? 100) / 100;
    adjusted += amount * pct;
    detail.push({ type: 'addback', name, amount, pct: adj.pct ?? 100 });
  }
  for (const adj of deductions) {
    const name = codeToName[adj.account_code];
    if (!name) continue;
    const row = allRows.find(r => r.rowType === 'Row' && (r.cells || [])[0]?.value === name);
    if (!row) continue;
    const amount = rowValues(row, 0) || 0;
    const pct = (adj.pct ?? 100) / 100;
    adjusted -= amount * pct;
    detail.push({ type: 'deduct_other', name, amount, pct: adj.pct ?? 100 });
  }
  return { adjustedProfit: adjusted, detail };
}

function errDetail(e) {
  if (e?.response?.statusCode) return `HTTP ${e.response.statusCode}: ${JSON.stringify(e.response.body)}`;
  return e?.message || String(e);
}

function parseXeroNum(val) {
  if (val == null || val === '' || val === '—') return 0;
  const s = String(val).trim();
  const negative = s.startsWith('(') && s.endsWith(')');
  const clean = s.replace(/[(),\s£$€,]/g, '');
  const n = parseFloat(clean);
  return Number.isFinite(n) ? (negative ? -n : n) : 0;
}

function flattenRows(rows) {
  const out = [];
  for (const row of (rows || [])) {
    out.push(row);
    if (row.rows) out.push(...flattenRows(row.rows));
  }
  return out;
}

function findRow(rows, pattern) {
  for (const row of flattenRows(rows)) {
    const first = (row.cells || [])[0]?.value || '';
    if (pattern instanceof RegExp ? pattern.test(first) : first === pattern) return row;
  }
  return null;
}

function rowValues(row, colIndex = null) {
  if (!row) return colIndex !== null ? null : [];
  const cells = (row.cells || []).slice(1);
  if (colIndex !== null) return parseXeroNum(cells[colIndex]?.value);
  return cells.map(c => parseXeroNum(c.value));
}

function getHeaders(rows) {
  const header = flattenRows(rows).find(r => r.rowType === 'Header');
  return (header?.cells || []).slice(1).map(c => c.value || '');
}

// ---- Calculate financial year periods ----
function getFinancialYearPeriods(fyEndMonth, fyEndDay, count, asOf) {
  const today = asOf ? new Date(asOf) : new Date();
  const thisYear = today.getFullYear();
  const fyEndThisYear = new Date(thisYear, fyEndMonth - 1, fyEndDay);
  const currentFyEndYear = today <= fyEndThisYear ? thisYear : thisYear + 1;

  const periods = [];
  for (let i = 0; i < count; i++) {
    const endYear = currentFyEndYear - i;
    const end = new Date(endYear, fyEndMonth - 1, fyEndDay);
    const prevEnd = new Date(endYear - 1, fyEndMonth - 1, fyEndDay);
    const start = new Date(prevEnd.getTime() + 86400000); // day after prev FY end
    const isCurrent = end >= today;
    const effectiveEnd = isCurrent ? today : end;
    const dd = String(fyEndDay).padStart(2, '0');
    const mm = String(fyEndMonth).padStart(2, '0');
    periods.push({
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
      effectiveEnd: effectiveEnd.toISOString().slice(0, 10),
      label: `${dd}/${mm}/${endYear}`,
      isCurrent,
    });
  }
  return periods;
}

// ---- P&L Parser ----
function parsePnL(report) {
  const rows = report.rows || [];
  const headers = getHeaders(rows);
  const totalIncome  = rowValues(findRow(rows, /^Total (Income|Revenue|Operating Income|Sales)$/i));
  const grossProfit  = rowValues(findRow(rows, /^Gross Profit|^Gross (Profit\/(Loss|Profit))$/i));
  const netProfit    = rowValues(findRow(rows, /^Net (Profit|Loss)(\/?\(?Loss\)?)?/i));
  const n = headers.length;
  // Xero returns columns newest-first; reverse to chronological (oldest -> newest, left to
  // right) so trend charts read correctly instead of appearing to decline over time.
  return {
    headers: [...headers].reverse(),
    totalIncome:  (totalIncome.length === n ? totalIncome : new Array(n).fill(0)).slice().reverse(),
    grossProfit:  (grossProfit.length  === n ? grossProfit : (totalIncome.length === n ? totalIncome : new Array(n).fill(0))).slice().reverse(),
    netProfit:    (netProfit.length    === n ? netProfit   : new Array(n).fill(0)).slice().reverse(),
  };
}

// Sum all period values from a P&L report (for annual total)
function sumPnL(report) {
  const rows = report.rows || [];
  const netProfitRow = findRow(rows, /^Net (Profit|Loss)(\/?\(?Loss\)?)?/i);
  // If only 1 column, grab column 0; else sum all
  const vals = rowValues(netProfitRow);
  return vals.reduce((a, b) => a + b, 0);
}

// Resolve a mapping category's configured account codes to the account *names* that appear on
// balance sheet rows (Xero's Reports API labels rows by name, not code).
function namesForCategory(ctx, category) {
  const codes = (ctx?.mappings || {})[category] || [];
  return codes.map(c => ctx.codeToName[c]).filter(Boolean);
}

function sumRowsByNames(allRows, names, col = 0) {
  if (!names.length) return null;
  let total = 0, found = false;
  for (const row of allRows) {
    if (row.rowType !== 'Row') continue;
    const label = (row.cells || [])[0]?.value || '';
    if (names.includes(label)) { total += rowValues(row, col) || 0; found = true; }
  }
  return found ? total : null;
}

// ---- Balance Sheet Parser ----
// ctx (optional): { mappings: {category: [account_code,...]}, codeToName: {code: name},
// categorySettings: {category: {enabled, overrideEnabled, overrideValue}} } — when a category has
// an explicit account mapping configured, that takes priority over the name-pattern heuristics
// below (which stay as the out-of-the-box fallback for clients nobody has configured yet).
function parseBalanceSheet(report, ctx = {}) {
  const rows = report.rows || [];
  const header = flattenRows(rows).find(r => r.rowType === 'Header');
  const asAtDate = (header?.cells || [])[1]?.value || null;

  const COL = 0; // first value column (current period)
  const allRows = flattenRows(rows);

  // Cash & Bank Balance normally comes straight from the "Total Bank" summary row, but when the
  // accountant has disregarded specific bank accounts (Xenon's "Disregard the following bank
  // accounts from the current cash balance"), sum the individual Bank-section rows minus those.
  const disregardedBankNames = namesForCategory(ctx, 'cash_disregard_banks');
  let cashAndBank;
  if (disregardedBankNames.length) {
    const bankSection = (rows || []).find(r => r.rowType === 'Section' && /^Bank$/i.test(r.title || ''));
    cashAndBank = (bankSection?.rows || [])
      .filter(r => r.rowType === 'Row' && !disregardedBankNames.includes((r.cells || [])[0]?.value || ''))
      .reduce((sum, r) => sum + (parseXeroNum((r.cells || [])[1]?.value) || 0), 0);
  } else {
    cashAndBank = rowValues(findRow(rows, /^Total Bank(s)?$/i), COL) ??
                  rowValues(findRow(rows, /^Total (Cash And Cash Equivalents?|Cash)$/i), COL) ?? null;
  }
  const tradeDebtors   = sumRowsByNames(allRows, namesForCategory(ctx, 'wc_trade_debtors')) ??
                         rowValues(findRow(rows, /^(Trade )?(Debtors?|Receivables?)$/i), COL) ?? null;
  const tradeCreditors = sumRowsByNames(allRows, namesForCategory(ctx, 'wc_trade_creditors')) ??
                         rowValues(findRow(rows, /^(Trade )?(Creditors?|Payables?)$/i), COL) ?? null;
  const stockInventory = sumRowsByNames(allRows, namesForCategory(ctx, 'wc_stock')) ??
                         rowValues(findRow(rows, /^Stock|^Inventory$/i), COL) ?? null;
  const dividendsPaid  = sumRowsByNames(allRows, namesForCategory(ctx, 'dividend')) ?? 0;

  // Retained/accumulated reserves: sum "Current Year Earnings" + "Retained Earnings" when both
  // exist (distinct rows for this year's profit vs. prior years' accumulated profit); fall back
  // to whichever single row is present, then to Total Equity.
  const currentYearRow = findRow(rows, /^Current Year Earnings?$/i);
  const priorRetainedRow = findRow(rows, /^(Retained (Earnings?|Surplus|Profits?)|Accumulated Funds?)$/i);
  const currentYearVal = currentYearRow ? rowValues(currentYearRow, COL) : null;
  const priorRetainedVal = priorRetainedRow ? rowValues(priorRetainedRow, COL) : null;
  const retainedEarnings = (currentYearVal != null || priorRetainedVal != null)
    ? (currentYearVal || 0) + (priorRetainedVal || 0)
    : null;
  const totalEquity = rowValues(findRow(rows, /^Total (Equity|Shareholders['']? Funds?)$/i), COL) ?? null;

  // "Enough cash to pay?" — when the accountant has actually mapped an account or set a real
  // override for at least one cash_health_* category, build the list from exactly those 9 buckets
  // (Xenon's model); an unmapped/disabled bucket with no override is simply omitted, matching
  // Xenon's behaviour of only showing what's configured. A category-settings row merely existing
  // (e.g. the settings form's default "Include" checkbox round-tripping as enabled=true on every
  // save, even one that only touched a different section) must NOT count as "configured" here —
  // otherwise saving any other category silently blanks this one. With nothing actually mapped,
  // fall back to listing whatever's booked under Current Liabilities (excluding the director loan
  // row, shown in its own card) — same as before.
  const hasCashHealthMapping = CASH_HEALTH_CATEGORIES.some(c => {
    const hasAccounts = ((ctx.mappings || {})[c.key] || []).length > 0;
    const setting = (ctx.categorySettings || {})[c.key];
    const hasRealOverride = setting && setting.overrideEnabled && setting.overrideValue != null;
    return hasAccounts || hasRealOverride;
  });
  let liabilityLines = [];
  if (hasCashHealthMapping) {
    for (const cat of CASH_HEALTH_CATEGORIES) {
      const setting = (ctx.categorySettings || {})[cat.key] || { enabled: true, overrideEnabled: false, overrideValue: null };
      if (!setting.enabled) continue;
      const mappedSum = sumRowsByNames(allRows, namesForCategory(ctx, cat.key));
      const value = setting.overrideEnabled && setting.overrideValue != null ? setting.overrideValue : (mappedSum ?? 0);
      if (value !== 0 || setting.overrideEnabled) liabilityLines.push({ name: cat.label, value });
    }
  } else {
    const currentLiabSection = (rows || []).find(r => r.rowType === 'Section' && /^Current Liabilities$/i.test(r.title || ''));
    for (const row of (currentLiabSection?.rows || [])) {
      if (row.rowType !== 'Row') continue;
      const label = (row.cells || [])[0]?.value || '';
      if (/director|DLA|loan to director/i.test(label)) continue;
      liabilityLines.push({ name: label, value: parseXeroNum((row.cells || [])[1]?.value) });
    }
  }

  // Director loan accounts — use the mapped accounts when configured, else auto-detect by name
  // pattern across the whole tree, any section.
  const mappedDirectorNames = namesForCategory(ctx, 'directors_loan');
  const directorAccounts = [];
  for (const row of allRows) {
    if (row.rowType !== 'Row') continue;
    const label = (row.cells || [])[0]?.value || '';
    const isDirectorRow = mappedDirectorNames.length
      ? mappedDirectorNames.includes(label)
      : /director|DLA|loan to director/i.test(label);
    if (!isDirectorRow) continue;
    const balance = parseXeroNum((row.cells || [])[1]?.value);
    const prevBalance = parseXeroNum((row.cells || [])[2]?.value);
    directorAccounts.push({ name: label, balance, prevBalance: (row.cells || []).length > 2 ? prevBalance : null });
  }

  return {
    asAtDate, cashAndBank, tradeDebtors, tradeCreditors, stockInventory,
    retainedEarnings, totalEquity, liabilityLines, directorAccounts, dividendsPaid,
  };
}

// ---- Main sync ----
async function syncInsight(tenantId, orgId, options = {}) {
  const today = options.toDate ? new Date(options.toDate) : new Date();
  const todayStr = today.toISOString().slice(0, 10);

  const fyEndMonth = options.fyEndMonth || 3;  // default March
  const fyEndDay   = options.fyEndDay   || 31;

  const fyPeriods = getFinancialYearPeriods(fyEndMonth, fyEndDay, 3, today);
  const errors = [];

  // Build the account-code -> account-name lookup, and load configured mappings, so
  // parseBalanceSheet can honour explicit account mappings instead of only guessing by label.
  const codeToName = {};
  for (const acc of getAccountCheckConfigurationForOrg(orgId)) codeToName[acc.account_code] = acc.account_name;
  const ctx = {
    codeToName,
    mappings: getInsightAccountMappings(orgId),
    categorySettings: getInsightCategorySettings(orgId),
  };

  // ---- 1. Monthly P&L (trailing 12m) ----
  // Deliberately omit fromDate: Xero's Reports API anchors periods+timeframe off toDate alone,
  // and passing a fromDate alongside them makes it return CUMULATIVE year-to-date totals per
  // column instead of discrete monthly figures (each "month" quietly includes every prior month
  // too, so the chart looked like relentless growth and "this month" was really "this year so
  // far"). Confirmed against Xero directly — dropping fromDate reproduces the real per-month
  // numbers exactly.
  let monthlyPnL = null;
  try {
    const resp = await apiCall(tenantId, async (xero, tid) =>
      xero.accountingApi.getReportProfitAndLoss(tid, undefined, todayStr, 11, 'MONTH', undefined, undefined, undefined, undefined, true, false)
    );
    const report = resp?.body?.reports?.[0];
    if (report) { monthlyPnL = parsePnL(report); saveInsightData(orgId, 'pnl', monthlyPnL); }
  } catch (e) { errors.push(`P&L monthly: ${errDetail(e)}`); }

  // ---- 1b. Cash movements (last 4 calendar months) — "Recent Cash Movements" needs actual net
  // bank movement (closing balance minus opening balance), which is a different figure from P&L
  // sales/income; the Bank Summary report has no periods/timeframe support, so this fetches one
  // calendar month at a time. Confirmed exact-match against real bank summary data.
  const cashMovements = [];
  for (let i = 3; i >= 0; i--) {
    const monthDate = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() - i + 1, 0);
    const label = monthDate.toLocaleDateString('en-GB', { month: 'long' });
    try {
      const resp = await apiCall(tenantId, async (xero, tid) =>
        xero.accountingApi.getReportBankSummary(tid, monthDate.toISOString().slice(0, 10), monthEnd.toISOString().slice(0, 10))
      );
      const report = resp?.body?.reports?.[0];
      const totalRow = flattenRows(report?.rows || []).find(r => r.rowType === 'SummaryRow' && (r.cells || [])[0]?.value === 'Total');
      const opening = totalRow ? parseXeroNum((totalRow.cells || [])[1]?.value) : null;
      const closing = totalRow ? parseXeroNum((totalRow.cells || [])[4]?.value) : null;
      cashMovements.push({ label, netMovement: (opening != null && closing != null) ? closing - opening : null });
    } catch (e) {
      cashMovements.push({ label, netMovement: null });
      errors.push(`Bank Summary ${label}: ${errDetail(e)}`);
    }
  }
  saveInsightData(orgId, 'cash_movements', { months: cashMovements });

  // ---- 2. Financial year P&Ls for Corp Tax (3 years) ----
  const rateBands = getInsightCorpTaxRateBands(orgId);
  const addbacks = getInsightCorpTaxAdjustments(orgId, 'addback');
  const deductions = getInsightCorpTaxAdjustments(orgId, 'deduct_other');
  const fyCorpTax = [];
  for (const fy of fyPeriods) {
    try {
      const resp = await apiCall(tenantId, async (xero, tid) =>
        xero.accountingApi.getReportProfitAndLoss(tid, fy.start, fy.effectiveEnd, undefined, undefined, undefined, undefined, undefined, undefined, true, false)
      );
      const report = resp?.body?.reports?.[0];
      const rawNetProfit = report ? sumPnL(report) : 0;
      const { adjustedProfit, detail } = report
        ? applyProfitAdjustments(report, rawNetProfit, addbacks, deductions, codeToName)
        : { adjustedProfit: rawNetProfit, detail: [] };
      const customRate = resolveCustomRate(rateBands, fy.effectiveEnd);
      const estimate = customRate != null ? Math.max(0, adjustedProfit) * customRate : ukCorpTax(adjustedProfit);
      fyCorpTax.push({
        ...fy, netProfit: rawNetProfit, taxableProfit: adjustedProfit, estimate,
        rate: adjustedProfit > 0 ? estimate / adjustedProfit : 0,
        rateSource: customRate != null ? 'custom' : 'hmrc_marginal_relief',
        adjustments: detail,
      });
    } catch (e) {
      fyCorpTax.push({ ...fy, netProfit: 0, taxableProfit: 0, estimate: 0, rate: 0, rateSource: 'hmrc_marginal_relief', adjustments: [] });
      errors.push(`P&L FY ${fy.label}: ${errDetail(e)}`);
    }
  }
  if (fyCorpTax.length) saveInsightData(orgId, 'corp_tax', { periods: fyCorpTax });

  // ---- 3. Balance Sheet ----
  let bsData = null;
  try {
    const resp = await apiCall(tenantId, async (xero, tid) =>
      xero.accountingApi.getReportBalanceSheet(tid, todayStr, 2, 'YEAR', undefined, undefined, true, false)
    );
    const report = resp?.body?.reports?.[0];
    if (report) bsData = parseBalanceSheet(report, ctx);
  } catch (e) { errors.push(`Balance Sheet: ${errDetail(e)}`); }

  // ---- 3b. Director loan "since [prior FY end]" — the periods=2/YEAR comparison above is
  // anchored to today's date one and two years back, not the client's actual fiscal year
  // boundary, so it doesn't match what "Since 31/03/20XX" is supposed to mean. Fetch a single
  // balance sheet as at the prior FY's end date to get the true opening balance.
  if (bsData && fyPeriods[1]) {
    try {
      const priorFyEnd = fyPeriods[1].end;
      const resp = await apiCall(tenantId, async (xero, tid) =>
        xero.accountingApi.getReportBalanceSheet(tid, priorFyEnd, undefined, undefined, undefined, undefined, true, false)
      );
      const report = resp?.body?.reports?.[0];
      if (report) {
        const priorRows = flattenRows(report.rows || []);
        for (const acc of bsData.directorAccounts) {
          const match = priorRows.find(r => r.rowType === 'Row' && (r.cells || [])[0]?.value === acc.name);
          acc.prevBalance = match ? parseXeroNum((match.cells || [])[1]?.value) : null;
        }
      }
    } catch (e) { errors.push(`Balance Sheet (prior FY end): ${errDetail(e)}`); }
  }

  if (bsData) saveInsightData(orgId, 'balance_sheet', bsData);

  if (errors.length) console.log(`[insightSync] ${tenantId} errors:`, errors);
  return { ok: errors.length === 0, errors };
}

module.exports = { syncInsight, getFinancialYearPeriods, CASH_HEALTH_CATEGORIES };
