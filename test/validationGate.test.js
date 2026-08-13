const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHECK_SUPPORT, PROFILE_TAGS, evaluateGate, isMaterialValueDelta,
} = require('../src/services/validationGate');
const { SCORE_PROFILE } = require('../src/services/scoreProfile');

const checkTypes = Object.keys(CHECK_SUPPORT);
const calibratedProfile = { ...SCORE_PROFILE, calibrationTargets: 5, status: 'calibrated' };

function snapshot(orgId, profileTag) {
  return {
    id: orgId,
    orgId,
    orgName: `Real Client ${orgId}`,
    periodKey: 'current_fy:2026-04-01:2027-03-31',
    sourceDate: '2026-08-07',
    xenonScore: 80,
    xenonIssues: 29,
    xenonValue: 2900,
    notes: '',
    scoreReason: '',
    profileTags: [profileTag],
    countsTowardGate: true,
    checks: Object.fromEntries(checkTypes.map(type => [type, {
      count: 1,
      value: 100,
      supportType: CHECK_SUPPORT[type],
      mismatchNote: '',
    }])),
  };
}

function activeRun() {
  return {
    periodKey: 'current_fy:2026-04-01:2027-03-31',
    score: 83,
    issues: 29,
    value: 2900,
    runStatus: 'succeeded',
    runCompletedAt: '2026-08-07 09:15:00',
    checks: Object.fromEntries(checkTypes.map(type => [type, { count: 1, value: 100 }])),
  };
}

function passedAssurances() {
  return Object.fromEntries([
    'review_state_survival', 'no_data_loss_sync', 'workflow_readiness',
  ].map(type => [type, {
    status: 'passed',
    evidenceDate: '2026-08-07',
    notes: `Recorded ${type} test evidence`,
  }]));
}

test('passing boundary accepts five real clients, all profiles, and a three-point score delta', () => {
  const snapshots = Array.from({ length: 5 }, (_, index) =>
    snapshot(index + 1, PROFILE_TAGS[index % PROFILE_TAGS.length]));
  const activeRuns = Object.fromEntries(snapshots.map(item => [item.orgId, activeRun()]));
  const gate = evaluateGate({
    snapshots, activeRuns, assurances: passedAssurances(), scoreProfile: calibratedProfile,
  });

  assert.equal(checkTypes.length, 29);
  assert.equal(gate.passed, true);
  assert.equal(gate.summary.distinctClients, 5);
  assert.equal(gate.summary.apiParity, 1);
  assert.equal(gate.missingEvidence.length, 0);
});

test('failing dataset reports exact missing evidence and never authorizes cancellation', () => {
  const snapshots = [
    snapshot(1, 'VAT_heavy'),
    snapshot(2, 'high_bank_volume'),
  ];
  const activeRuns = { 1: activeRun(), 2: activeRun() };
  activeRuns[1].checks.duplicate_invoices.count = 2;
  activeRuns[1].checks.duplicate_bills.count = 2;
  snapshots[0].checks.duplicate_invoices.mismatchNote = 'Known snapshot timing difference';
  const gate = evaluateGate({
    snapshots,
    activeRuns,
    assurances: {
      review_state_survival: {
        status: 'passed', evidenceDate: '2026-08-07', notes: 'Verified',
      },
    },
  });

  assert.equal(gate.passed, false);
  assert.equal(gate.cancellationMessage, 'DO NOT CANCEL XENON');
  assert.ok(gate.missingEvidence.includes('3 more distinct real client(s)'));
  assert.ok(gate.missingEvidence.includes('Representative profile not evidenced: credit_note_heavy'));
  assert.ok(gate.missingEvidence.some(item => item.includes('Unexplained count mismatch: Real Client 1: Duplicate Bills')));
  assert.ok(gate.missingEvidence.some(item => item.includes('No-data-loss sync test')));
});

test('draft snapshots never count and material value threshold is explicit', () => {
  const draft = snapshot(1, 'clean');
  draft.countsTowardGate = false;
  const gate = evaluateGate({
    snapshots: [draft],
    activeRuns: { 1: activeRun() },
    assurances: passedAssurances(),
  });

  assert.equal(gate.summary.countedSnapshots, 0);
  assert.equal(gate.summary.distinctClients, 0);
  assert.equal(gate.passed, false);
  assert.equal(isMaterialValueDelta(1000, 10), false);
  assert.equal(isMaterialValueDelta(1000, 10.01), true);
});

test('a check Xenon never published leaves the parity ratio and does not block the gate', () => {
  const snapshots = Array.from({ length: 5 }, (_, index) =>
    snapshot(index + 1, PROFILE_TAGS[index % PROFILE_TAGS.length]));
  // Xenon printed "!" rather than a number, so this row carries no count or value at all.
  snapshots[0].checks.contact_defaults.count = null;
  snapshots[0].checks.contact_defaults.value = null;
  const activeRuns = Object.fromEntries(snapshots.map(item => [item.orgId, activeRun()]));
  const gate = evaluateGate({
    snapshots, activeRuns, assurances: passedAssurances(), scoreProfile: calibratedProfile,
  });

  const comparison = gate.comparisons.find(item => item.orgId === 1)
    .checks.find(item => item.type === 'contact_defaults');
  assert.equal(comparison.xenonUnknown, true);
  assert.equal(comparison.countParity, false);
  assert.equal(gate.summary.apiComparisonCount, gate.summary.apiParityCount);
  assert.equal(gate.summary.apiParity, 1);
  assert.equal(gate.summary.unvalidatedCheckCount, 1);
  assert.equal(gate.passed, true);
  assert.ok(!gate.missingEvidence.some(item =>
    item.startsWith('Xenon published no figure to validate against:')));
});

test('an app zero never counts as agreement with an unpublished Xenon figure', () => {
  const single = snapshot(1, 'clean');
  single.checks.contact_defaults.count = null;
  single.checks.contact_defaults.value = null;
  const run = activeRun();
  run.checks.contact_defaults = { count: 0, value: 0 };
  const gate = evaluateGate({
    snapshots: [single], activeRuns: { 1: run }, assurances: passedAssurances(),
    scoreProfile: calibratedProfile,
  });

  const comparison = gate.comparisons[0].checks.find(item => item.type === 'contact_defaults');
  assert.equal(comparison.countParity, false);
  assert.equal(comparison.materialValueDelta, true);
  // Still fails for missing clients/profiles — but not because of the unpublished figure.
  assert.equal(gate.passed, false);
  assert.ok(!gate.missingEvidence.some(item =>
    item.startsWith('Xenon published no figure to validate against:')));
});

test('a documented mismatch is excluded from the parity ratio and does not fail the gate', () => {
  const snapshots = Array.from({ length: 5 }, (_, index) =>
    snapshot(index + 1, PROFILE_TAGS[index % PROFILE_TAGS.length]));
  snapshots[0].checks.purchase_tax_missing.mismatchNote =
    'Xenon dismissals / Ignore contact — invisible to API';
  const activeRuns = Object.fromEntries(snapshots.map(item => [item.orgId, activeRun()]));
  activeRuns[1].checks.purchase_tax_missing.count = 99;
  const gate = evaluateGate({
    snapshots, activeRuns, assurances: passedAssurances(), scoreProfile: calibratedProfile,
  });

  assert.equal(gate.summary.apiParity, 1);
  assert.equal(gate.passed, true);
  assert.ok(!gate.missingEvidence.some(item => item.includes('Purchase Tax Missing')));
});

test('a failed or stale sync run is not comparable evidence', () => {
  const single = snapshot(1, 'clean');
  for (const [label, mutate] of [
    ['failed run', run => { run.runStatus = 'failed'; }],
    ['run predating the Xenon export', run => { run.runCompletedAt = '2026-08-06 22:00:00'; }],
    ['run with no recorded sync', run => { run.runStatus = null; run.runCompletedAt = null; }],
  ]) {
    const run = activeRun();
    mutate(run);
    const gate = evaluateGate({
      snapshots: [single], activeRuns: { 1: run }, assurances: passedAssurances(),
      scoreProfile: calibratedProfile,
    });
    assert.equal(gate.comparisons[0].runMatches, false, label);
    assert.equal(gate.comparisons[0].appScore, null, label);
    assert.ok(gate.missingEvidence.some(item => item.includes('no succeeded app run')), label);
  }
});

test('a free-text reason cannot wave through a score gap, and an uncalibrated profile blocks', () => {
  const snapshots = Array.from({ length: 5 }, (_, index) =>
    snapshot(index + 1, PROFILE_TAGS[index % PROFILE_TAGS.length]));
  snapshots[0].scoreReason = 'Xenon weights unknown; accepted by the practice';
  const activeRuns = Object.fromEntries(snapshots.map(item => [item.orgId, activeRun()]));
  activeRuns[1].score = 20;
  const excused = evaluateGate({
    snapshots, activeRuns, assurances: passedAssurances(), scoreProfile: calibratedProfile,
  });
  assert.equal(excused.passed, false);
  assert.ok(excused.missingEvidence.some(item => item.includes('more than 3 points out')));

  // A profile fitted below the required number of targets can never satisfy the gate, whatever
  // its status field claims.
  const underfitted = evaluateGate({
    snapshots,
    activeRuns: Object.fromEntries(snapshots.map(item => [item.orgId, activeRun()])),
    assurances: passedAssurances(),
    scoreProfile: { ...SCORE_PROFILE, calibrationTargets: 1, status: 'calibrated' },
  });
  assert.equal(underfitted.summary.scoreProfileCalibrated, false);
  assert.equal(underfitted.passed, false);
  assert.ok(underfitted.missingEvidence.some(item => item.includes('independent Xenon targets')));
});
