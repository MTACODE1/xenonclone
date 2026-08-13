const { getDb } = require('./schema');
const {
  NON_SCORED_CHECKS, addFindingKeys, allocateFindingValues, isReviewStateActive,
} = require('../services/checkRules');
const { calculateScoreBreakdown } = require('../services/scoreProfile');

function cacheDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// Organisations
function upsertOrganisation(data) {
  const db = getDb();
  return db.prepare(`
    INSERT INTO organisations (xero_tenant_id, name, client_ref, tag, connection_status, last_synced_at)
    VALUES (@xero_tenant_id, @name, @client_ref, @tag, @connection_status, @last_synced_at)
    ON CONFLICT(xero_tenant_id) DO UPDATE SET
      name = excluded.name,
      connection_status = excluded.connection_status,
      last_synced_at = COALESCE(excluded.last_synced_at, organisations.last_synced_at)
  `).run(data);
}

function getAllOrganisations() {
  const db = getDb();
  return db.prepare(`
    SELECT o.*, hs.score, hs.total_issues, hs.total_potential_errors_gbp,
           hs.last_bank_reconciled, hs.most_recent_transaction,
           hs.unreconciled_bank_items, hs.lock_date, hs.score_profile_version,
           hs.score_breakdown_json, hs.calculated_at, hs.period_key, hs.period_type,
           hs.period_start, hs.period_end, hs.period_label,
           (SELECT MAX(completed_at) FROM sync_runs
            WHERE org_id = o.id AND status = 'succeeded') AS last_successful_sync_at
    FROM organisations o
    LEFT JOIN health_scores hs ON hs.org_id = o.id
      AND hs.id = (SELECT MAX(id) FROM health_scores WHERE org_id = o.id AND is_active = 1)
    ORDER BY o.name
  `).all();
}

function getOrganisationByTenantId(tenantId) {
  const db = getDb();
  return db.prepare(`
    SELECT o.*, hs.score, hs.total_issues, hs.total_potential_errors_gbp,
           hs.last_bank_reconciled, hs.most_recent_transaction,
           hs.unreconciled_bank_items, hs.lock_date, hs.score_profile_version,
           hs.score_breakdown_json, hs.calculated_at, hs.period_key, hs.period_type,
           hs.period_start, hs.period_end, hs.period_label,
           (SELECT MAX(completed_at) FROM sync_runs
            WHERE org_id = o.id AND status = 'succeeded') AS last_successful_sync_at
    FROM organisations o
    LEFT JOIN health_scores hs ON hs.org_id = o.id
      AND hs.id = (SELECT MAX(id) FROM health_scores WHERE org_id = o.id AND is_active = 1)
    WHERE o.xero_tenant_id = ?
  `).get(tenantId);
}

function updateOrganisationMeta(tenantId, { client_ref, tag }) {
  const db = getDb();
  db.prepare(`UPDATE organisations SET client_ref = ?, tag = ? WHERE xero_tenant_id = ?`)
    .run(client_ref, tag, tenantId);
}

function updateOrganisationAccountingSettings(orgId, data) {
  getDb().prepare(`
    UPDATE organisations SET financial_year_end_day = ?, financial_year_end_month = ? WHERE id = ?
  `).run(data.financialYearEndDay || null, data.financialYearEndMonth || null, orgId);
}

function markOrganisationDisconnected(tenantId) {
  const db = getDb();
  db.prepare(`UPDATE organisations SET connection_status = 'disconnected' WHERE xero_tenant_id = ?`).run(tenantId);
}

// Health Scores
function upsertHealthScore(orgId, data) {
  const db = getDb();
  return db.prepare(`
    INSERT INTO health_scores (org_id, score, total_issues, total_potential_errors_gbp,
      last_bank_reconciled, most_recent_transaction, unreconciled_bank_items, lock_date,
      period_key, period_type, period_start, period_end, period_label,
      score_profile_version, score_breakdown_json, run_id, is_active)
    VALUES (@org_id, @score, @total_issues, @total_potential_errors_gbp,
      @last_bank_reconciled, @most_recent_transaction, @unreconciled_bank_items, @lock_date,
      @period_key, @period_type, @period_start, @period_end, @period_label,
      @score_profile_version, @score_breakdown_json, @run_id, @is_active)
  `).run({
    period_key: null,
    period_type: null,
    period_start: null,
    period_end: null,
    period_label: null,
    score_profile_version: null,
    score_breakdown_json: null,
    run_id: null,
    is_active: 1,
    org_id: orgId,
    ...data,
  });
}

// Issues
function deleteIssuesForOrg(orgId) {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM issue_findings WHERE org_id = ?`).run(orgId);
    db.prepare(`DELETE FROM issues WHERE org_id = ?`).run(orgId);
  })();
}

function insertIssue(data) {
  const db = getDb();
  let details = [];
  try {
    const parsed = JSON.parse(data.detail_json || '[]');
    if (Array.isArray(parsed)) details = addFindingKeys(data.check_type, parsed);
  } catch (error) {
    details = [];
  }
  return db.transaction(() => {
    const reviews = db.prepare(`
      SELECT * FROM finding_review_states WHERE org_id = ? AND check_type = ?
    `).all(data.org_id, data.check_type);
    const reviewByKey = new Map(reviews.map(review => [review.finding_key, review]));
    const values = allocateFindingValues(details, data.potential_value_gbp);
    const activeDetails = details.filter(detail =>
      !detail.displayOnly && !isReviewStateActive(reviewByKey.get(detail.finding_key), data.period_checked)
    );
    const filteredData = details.length ? {
      ...data,
      count: data.count == null ? null : activeDetails.length,
      potential_value_gbp: details.reduce((sum, detail, index) =>
        sum + (!detail.displayOnly && !isReviewStateActive(reviewByKey.get(detail.finding_key), data.period_checked)
          ? values[index] : 0), 0),
    } : data;
    const result = db.prepare(`
      INSERT INTO issues (org_id, check_type, importance, count, potential_value_gbp, detail_json,
        period_checked, run_id, is_active)
      VALUES (@org_id, @check_type, @importance, @count, @potential_value_gbp, @detail_json,
        @period_checked, @run_id, @is_active)
    `).run({
      run_id: null, is_active: 1, ...filteredData,
      detail_json: details.length ? null : (data.detail_json || '[]'),
    });
    const insertFinding = db.prepare(`
      INSERT OR IGNORE INTO issue_findings
        (issue_id, org_id, check_type, finding_key, detail_json, display_only,
         potential_value_gbp, run_id, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [index, detail] of details.entries()) {
      insertFinding.run(
        result.lastInsertRowid, data.org_id, data.check_type, detail.finding_key,
        JSON.stringify(detail), detail.displayOnly ? 1 : 0, values[index],
        data.run_id || null, data.is_active == null ? 1 : data.is_active
      );
    }
    return result;
  })();
}

function replaceIssueForCheck(data) {
  const db = getDb();
  db.transaction(() => {
    const active = data.is_active == null ? 1 : data.is_active;
    const ids = db.prepare(`
      SELECT id FROM issues WHERE org_id = ? AND check_type = ? AND is_active = ?
        AND (? IS NULL OR run_id = ?)
    `).all(data.org_id, data.check_type, active, data.run_id || null, data.run_id || null).map(row => row.id);
    for (const id of ids) db.prepare(`DELETE FROM issue_findings WHERE issue_id = ?`).run(id);
    db.prepare(`
      DELETE FROM issues WHERE org_id = ? AND check_type = ? AND is_active = ?
        AND (? IS NULL OR run_id = ?)
    `).run(data.org_id, data.check_type, active, data.run_id || null, data.run_id || null);
    insertIssue(data);
  })();
}

function refreshLatestHealthScore(orgId) {
  const db = getDb();
  const issues = getIssuesForOrg(orgId);
  const scored = issues.filter(row => !NON_SCORED_CHECKS.includes(row.check_type));
  const breakdown = calculateScoreBreakdown(getScoringObservations(orgId), {
    nonScoredChecks: NON_SCORED_CHECKS,
  });
  db.prepare(`
    UPDATE health_scores SET score = ?, total_issues = ?, total_potential_errors_gbp = ?,
      score_profile_version = ?, score_breakdown_json = ?
    WHERE id = (SELECT MAX(id) FROM health_scores WHERE org_id = ? AND is_active = 1)
  `).run(
    breakdown.score,
    scored.reduce((sum, row) => sum + (row.count || 0), 0),
    scored.reduce((sum, row) => sum + (row.potential_value_gbp || 0), 0),
    breakdown.profileVersion,
    JSON.stringify(breakdown),
    orgId
  );
}

function refreshIssueAggregations(orgId, issueId = null) {
  const db = getDb();
  db.prepare(`
    UPDATE issues SET
      count = CASE WHEN count IS NULL THEN NULL ELSE (
        SELECT COUNT(*) FROM issue_findings f
        LEFT JOIN finding_review_states r
          ON r.org_id = f.org_id AND r.check_type = f.check_type AND r.finding_key = f.finding_key
        WHERE f.issue_id = issues.id AND f.display_only = 0
          AND NOT COALESCE((
            r.state = 'dismissed'
            OR (r.state = 'ignored' AND datetime(r.ignored_until) > datetime('now'))
            OR (r.state = 'ok' AND r.period_key = issues.period_checked)
          ), 0)
      ) END,
      potential_value_gbp = CASE WHEN count IS NULL THEN potential_value_gbp ELSE (
        SELECT COALESCE(SUM(f.potential_value_gbp), 0) FROM issue_findings f
        LEFT JOIN finding_review_states r
          ON r.org_id = f.org_id AND r.check_type = f.check_type AND r.finding_key = f.finding_key
        WHERE f.issue_id = issues.id AND f.display_only = 0
          AND NOT COALESCE((
            r.state = 'dismissed'
            OR (r.state = 'ignored' AND datetime(r.ignored_until) > datetime('now'))
            OR (r.state = 'ok' AND r.period_key = issues.period_checked)
          ), 0)
      ) END
    WHERE org_id = ? AND is_active = 1 AND (? IS NULL OR id = ?)
  `).run(orgId, issueId, issueId);
}

function getIssuesForOrg(orgId) {
  const db = getDb();
  refreshIssueAggregations(orgId);
  return db.prepare(`SELECT * FROM issues WHERE org_id = ? AND is_active = 1 ORDER BY
    CASE importance WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END,
    count DESC`).all(orgId);
}

function getScoringObservations(orgId) {
  const db = getDb();
  refreshIssueAggregations(orgId);
  const issues = db.prepare(`SELECT * FROM issues WHERE org_id = ? AND is_active = 1`).all(orgId);
  const findings = db.prepare(`
    SELECT f.check_type, f.detail_json, f.potential_value_gbp, f.display_only,
      COALESCE((
        r.state = 'dismissed'
        OR (r.state = 'ignored' AND datetime(r.ignored_until) > datetime('now'))
        OR (r.state = 'ok' AND r.period_key = i.period_checked)
      ), 0) AS reviewed
    FROM issue_findings f
    JOIN issues i ON i.id = f.issue_id
    LEFT JOIN finding_review_states r
      ON r.org_id = f.org_id AND r.check_type = f.check_type AND r.finding_key = f.finding_key
    WHERE f.org_id = ? AND f.is_active = 1 AND i.is_active = 1
  `).all(orgId);
  const byCheck = new Map();
  const normalizedChecks = new Set();
  for (const finding of findings) {
    normalizedChecks.add(finding.check_type);
    if (finding.display_only || finding.reviewed) continue;
    let detail = {};
    try {
      detail = JSON.parse(finding.detail_json);
    } catch (error) {
      detail = {};
    }
    const rows = byCheck.get(finding.check_type) || [];
    rows.push({ ...detail, potential_value_gbp: Math.abs(Number(finding.potential_value_gbp) || 0) });
    byCheck.set(finding.check_type, rows);
  }
  return issues.map(issue => ({
    ...issue,
    findings: byCheck.get(issue.check_type) || [],
    normalizedFindingsAvailable: normalizedChecks.has(issue.check_type),
  }));
}

function getIssuesForRun(orgId, runId, checkType = null) {
  const db = getDb();
  const staged = db.prepare(`
    SELECT * FROM issues WHERE org_id = ? AND run_id = ? AND is_active = 0
  `).all(orgId, runId);
  if (!checkType) return staged;
  return [
    ...db.prepare(`
      SELECT * FROM issues WHERE org_id = ? AND is_active = 1 AND check_type <> ?
    `).all(orgId, checkType),
    ...staged,
  ];
}

function getScoringObservationsForRun(orgId, runId, checkType = null) {
  const db = getDb();
  const issues = getIssuesForRun(orgId, runId, checkType);
  const findings = db.prepare(`
    SELECT f.check_type, f.detail_json, f.potential_value_gbp, f.display_only,
      COALESCE((
        r.state = 'dismissed'
        OR (r.state = 'ignored' AND datetime(r.ignored_until) > datetime('now'))
        OR (r.state = 'ok' AND r.period_key = i.period_checked)
      ), 0) AS reviewed
    FROM issue_findings f
    JOIN issues i ON i.id = f.issue_id
    LEFT JOIN finding_review_states r
      ON r.org_id = f.org_id AND r.check_type = f.check_type AND r.finding_key = f.finding_key
    WHERE f.org_id = ? AND (
      (f.run_id = ? AND f.is_active = 0)
      OR (? IS NOT NULL AND f.is_active = 1 AND f.check_type <> ?)
    )
  `).all(orgId, runId, checkType, checkType);
  const byCheck = new Map();
  const normalized = new Set();
  for (const finding of findings) {
    normalized.add(finding.check_type);
    if (finding.display_only || finding.reviewed) continue;
    let detail = {};
    try { detail = JSON.parse(finding.detail_json); } catch (error) { detail = {}; }
    const rows = byCheck.get(finding.check_type) || [];
    rows.push({ ...detail, potential_value_gbp: Math.abs(Number(finding.potential_value_gbp) || 0) });
    byCheck.set(finding.check_type, rows);
  }
  return issues.map(issue => ({
    ...issue,
    findings: byCheck.get(issue.check_type) || [],
    normalizedFindingsAvailable: normalized.has(issue.check_type),
  }));
}

function createSyncRun(orgId, mode, periodKey = null) {
  return Number(getDb().prepare(`
    INSERT INTO sync_runs (org_id, mode, status, period_key) VALUES (?, ?, 'running', ?)
  `).run(orgId, mode, periodKey).lastInsertRowid);
}

function finishSyncRun(runId, status, error = null) {
  getDb().prepare(`
    UPDATE sync_runs SET status = ?, error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(status, error, runId);
}

function activateSyncRun(orgId, runId, checkType = null) {
  const db = getDb();
  db.transaction(() => {
    if (!db.prepare(`
      SELECT 1 FROM health_scores WHERE org_id = ? AND run_id = ? AND is_active = 0
    `).get(orgId, runId)) {
      throw new Error('Cannot activate a run without a staged health score');
    }
    if (!checkType && !db.prepare(`
      SELECT 1 FROM transaction_counts WHERE org_id = ? AND run_id = ? AND is_active = 0
    `).get(orgId, runId)) {
      throw new Error('Cannot activate a full run without staged transaction counts');
    }
    if (checkType) {
      db.prepare(`UPDATE issues SET is_active = 0 WHERE org_id = ? AND is_active = 1 AND check_type = ?`)
        .run(orgId, checkType);
      db.prepare(`UPDATE issue_findings SET is_active = 0 WHERE org_id = ? AND is_active = 1 AND check_type = ?`)
        .run(orgId, checkType);
    } else {
      db.prepare(`UPDATE issues SET is_active = 0 WHERE org_id = ? AND is_active = 1`).run(orgId);
      db.prepare(`UPDATE issue_findings SET is_active = 0 WHERE org_id = ? AND is_active = 1`).run(orgId);
      db.prepare(`UPDATE transaction_counts SET is_active = 0 WHERE org_id = ? AND is_active = 1`).run(orgId);
    }
    db.prepare(`UPDATE health_scores SET is_active = 0 WHERE org_id = ? AND is_active = 1`).run(orgId);
    db.prepare(`UPDATE issues SET is_active = 1 WHERE org_id = ? AND run_id = ?`).run(orgId, runId);
    db.prepare(`UPDATE issue_findings SET is_active = 1 WHERE org_id = ? AND run_id = ?`).run(orgId, runId);
    db.prepare(`UPDATE health_scores SET is_active = 1 WHERE org_id = ? AND run_id = ?`).run(orgId, runId);
    if (!checkType) {
      db.prepare(`UPDATE transaction_counts SET is_active = 1 WHERE org_id = ? AND run_id = ?`).run(orgId, runId);
    }
    db.prepare(`UPDATE sync_runs SET is_active = 0 WHERE org_id = ? AND is_active = 1`).run(orgId);
    db.prepare(`
      UPDATE sync_runs SET status = 'succeeded', is_active = 1, completed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND org_id = ?
    `).run(runId, orgId);
    db.prepare(`UPDATE organisations SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?`).run(orgId);
  })();
}

function getLastSuccessfulRun(orgId) {
  return getDb().prepare(`
    SELECT * FROM sync_runs WHERE org_id = ? AND status = 'succeeded'
    ORDER BY completed_at DESC, id DESC LIMIT 1
  `).get(orgId);
}

function mergeEntityCache(orgId, entityType, rows, { runId = null, fullRefresh = false } = {}) {
  const db = getDb();
  const idFields = {
    invoice: 'invoiceID', contact: 'contactID', credit_note: 'creditNoteID',
    bank_transaction: 'bankTransactionID', payment: 'paymentID', account: 'accountID',
    bank_transfer: 'bankTransferID', manual_journal: 'manualJournalID',
    tax_rate: 'taxType',
    organisation: 'organisationID',
    journal: 'journalNumber',
  };
  const idField = idFields[entityType];
  if (!idField) throw new Error(`Unsupported cache entity type: ${entityType}`);
  const fetchedAt = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO xero_entity_cache
      (org_id, entity_type, entity_id, json, modified_at, fetched_at, source_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id, entity_type, entity_id) DO UPDATE SET
      json = excluded.json, modified_at = excluded.modified_at,
      fetched_at = excluded.fetched_at, source_run_id = excluded.source_run_id
  `);
  db.transaction(() => {
    const seen = new Set();
    for (const row of rows) {
      const id = row?.[idField] ?? row?.journalNumber;
      if (id == null) continue;
      seen.add(String(id));
      insert.run(
        orgId, entityType, String(id), JSON.stringify(row),
        cacheDate(row.updatedDateUTC || row.updatedDateUtc),
        fetchedAt, runId
      );
    }
    if (fullRefresh) {
      const existing = db.prepare(`
        SELECT entity_id FROM xero_entity_cache WHERE org_id = ? AND entity_type = ?
      `).all(orgId, entityType);
      const remove = db.prepare(`
        DELETE FROM xero_entity_cache WHERE org_id = ? AND entity_type = ? AND entity_id = ?
      `);
      for (const item of existing) if (!seen.has(item.entity_id)) remove.run(orgId, entityType, item.entity_id);
    }
  })();
}

function getCachedEntities(orgId, entityType) {
  return getDb().prepare(`
    SELECT json FROM xero_entity_cache WHERE org_id = ? AND entity_type = ? ORDER BY entity_id
  `).all(orgId, entityType).map(row => JSON.parse(row.json));
}

function getEntityCacheWatermark(orgId, entityType) {
  return getDb().prepare(`
    SELECT MAX(fetched_at) AS fetched_at FROM xero_entity_cache WHERE org_id = ? AND entity_type = ?
  `).get(orgId, entityType)?.fetched_at || null;
}

function getIssueByCheckType(orgId, checkType) {
  const db = getDb();
  const current = db.prepare(`SELECT id FROM issues WHERE org_id = ? AND check_type = ? AND is_active = 1`).get(orgId, checkType);
  if (current) refreshIssueAggregations(orgId, current.id);
  return db.prepare(`SELECT * FROM issues WHERE org_id = ? AND check_type = ? AND is_active = 1`).get(orgId, checkType);
}

function getIssueFindings(issueId, page = 1, pageSize = 50, status = 'active') {
  const db = getDb();
  const safeSize = Math.min(100, Math.max(1, Number(pageSize) || 50));
  const allowedStatus = ['active', 'dismissed', 'ignored', 'ok', 'all'].includes(status) ? status : 'active';
  const effectiveState = `CASE
    WHEN r.state = 'dismissed' THEN 'dismissed'
    WHEN r.state = 'ignored' AND datetime(r.ignored_until) > datetime('now') THEN 'ignored'
    WHEN r.state = 'ok' AND r.period_key = i.period_checked THEN 'ok'
    ELSE 'active' END`;
  const where = allowedStatus === 'all' ? '' : `AND (${effectiveState}) = ?`;
  const params = allowedStatus === 'all' ? [issueId] : [issueId, allowedStatus];
  const total = db.prepare(`
    SELECT COUNT(*) AS count
    FROM issue_findings f
    JOIN issues i ON i.id = f.issue_id
    LEFT JOIN finding_review_states r
      ON r.org_id = f.org_id AND r.check_type = f.check_type AND r.finding_key = f.finding_key
    WHERE f.issue_id = ? ${where}
  `).get(...params).count;
  const totalPages = Math.max(1, Math.ceil(total / safeSize));
  const safePage = Math.min(totalPages, Math.max(1, Number(page) || 1));
  const rows = db.prepare(`
    SELECT f.finding_key, f.detail_json, f.display_only, f.potential_value_gbp,
      ${effectiveState} AS review_state, r.ignored_until, r.period_key, r.notes
    FROM issue_findings f
    JOIN issues i ON i.id = f.issue_id
    LEFT JOIN finding_review_states r
      ON r.org_id = f.org_id AND r.check_type = f.check_type AND r.finding_key = f.finding_key
    WHERE f.issue_id = ? ${where}
    ORDER BY f.id LIMIT ? OFFSET ?
  `).all(...params, safeSize, (safePage - 1) * safeSize);
  return {
    items: rows.map(row => ({
      ...JSON.parse(row.detail_json),
      finding_key: row.finding_key,
      review_state: row.review_state,
      ignored_until: row.ignored_until,
      notes: row.notes,
      displayOnly: !!row.display_only,
    })),
    page: safePage,
    pageSize: safeSize,
    total,
    totalPages,
    status: allowedStatus,
  };
}

function getIssueFindingSummary(issueId) {
  const db = getDb();
  const summary = { active: 0, dismissed: 0, ignored: 0, ok: 0 };
  const rows = db.prepare(`
    SELECT CASE
      WHEN r.state = 'dismissed' THEN 'dismissed'
      WHEN r.state = 'ignored' AND datetime(r.ignored_until) > datetime('now') THEN 'ignored'
      WHEN r.state = 'ok' AND r.period_key = i.period_checked THEN 'ok'
      ELSE 'active'
    END AS status, COUNT(*) AS count
    FROM issue_findings f
    JOIN issues i ON i.id = f.issue_id
    LEFT JOIN finding_review_states r
      ON r.org_id = f.org_id AND r.check_type = f.check_type AND r.finding_key = f.finding_key
    WHERE f.issue_id = ?
    GROUP BY status
  `).all(issueId);
  for (const row of rows) summary[row.status] = row.count;
  return summary;
}

function getReportFindings(orgId, perCheckLimit = 50) {
  const limit = Math.min(100, Math.max(1, Number(perCheckLimit) || 50));
  const rows = getDb().prepare(`
    WITH ranked AS (
      SELECT f.*, ROW_NUMBER() OVER (PARTITION BY f.check_type ORDER BY f.id) AS row_number,
        CASE
          WHEN r.state = 'dismissed' THEN 'dismissed'
          WHEN r.state = 'ignored' AND datetime(r.ignored_until) > datetime('now') THEN 'ignored'
          WHEN r.state = 'ok' AND r.period_key = i.period_checked THEN 'ok'
          ELSE 'active'
        END AS review_state
      FROM issue_findings f
      JOIN issues i ON i.id = f.issue_id
      LEFT JOIN finding_review_states r
        ON r.org_id = f.org_id AND r.check_type = f.check_type AND r.finding_key = f.finding_key
      WHERE f.org_id = ? AND f.is_active = 1 AND i.is_active = 1
    )
    SELECT * FROM ranked WHERE row_number <= ? ORDER BY check_type, id
  `).all(orgId, limit);
  const byCheck = {};
  for (const row of rows) {
    if (!byCheck[row.check_type]) byCheck[row.check_type] = [];
    byCheck[row.check_type].push({
      ...JSON.parse(row.detail_json),
      finding_key: row.finding_key,
      review_state: row.review_state,
      displayOnly: !!row.display_only,
    });
  }
  return byCheck;
}

function setFindingReviewStates(orgId, checkType, findingKeys, state, notes = null) {
  if (!['dismissed', 'ignored', 'ok', 'restore'].includes(state)) throw new Error('Invalid review state');
  const db = getDb();
  const uniqueKeys = [...new Set(findingKeys.filter(Boolean))];
  if (!uniqueKeys.length) return 0;
  return db.transaction(() => {
    const issue = db.prepare(`
      SELECT id, period_checked FROM issues WHERE org_id = ? AND check_type = ? AND is_active = 1
    `).get(orgId, checkType);
    if (!issue) throw new Error('Issue check not found');
    const valid = db.prepare(`
      SELECT finding_key FROM issue_findings WHERE issue_id = ?
    `).all(issue.id);
    const validKeys = new Set(valid.map(row => row.finding_key));
    const getPrevious = db.prepare(`
      SELECT * FROM finding_review_states WHERE org_id = ? AND check_type = ? AND finding_key = ?
    `);
    const upsert = db.prepare(`
      INSERT INTO finding_review_states
        (org_id, check_type, finding_key, state, ignored_until, period_key, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id, check_type, finding_key) DO UPDATE SET
        state = excluded.state, ignored_until = excluded.ignored_until,
        period_key = excluded.period_key, notes = excluded.notes, updated_at = CURRENT_TIMESTAMP
    `);
    const remove = db.prepare(`
      DELETE FROM finding_review_states WHERE org_id = ? AND check_type = ? AND finding_key = ?
    `);
    const audit = db.prepare(`
      INSERT INTO finding_review_audit
        (org_id, check_type, finding_key, action, previous_state, new_state,
         ignored_until, period_key, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let changed = 0;
    for (const key of uniqueKeys) {
      if (!validKeys.has(key)) continue;
      const previous = getPrevious.get(orgId, checkType, key);
      const ignoredUntil = state === 'ignored'
        ? new Date(Date.now() + 30 * 86400000).toISOString()
        : null;
      const periodKey = state === 'ok' ? issue.period_checked : null;
      if (state === 'restore') remove.run(orgId, checkType, key);
      else upsert.run(orgId, checkType, key, state, ignoredUntil, periodKey, notes || null);
      audit.run(
        orgId, checkType, key, state === 'restore' ? 'restored' : 'set',
        previous?.state || null, state === 'restore' ? null : state,
        ignoredUntil, periodKey, notes || null
      );
      changed++;
    }
    db.prepare(`
      UPDATE issues SET
        count = (
          SELECT COUNT(*) FROM issue_findings f
          LEFT JOIN finding_review_states r
            ON r.org_id = f.org_id AND r.check_type = f.check_type AND r.finding_key = f.finding_key
          WHERE f.issue_id = issues.id AND f.display_only = 0
            AND NOT COALESCE((
              r.state = 'dismissed'
              OR (r.state = 'ignored' AND datetime(r.ignored_until) > datetime('now'))
              OR (r.state = 'ok' AND r.period_key = issues.period_checked)
            ), 0)
        ),
        potential_value_gbp = (
          SELECT COALESCE(SUM(f.potential_value_gbp), 0) FROM issue_findings f
          LEFT JOIN finding_review_states r
            ON r.org_id = f.org_id AND r.check_type = f.check_type AND r.finding_key = f.finding_key
          WHERE f.issue_id = issues.id AND f.display_only = 0
            AND NOT COALESCE((
              r.state = 'dismissed'
              OR (r.state = 'ignored' AND datetime(r.ignored_until) > datetime('now'))
              OR (r.state = 'ok' AND r.period_key = issues.period_checked)
            ), 0)
        )
      WHERE id = ?
    `).run(issue.id);
    const issues = getIssuesForOrg(orgId);
    const scored = issues.filter(row => !NON_SCORED_CHECKS.includes(row.check_type));
    const breakdown = calculateScoreBreakdown(getScoringObservations(orgId), {
      nonScoredChecks: NON_SCORED_CHECKS,
    });
    db.prepare(`
      UPDATE health_scores SET score = ?, total_issues = ?, total_potential_errors_gbp = ?,
        score_profile_version = ?, score_breakdown_json = ?
      WHERE id = (SELECT MAX(id) FROM health_scores WHERE org_id = ? AND is_active = 1)
    `).run(
      breakdown.score,
      scored.reduce((sum, row) => sum + (row.count || 0), 0),
      scored.reduce((sum, row) => sum + (row.potential_value_gbp || 0), 0),
      breakdown.profileVersion,
      JSON.stringify(breakdown),
      orgId
    );
    return changed;
  })();
}

// Tokens
function upsertToken(data) {
  const db = getDb();
  return db.prepare(`
    INSERT INTO xero_tokens (xero_tenant_id, access_token, refresh_token, expires_at)
    VALUES (@xero_tenant_id, @access_token, @refresh_token, @expires_at)
    ON CONFLICT(xero_tenant_id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      updated_at = CURRENT_TIMESTAMP
  `).run(data);
}

// A single Xero consent covers every tenant the user ticked, and Xero issues ONE token set for that
// whole connection — so auth.js stores the same refresh_token against each of those tenant rows.
// Refresh tokens are single-use: refreshing rotates them and invalidates the previous one. Writing
// the rotated token back for only the tenant being synced therefore left every other tenant on the
// consumed token, and the next sync of any of them died with
// "invalid_grant (Refresh token has been consumed)". Observed live: six tenants sharing one token,
// of which only the last one synced still worked. Propagate the rotation across the connection.
function upsertTokenForConnection(previousRefreshToken, data) {
  const db = getDb();
  return db.transaction(() => {
    let propagated = 0;
    if (previousRefreshToken && previousRefreshToken !== data.refresh_token) {
      propagated = db.prepare(`
        UPDATE xero_tokens
        SET access_token = @access_token, refresh_token = @refresh_token,
            expires_at = @expires_at, updated_at = CURRENT_TIMESTAMP
        WHERE refresh_token = @previous_refresh_token
      `).run({ ...data, previous_refresh_token: previousRefreshToken }).changes;
    }
    // Always write the syncing tenant's own row, so it is correct even if it did not share a token.
    upsertToken(data);
    return propagated;
  })();
}

// When a refresh token is genuinely rejected, the whole connection is dead — not just the tenant
// that happened to be syncing. Marking only that one left the others showing "connected" in the UI
// when they were not.
function markConnectionDisconnected(refreshToken, tenantId) {
  const db = getDb();
  return db.transaction(() => {
    let affected = 0;
    if (refreshToken) {
      affected = db.prepare(`
        UPDATE organisations SET connection_status = 'disconnected'
        WHERE xero_tenant_id IN (
          SELECT xero_tenant_id FROM xero_tokens WHERE refresh_token = ?
        )
      `).run(refreshToken).changes;
    }
    if (tenantId) {
      db.prepare(`
        UPDATE organisations SET connection_status = 'disconnected' WHERE xero_tenant_id = ?
      `).run(tenantId);
    }
    return affected;
  })();
}

function getToken(tenantId) {
  const db = getDb();
  return db.prepare(`SELECT * FROM xero_tokens WHERE xero_tenant_id = ?`).get(tenantId);
}

// Tenants sharing one refresh token are one Xero connection; used to explain a dead connection.
function getTenantsSharingRefreshToken(refreshToken) {
  if (!refreshToken) return [];
  return getDb().prepare(`
    SELECT t.xero_tenant_id, o.name
    FROM xero_tokens t LEFT JOIN organisations o ON o.xero_tenant_id = t.xero_tenant_id
    WHERE t.refresh_token = ?
  `).all(refreshToken);
}

function deleteToken(tenantId) {
  const db = getDb();
  db.prepare(`DELETE FROM xero_tokens WHERE xero_tenant_id = ?`).run(tenantId);
}

// Bank Reconciliation (secondary/optional real bank check)
function upsertBankReconciliationXeroBalance(orgId, bankAccountId, bankAccountName, xeroBalance, asOfDate) {
  const db = getDb();
  db.prepare(`
    INSERT INTO bank_reconciliation (org_id, bank_account_id, bank_account_name, xero_calculated_balance, xero_balance_as_of)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(org_id, bank_account_id) DO UPDATE SET
      bank_account_name = excluded.bank_account_name,
      xero_calculated_balance = excluded.xero_calculated_balance,
      xero_balance_as_of = excluded.xero_balance_as_of
  `).run(orgId, bankAccountId, bankAccountName, xeroBalance, asOfDate);
}

function updateStatementBalance(orgId, bankAccountId, statementBalance) {
  const db = getDb();
  db.prepare(`
    UPDATE bank_reconciliation SET statement_balance = ?, statement_balance_updated_at = CURRENT_TIMESTAMP
    WHERE org_id = ? AND bank_account_id = ?
  `).run(statementBalance, orgId, bankAccountId);
}

function getBankReconciliationForOrg(orgId) {
  const db = getDb();
  return db.prepare(`SELECT * FROM bank_reconciliation WHERE org_id = ? ORDER BY bank_account_name`).all(orgId);
}

// Manual statement evidence
function getXeroBankItemsForOrg(orgId) {
  return getDb().prepare(`
    SELECT * FROM xero_bank_items_cache WHERE org_id = ? ORDER BY transaction_date DESC
  `).all(orgId);
}

function replaceXeroBankItemsCache(orgId, items) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO xero_bank_items_cache
      (org_id, cache_key, source_type, source_id, bank_account_id, bank_account_name,
       transaction_date, amount, reference, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    db.prepare(`DELETE FROM xero_bank_items_cache WHERE org_id = ?`).run(orgId);
    for (const item of items) insert.run(
      orgId, item.cacheKey, item.sourceType, item.sourceId, item.bankAccountId || null,
      item.bankAccountName || null, item.transactionDate || null, item.amount,
      item.reference || null, item.description || null
    );
  })();
}

function createStatementImport(orgId, data, lines) {
  const db = getDb();
  return db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO statement_imports
        (org_id, bank_account_id, bank_account_name, original_filename, stored_filename,
         file_sha256, statement_start_date, statement_end_date, opening_balance,
         closing_balance, column_mapping_json, row_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orgId, data.bankAccountId, data.bankAccountName, data.originalFilename, data.storedFilename,
      data.fileSha256, data.statementStartDate, data.statementEndDate, data.openingBalance,
      data.closingBalance, JSON.stringify(data.columnMapping), lines.length
    );
    const insert = db.prepare(`
      INSERT INTO statement_lines
        (import_id, org_id, bank_account_id, line_number, transaction_date, amount,
         reference, description, match_confidence, matched_xero_item_id, match_candidates)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const line of lines) insert.run(
      result.lastInsertRowid, orgId, data.bankAccountId, line.lineNumber,
      line.transactionDate, line.amount, line.reference, line.description,
      line.confidence, line.matchedId, line.candidates
    );
    return Number(result.lastInsertRowid);
  })();
}

function getStatementImportByHash(orgId, hash) {
  return getDb().prepare(`SELECT * FROM statement_imports WHERE org_id = ? AND file_sha256 = ?`).get(orgId, hash);
}

function getStatementImportsForOrg(orgId) {
  return getDb().prepare(`
    SELECT si.*,
      SUM(CASE WHEN sl.match_confidence = 'exact' THEN 1 ELSE 0 END) exact_count,
      SUM(CASE WHEN sl.match_confidence = 'probable' THEN 1 ELSE 0 END) probable_count,
      SUM(CASE WHEN sl.match_confidence = 'ambiguous' THEN 1 ELSE 0 END) ambiguous_count,
      SUM(CASE WHEN sl.match_confidence = 'unmatched' THEN 1 ELSE 0 END) unmatched_count
    FROM statement_imports si
    LEFT JOIN statement_lines sl ON sl.import_id = si.id
    WHERE si.org_id = ?
    GROUP BY si.id ORDER BY si.statement_end_date DESC, si.imported_at DESC
  `).all(orgId);
}

function getLatestStatementLinesForOrg(orgId) {
  return getDb().prepare(`
    SELECT sl.*, si.statement_end_date, si.closing_balance, si.bank_account_name
    FROM statement_lines sl
    JOIN statement_imports si ON si.id = sl.import_id
    WHERE si.org_id = ? AND si.id = (
      SELECT latest.id FROM statement_imports latest
      WHERE latest.org_id = si.org_id AND latest.bank_account_id = si.bank_account_id
      ORDER BY latest.statement_end_date DESC, latest.imported_at DESC LIMIT 1
    )
    ORDER BY sl.transaction_date, sl.line_number
  `).all(orgId);
}

function getStatementLinesForOrg(orgId) {
  return getDb().prepare(`
    SELECT * FROM statement_lines WHERE org_id = ? ORDER BY id
  `).all(orgId);
}

function getLatestStatementImportsForOrg(orgId) {
  return getDb().prepare(`
    SELECT si.* FROM statement_imports si
    WHERE si.org_id = ? AND si.id = (
      SELECT latest.id FROM statement_imports latest
      WHERE latest.org_id = si.org_id AND latest.bank_account_id = si.bank_account_id
      ORDER BY latest.statement_end_date DESC, latest.imported_at DESC LIMIT 1
    )
    ORDER BY si.bank_account_name
  `).all(orgId);
}

function updateStatementLineMatches(orgId, matches) {
  const db = getDb();
  const update = db.prepare(`
    UPDATE statement_lines SET match_confidence = ?, matched_xero_item_id = ?, match_candidates = ?
    WHERE id = ? AND org_id = ?
  `);
  db.transaction(() => {
    for (const match of matches) update.run(
      match.confidence, match.matchedId || null, match.candidates || 0, match.id, orgId
    );
  })();
}

function deleteStatementImport(orgId, importId) {
  const db = getDb();
  return db.transaction(() => {
    const record = db.prepare(`SELECT * FROM statement_imports WHERE id = ? AND org_id = ?`).get(importId, orgId);
    if (!record) return null;
    db.prepare(`DELETE FROM statement_imports WHERE id = ? AND org_id = ?`).run(importId, orgId);
    return record;
  })();
}

// Filed statutory accounts evidence
function upsertFiledAccounts(orgId, data) {
  getDb().prepare(`
    INSERT INTO filed_accounts
      (org_id, filing_date, net_assets, source_note, source_document_path, source, made_up_to)
    VALUES (?, ?, ?, ?, ?, 'manual', ?)
    ON CONFLICT(org_id, filing_date) DO UPDATE SET
      net_assets = excluded.net_assets, source_note = excluded.source_note,
      source_document_path = COALESCE(excluded.source_document_path, filed_accounts.source_document_path),
      source = 'manual', made_up_to = excluded.made_up_to,
      taxonomy_concept = NULL, context_ref = NULL, context_date = NULL,
      extraction_method = NULL, extraction_confidence = NULL,
      xero_net_assets = NULL, xero_balance_as_of = NULL, xero_synced_at = NULL
  `).run(
    orgId, data.filingDate, data.netAssets, data.sourceNote || null,
    data.sourceDocumentPath || null, data.madeUpTo || data.filingDate
  );
}

// Automatic Companies House figures are written through a separate path with two guarantees:
//  - a row an accountant entered by hand (source='manual') is never overwritten;
//  - the Xero comparison balance is only invalidated when the filed figure actually changed,
//    so a nightly re-extraction of the same accounts does not force a Balance Sheet re-fetch.
function upsertFiledAccountsFromCompaniesHouse(orgId, data) {
  const result = getDb().prepare(`
    INSERT INTO filed_accounts
      (org_id, filing_date, net_assets, source_note, source, made_up_to,
       ch_transaction_id, ch_document_id, taxonomy_concept, context_ref, context_date,
       extraction_method, extraction_confidence, extracted_at)
    VALUES (?, ?, ?, ?, 'companies_house', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(org_id, filing_date) DO UPDATE SET
      net_assets = excluded.net_assets, source_note = excluded.source_note,
      made_up_to = excluded.made_up_to,
      ch_transaction_id = excluded.ch_transaction_id,
      ch_document_id = excluded.ch_document_id,
      taxonomy_concept = excluded.taxonomy_concept,
      context_ref = excluded.context_ref,
      context_date = excluded.context_date,
      extraction_method = excluded.extraction_method,
      extraction_confidence = excluded.extraction_confidence,
      extracted_at = CURRENT_TIMESTAMP,
      xero_net_assets = CASE
        WHEN filed_accounts.net_assets IS excluded.net_assets THEN filed_accounts.xero_net_assets
        ELSE NULL END,
      xero_balance_as_of = CASE
        WHEN filed_accounts.net_assets IS excluded.net_assets THEN filed_accounts.xero_balance_as_of
        ELSE NULL END,
      xero_synced_at = CASE
        WHEN filed_accounts.net_assets IS excluded.net_assets THEN filed_accounts.xero_synced_at
        ELSE NULL END
    WHERE filed_accounts.source = 'companies_house'
  `).run(
    orgId, data.filingDate, data.netAssets, data.sourceNote || null, data.madeUpTo || data.filingDate,
    data.chTransactionId || null, data.chDocumentId || null, data.taxonomyConcept || null,
    data.contextRef || null, data.contextDate || null,
    data.extractionMethod || null, data.extractionConfidence || null
  );
  return result.changes > 0;
}

// One row per (org, balance-sheet date) recording the latest extraction attempt, including
// failures, so the client page can explain exactly why a filed figure is or is not available.
function recordFiledAccountsExtraction(orgId, data) {
  getDb().prepare(`
    INSERT INTO filed_accounts_extractions
      (org_id, made_up_to, company_number, ch_transaction_id, ch_document_id, filing_date,
       filing_description, content_type, taxonomy_concept, context_ref, context_date,
       extracted_value, extraction_method, extraction_confidence, failure_reason,
       available_dates, candidates_json, applied, attempted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(org_id, made_up_to) DO UPDATE SET
      company_number = excluded.company_number,
      ch_transaction_id = excluded.ch_transaction_id,
      ch_document_id = excluded.ch_document_id,
      filing_date = excluded.filing_date,
      filing_description = excluded.filing_description,
      content_type = excluded.content_type,
      taxonomy_concept = excluded.taxonomy_concept,
      context_ref = excluded.context_ref,
      context_date = excluded.context_date,
      extracted_value = excluded.extracted_value,
      extraction_method = excluded.extraction_method,
      extraction_confidence = excluded.extraction_confidence,
      failure_reason = excluded.failure_reason,
      available_dates = excluded.available_dates,
      candidates_json = excluded.candidates_json,
      applied = excluded.applied,
      attempted_at = CURRENT_TIMESTAMP
  `).run(
    orgId, data.madeUpTo, data.companyNumber || null, data.chTransactionId || null,
    data.chDocumentId || null, data.filingDate || null, data.filingDescription || null,
    data.contentType || null, data.taxonomyConcept || null, data.contextRef || null,
    data.contextDate || null,
    data.extractedValue == null ? null : Number(data.extractedValue),
    data.extractionMethod || null, data.extractionConfidence || null,
    data.failureReason || null,
    data.availableDates ? JSON.stringify(data.availableDates) : null,
    data.candidates ? JSON.stringify(data.candidates) : null,
    data.applied ? 1 : 0
  );
}

function getFiledAccountsExtractionsForOrg(orgId) {
  return getDb().prepare(`
    SELECT * FROM filed_accounts_extractions WHERE org_id = ? ORDER BY made_up_to DESC
  `).all(orgId);
}

function updateFiledAccountsXeroBalance(orgId, filingDate, netAssets) {
  getDb().prepare(`
    UPDATE filed_accounts SET xero_net_assets = ?, xero_balance_as_of = ?,
      xero_synced_at = CURRENT_TIMESTAMP WHERE org_id = ? AND filing_date = ?
  `).run(netAssets, filingDate, orgId, filingDate);
}

function getFiledAccountsForOrg(orgId) {
  return getDb().prepare(`
    SELECT * FROM filed_accounts WHERE org_id = ? ORDER BY filing_date DESC
  `).all(orgId);
}

// Companies House public-register snapshot (informational only)
function updateOrganisationCompanyNumber(orgId, companyNumber) {
  getDb().prepare(`UPDATE organisations SET company_number = ? WHERE id = ?`)
    .run(companyNumber || null, orgId);
}

function upsertCompaniesHouseProfile(orgId, data) {
  getDb().prepare(`
    INSERT INTO companies_house_profile
      (org_id, company_number, company_name, company_status, company_type, incorporation_date,
       accounts_next_due, accounts_last_made_up_to, accounts_overdue,
       confirmation_next_due, confirmation_last_made_up_to, confirmation_overdue,
       sic_codes, registered_office, raw_json, fetch_error, fetched_at)
    VALUES (@org_id, @company_number, @company_name, @company_status, @company_type, @incorporation_date,
       @accounts_next_due, @accounts_last_made_up_to, @accounts_overdue,
       @confirmation_next_due, @confirmation_last_made_up_to, @confirmation_overdue,
       @sic_codes, @registered_office, @raw_json, @fetch_error, CURRENT_TIMESTAMP)
    ON CONFLICT(org_id) DO UPDATE SET
      company_number = excluded.company_number, company_name = excluded.company_name,
      company_status = excluded.company_status, company_type = excluded.company_type,
      incorporation_date = excluded.incorporation_date,
      accounts_next_due = excluded.accounts_next_due,
      accounts_last_made_up_to = excluded.accounts_last_made_up_to,
      accounts_overdue = excluded.accounts_overdue,
      confirmation_next_due = excluded.confirmation_next_due,
      confirmation_last_made_up_to = excluded.confirmation_last_made_up_to,
      confirmation_overdue = excluded.confirmation_overdue,
      sic_codes = excluded.sic_codes, registered_office = excluded.registered_office,
      raw_json = excluded.raw_json, fetch_error = excluded.fetch_error,
      fetched_at = CURRENT_TIMESTAMP
  `).run({
    org_id: orgId,
    company_number: data.companyNumber || null,
    company_name: data.companyName || null,
    company_status: data.status || null,
    company_type: data.type || null,
    incorporation_date: data.incorporationDate || null,
    accounts_next_due: data.accountsNextDue || null,
    accounts_last_made_up_to: data.accountsLastMadeUpTo || null,
    accounts_overdue: data.accountsOverdue ? 1 : 0,
    confirmation_next_due: data.confirmationNextDue || null,
    confirmation_last_made_up_to: data.confirmationLastMadeUpTo || null,
    confirmation_overdue: data.confirmationOverdue ? 1 : 0,
    sic_codes: data.sicCodes && data.sicCodes.length ? JSON.stringify(data.sicCodes) : null,
    registered_office: data.registeredOffice || null,
    raw_json: data.rawJson || null,
    fetch_error: data.fetchError || null,
  });
}

function getCompaniesHouseProfileForOrg(orgId) {
  const row = getDb().prepare(`SELECT * FROM companies_house_profile WHERE org_id = ?`).get(orgId);
  if (!row) return null;
  let sicCodes = [];
  try { sicCodes = row.sic_codes ? JSON.parse(row.sic_codes) : []; } catch { sicCodes = []; }
  return { ...row, sic_codes: sicCodes };
}

// Chart of Accounts cache (drives per-client Capital Item Review account selection)
function upsertChartOfAccountsCache(orgId, accounts) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO chart_of_accounts_cache (org_id, account_code, account_name, account_class, account_type)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(org_id, account_code) DO UPDATE SET
      account_name = excluded.account_name,
      account_class = excluded.account_class,
      account_type = excluded.account_type
  `);
  // Some Xero accounts (e.g. system/tracking accounts) have no code at all — nothing to key on.
  const run = db.transaction((rows) => { for (const a of rows) if (a.code) stmt.run(orgId, a.code, a.name, a._class, a.type); });
  run(accounts);
}

function getExpenseAccountsForOrg(orgId) {
  const db = getDb();
  return db.prepare(`SELECT * FROM chart_of_accounts_cache WHERE org_id = ? AND account_class = 'EXPENSE' ORDER BY account_code`).all(orgId);
}

function getAccountCheckConfigurationForOrg(orgId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM chart_of_accounts_cache WHERE org_id = ? ORDER BY account_class, account_code
  `).all(orgId);
}

function setAccountCheckConfiguration(orgId, configurations) {
  const db = getDb();
  const all = db.prepare(`SELECT account_code FROM chart_of_accounts_cache WHERE org_id = ?`).all(orgId);
  const byCode = new Map(configurations.map(config => [config.account_code, config]));
  const update = db.prepare(`
    UPDATE chart_of_accounts_cache SET
      is_capital_candidate = ?,
      capital_review_threshold = ?,
      monitor_misallocated = ?,
      misallocated_threshold = ?,
      purchase_tax_ignore = ?,
      purchase_tax_include_asset_prepayment = ?
    WHERE org_id = ? AND account_code = ?
  `);
  const run = db.transaction(() => {
    for (const row of all) {
      const config = byCode.get(row.account_code) || {};
      update.run(
        config.is_capital_candidate ? 1 : 0,
        config.capital_review_threshold ?? null,
        config.monitor_misallocated ? 1 : 0,
        config.misallocated_threshold ?? null,
        config.purchase_tax_ignore ? 1 : 0,
        config.purchase_tax_include_asset_prepayment ? 1 : 0,
        orgId,
        row.account_code
      );
    }
  });
  run();
}

// Settings
function getSetting(key) {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  const db = getDb();
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

// Xenon validation evidence and cancellation gate
function createValidationSnapshot(orgId, data, checks) {
  const db = getDb();
  return db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO validation_snapshots
        (org_id, period_key, xenon_score, xenon_issues, xenon_value_gbp,
         source_date, source_filename, source_file_sha256, evidence_path, notes,
         score_reason, profile_tags_json, evidence_kind, counts_toward_gate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orgId, data.periodKey, data.xenonScore, data.xenonIssues, data.xenonValue,
      data.sourceDate, data.sourceFilename || null, data.sourceFileSha256,
      data.evidencePath || null, data.notes || null, data.scoreReason || null,
      JSON.stringify(data.profileTags), data.evidenceKind, data.countsTowardGate ? 1 : 0
    );
    const insert = db.prepare(`
      INSERT INTO validation_snapshot_checks
        (snapshot_id, check_type, xenon_count, xenon_value_gbp, support_type, mismatch_note)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const check of checks) insert.run(
      result.lastInsertRowid, check.type, check.count, check.value,
      check.supportType, check.mismatchNote || null
    );
    return Number(result.lastInsertRowid);
  })();
}

function getValidationSnapshots() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT vs.*, o.name AS org_name, o.xero_tenant_id
    FROM validation_snapshots vs
    JOIN organisations o ON o.id = vs.org_id
    ORDER BY vs.created_at DESC, vs.id DESC
  `).all();
  const checkQuery = db.prepare(`
    SELECT * FROM validation_snapshot_checks WHERE snapshot_id = ? ORDER BY check_type
  `);
  return rows.map(row => {
    const checks = {};
    for (const check of checkQuery.all(row.id)) checks[check.check_type] = {
      count: check.xenon_count,
      value: check.xenon_value_gbp,
      supportType: check.support_type,
      mismatchNote: check.mismatch_note,
    };
    let profileTags = [];
    try { profileTags = JSON.parse(row.profile_tags_json); } catch (error) { profileTags = []; }
    return {
      id: row.id,
      orgId: row.org_id,
      orgName: row.org_name,
      tenantId: row.xero_tenant_id,
      periodKey: row.period_key,
      xenonScore: row.xenon_score,
      xenonIssues: row.xenon_issues,
      xenonValue: row.xenon_value_gbp,
      sourceDate: row.source_date,
      sourceFilename: row.source_filename,
      sourceFileSha256: row.source_file_sha256,
      notes: row.notes,
      scoreReason: row.score_reason,
      profileTags,
      evidenceKind: row.evidence_kind,
      countsTowardGate: !!row.counts_toward_gate,
      createdAt: row.created_at,
      checks,
    };
  });
}

// A snapshot can only be compared against a run covering the same period, but the active run
// follows whatever period the user last synced — clicking Sync on the dashboard moves it to today
// and silently blanked every comparison. Look up the newest run for the requested period instead;
// runIsComparable still demands it succeeded and finished no earlier than the Xenon export.
function getValidationRunForPeriod(orgId, periodKey) {
  const db = getDb();
  const score = db.prepare(`
    SELECT hs.*, sr.status AS run_status, sr.completed_at AS run_completed_at
    FROM health_scores hs
    LEFT JOIN sync_runs sr ON sr.id = hs.run_id
    WHERE hs.org_id = ? AND hs.period_key = ? AND sr.status = 'succeeded'
    ORDER BY hs.id DESC LIMIT 1
  `).get(orgId, periodKey);
  if (!score) return null;
  const issues = db.prepare(`
    SELECT check_type, count, potential_value_gbp FROM issues WHERE org_id = ? AND run_id = ?
  `).all(orgId, score.run_id);
  return {
    periodKey: score.period_key,
    score: score.score,
    issues: score.total_issues,
    value: score.total_potential_errors_gbp,
    runId: score.run_id,
    runStatus: score.run_status,
    runCompletedAt: score.run_completed_at,
    checks: Object.fromEntries(issues.map(issue => [issue.check_type, {
      count: issue.count,
      value: issue.potential_value_gbp,
    }])),
  };
}

function getActiveValidationRuns() {
  const db = getDb();
  // The run's provenance travels with it: the gate must be able to tell a score row a real
  // sync produced from one that was edited or left behind by a failed run.
  const scores = db.prepare(`
    SELECT hs.*, sr.status AS run_status, sr.completed_at AS run_completed_at
    FROM health_scores hs
    LEFT JOIN sync_runs sr ON sr.id = hs.run_id
    WHERE hs.is_active = 1 AND hs.id = (
      SELECT MAX(latest.id) FROM health_scores latest
      WHERE latest.org_id = hs.org_id AND latest.is_active = 1
    )
  `).all();
  const issues = db.prepare(`
    SELECT org_id, check_type, count, potential_value_gbp
    FROM issues WHERE is_active = 1
  `).all();
  const result = {};
  for (const score of scores) result[score.org_id] = {
    periodKey: score.period_key,
    score: score.score,
    issues: score.total_issues,
    value: score.total_potential_errors_gbp,
    runId: score.run_id,
    runStatus: score.run_status,
    runCompletedAt: score.run_completed_at,
    checks: {},
  };
  for (const issue of issues) {
    if (!result[issue.org_id]) continue;
    result[issue.org_id].checks[issue.check_type] = {
      count: issue.count,
      value: issue.potential_value_gbp,
    };
  }
  return result;
}

function getValidationGateAssurances() {
  const rows = getDb().prepare(`SELECT * FROM validation_gate_assurances`).all();
  return Object.fromEntries(rows.map(row => [row.assurance_type, {
    status: row.status,
    evidenceDate: row.evidence_date,
    notes: row.notes,
    updatedAt: row.updated_at,
  }]));
}

function setValidationGateAssurance(type, status, evidenceDate, notes) {
  return getDb().prepare(`
    INSERT INTO validation_gate_assurances (assurance_type, status, evidence_date, notes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(assurance_type) DO UPDATE SET
      status = excluded.status, evidence_date = excluded.evidence_date,
      notes = excluded.notes, updated_at = CURRENT_TIMESTAMP
  `).run(type, status, evidenceDate || null, notes || null);
}

// Transaction Counts
function upsertTransactionCounts(orgId, data) {
  const db = getDb();
  db.prepare(`
    DELETE FROM transaction_counts WHERE org_id = ? AND period = ? AND is_active = ?
      AND (? IS NULL OR run_id = ?)
  `).run(
    orgId, data.period || 'rolling_12_months', data.is_active == null ? 1 : data.is_active,
    data.run_id || null, data.run_id || null
  );
  return db.prepare(`
    INSERT INTO transaction_counts (org_id, period, period_start, period_end, months_covered,
      turnover, total_transactions, customer_invoices, supplier_bills,
      credit_notes_sales, credit_notes_purchase, bank_processed, journals, run_id, is_active)
    VALUES (@org_id, @period, @period_start, @period_end, @months_covered,
      @turnover, @total_transactions, @customer_invoices, @supplier_bills,
      @credit_notes_sales, @credit_notes_purchase, @bank_processed, @journals, @run_id, @is_active)
  `).run({ run_id: null, is_active: 1, org_id: orgId, ...data });
}

function getTransactionCountsForOrg(orgId, periodType = null, periodStart = null, periodEnd = null) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM transaction_counts
    WHERE org_id = ? AND is_active = 1 AND (? IS NULL OR period = ?)
      AND (? IS NULL OR period_start = ?) AND (? IS NULL OR period_end = ?)
    ORDER BY synced_at DESC, id DESC LIMIT 1
  `).get(orgId, periodType, periodType, periodStart, periodStart, periodEnd, periodEnd);
}

function getAllTransactionCounts(periodType = null, periodStart = null, periodEnd = null) {
  const db = getDb();
  return db.prepare(`
    SELECT o.xero_tenant_id, o.name, o.client_ref, o.connection_status, o.last_synced_at,
           tc.period, tc.period_start, tc.period_end, tc.months_covered,
           tc.turnover, tc.total_transactions, tc.customer_invoices, tc.supplier_bills,
           tc.credit_notes_sales, tc.credit_notes_purchase, tc.bank_processed, tc.journals
    FROM organisations o
    LEFT JOIN transaction_counts tc ON tc.org_id = o.id
      AND tc.id = (
        SELECT id FROM transaction_counts
        WHERE org_id = o.id AND is_active = 1 AND (? IS NULL OR period = ?)
          AND (? IS NULL OR period_start = ?) AND (? IS NULL OR period_end = ?)
        ORDER BY synced_at DESC, id DESC LIMIT 1
      )
    ORDER BY o.name
  `).all(periodType, periodType, periodStart, periodStart, periodEnd, periodEnd);
}

function getPanoramaOrganisations() {
  const db = getDb();
  return db.prepare(`
    WITH latest_health AS (
      SELECT hs.* FROM health_scores hs
      WHERE hs.is_active = 1 AND hs.id = (
        SELECT MAX(newer.id) FROM health_scores newer WHERE newer.org_id = hs.org_id AND newer.is_active = 1
      )
    ), breakdown AS (
      SELECT i.org_id,
        json_group_array(json_object(
          'checkType', i.check_type, 'importance', i.importance,
          'count', i.count, 'potentialValue', i.potential_value_gbp
        )) AS issue_breakdown_json
      FROM issues i
      WHERE i.is_active = 1 AND COALESCE(i.count, 0) > 0
      GROUP BY i.org_id
    )
    SELECT o.*, hs.score, hs.total_issues, hs.total_potential_errors_gbp,
      hs.last_bank_reconciled, hs.most_recent_transaction, hs.unreconciled_bank_items,
      hs.lock_date, hs.calculated_at, hs.period_key, hs.period_label,
      (SELECT MAX(completed_at) FROM sync_runs sr
       WHERE sr.org_id = o.id AND sr.status = 'succeeded') AS last_successful_sync_at,
      COALESCE(b.issue_breakdown_json, '[]') AS issue_breakdown_json
    FROM organisations o
    LEFT JOIN latest_health hs ON hs.org_id = o.id
    LEFT JOIN breakdown b ON b.org_id = o.id
    ORDER BY o.name
  `).all().map(row => {
    try {
      return { ...row, issueBreakdown: JSON.parse(row.issue_breakdown_json) };
    } catch (error) {
      return { ...row, issueBreakdown: [] };
    }
  });
}

module.exports = {
  upsertOrganisation, getAllOrganisations, getOrganisationByTenantId,
  updateOrganisationMeta, updateOrganisationAccountingSettings, markOrganisationDisconnected,
  upsertHealthScore, deleteIssuesForOrg, insertIssue, replaceIssueForCheck, refreshLatestHealthScore,
  getIssuesForOrg, getScoringObservations, getIssueByCheckType,
  getIssuesForRun, getScoringObservationsForRun,
  getIssueFindings, getIssueFindingSummary, getReportFindings, setFindingReviewStates,
  upsertToken, upsertTokenForConnection, markConnectionDisconnected,
  getTenantsSharingRefreshToken, getToken, deleteToken, getSetting, setSetting,
  upsertTransactionCounts, getTransactionCountsForOrg, getAllTransactionCounts, getPanoramaOrganisations,
  upsertBankReconciliationXeroBalance, updateStatementBalance, getBankReconciliationForOrg,
  getXeroBankItemsForOrg, replaceXeroBankItemsCache, createStatementImport,
  getStatementImportByHash, getStatementImportsForOrg, getLatestStatementLinesForOrg, getStatementLinesForOrg,
  getLatestStatementImportsForOrg, updateStatementLineMatches, deleteStatementImport,
  upsertFiledAccounts, updateFiledAccountsXeroBalance, getFiledAccountsForOrg,
  upsertFiledAccountsFromCompaniesHouse, recordFiledAccountsExtraction,
  getFiledAccountsExtractionsForOrg,
  updateOrganisationCompanyNumber, upsertCompaniesHouseProfile, getCompaniesHouseProfileForOrg,
  upsertChartOfAccountsCache, getExpenseAccountsForOrg,
  getAccountCheckConfigurationForOrg, setAccountCheckConfiguration,
  createSyncRun, finishSyncRun, activateSyncRun, getLastSuccessfulRun,
  mergeEntityCache, getCachedEntities, getEntityCacheWatermark,
  createValidationSnapshot, getValidationSnapshots, getActiveValidationRuns,
  getValidationRunForPeriod, getValidationGateAssurances, setValidationGateAssurance
};
