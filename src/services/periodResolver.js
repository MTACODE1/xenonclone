const PERIOD_TYPES = Object.freeze([
  'since_lock_date',
  'current_month',
  'previous_month',
  'rolling_12_months',
  'current_fy',
  'previous_fy',
  'custom',
]);

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

function resolvePeriod(input = {}, context = {}) {
  const type = PERIOD_TYPES.includes(input.type) ? input.type : 'since_lock_date';
  const asOf = isoDate(context.asOf) || formatDate(new Date());
  const now = utcDate(asOf);
  let start;
  let end = asOf;
  let label;

  if (type === 'since_lock_date') {
    start = isoDate(context.lockDate) || '2000-01-01';
    label = context.lockDate ? `Since lock date (${start})` : `All activity to ${end}`;
  } else if (type === 'current_month') {
    start = `${asOf.slice(0, 7)}-01`;
    label = `Current month (${start} to ${end})`;
  } else if (type === 'previous_month') {
    const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    start = formatDate(previous);
    end = monthEnd(previous.getUTCFullYear(), previous.getUTCMonth());
    label = `Previous month (${start} to ${end})`;
  } else if (type === 'rolling_12_months') {
    const prior = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate()));
    start = addDays(formatDate(prior), 1);
    label = `Rolling 12 months (${start} to ${end})`;
  } else if (type === 'custom') {
    start = isoDate(input.from);
    end = isoDate(input.to);
    if (!start || !end) throw new Error('Custom period requires valid YYYY-MM-DD start and end dates');
    if (start > end) throw new Error('Custom period start date must not be after its end date');
    if (end > asOf) throw new Error('Custom period end date must not be in the future');
    label = `Custom (${start} to ${end})`;
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
      label = `Current financial year (${start} to ${end})`;
    } else {
      const previousPriorEnd = clampFinancialYearEnd(currentEndYear - 2, month, day);
      start = addDays(previousPriorEnd, 1);
      end = priorEnd;
      label = `Previous financial year (${start} to ${end})`;
    }
  }

  if (start > end) throw new Error('Resolved period starts after it ends');
  return Object.freeze({
    type,
    start,
    end,
    key: `${type}:${start}:${end}`,
    label,
    monthsCovered: Math.max(1 / 31, (utcDate(end) - utcDate(start) + 86400000) / (365.2425 / 12 * 86400000)),
  });
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

function periodInput(query = {}, fallback = 'since_lock_date') {
  return {
    type: PERIOD_TYPES.includes(query.period) ? query.period : fallback,
    from: query.from,
    to: query.to,
  };
}

module.exports = { PERIOD_TYPES, isoDate, isWithinPeriod, periodInput, resolvePeriod };
