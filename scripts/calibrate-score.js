#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { SCORE_PROFILE, calculateScoreBreakdown } = require('../src/services/scoreProfile');
const { NON_SCORED_CHECKS } = require('../src/services/checkRules');

function readFixture(filename) {
  const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!Array.isArray(parsed.clients)) throw new Error('Fixture must contain a clients array');
  return parsed;
}

function fitGlobalScale(clients, profile = SCORE_PROFILE) {
  const unitProfile = { ...profile, globalScale: 1 };
  const rows = clients.map(client => {
    const result = calculateScoreBreakdown(client.observations || [], {
      profile: unitProfile,
      nonScoredChecks: NON_SCORED_CHECKS,
      asOf: client.asOf,
    });
    return { rawDeduction: result.uncappedDeduction, targetDeduction: 100 - client.targetScore };
  }).filter(row => row.rawDeduction > 0 && Number.isFinite(row.targetDeduction));
  if (!rows.length) throw new Error('No client has both scored observations and a numeric targetScore');
  // One free parameter fitted to one target reproduces that target exactly, so a fit below the
  // required number of targets says nothing about the model and must not be produced at all.
  if (rows.length < profile.minCalibrationTargets) {
    throw new Error(
      `Fitting globalScale needs at least ${profile.minCalibrationTargets} independent Xenon ` +
      `targets; the fixture supplies ${rows.length}. A fit on ${rows.length} target(s) reports ` +
      'zero error by construction and cannot identify the model.'
    );
  }
  const numerator = rows.reduce((sum, row) => sum + row.rawDeduction * row.targetDeduction, 0);
  const denominator = rows.reduce((sum, row) => sum + row.rawDeduction ** 2, 0);
  return Math.max(0, numerator / denominator);
}

function evaluate(clients, profile) {
  return clients.map(client => {
    const result = calculateScoreBreakdown(client.observations || [], {
      profile,
      nonScoredChecks: NON_SCORED_CHECKS,
      asOf: client.asOf,
    });
    return {
      id: client.id,
      targetScore: client.targetScore,
      predictedScore: result.score,
      error: Number.isFinite(client.targetScore) ? result.score - client.targetScore : null,
      activeChecks: result.observations.filter(item => item.deduction > 0).length,
      profileVersion: result.profileVersion,
    };
  });
}

function main(argv = process.argv.slice(2)) {
  const fit = argv.includes('--fit-scale');
  const filenameArg = argv.find(argument => !argument.startsWith('--'));
  const filename = path.resolve(filenameArg || path.join(__dirname, '../test/fixtures/score-calibration.json'));
  const fixture = readFixture(filename);
  const scale = fit ? fitGlobalScale(fixture.clients) : SCORE_PROFILE.globalScale;
  const profile = { ...SCORE_PROFILE, globalScale: scale };
  const predictions = evaluate(fixture.clients, profile);
  const scored = predictions.filter(row => Number.isFinite(row.error));
  const identified = scored.length >= SCORE_PROFILE.minCalibrationTargets;
  console.log(JSON.stringify({
    fixture: path.relative(process.cwd(), filename),
    profileStatus: SCORE_PROFILE.status,
    limitation: fixture.provenance || SCORE_PROFILE.rationale,
    fittedParameter: fit ? { globalScale: scale } : null,
    profileGlobalScale: scale,
    targets: scored.length,
    minTargetsForCalibration: SCORE_PROFILE.minCalibrationTargets,
    predictions,
    // Withheld below the target threshold: an error figure from a saturated fit reads as
    // accuracy when it is only arithmetic.
    meanAbsoluteError: identified
      ? scored.reduce((sum, row) => sum + Math.abs(row.error), 0) / scored.length
      : null,
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { evaluate, fitGlobalScale, readFixture };
