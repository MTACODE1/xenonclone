const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const {
  createValidationSnapshot, getActiveValidationRuns, getAllOrganisations,
  getValidationGateAssurances, getValidationRunForPeriod, getValidationSnapshots,
  setValidationGateAssurance,
} = require('../db/queries');
const { CHECK_DEFINITIONS } = require('../services/checkRules');
const {
  CHECK_SUPPORT, PROFILE_TAGS, evaluateGate,
} = require('../services/validationGate');

const router = express.Router();
const evidenceDir = path.join(__dirname, '../../data/validation-evidence');
fs.mkdirSync(evidenceDir, { recursive: true });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 200 },
});

function csrfValid(req) {
  return req.session.csrfToken && req.body.csrf_token === req.session.csrfToken;
}

function limitedText(value, max = 2000) {
  return String(value || '').trim().slice(0, max);
}

function requiredNumber(value, label, { integer = false, min = 0 } = {}) {
  if (value === '' || value === null || value === undefined) throw new Error(`${label} is required`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${label} must be ${integer ? 'a whole' : 'a valid'} number of at least ${min}`);
  }
  return parsed;
}

// Xenon prints "N/A" or a bare "!" when it flags a check without publishing a figure. That is
// an absence of evidence, not a zero: storing it as 0 would let an app zero score as exact
// parity and pad the cancellation gate with rows Xenon never attested.
const UNKNOWN_MARKERS = new Set(['n/a', 'na', '!', '?', '-', '—', 'unknown', 'not published']);

function unknownOrNumber(value, label, options) {
  if (UNKNOWN_MARKERS.has(String(value ?? '').trim().toLowerCase())) return null;
  return requiredNumber(value, label, options);
}

function normalizeTags(value) {
  const input = Array.isArray(value) ? value : String(value || '').split(/[|,]/);
  const tags = [...new Set(input.map(tag => String(tag).trim()).filter(tag => PROFILE_TAGS.includes(tag)))];
  if (!tags.length) throw new Error('At least one representative profile tag is required');
  return tags;
}

function normalizeChecks(input) {
  const byType = new Map(
    (Array.isArray(input) ? input : Object.entries(input || {}).map(([type, row]) => ({ type, ...row })))
      .map(row => [limitedText(row.type || row.check_type, 80), row])
  );
  return CHECK_DEFINITIONS.map(definition => {
    const row = byType.get(definition.type);
    if (!row) throw new Error(`Missing check: ${definition.type}`);
    return {
      type: definition.type,
      count: unknownOrNumber(row.count ?? row.xenon_count, `${definition.label} count`, { integer: true }),
      value: unknownOrNumber(row.value ?? row.xenon_value_gbp, `${definition.label} value`),
      supportType: CHECK_SUPPORT[definition.type],
      mismatchNote: limitedText(row.mismatchNote ?? row.mismatch_note),
    };
  });
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted && character === '"' && text[index + 1] === '"') {
      value += '"';
      index++;
    } else if (character === '"') quoted = !quoted;
    else if (!quoted && character === ',') {
      row.push(value);
      value = '';
    } else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && text[index + 1] === '\n') index++;
      row.push(value);
      if (row.some(cell => cell.trim())) rows.push(row);
      row = [];
      value = '';
    } else value += character;
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field');
  row.push(value);
  if (row.some(cell => cell.trim())) rows.push(row);
  if (rows.length < 2) throw new Error('CSV must contain a header and 29 check rows');
  const headers = rows.shift().map(header => header.trim().toLowerCase());
  return rows.map(cells => Object.fromEntries(headers.map((header, index) => [header, cells[index] || ''])));
}

function normalizePayload(payload) {
  const xenon = payload.xenon || payload;
  return {
    periodKey: limitedText(payload.periodKey ?? payload.period_key, 160),
    xenonScore: requiredNumber(xenon.score ?? payload.xenon_score, 'Xenon score', { min: 0 }),
    xenonIssues: requiredNumber(xenon.issues ?? payload.xenon_issues, 'Xenon issues', { integer: true }),
    xenonValue: requiredNumber(xenon.value ?? payload.xenon_value_gbp, 'Xenon value'),
    sourceDate: limitedText(payload.sourceDate ?? payload.source_date, 10),
    notes: limitedText(payload.notes),
    scoreReason: limitedText(payload.scoreReason ?? payload.score_reason),
    profileTags: normalizeTags(payload.profileTags ?? payload.profile_tags),
    countsTowardGate: payload.countsTowardGate === true || payload.countsTowardGate === 1 ||
      payload.counts_toward_gate === '1' || payload.counts_toward_gate === 'true',
    checks: normalizeChecks(payload.checks),
  };
}

function validatePayload(payload) {
  if (!payload.periodKey) throw new Error('Period key is required and must match an active app run');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.sourceDate) ||
      Number.isNaN(new Date(`${payload.sourceDate}T00:00:00Z`).getTime())) {
    throw new Error('Source date must be YYYY-MM-DD');
  }
  if (payload.xenonScore > 100) throw new Error('Xenon score cannot exceed 100');
  return payload;
}

function gateState() {
  const snapshots = getValidationSnapshots();
  const assurances = getValidationGateAssurances();
  const activeRuns = getActiveValidationRuns();
  // Snapshots are newest-first. Bind each org to the run for its newest snapshot's period
  // only — walking older snapshots and overwriting wiped period matches whenever a client
  // had both an Aug-6 and an Aug-11 export (Rose/MBX re-ingest 11 Aug 2026).
  const boundOrgs = new Set();
  for (const snapshot of snapshots) {
    if (boundOrgs.has(snapshot.orgId)) continue;
    const matched = getValidationRunForPeriod(snapshot.orgId, snapshot.periodKey);
    if (matched) {
      activeRuns[snapshot.orgId] = matched;
      boundOrgs.add(snapshot.orgId);
    }
  }
  return { snapshots, assurances, gate: evaluateGate({ snapshots, assurances, activeRuns }) };
}

router.get('/', (req, res) => {
  const state = gateState();
  res.render('validation', {
    ...state,
    organisations: getAllOrganisations(),
    checkDefinitions: CHECK_DEFINITIONS,
    checkSupport: CHECK_SUPPORT,
    profileTags: PROFILE_TAGS,
    query: req.query,
  });
});

router.get('/guide', (req, res) => {
  res.sendFile(path.join(__dirname, '../../VALIDATION_GUIDE.md'));
});

router.get('/result.json', (req, res) => {
  const state = gateState();
  res.setHeader('Content-Disposition', 'attachment; filename="xenon-validation-gate.json"');
  res.json({
    ...state.gate,
    snapshots: state.snapshots.map(snapshot => ({
      ...snapshot,
      sourceFilename: snapshot.sourceFilename || null,
    })),
    assurances: state.assurances,
  });
});

router.post('/import', upload.single('validation_file'), (req, res) => {
  try {
    if (!csrfValid(req)) return res.status(403).send('Invalid CSRF token');
    if (!req.file) throw new Error('Choose a JSON or CSV file');
    const extension = path.extname(req.file.originalname).toLowerCase();
    if (!['.json', '.csv'].includes(extension)) throw new Error('Only .json and .csv files are accepted');
    const org = getAllOrganisations().find(item => String(item.id) === String(req.body.org_id));
    if (!org) throw new Error('Select a connected organisation');
    const text = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '');
    let raw;
    if (extension === '.json') raw = JSON.parse(text);
    else {
      const rows = parseCsv(text);
      const first = rows[0] || {};
      raw = {
        ...first,
        profile_tags: first.profile_tags,
        counts_toward_gate: first.counts_toward_gate,
        checks: rows,
      };
    }
    const payload = validatePayload(normalizePayload(raw));
    const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const storedName = `${hash}${extension}`;
    const storedPath = path.join(evidenceDir, storedName);
    if (!fs.existsSync(storedPath)) fs.writeFileSync(storedPath, req.file.buffer, { mode: 0o600 });
    createValidationSnapshot(org.id, {
      ...payload,
      sourceFilename: path.basename(req.file.originalname).slice(0, 255),
      sourceFileSha256: hash,
      evidencePath: storedName,
      evidenceKind: extension.slice(1),
    }, payload.checks);
    res.redirect('/validation?saved=1');
  } catch (error) {
    res.redirect(`/validation?error=${encodeURIComponent(error.message)}`);
  }
});

router.post('/manual', (req, res) => {
  try {
    if (!csrfValid(req)) return res.status(403).send('Invalid CSRF token');
    const org = getAllOrganisations().find(item => String(item.id) === String(req.body.org_id));
    if (!org) throw new Error('Select a connected organisation');
    const checks = CHECK_DEFINITIONS.map(definition => ({
      type: definition.type,
      count: req.body[`count_${definition.type}`],
      value: req.body[`value_${definition.type}`],
      mismatch_note: req.body[`note_${definition.type}`],
    }));
    const payload = validatePayload(normalizePayload({
      ...req.body,
      countsTowardGate: req.body.counts_toward_gate === '1',
      profileTags: req.body.profile_tags,
      checks,
    }));
    const canonical = JSON.stringify({ orgId: org.id, ...payload, recordedAt: new Date().toISOString() });
    const hash = crypto.createHash('sha256').update(canonical).digest('hex');
    const storedName = `${hash}.json`;
    fs.writeFileSync(path.join(evidenceDir, storedName), canonical, { mode: 0o600, flag: 'wx' });
    createValidationSnapshot(org.id, {
      ...payload,
      sourceFilename: 'manual-entry.json',
      sourceFileSha256: hash,
      evidencePath: storedName,
      evidenceKind: req.body.counts_toward_gate === '1' ? 'manual' : 'draft',
    }, payload.checks);
    res.redirect('/validation?saved=1');
  } catch (error) {
    res.redirect(`/validation?error=${encodeURIComponent(error.message)}`);
  }
});

router.post('/assurance', (req, res) => {
  if (!csrfValid(req)) return res.status(403).send('Invalid CSRF token');
  const allowedTypes = ['review_state_survival', 'no_data_loss_sync', 'workflow_readiness'];
  const allowedStatuses = ['not_tested', 'failed', 'passed'];
  if (!allowedTypes.includes(req.body.assurance_type) || !allowedStatuses.includes(req.body.status)) {
    return res.status(400).send('Invalid assurance update');
  }
  setValidationGateAssurance(
    req.body.assurance_type, req.body.status,
    limitedText(req.body.evidence_date, 10), limitedText(req.body.notes)
  );
  res.redirect('/validation?saved=1');
});

module.exports = router;
