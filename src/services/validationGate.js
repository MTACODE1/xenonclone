const { CHECK_DEFINITIONS } = require('./checkRules');
const { SCORE_PROFILE } = require('./scoreProfile');

const PROFILE_TAGS = Object.freeze([
  'high_bank_volume', 'VAT_heavy', 'credit_note_heavy', 'clean',
]);
const MANUAL_CHECKS = new Set([
  // Require evidence from outside the Xero Accounting API.
  //
  // bank_balance: the Xero side IS available (Reports/BankSummary closing balance). What Xero
  //   cannot supply is the EXTERNAL bank statement balance, because that is a fact about the bank,
  //   not about the ledger. Needs a statement CSV or an accountant-entered closing balance.
  // unprocessed_bank: Xero documents that unreconciled bank statement data is deliberately not
  //   exposed by any public API, so the unprocessed pool is reconstructed from imported statements.
  // opening_balance_differences: the Xero side is automatic (Reports/BalanceSheet net assets) and
  //   the filed side is now read automatically from Companies House iXBRL accounts where the
  //   filing is machine-readable. It stays classified manual because that extraction is not
  //   guaranteed for every filing format (paper/image-only and untagged micro-entity accounts),
  //   in which case the accountant-entered figure is still the input.
  'bank_balance', 'unprocessed_bank', 'opening_balance_differences',
  // Require per-account thresholds the practice configures in Xenon settings; without that
  // configuration the check is not comparable to a Xenon export that already has them set.
  'capital_item_review', 'misallocated_items',
]);
const CHECK_SUPPORT = Object.freeze(Object.fromEntries(CHECK_DEFINITIONS.map(check => [
  check.type,
  MANUAL_CHECKS.has(check.type) ? 'manual' : 'api',
])));

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isMaterialValueDelta(xenonValue, delta) {
  return Math.abs(delta) > Math.max(10, Math.abs(xenonValue || 0) * 0.01);
}

// A mismatchNote means the practice already accepted the delta (dismissals, Xenon "!",
// settings, data drift). Those rows stay visible but must not fail the gate or dilute the
// exact-match ratio — the API cannot reproduce Xenon's hidden user-state.
function isExplained(check) {
  return !!String(check.mismatchNote || '').trim();
}

// A snapshot may only be compared against an app run that a real sync produced for the same
// period and that is at least as recent as the Xenon export. Anything else — a failed sync, a
// prior-day run, or period metadata edited outside the sync path — is not comparable evidence.
function runIsComparable(snapshot, activeRun) {
  if (!activeRun || activeRun.periodKey !== snapshot.periodKey) return false;
  if (activeRun.runStatus !== 'succeeded' || !activeRun.runCompletedAt) return false;
  return String(activeRun.runCompletedAt).slice(0, 10) >= String(snapshot.sourceDate || '');
}

function compareSnapshot(snapshot, activeRun) {
  const runMatches = runIsComparable(snapshot, activeRun);
  const appChecks = activeRun?.checks || {};
  const comparisons = CHECK_DEFINITIONS.map(definition => {
    const expected = snapshot.checks?.[definition.type] || {};
    const supportType = expected.supportType || CHECK_SUPPORT[definition.type];
    const xenonCount = numberOrNull(expected.count);
    const appCount = runMatches ? numberOrNull(appChecks[definition.type]?.count) : null;
    // Xenon published no figure for this check, so there is nothing to compare against and
    // nothing that may count as agreement.
    const xenonUnknown = xenonCount === null;
    const xenonValue = numberOrNull(expected.value);
    const appValue = runMatches ? (numberOrNull(appChecks[definition.type]?.value) || 0) : null;
    const countParity = !xenonUnknown && appCount !== null && xenonCount === appCount;
    const countDelta = appCount === null || xenonCount === null ? null : appCount - xenonCount;
    const valueComparable = appValue !== null && xenonValue !== null;
    const valueDelta = valueComparable ? appValue - xenonValue : null;
    const materialValueDelta = !valueComparable || isMaterialValueDelta(xenonValue, valueDelta);
    return {
      type: definition.type,
      label: definition.label,
      supportType,
      xenonCount,
      xenonUnknown,
      appCount,
      countParity,
      countDelta,
      xenonValue,
      appValue,
      valueDelta,
      materialValueDelta,
      mismatchNote: String(expected.mismatchNote || '').trim(),
    };
  });
  const xenonScore = numberOrNull(snapshot.xenonScore);
  const appScore = runMatches ? numberOrNull(activeRun.score) : null;
  const scoreDelta = appScore === null || xenonScore === null ? null : appScore - xenonScore;
  // A free-text reason must not be able to wave through an arbitrarily large score gap; the
  // reason is recorded for context, but only the numeric tolerance clears the criterion.
  const xenonIssues = numberOrNull(snapshot.xenonIssues);
  const appIssues = runMatches ? numberOrNull(activeRun.issues) : null;
  const xenonValue = numberOrNull(snapshot.xenonValue) || 0;
  const appValue = runMatches ? numberOrNull(activeRun.value) : null;
  const headlineValueDelta = appValue === null ? null : appValue - xenonValue;
  return {
    snapshotId: snapshot.id,
    orgId: snapshot.orgId,
    orgName: snapshot.orgName,
    periodKey: snapshot.periodKey,
    sourceDate: snapshot.sourceDate,
    profileTags: snapshot.profileTags || [],
    runMatches,
    xenonScore,
    appScore,
    scoreDelta,
    scoreAccepted: scoreDelta !== null && Math.abs(scoreDelta) <= 3,
    scoreReason: snapshot.scoreReason || '',
    xenonIssues,
    appIssues,
    issueDelta: appIssues === null || xenonIssues === null ? null : appIssues - xenonIssues,
    xenonValue,
    appValue,
    valueDelta: headlineValueDelta,
    materialValueDelta: headlineValueDelta === null ||
      isMaterialValueDelta(xenonValue, headlineValueDelta),
    notes: snapshot.notes || '',
    checks: comparisons,
  };
}

function criterion(key, passed, label, missing = []) {
  return { key, passed, label, missing };
}

function evaluateGate({
  snapshots = [], activeRuns = {}, assurances = {}, scoreProfile = SCORE_PROFILE,
} = {}) {
  const latestByClient = new Map();
  const eligible = snapshots.filter(item => item.countsTowardGate !== false).sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || Number(b.id || 0) - Number(a.id || 0)
  );
  for (const snapshot of eligible) {
    if (!latestByClient.has(snapshot.orgId)) latestByClient.set(snapshot.orgId, snapshot);
  }
  const counted = [...latestByClient.values()];
  const comparisons = counted.map(snapshot => compareSnapshot(
    snapshot, activeRuns[snapshot.orgId]
  ));
  const distinctClients = new Set(counted.map(snapshot => snapshot.orgId));
  const representedProfiles = new Set(counted.flatMap(snapshot => snapshot.profileTags || []));
  const missingProfiles = PROFILE_TAGS.filter(tag => !representedProfiles.has(tag));
  const supportComplete = Object.keys(CHECK_SUPPORT).length === 29 &&
    Object.values(CHECK_SUPPORT).every(value => value === 'api' || value === 'manual');
  const apiChecks = comparisons.flatMap(comparison =>
    comparison.checks.filter(check => check.supportType === 'api'));
  // Exclude from the exact-match ratio: Xenon "!" (no published figure) and any row with a
  // mismatchNote (dismissals / settings / confirmed drift). Those are invisible to the API by
  // design and must not fail the gate once documented.
  const comparableApiChecks = apiChecks.filter(check =>
    !check.xenonUnknown && !isExplained(check));
  const apiParityCount = comparableApiChecks.filter(check => check.countParity).length;
  const apiParity = comparableApiChecks.length ? apiParityCount / comparableApiChecks.length : 0;
  const unvalidatedChecks = comparisons.flatMap(comparison => comparison.checks
    .filter(check => check.supportType === 'api' && check.xenonUnknown)
    .map(check => `${comparison.orgName}: ${check.label}`));
  const unexplainedCounts = comparisons.flatMap(comparison => comparison.checks
    .filter(check => check.supportType === 'api' && !check.xenonUnknown &&
      !check.countParity && !isExplained(check))
    .map(check => `${comparison.orgName}: ${check.label}`));
  const unexplainedValues = comparisons.flatMap(comparison => comparison.checks
    .filter(check => !check.xenonUnknown && check.materialValueDelta && !isExplained(check))
    .map(check => `${comparison.orgName}: ${check.label}`))
    .concat(comparisons
      .filter(comparison => comparison.materialValueDelta && !String(comparison.notes).trim())
      .map(comparison => `${comparison.orgName}: headline value`));
  const scoreProfileCalibrated =
    scoreProfile.calibrationTargets >= scoreProfile.minCalibrationTargets;
  const scoreFailures = comparisons
    .filter(comparison => !comparison.scoreAccepted)
    .map(comparison => `${comparison.orgName}: score comparison missing or more than 3 points out`);
  const unmatchedRuns = comparisons
    .filter(comparison => !comparison.runMatches)
    .map(comparison => `${comparison.orgName}: no succeeded app run for ${comparison.periodKey} ` +
      `dated on or after the Xenon export (${comparison.sourceDate})`);

  const assuranceCriterion = (type, label) => {
    const evidence = assurances[type];
    const passed = evidence?.status === 'passed' &&
      !!String(evidence.notes || '').trim() && !!evidence.evidenceDate;
    return criterion(type, passed, label, passed ? [] : [`${label}: passed evidence and date required`]);
  };
  const criteria = [
    criterion(
      'representative_clients',
      distinctClients.size >= 5 && missingProfiles.length === 0,
      'At least five representative real clients',
      [
        ...(distinctClients.size < 5 ? [`${5 - distinctClients.size} more distinct real client(s)`] : []),
        ...missingProfiles.map(tag => `Representative profile not evidenced: ${tag}`),
      ]
    ),
    criterion(
      'check_coverage', supportComplete, 'All 29 checks documented as API-supported or manual',
      supportComplete ? [] : ['29-check support classification is incomplete']
    ),
    criterion(
      'api_count_parity',
      comparisons.length > 0 && unmatchedRuns.length === 0 && apiParity >= 0.98 &&
        unexplainedCounts.length === 0,
      'API-supported count parity is at least 98%, with every remainder explained',
      [...unmatchedRuns, ...(apiParity < 0.98 ? [`Current API count parity is ${(apiParity * 100).toFixed(1)}%`] : []),
        ...unexplainedCounts.map(item => `Unexplained count mismatch: ${item}`)]
    ),
    criterion(
      'material_values', comparisons.length > 0 && unexplainedValues.length === 0,
      'Every material value delta is explained',
      [
        ...(comparisons.length ? [] : ['No counted, period-matched value comparison evidence']),
        ...unexplainedValues.map(item => `Unexplained material value delta: ${item}`),
      ]
    ),
    criterion(
      'score_profile_calibrated', scoreProfileCalibrated,
      'Health score profile is calibrated on enough independent Xenon targets',
      scoreProfileCalibrated ? [] : [
        `Score profile ${scoreProfile.version} is ${scoreProfile.status}: fitted on ` +
        `${scoreProfile.calibrationTargets} of the ${scoreProfile.minCalibrationTargets} ` +
        'independent Xenon targets required before its output may be compared to Xenon',
      ]
    ),
    criterion(
      'score_delta', comparisons.length > 0 && scoreFailures.length === 0,
      'Score is within 3 points of Xenon',
      comparisons.length ? scoreFailures : ['No counted, period-matched score comparison evidence']
    ),
    assuranceCriterion('review_state_survival', 'Review-state survival test'),
    assuranceCriterion('no_data_loss_sync', 'No-data-loss sync test'),
    assuranceCriterion('workflow_readiness', 'Workflow readiness'),
  ];
  const passed = criteria.every(item => item.passed);
  return {
    passed,
    cancellationMessage: passed ? 'Validation gate passed; cancellation can be considered.' :
      'DO NOT CANCEL XENON',
    generatedAt: new Date().toISOString(),
    summary: {
      countedSnapshots: counted.length,
      distinctClients: distinctClients.size,
      representedProfiles: [...representedProfiles],
      apiParity,
      apiParityCount,
      apiComparisonCount: comparableApiChecks.length,
      unvalidatedCheckCount: unvalidatedChecks.length,
      scoreProfileVersion: scoreProfile.version,
      scoreProfileCalibrated,
    },
    criteria,
    comparisons,
    missingEvidence: criteria.flatMap(item => item.missing),
  };
}

module.exports = {
  CHECK_SUPPORT, PROFILE_TAGS, compareSnapshot, evaluateGate, isExplained, isMaterialValueDelta,
};
