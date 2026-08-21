const SCORE_PROFILE = Object.freeze({
  version: 'calibrated-2026-08-n5',
  status: 'calibrated',
  rationale: 'Fitted to five period-matched Xenon exports. Mean absolute error is 4.8 points and ' +
    'three of the five clients land within 3 points, but two do not (77 predicted as 66, 32 as 40). ' +
    'One free scale parameter cannot absorb that spread, so the residual is the shape of the ' +
    'deduction curve rather than its magnitude. Treat scores as indicative until the curve itself ' +
    'is fitted against more exports.',
  // Number of independent, period-matched Xenon targets this scale was fitted against, and the
  // number required before the fit is treated as identified rather than as a single-point guess.
  calibrationTargets: 5,
  minCalibrationTargets: 3,
  // Least-squares fit against all five exports in the calibration fixture. The previous value of
  // 2.506 came from a single partial MBX data point and deducted so hard that any client with more
  // than about fourteen firing checks floored at zero (Fast Track 101.5 points, MBX 147.7).
  globalScale: 0.9108611991785556,
  maxCheckDeduction: 8,
  severityWeights: Object.freeze({ critical: 1.6, high: 1.15, medium: 0.75, low: 0.35 }),
  componentWeights: Object.freeze({ count: 0.55, value: 0.3, age: 0.15 }),
  transformCaps: Object.freeze({ count: 1000, value: 1000000, ageDays: 3650 }),
  transformReferences: Object.freeze({ count: 5, value: 100, ageDays: 30 }),
  checkWeights: Object.freeze({
    bank_balance: 1.25,
    unreconciled_bank_items: 1.15,
    duplicate_invoices: 1.1,
    duplicate_bills: 1.1,
    old_unpaid_invoices: 1.1,
    old_unpaid_bills: 1.1,
    old_sales_credits: 1.05,
    old_purchase_credits: 1.05,
    sales_tax_missing: 1.05,
    purchase_tax_missing: 1.05,
    sales_tax_on_bills: 1.05,
    purchase_tax_on_invoices: 1.05,
  }),
});

const NON_SCORED_PERIODS = new Set(['out_of_scope', 'not_configured', 'needs_sync', 'unavailable']);
const DATE_FIELDS = [
  'date', 'date1', 'date2', 'transactionDate', 'documentDate', 'dueDate',
  'evidenceDate', 'filingDate', 'xeroBalanceAsOf',
];

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function boundedLog(value, reference, cap) {
  const safe = clamp(Math.abs(Number(value) || 0), 0, cap);
  return safe ? Math.log1p(safe / reference) / Math.log1p(cap / reference) : 0;
}

function dateAgeDays(value, asOf) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  const end = new Date(asOf).getTime();
  if (!Number.isFinite(timestamp) || !Number.isFinite(end)) return null;
  return Math.max(0, (end - timestamp) / 86400000);
}

function findingAgeDays(finding, asOf) {
  const ages = DATE_FIELDS.map(field => dateAgeDays(finding?.[field], asOf)).filter(Number.isFinite);
  return ages.length ? Math.max(...ages) : null;
}

function normalizeObservation(issue, asOf = new Date()) {
  const providedFindings = Array.isArray(issue.findings) ? issue.findings : [];
  const findings = providedFindings.filter(item => !item.displayOnly);
  const normalizedFindingsAvailable = issue.normalizedFindingsAvailable || providedFindings.length > 0;
  const count = normalizedFindingsAvailable ? findings.length : Number(issue.count);
  const exposure = normalizedFindingsAvailable
    ? findings.reduce((sum, finding) =>
      sum + Math.abs(Number(finding.potential_value_gbp ?? finding.potentialValue ?? 0) || 0), 0)
    : Math.abs(Number(issue.exposure ?? issue.potential_value_gbp) || 0);
  const ages = normalizedFindingsAvailable
    ? findings.map(finding => findingAgeDays(finding, asOf)).filter(Number.isFinite)
    : [Number(issue.ageDays ?? issue.average_age_days)].filter(Number.isFinite);
  return {
    count,
    exposure,
    ageDays: ages.length ? ages.reduce((sum, age) => sum + age, 0) / ages.length : 0,
    source: normalizedFindingsAvailable ? 'active_findings' : 'check_aggregate',
  };
}

function scoreObservation(issue, profile = SCORE_PROFILE, asOf = new Date()) {
  const checkType = issue.check_type || issue.type;
  const hasFindings = Array.isArray(issue.findings) && issue.findings.some(item => !item.displayOnly);
  const excludedReason = issue.nonScored
    ? 'non_scored'
    : NON_SCORED_PERIODS.has(issue.period_checked)
      ? issue.period_checked
      : issue.count == null && !hasFindings
        ? 'unavailable'
        : null;
  const normalized = normalizeObservation(issue, asOf);
  if (excludedReason || !Number.isFinite(normalized.count) || normalized.count <= 0) {
    return { checkType, importance: issue.importance, deduction: 0, excludedReason: excludedReason || 'no_active_findings', ...normalized };
  }

  const transforms = {
    count: boundedLog(normalized.count, profile.transformReferences.count, profile.transformCaps.count),
    value: boundedLog(normalized.exposure, profile.transformReferences.value, profile.transformCaps.value),
    age: boundedLog(normalized.ageDays, profile.transformReferences.ageDays, profile.transformCaps.ageDays),
  };
  const weightedSignal = Object.entries(profile.componentWeights)
    .reduce((sum, [key, weight]) => sum + transforms[key] * weight, 0);
  const severityWeight = profile.severityWeights[issue.importance] || 0;
  const checkWeight = profile.checkWeights[checkType] || 1;
  const rawDeduction = Math.min(
    profile.maxCheckDeduction,
    profile.maxCheckDeduction * severityWeight * checkWeight * weightedSignal
  );
  return {
    checkType,
    importance: issue.importance,
    deduction: rawDeduction * profile.globalScale,
    rawDeduction,
    transforms,
    severityWeight,
    checkWeight,
    excludedReason: null,
    ...normalized,
  };
}

function calculateScoreBreakdown(issues, options = {}) {
  const profile = options.profile || SCORE_PROFILE;
  const nonScoredChecks = new Set(options.nonScoredChecks || []);
  const observations = issues.map(issue => scoreObservation({
    ...issue,
    nonScored: issue.nonScored || nonScoredChecks.has(issue.check_type || issue.type),
  }, profile, options.asOf || new Date()));
  const totalDeduction = observations.reduce((sum, item) => sum + item.deduction, 0);
  return {
    score: clamp(Math.round(100 - totalDeduction), 0, 100),
    totalDeduction: Math.min(100, totalDeduction),
    uncappedDeduction: totalDeduction,
    profileVersion: profile.version,
    profileStatus: profile.status,
    rationale: profile.rationale,
    observations,
  };
}

module.exports = {
  SCORE_PROFILE,
  boundedLog,
  calculateScoreBreakdown,
  findingAgeDays,
  normalizeObservation,
  scoreObservation,
};
