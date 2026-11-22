const PERIOD_TYPES = Object.freeze([
  'since_lock_date',
  'all_transactions',
  'current_month',
  'previous_month',
  'previous_month_and_earlier',
  'rolling_12_months',
  'rolling_24_months',
  // Xenon's three "Quarter Ended" options: the three months ending this month, last month and the month before.
  'quarter_ended_0',
  'quarter_ended_1',
  'quarter_ended_2',
  'current_fy',
  'previous_fy',
  'previous_fy_2',
  'custom',
]);

// The earliest date any period reaches back to ("All transactions", or no Xero lock date).
const EARLIEST = '2000-01-01';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function utcDate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(value, days) {
  const date = utcDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}

function monthEnd(year, monthIndex) {
  return formatDate(new Date(Date.UTC(year, monthIndex + 1, 0)));
}

function clampFinancialYearEnd(year, month, day) {
  const end = new Date(Date.UTC(year, month, 0));
  end.setUTCDate(Math.min(Math.max(1, day), end.getUTCDate()));
  return formatDate(end);
}

const ukDate = iso => String(iso || '').slice(0, 10).split('-').reverse().join('/');

function resolvePeriod(input = {}, context = {}) {
  const type = PERIOD_TYPES.includes(input.type) ? input.type : 'since_lock_date';
  const asOf = isoDate(context.asOf) || formatDate(new Date());
  const now = utcDate(asOf);
  let start;
  let end = asOf;
  let label;

  if (type === 'since_lock_date') {
    start = isoDate(context.lockDate) || EARLIEST;
    // Xenon's wording and UK date order ("Since Xero Lock Date (31/10/2025)"). Where Abdur's rule starts the review at
    // the last signed accounts instead (later than Xero's lock date), the label says so rather than naming a date
    // that is not Xero's lock date.
    label = !context.lockDate ? `All transactions to ${ukDate(end)} (no Xero lock date)`
      : context.lockSource === 'signed_accounts' ? `Since last signed accounts (${ukDate(start)})` : `Since Xero Lock Date (${ukDate(start)})`;
  } else if (type === 'all_transactions') {
    start = EARLIEST;
    label = `All transactions (to ${ukDate(end)})`;
  } else if (type === 'current_month') {
    start = `${asOf.slice(0, 7)}-01`;
    label = `Current month (${ukDate(start)} to ${ukDate(end)})`;
  } else if (type === 'previous_month' || type === 'previous_month_and_earlier') {
    const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    end = monthEnd(previous.getUTCFullYear(), previous.getUTCMonth());
    if (type === 'previous_month') {
      start = formatDate(previous);
      label = `Previous month (${ukDate(start)} to ${ukDate(end)})`;
    } else {
      start = EARLIEST;
      label = `Previous month and earlier (to ${ukDate(end)})`;
    }
  } else if (type === 'rolling_12_months' || type === 'rolling_24_months') {
    const years = type === 'rolling_12_months' ? 1 : 2;
    const prior = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
    start = addDays(formatDate(prior), 1);
    label = `Rolling ${years * 12} months (${ukDate(start)} to ${ukDate(end)})`;
  } else if (type.startsWith('quarter_ended_')) {
    // Like Xenon: "Quarter Ended 30/11/2026" while November is still running covers September up to today.
    const back = Number(type.slice(-1));
    const quarterEnd = monthEnd(now.getUTCFullYear(), now.getUTCMonth() - back);
    start = formatDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back - 2, 1)));
    end = quarterEnd < asOf ? quarterEnd : asOf;
    label = `Quarter ended ${ukDate(quarterEnd)} (${ukDate(start)} to ${ukDate(end)})`;
  } else if (type === 'custom') {
    start = isoDate(input.from);
    end = isoDate(input.to);
    if (!start || !end) throw new Error('Custom period requires valid YYYY-MM-DD start and end dates');
    if (start > end) throw new Error('Custom period start date must not be after its end date');
    if (end > asOf) throw new Error('Custom period end date must not be in the future');
    label = `Custom (${ukDate(start)} to ${ukDate(end)})`;
  } else {
    const month = Math.min(12, Math.max(1, Number(context.financialYearEndMonth) || 3));
    const day = Math.min(31, Math.max(1, Number(context.financialYearEndDay) || 31));
    let currentEndYear = now.getUTCFullYear();
    let currentEnd = clampFinancialYearEnd(currentEndYear, month, day);
    if (asOf > currentEnd) {
      currentEndYear += 1;
      currentEnd = clampFinancialYearEnd(currentEndYear, month, day);
    }
    const priorEnd = clampFinancialYearEnd(currentEndYear - 1, month, day);
    const currentStart = addDays(priorEnd, 1);
    if (type === 'current_fy') {
      start = currentStart;
      end = asOf < currentEnd ? asOf : currentEnd;
      label = `Year ended ${ukDate(currentEnd)} (${ukDate(start)} to ${ukDate(end)})`;
    } else {
      // previous_fy: the year that ended last; previous_fy_2: the one before it.
      const back = type === 'previous_fy' ? 1 : 2;
      const yearEnd = back === 1 ? priorEnd : clampFinancialYearEnd(currentEndYear - 2, month, day);
      start = addDays(clampFinancialYearEnd(currentEndYear - back - 1, month, day), 1);
      end = yearEnd;
      label = `Year ended ${ukDate(yearEnd)} (${ukDate(start)} to ${ukDate(end)})`;
    }
  }

  if (start > end) throw new Error('Resolved period starts after it ends');
  return Object.freeze({
    type,
    start,
    end,
    key: `${type}:${start}:${end}`,
    label,
    // Whole months, as Xenon's "/mth" figures use: a year is 12 (not 11.99), a month that has only started is 1.
    // Checked against Xenon's Client Panorama, 22 Nov 2026.
    monthsCovered: Math.max(1, Math.round((utcDate(end) - utcDate(start) + 86400000) / (365.2425 / 12 * 86400000))),
  });
}

// A stored period key ("since_lock_date:2025-09-30:2026-11-21") in words, for screens that only have the key.
const KEY_WORDS = {
  all_transactions: 'All transactions', current_month: 'Current month', previous_month: 'Previous month',
  previous_month_and_earlier: 'Previous month and earlier', rolling_12_months: 'Rolling 12 months',
  rolling_24_months: 'Rolling 24 months', quarter_ended_0: 'Quarter', quarter_ended_1: 'Quarter',
  quarter_ended_2: 'Quarter', current_fy: 'Current financial year', previous_fy: 'Previous financial year',
  previous_fy_2: 'Financial year', custom: 'Custom',
};

// The period dropdown in Xenon's order, each option naming this client's own dates where Xenon does
// ("Quarter Ended 30/11/2026", "Year Ended 30/09/2026", "Since Xero Lock Date (30/09/2025)"). The full date range
// of every option is in `title` (shown on hover). `context` is what resolvePeriod takes.
const MENU_ORDER = ['all_transactions', 'current_month', 'previous_month', 'previous_month_and_earlier',
  'rolling_12_months', 'rolling_24_months', 'quarter_ended_0', 'quarter_ended_1', 'quarter_ended_2',
  'current_fy', 'previous_fy', 'previous_fy_2', 'since_lock_date', 'custom'];
const MENU_WORDS = {
  all_transactions: 'All transactions', current_month: 'Current Month', previous_month: 'Previous Month',
  previous_month_and_earlier: 'Previous Month (and Earlier)', rolling_12_months: 'Rolling 12 months',
  rolling_24_months: 'Rolling 24 months',
};
// Any YYYY-MM-DD in a label written as DD/MM/YYYY. Labels saved by syncs before 22 Nov 2026 can hold YYYY-MM-DD.
const ukDatesIn = text => String(text == null ? '' : text).replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, '$3/$2/$1');

// A client's normal period in words, from what its last sync saved.
function storedPeriodLabel(org) {
  if (!org) return '';
  return org.period_label ? ukDatesIn(org.period_label) : periodKeyLabel(org.period_key);
}

function periodMenu(context = {}) {
  return MENU_ORDER.map(type => {
    if (type === 'custom') return { value: type, label: 'Custom Date Range', title: 'Choose the start and end dates' };
    const period = resolvePeriod({ type }, context);
    let label = MENU_WORDS[type];
    if (!label) {
      const ended = /^(Quarter|Year) ended (\S+)/.exec(period.label);
      label = ended ? `${ended[1]} Ended ${ended[2]}` : period.label;
    }
    return { value: type, label, title: period.label };
  });
}
function periodKeyLabel(key) {
  const match = /^([a-z_0-9]+):(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(String(key || ''));
  if (!match) return String(key || '').replace(/_/g, ' ');
  const [, type, start, end] = match;
  if (type === 'since_lock_date') return `${ukDate(start)} to ${ukDate(end)}`;
  return `${KEY_WORDS[type] || type.replace(/_/g, ' ')} (${ukDate(start)} to ${ukDate(end)})`;
}

function isWithinPeriod(value, period) {
  const date = isoDate(value instanceof Date ? value : String(value || '').slice(0, 10));
  if (!date || !period?.start || !period?.end) return false;
  // Xenon "Activity Since <lock date>" excludes the lock date itself: Rose purchase-tax and
  // unexpected-account residuals were exactly the 16 / 1 findings dated on period.start
  // (2025-10-31), and dropping date === start made both count and £ exact. Other since_lock
  // clients had zero findings on their start day, so exclusive start is holdout-safe.
  // period.key still embeds the lock date as `start` for snapshot matching / labels.
  if (period.type === 'since_lock_date') {
    return date > period.start && date <= period.end;
  }
  return date >= period.start && date <= period.end;
}

// A supplier-pattern window that starts at `windowStart`. With no lookback the window starts at period.start and is the
// review period itself, so it must exclude the start day exactly as isWithinPeriod does (a bill dated on the signed
// year end belongs to the closed year). With a lookback the start is earlier and inclusive.
function isWithinPatternWindow(value, period, windowStart) {
  if (windowStart === period.start) return isWithinPeriod(value, period);
  const date = isoDate(value instanceof Date ? value : String(value || '').slice(0, 10));
  return Boolean(date) && date >= windowStart && date <= period.end;
}

// Is this the client's NORMAL period (the one its sync runs with), or another one to be shown as a period view?
// Decided by the KIND of period, not its exact dates: a period key includes today's date, so the client's own
// period (say "since lock date") gets a new key every day and must still count as the normal one, refreshed by a
// real sync. Only a custom range is compared by its dates. A client never synced has no other period yet.
function isNormalPeriod(org, selectedPeriod) {
  if (!org || !org.period_key || !org.period_type) return true;
  if (selectedPeriod.type !== org.period_type) return false;
  const day = value => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10));
  return selectedPeriod.type !== 'custom'
    || (selectedPeriod.start === day(org.period_start) && selectedPeriod.end === day(org.period_end));
}

function periodInput(query = {}, fallback = 'since_lock_date') {
  return {
    type: PERIOD_TYPES.includes(query.period) ? query.period : fallback,
    from: query.from,
    to: query.to,
  };
}

function shouldUseCacheOnlyForReanalysis(activePeriodKey, selectedPeriodKey) {
  return Boolean(activePeriodKey) && Boolean(selectedPeriodKey) && selectedPeriodKey !== activePeriodKey;
}

// The first day a period actually counts, for labels. A since-lock-date period starts the day AFTER the lock date
// (isWithinPeriod leaves the locked day out), so showing period.start would wrongly suggest the locked day is in.
function firstCountedDay(period) {
  const start = isoDate(String(period?.start || '').slice(0, 10));
  if (!start) return null;
  if (period.type !== 'since_lock_date') return start;
  const next = new Date(start + 'T00:00:00Z');
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

module.exports = {
  firstCountedDay,
  periodMenu,
  storedPeriodLabel,
  ukDate,
  ukDatesIn,
  periodKeyLabel,
  PERIOD_TYPES,
  isWithinPatternWindow,
  isoDate,
  isWithinPeriod,
  periodInput,
  resolvePeriod,
  shouldUseCacheOnlyForReanalysis,
  isNormalPeriod,
};
