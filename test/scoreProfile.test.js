const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/score-calibration.json');
const { NON_SCORED_CHECKS } = require('../src/services/checkRules');
const {
  SCORE_PROFILE, calculateScoreBreakdown, scoreObservation,
} = require('../src/services/scoreProfile');
const { fitGlobalScale } = require('../scripts/calibrate-score');

const issue = overrides => ({
  check_type: 'purchase_tax_missing',
  importance: 'medium',
  count: 1,
  potential_value_gbp: 100,
  period_checked: 'since_lock_date',
  ...overrides,
});

test('count, absolute value, age and severity effects are monotonic', () => {
  assert.ok(scoreObservation(issue({ count: 20 })).deduction > scoreObservation(issue({ count: 2 })).deduction);
  assert.ok(scoreObservation(issue({ potential_value_gbp: -10000 })).deduction >
    scoreObservation(issue({ potential_value_gbp: 100 })).deduction);
  const recent = scoreObservation(issue({
    findings: [{ date: '2026-07-01', potential_value_gbp: 100 }],
  }), SCORE_PROFILE, new Date('2026-08-01'));
  const old = scoreObservation(issue({
    findings: [{ date: '2025-07-01', potential_value_gbp: 100 }],
  }), SCORE_PROFILE, new Date('2026-08-01'));
  assert.ok(old.deduction > recent.deduction);
  assert.ok(scoreObservation(issue({ importance: 'critical' })).deduction >
    scoreObservation(issue({ importance: 'high' })).deduction);
});

test('bounded transforms and per-check cap stabilize extreme clients', () => {
  const capped = scoreObservation(issue({ count: 1e9, potential_value_gbp: 1e15, average_age_days: 1e8 }));
  const farther = scoreObservation(issue({ count: 1e12, potential_value_gbp: 1e18, average_age_days: 1e10 }));
  assert.equal(capped.deduction, farther.deduction);
  assert.ok(capped.rawDeduction <= SCORE_PROFILE.maxCheckDeduction);
});

test('unavailable, unconfigured, not_applicable, non-scored and display-only observations deduct zero', () => {
  // 'not_vat_registered' (the not_applicable category) is included alongside the pre-existing four
  // — a check with nothing applicable to find must not be penalised, same as one with no evidence
  // configured yet.
  for (const period_checked of ['out_of_scope', 'unavailable', 'not_configured', 'needs_sync', 'not_vat_registered']) {
    assert.equal(scoreObservation(issue({ period_checked, count: 100, potential_value_gbp: 1e9 })).deduction, 0);
  }
  const breakdown = calculateScoreBreakdown([
    issue({ check_type: 'undocumented_bills', count: 100 }),
    issue({ findings: [{ displayOnly: true, date: '2020-01-01', potential_value_gbp: 100000 }] }),
  ], { nonScoredChecks: NON_SCORED_CHECKS });
  assert.equal(breakdown.score, 100);
});

// Confirmed bug this fixes: a non-VAT-registered client's sales_tax_missing/purchase_tax_missing
// checks must contribute neither a penalty NOR a false "clean check" reward — this scoring model
// has no reward mechanic at all (score = 100 minus deductions from active issues), so a genuinely
// clean check and a not-applicable check both already deduct zero; what must additionally hold is
// that the two are distinguishable by *reason*, not silently conflated into the same generic
// "nothing to score" bucket, so a future consumer of scoreObservation's output can tell them apart.
test('a not-applicable VAT check and a genuinely clean VAT check both deduct zero, but for different, distinguishable reasons', () => {
  const notApplicable = scoreObservation(issue({
    check_type: 'sales_tax_missing', period_checked: 'not_vat_registered', count: 0,
  }));
  const genuinelyClean = scoreObservation(issue({
    check_type: 'sales_tax_missing', period_checked: 'since_lock_date:2025-10-31:2026-09-07', count: 0,
  }));
  assert.equal(notApplicable.deduction, 0);
  assert.equal(genuinelyClean.deduction, 0);
  assert.equal(notApplicable.excludedReason, 'not_vat_registered');
  assert.notEqual(notApplicable.excludedReason, genuinelyClean.excludedReason);
});

test('a VAT-registered client with real findings still scores normally — the fix only suppresses the not_vat_registered label itself', () => {
  const withFindings = scoreObservation(issue({
    check_type: 'purchase_tax_missing', period_checked: 'since_lock_date:2025-10-31:2026-09-07',
    count: 50, potential_value_gbp: 5000, importance: 'medium',
  }));
  assert.ok(withFindings.deduction > 0);
  assert.equal(withFindings.excludedReason, null);
});

test('normalized active findings override stale aggregate count and exposure', () => {
  const result = scoreObservation(issue({
    count: 999,
    potential_value_gbp: 999999,
    findings: [{ date: '2026-01-01', potential_value_gbp: -25 }],
  }), SCORE_PROFILE, new Date('2026-02-01'));
  assert.equal(result.count, 1);
  assert.equal(result.exposure, 25);
  assert.equal(result.source, 'active_findings');
});

test('health score is always bounded from zero to one hundred', () => {
  assert.equal(calculateScoreBreakdown([]).score, 100);
  const severe = Array.from({ length: 29 }, (_, index) => issue({
    check_type: `severe_${index}`,
    importance: 'critical',
    count: 1e9,
    potential_value_gbp: 1e15,
    average_age_days: 1e8,
  }));
  assert.equal(calculateScoreBreakdown(severe).score, 0);
});

test('the shipped scale is the fit against every target in the fixture, and stays honest about error', () => {
  assert.ok(SCORE_PROFILE.calibrationTargets >= SCORE_PROFILE.minCalibrationTargets);
  assert.equal(SCORE_PROFILE.calibrationTargets, fixture.clients.length);
  assert.ok(Math.abs(fitGlobalScale(fixture.clients) - SCORE_PROFILE.globalScale) < 1e-9);
  // The rationale must keep naming the clients the single scale parameter cannot reach, so a
  // calibrated status is never read as Xenon equivalence.
  assert.match(SCORE_PROFILE.rationale, /within 3 points, but two do not/);
  assert.equal(fixture.clients.some(client => /fast track/i.test(client.id)), false);
});

test('no client is scored more than 12 points from its Xenon target', () => {
  for (const client of fixture.clients) {
    const result = calculateScoreBreakdown(client.observations, {
      nonScoredChecks: NON_SCORED_CHECKS, asOf: client.asOf,
    });
    assert.ok(Math.abs(result.score - client.targetScore) <= 12,
      `${client.id}: scored ${result.score} against Xenon ${client.targetScore}`);
  }
});

test('fitting the scale is refused below the required number of independent targets', () => {
  assert.throws(() => fitGlobalScale(fixture.clients.slice(0, 2)),
    /at least 3 independent Xenon targets/);
  const scale = fitGlobalScale(fixture.clients);
  assert.ok(Number.isFinite(scale) && scale > 0);
});
