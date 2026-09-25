const { getDb } = require('./schema');
const { getPool } = require('./mysqlPool');
const {
  NON_SCORED_CHECKS, addFindingKeys, allocateFindingValues, isReviewStateActive, normalizeContactKey,
} = require('../services/checkRules');
const { calculateScoreBreakdown } = require('../services/scoreProfile');

function cacheDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// Organisations — migrated to the shared MySQL database (akrio_organisations), see
// scripts/mysql-schema.sql. health_scores and sync_runs moved alongside it (below), so the
// existing JOINs stay single MySQL queries; issues/findings/insight/statement tables stay on
// SQLite for now (see getPanoramaOrganisations for how that split is handled).
async function upsertOrganisation(data) {
  await getPool().query(
    `INSERT INTO akrio_organisations
       (xero_tenant_id, name, client_ref, tag, connection_status, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?) AS new
     ON DUPLICATE KEY UPDATE
       name = new.name,
       connection_status = new.connection_status,
       last_synced_at = COALESCE(new.last_synced_at, akrio_organisations.last_synced_at)`,
    [data.xero_tenant_id, data.name, data.client_ref, data.tag, data.connection_status, data.last_synced_at]
  );
}

// Raw organisations row (no health_scores join) — for resolving per-org check configuration,
// where only the organisation's own override columns matter, not its latest health score.
async function getOrganisationById(orgId) {
  const [rows] = await getPool().query(`SELECT * FROM akrio_organisations WHERE id = ?`, [orgId]);
  return rows[0] || null;
}

async function getAllOrganisations() {
  const [rows] = await getPool().query(`
    SELECT o.*, hs.score, hs.total_issues, hs.total_potential_errors_gbp,
           hs.last_bank_reconciled, hs.most_recent_transaction,
           hs.unreconciled_bank_items, hs.lock_date, hs.score_profile_version,
           hs.score_breakdown_json, hs.calculated_at, hs.period_key, hs.period_type,
           hs.period_start, hs.period_end, hs.period_label,
           (SELECT MAX(completed_at) FROM akrio_sync_runs
            WHERE org_id = o.id AND status = 'succeeded') AS last_successful_sync_at
    FROM akrio_organisations o
    LEFT JOIN akrio_health_scores hs ON hs.org_id = o.id
      AND hs.id = (SELECT MAX(id) FROM akrio_health_scores WHERE org_id = o.id AND is_active = 1)
    ORDER BY o.name
  `);
  return rows;
}

async function getOrganisationByTenantId(tenantId) {
  const [rows] = await getPool().query(`
    SELECT o.*, hs.score, hs.total_issues, hs.total_potential_errors_gbp,
           hs.last_bank_reconciled, hs.most_recent_transaction,
           hs.unreconciled_bank_items, hs.lock_date, hs.score_profile_version,
           hs.score_breakdown_json, hs.calculated_at, hs.period_key, hs.period_type,
           hs.period_start, hs.period_end, hs.period_label,
           (SELECT MAX(completed_at) FROM akrio_sync_runs
            WHERE org_id = o.id AND status = 'succeeded') AS last_successful_sync_at
    FROM akrio_organisations o
    LEFT JOIN akrio_health_scores hs ON hs.org_id = o.id
      AND hs.id = (SELECT MAX(id) FROM akrio_health_scores WHERE org_id = o.id AND is_active = 1)
    WHERE o.xero_tenant_id = ? OR o.freeagent_company_id = ?
  `, [tenantId, tenantId]);
  return rows[0] || null;
}

// tenantId here is the same universal identifier getOrganisationByTenantId resolves — either a
// Xero tenant id or a FreeAgent company id. Matching on both columns (only one is ever non-null
// per org) means this silently updates 0 rows for a FreeAgent org otherwise, since its
// xero_tenant_id is null.
async function updateOrganisationMeta(tenantId, { client_ref, tag }) {
  await getPool().query(
    `UPDATE akrio_organisations SET client_ref = ?, tag = ? WHERE xero_tenant_id = ? OR freeagent_company_id = ?`,
    [client_ref, tag, tenantId, tenantId]
  );
}

async function updateOrganisationAccountingSettings(orgId, data) {
  await getPool().query(
    `UPDATE akrio_organisations SET financial_year_end_day = ?, financial_year_end_month = ? WHERE id = ?`,
    [data.financialYearEndDay || null, data.financialYearEndMonth || null, orgId]
  );
}

// NULL (the default) means "use the 12-month fallback tuned against already-validated clients" —
// see checkRules.js's resolveSupplierPatternLookbackMonths. A positive integer here overrides that
// per-client, matching Xenon's own "3 months by default, changeable per client" setting.
async function updateOrganisationSupplierPatternLookback(orgId, months) {
  await getPool().query(
    `UPDATE akrio_organisations SET supplier_pattern_lookback_months = ? WHERE id = ?`,
    [Number.isInteger(months) && months > 0 ? months : null, orgId]
  );
}

async function updateOrganisationMultiAccountPatternLookback(orgId, months) {
  await getPool().query(
    `UPDATE akrio_organisations SET multi_account_pattern_lookback_months = ? WHERE id = ?`,
    [Number.isInteger(months) && months > 0 ? months : null, orgId]
  );
}

// Config-isolation overrides (2026-09) — one organisation's own settings for values that
// previously came only from the practice-wide `settings` table or a hardcoded constant. Every
// field is nullable: NULL means "not configured for this client," so this UPDATE alone can never
// change a client's behaviour — only an explicit non-null value the accountant chose to set does.
// A caller passing `undefined` for a field leaves that column untouched (COALESCE onto its current
// value) so a form that only edits some fields can't accidentally null out the others.
async function updateOrganisationCheckConfig(orgId, fields) {
  const current = await getOrganisationById(orgId);
  if (!current) return;
  const numericOrNull = value => (Number.isFinite(Number(value)) ? Number(value) : null);
  // Tri-state boolean field: '' / null means "not configured, use the documented default";
  // '1'/true means explicitly on; '0'/false (and anything else) means explicitly off. A plain HTML
  // checkbox can't express this (unchecked and never-shown look identical), so these come from a
  // three-option <select> on the settings form instead.
  const triStateBoolOrNull = value => (value === '' || value == null ? null : (value === '1' || value === true || value === 1 ? 1 : 0));
  const merged = {
    opening_balance_threshold_gbp: fields.opening_balance_threshold_gbp === undefined
      ? current.opening_balance_threshold_gbp
      : (fields.opening_balance_threshold_gbp === null ? null : numericOrNull(fields.opening_balance_threshold_gbp)),
    capital_review_default_threshold_gbp: fields.capital_review_default_threshold_gbp === undefined
      ? current.capital_review_default_threshold_gbp
      : (fields.capital_review_default_threshold_gbp === null ? null : numericOrNull(fields.capital_review_default_threshold_gbp)),
    misallocated_items_default_threshold_gbp: fields.misallocated_items_default_threshold_gbp === undefined
      ? current.misallocated_items_default_threshold_gbp
      : (fields.misallocated_items_default_threshold_gbp === null ? null : numericOrNull(fields.misallocated_items_default_threshold_gbp)),
    multi_account_suppliers_min_value_gbp: fields.multi_account_suppliers_min_value_gbp === undefined
      ? current.multi_account_suppliers_min_value_gbp
      : (fields.multi_account_suppliers_min_value_gbp === null ? null : numericOrNull(fields.multi_account_suppliers_min_value_gbp)),
    multi_tax_suppliers_min_value_gbp: fields.multi_tax_suppliers_min_value_gbp === undefined
      ? current.multi_tax_suppliers_min_value_gbp
      : (fields.multi_tax_suppliers_min_value_gbp === null ? null : numericOrNull(fields.multi_tax_suppliers_min_value_gbp)),
    purchase_tax_missing_exclude_codes: fields.purchase_tax_missing_exclude_codes === undefined
      ? current.purchase_tax_missing_exclude_codes
      : fields.purchase_tax_missing_exclude_codes,
    duplicate_invoice_window_days: fields.duplicate_invoice_window_days === undefined
      ? current.duplicate_invoice_window_days
      : (fields.duplicate_invoice_window_days === null ? null : (Number.isInteger(Number(fields.duplicate_invoice_window_days)) ? Number(fields.duplicate_invoice_window_days) : null)),
    duplicate_bill_window_days: fields.duplicate_bill_window_days === undefined
      ? current.duplicate_bill_window_days
      : (fields.duplicate_bill_window_days === null ? null : (Number.isInteger(Number(fields.duplicate_bill_window_days)) ? Number(fields.duplicate_bill_window_days) : null)),
    duplicate_invoice_require_exact_reference: fields.duplicate_invoice_require_exact_reference === undefined
      ? current.duplicate_invoice_require_exact_reference
      : triStateBoolOrNull(fields.duplicate_invoice_require_exact_reference),
    duplicate_invoice_include_fully_paid: fields.duplicate_invoice_include_fully_paid === undefined
      ? current.duplicate_invoice_include_fully_paid
      : triStateBoolOrNull(fields.duplicate_invoice_include_fully_paid),
    duplicate_bill_require_exact_reference: fields.duplicate_bill_require_exact_reference === undefined
      ? current.duplicate_bill_require_exact_reference
      : triStateBoolOrNull(fields.duplicate_bill_require_exact_reference),
    duplicate_bill_include_fully_paid: fields.duplicate_bill_include_fully_paid === undefined
      ? current.duplicate_bill_include_fully_paid
      : triStateBoolOrNull(fields.duplicate_bill_include_fully_paid),
    duplicate_invoice_require_exact_total: fields.duplicate_invoice_require_exact_total === undefined
      ? current.duplicate_invoice_require_exact_total
      : triStateBoolOrNull(fields.duplicate_invoice_require_exact_total),
    duplicate_bill_require_exact_total: fields.duplicate_bill_require_exact_total === undefined
      ? current.duplicate_bill_require_exact_total
      : triStateBoolOrNull(fields.duplicate_bill_require_exact_total),
  };
  await getPool().query(`
    UPDATE akrio_organisations SET
      opening_balance_threshold_gbp = ?,
      capital_review_default_threshold_gbp = ?,
      misallocated_items_default_threshold_gbp = ?,
      multi_account_suppliers_min_value_gbp = ?,
      multi_tax_suppliers_min_value_gbp = ?,
      purchase_tax_missing_exclude_codes = ?,
      duplicate_invoice_window_days = ?,
      duplicate_bill_window_days = ?,
      duplicate_invoice_require_exact_reference = ?,
      duplicate_invoice_include_fully_paid = ?,
      duplicate_bill_require_exact_reference = ?,
      duplicate_bill_include_fully_paid = ?,
      duplicate_invoice_require_exact_total = ?,
      duplicate_bill_require_exact_total = ?
    WHERE id = ?
  `, [
    merged.opening_balance_threshold_gbp,
    merged.capital_review_default_threshold_gbp,
    merged.misallocated_items_default_threshold_gbp,
    merged.multi_account_suppliers_min_value_gbp,
    merged.multi_tax_suppliers_min_value_gbp,
    merged.purchase_tax_missing_exclude_codes,
    merged.duplicate_invoice_window_days,
    merged.duplicate_bill_window_days,
    merged.duplicate_invoice_require_exact_reference,
    merged.duplicate_invoice_include_fully_paid,
    merged.duplicate_bill_require_exact_reference,
    merged.duplicate_bill_include_fully_paid,
    merged.duplicate_invoice_require_exact_total,
    merged.duplicate_bill_require_exact_total,
    orgId,
  ]);
}

async function markOrganisationDisconnected(tenantId) {
  await getPool().query(
    `UPDATE akrio_organisations SET connection_status = 'disconnected' WHERE xero_tenant_id = ?`,
    [tenantId]
  );
}

// Health Scores — migrated to the shared MySQL database (akrio_health_scores), moved
// alongside organisations/sync_runs since they're joined together in the queries above.
async function upsertHealthScore(orgId, data) {
  const merged = {
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
  };
  const [result] = await getPool().query(`
    INSERT INTO akrio_health_scores (org_id, score, total_issues, total_potential_errors_gbp,
      last_bank_reconciled, most_recent_transaction, unreconciled_bank_items, lock_date,
      period_key, period_type, period_start, period_end, period_label,
      score_profile_version, score_breakdown_json, run_id, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    merged.org_id, merged.score, merged.total_issues, merged.total_potential_errors_gbp,
    merged.last_bank_reconciled, merged.most_recent_transaction, merged.unreconciled_bank_items,
    merged.lock_date, merged.period_key, merged.period_type, merged.period_start,
    merged.period_end, merged.period_label, merged.score_profile_version,
    merged.score_breakdown_json, merged.run_id, merged.is_active,
  ]);
  return result.insertId;
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
    let values = allocateFindingValues(details, data.potential_value_gbp);
    // Recorded BEFORE contact-exclusion filtering below: whether this check produced a real
    // findings array at all. Distinguishes "a legacy/simple check with no findings array — trust
    // data.count/value as given" from "a real findings array that exclusions happened to filter
    // down to zero" — the latter must still report count 0 / value 0, not silently revert to the
    // original unfiltered numbers.
    const hadDetails = details.length > 0;
    // "Ignore this contact" is a PERMANENT exclusion (contact_exclusions), unlike the per-finding
    // dismiss/ignore below — applied AFTER allocateFindingValues so the excluded contact's own
    // share of the total is what's removed (not the whole total re-inflated across fewer items);
    // this takes effect on every future sync automatically, with no changes needed in any check.
    const excluded = new Set(db.prepare(`
      SELECT contact_key FROM contact_exclusions WHERE org_id = ? AND check_type = ?
    `).all(data.org_id, data.check_type).map(row => row.contact_key));
    if (excluded.size && details.length) {
      const keep = details.map((detail, index) =>
        !excluded.has(normalizeContactKey(detail.contact || detail.name)) ? index : null
      ).filter(index => index !== null);
      details = keep.map(index => details[index]);
      values = keep.map(index => values[index]);
    }
    const activeDetails = details.filter(detail =>
      !detail.displayOnly && !isReviewStateActive(reviewByKey.get(detail.finding_key), data.period_checked)
    );
    const filteredData = hadDetails ? {
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
      detail_json: hadDetails ? null : (data.detail_json || '[]'),
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

// "Ignore this contact" — see contact_exclusions in schema.js. Deliberately takes effect on the
// NEXT sync/reanalyse of this check, not immediately — same as every other check-configuration
// change in this app (e.g. account thresholds). An earlier version also immediately dismissed the
// contact's currently-active findings via finding_review_states, but that left a stale 'dismissed'
// row keyed by a deterministic finding_key hash that outlived the exclusion itself: removing the
// exclusion later did not correctly un-hide the contact, because there was no reliable way to tell
// "dismissed because of this exclusion" apart from "dismissed by the user for an unrelated reason"
// in order to undo only the former. Kept simple and consistent instead of adding that ambiguity.
function addContactExclusion(orgId, checkType, contactName) {
  const db = getDb();
  const contactKey = normalizeContactKey(contactName);
  if (!orgId || !checkType || !contactKey) throw new Error('Missing required field');
  db.prepare(`
    INSERT OR IGNORE INTO contact_exclusions (org_id, check_type, contact_key)
    VALUES (?, ?, ?)
  `).run(orgId, checkType, contactKey);
}

function getContactExclusions(orgId, checkType) {
  const db = getDb();
  return db.prepare(`
    SELECT contact_key, created_at FROM contact_exclusions WHERE org_id = ? AND check_type = ? ORDER BY contact_key
  `).all(orgId, checkType);
}

function removeContactExclusion(orgId, checkType, contactName) {
  const db = getDb();
  const contactKey = normalizeContactKey(contactName);
  db.prepare(`
    DELETE FROM contact_exclusions WHERE org_id = ? AND check_type = ? AND contact_key = ?
  `).run(orgId, checkType, contactKey);
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

// Reads (issues/scoring observations) stay plain sync SQLite calls — only the health_scores
// write below moved to MySQL, so this function is now async purely because of that one write.
async function refreshLatestHealthScore(orgId) {
  const issues = getIssuesForOrg(orgId);
  const scored = issues.filter(row => !NON_SCORED_CHECKS.includes(row.check_type));
  const breakdown = calculateScoreBreakdown(getScoringObservations(orgId), {
    nonScoredChecks: NON_SCORED_CHECKS,
  });
  await getPool().query(`
    UPDATE akrio_health_scores SET score = ?, total_issues = ?, total_potential_errors_gbp = ?,
      score_profile_version = ?, score_breakdown_json = ?
    WHERE id = (SELECT id FROM (SELECT MAX(id) AS id FROM akrio_health_scores WHERE org_id = ? AND is_active = 1) AS latest)
  `, [
    breakdown.score,
    scored.reduce((sum, row) => sum + (row.count || 0), 0),
    scored.reduce((sum, row) => sum + (row.potential_value_gbp || 0), 0),
    breakdown.profileVersion,
    JSON.stringify(breakdown),
    orgId,
  ]);
}

// Shared by both branches of refreshIssueAggregations' UPDATE below — a live (non-reviewed)
// finding is one that isn't display-only and isn't dismissed/currently-ignored/marked-ok-for-this-
// period. Kept as one string so a future change to what counts as "reviewed" can't be applied to
// count but not potential_value_gbp (or vice versa) by editing one copy and missing the other.
const LIVE_FINDING_FILTER_SQL = `
  f.issue_id = issues.id AND f.display_only = 0
  AND NOT COALESCE((
    r.state = 'dismissed'
    OR (r.state = 'ignored' AND datetime(r.ignored_until) > datetime('now'))
    OR (r.state = 'ok' AND r.period_key = issues.period_checked)
  ), 0)
`;

function refreshIssueAggregations(orgId, issueId = null) {
  const db = getDb();
  db.prepare(`
    UPDATE issues SET
      count = CASE
        WHEN count IS NULL THEN NULL
        WHEN NOT EXISTS (SELECT 1 FROM issue_findings source WHERE source.issue_id = issues.id)
          THEN count
        ELSE (
        SELECT COUNT(*) FROM issue_findings f
        LEFT JOIN finding_review_states r
          ON r.org_id = f.org_id AND r.check_type = f.check_type AND r.finding_key = f.finding_key
        WHERE ${LIVE_FINDING_FILTER_SQL}
      ) END,
      potential_value_gbp = CASE
        WHEN count IS NULL THEN potential_value_gbp
        WHEN NOT EXISTS (SELECT 1 FROM issue_findings source WHERE source.issue_id = issues.id)
          THEN potential_value_gbp
        ELSE (
        SELECT COALESCE(SUM(f.potential_value_gbp), 0) FROM issue_findings f
        LEFT JOIN finding_review_states r
          ON r.org_id = f.org_id AND r.check_type = f.check_type AND r.finding_key = f.finding_key
        WHERE ${LIVE_FINDING_FILTER_SQL}
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

// sync_runs — migrated to the shared MySQL database (akrio_sync_runs), moved alongside
// organisations/health_scores since all three are joined together elsewhere in this file.
async function createSyncRun(orgId, mode, periodKey = null) {
  const [result] = await getPool().query(
    `INSERT INTO akrio_sync_runs (org_id, mode, status, period_key) VALUES (?, ?, 'running', ?)`,
    [orgId, mode, periodKey]
  );
  return result.insertId;
}

async function finishSyncRun(runId, status, error = null) {
  await getPool().query(
    `UPDATE akrio_sync_runs SET status = ?, error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [status, error, runId]
  );
}

// This used to be ONE SQLite transaction flipping is_active across health_scores, issues,
// issue_findings, transaction_counts, sync_runs, and organisations all atomically. Now that
// health_scores/sync_runs/organisations live in MySQL while issues/issue_findings/
// transaction_counts stay on SQLite, that single atomic guarantee is no longer possible across
// both — this runs as two sequential transactions (SQLite first, then MySQL). If the process
// crashes between them, the SQLite-side tables (issues/findings/transaction_counts) would show
// the new run's data while health_scores/sync_runs/organisations still show the previous run's —
// a stale-looking dashboard until the next sync, not data loss or corruption. This is an accepted,
// documented tradeoff of the staged migration, not an oversight.
async function activateSyncRun(orgId, runId, checkType = null) {
  const [stagedScoreRows] = await getPool().query(
    `SELECT 1 FROM akrio_health_scores WHERE org_id = ? AND run_id = ? AND is_active = 0`,
    [orgId, runId]
  );
  if (!stagedScoreRows.length) {
    throw new Error('Cannot activate a run without a staged health score');
  }

  const db = getDb();
  if (!checkType && !db.prepare(`
    SELECT 1 FROM transaction_counts WHERE org_id = ? AND run_id = ? AND is_active = 0
  `).get(orgId, runId)) {
    throw new Error('Cannot activate a full run without staged transaction counts');
  }

  // SQLite side first: issues/issue_findings/transaction_counts.
  db.transaction(() => {
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
    db.prepare(`UPDATE issues SET is_active = 1 WHERE org_id = ? AND run_id = ?`).run(orgId, runId);
    db.prepare(`UPDATE issue_findings SET is_active = 1 WHERE org_id = ? AND run_id = ?`).run(orgId, runId);
    if (!checkType) {
      db.prepare(`UPDATE transaction_counts SET is_active = 1 WHERE org_id = ? AND run_id = ?`).run(orgId, runId);
    }
  })();

  // MySQL side second: health_scores/sync_runs/organisations, in one real transaction.
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`UPDATE akrio_health_scores SET is_active = 0 WHERE org_id = ? AND is_active = 1`, [orgId]);
    await conn.query(`UPDATE akrio_health_scores SET is_active = 1 WHERE org_id = ? AND run_id = ?`, [orgId, runId]);
    await conn.query(`UPDATE akrio_sync_runs SET is_active = 0 WHERE org_id = ? AND is_active = 1`, [orgId]);
    await conn.query(
      `UPDATE akrio_sync_runs SET status = 'succeeded', is_active = 1, completed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND org_id = ?`,
      [runId, orgId]
    );
    await conn.query(`UPDATE akrio_organisations SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?`, [orgId]);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function getLastSuccessfulRun(orgId) {
  const [rows] = await getPool().query(
    `SELECT * FROM akrio_sync_runs WHERE org_id = ? AND status = 'succeeded'
     ORDER BY completed_at DESC, id DESC LIMIT 1`,
    [orgId]
  );
  return rows[0] || null;
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

// orgId is defense-in-depth, not the primary guard: today's only caller (client.js) already
// resolves issueId from an org_id-scoped getIssueByCheckType lookup, so this can't currently be
// reached with a mismatched (issueId, orgId) pair. Requiring orgId here anyway means a future
// caller that skips that lookup fails closed (returns nothing) instead of silently leaking another
// organisation's finding detail if it ever passed the wrong issueId.
function getIssueFindings(issueId, orgId, page = 1, pageSize = 50, status = 'active') {
  const db = getDb();
  const safeSize = Math.min(100, Math.max(1, Number(pageSize) || 50));
  const allowedStatus = ['active', 'dismissed', 'ignored', 'ok', 'all'].includes(status) ? status : 'active';
  const effectiveState = `CASE
    WHEN r.state = 'dismissed' THEN 'dismissed'
    WHEN r.state = 'ignored' AND datetime(r.ignored_until) > datetime('now') THEN 'ignored'
    WHEN r.state = 'ok' AND r.period_key = i.period_checked THEN 'ok'
    ELSE 'active' END`;
  const where = allowedStatus === 'all' ? '' : `AND (${effectiveState}) = ?`;
  const params = allowedStatus === 'all' ? [issueId, orgId] : [issueId, orgId, allowedStatus];
  const total = db.prepare(`
    SELECT COUNT(*) AS count
    FROM issue_findings f
    JOIN issues i ON i.id = f.issue_id
    LEFT JOIN finding_review_states r
      ON r.org_id = f.org_id AND r.check_type = f.check_type AND r.finding_key = f.finding_key
    WHERE f.issue_id = ? AND f.org_id = ? ${where}
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
    WHERE f.issue_id = ? AND f.org_id = ? ${where}
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

// For a bulk "act on every matching finding" action (e.g. "Ignore all N items") — deliberately
// uncapped, unlike getIssueFindings' pageSize (capped at 100 for normal display pagination), since
// a real check can have thousands of active findings (e.g. Rose's purchase_tax_missing at 2952) and
// a bulk action must reach all of them, not silently the first 100.
function getAllFindingKeysForIssue(issueId, orgId, status = 'active') {
  const db = getDb();
  const allowedStatus = ['active', 'dismissed', 'ignored', 'ok', 'all'].includes(status) ? status : 'active';
  const effectiveState = `CASE
    WHEN r.state = 'dismissed' THEN 'dismissed'
    WHEN r.state = 'ignored' AND datetime(r.ignored_until) > datetime('now') THEN 'ignored'
    WHEN r.state = 'ok' AND r.period_key = i.period_checked THEN 'ok'
    ELSE 'active' END`;
  const where = allowedStatus === 'all' ? '' : `AND (${effectiveState}) = ?`;
  const params = allowedStatus === 'all' ? [issueId, orgId] : [issueId, orgId, allowedStatus];
  return db.prepare(`
    SELECT f.finding_key
    FROM issue_findings f
    JOIN issues i ON i.id = f.issue_id
    LEFT JOIN finding_review_states r
      ON r.org_id = f.org_id AND r.check_type = f.check_type AND r.finding_key = f.finding_key
    WHERE f.issue_id = ? AND f.org_id = ? ${where}
  `).all(...params).map(row => row.finding_key);
}

// orgId is defense-in-depth here too — see getIssueFindings above for why.
function getIssueFindingSummary(issueId, orgId) {
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
    WHERE f.issue_id = ? AND f.org_id = ?
    GROUP BY status
  `).all(issueId, orgId);
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

// The finding_review_states/finding_review_audit/issues work below is all SQLite and stays one
// atomic transaction. Only the final health_scores recalculation moved to MySQL (see
// refreshLatestHealthScore) — it now runs as a separate step after the SQLite transaction
// commits, same two-phase pattern as activateSyncRun, and reuses that function instead of
// duplicating the score-recalculation logic that used to be inlined here.
async function setFindingReviewStates(orgId, checkType, findingKeys, state, notes = null) {
  if (!['dismissed', 'ignored', 'ok', 'restore'].includes(state)) throw new Error('Invalid review state');
  const db = getDb();
  const uniqueKeys = [...new Set(findingKeys.filter(Boolean))];
  if (!uniqueKeys.length) return 0;
  const changed = db.transaction(() => {
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
    return changed;
  })();
  await refreshLatestHealthScore(orgId);
  return changed;
}

// Per-transaction "reviewed" audit trail for checks with a drill-down (multi_account_suppliers,
// multi_tax_suppliers) — see finding_line_reviews in schema.js. Deliberately does not touch
// issues/health_scores: a transaction-level mark never changes the parent finding's count/value.
function setLineReviewState(orgId, checkType, findingKey, lineKey, ok, notes = null) {
  if (!orgId || !checkType || !findingKey || !lineKey) throw new Error('Missing required field');
  const db = getDb();
  db.prepare(`
    INSERT INTO finding_line_reviews (org_id, check_type, finding_key, line_key, ok, notes)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id, check_type, finding_key, line_key) DO UPDATE SET
      ok = excluded.ok, notes = excluded.notes, updated_at = CURRENT_TIMESTAMP
  `).run(orgId, checkType, findingKey, lineKey, ok ? 1 : 0, notes || null);
}

// Returns a { [lineKey]: { ok, notes } } map for one contact-level finding, for the drill-down UI.
function getLineReviewStates(orgId, checkType, findingKey) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT line_key, ok, notes FROM finding_line_reviews
    WHERE org_id = ? AND check_type = ? AND finding_key = ?
  `).all(orgId, checkType, findingKey);
  const map = {};
  for (const row of rows) map[row.line_key] = { ok: !!row.ok, notes: row.notes };
  return map;
}

// A note attached to a finding independent of its dismiss/ignore/ok review state — see
// finding_notes in schema.js. Never touches finding_review_states or the parent issue's
// count/value/score.
function setFindingNote(orgId, checkType, findingKey, notes) {
  if (!orgId || !checkType || !findingKey) throw new Error('Missing required field');
  const db = getDb();
  db.prepare(`
    INSERT INTO finding_notes (org_id, check_type, finding_key, notes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(org_id, check_type, finding_key) DO UPDATE SET
      notes = excluded.notes, updated_at = CURRENT_TIMESTAMP
  `).run(orgId, checkType, findingKey, notes || null);
}

// Returns a { [finding_key]: note } map for one check, for bulk display alongside a findings list.
function getFindingNotes(orgId, checkType) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT finding_key, notes FROM finding_notes WHERE org_id = ? AND check_type = ?
  `).all(orgId, checkType);
  const map = {};
  for (const row of rows) map[row.finding_key] = row.notes;
  return map;
}

// Tokens
// xero_tokens — migrated to the shared MySQL database (akrio_xero_tokens), moved alongside
// organisations since they're joined together below.
async function upsertToken(data) {
  await getPool().query(
    `INSERT INTO akrio_xero_tokens (xero_tenant_id, access_token, refresh_token, expires_at)
     VALUES (?, ?, ?, ?) AS new
     ON DUPLICATE KEY UPDATE
       access_token = new.access_token,
       refresh_token = new.refresh_token,
       expires_at = new.expires_at,
       updated_at = CURRENT_TIMESTAMP`,
    [data.xero_tenant_id, data.access_token, data.refresh_token, data.expires_at]
  );
}

// A single Xero consent covers every tenant the user ticked, and Xero issues ONE token set for that
// whole connection — so auth.js stores the same refresh_token against each of those tenant rows.
// Refresh tokens are single-use: refreshing rotates them and invalidates the previous one. Writing
// the rotated token back for only the tenant being synced therefore left every other tenant on the
// consumed token, and the next sync of any of them died with
// "invalid_grant (Refresh token has been consumed)". Observed live: six tenants sharing one token,
// of which only the last one synced still worked. Propagate the rotation across the connection.
async function upsertTokenForConnection(previousRefreshToken, data) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    let propagated = 0;
    if (previousRefreshToken && previousRefreshToken !== data.refresh_token) {
      const [result] = await conn.query(
        `UPDATE akrio_xero_tokens
         SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP
         WHERE refresh_token = ?`,
        [data.access_token, data.refresh_token, data.expires_at, previousRefreshToken]
      );
      propagated = result.affectedRows;
    }
    // Always write the syncing tenant's own row, so it is correct even if it did not share a token.
    await conn.query(
      `INSERT INTO akrio_xero_tokens (xero_tenant_id, access_token, refresh_token, expires_at)
       VALUES (?, ?, ?, ?) AS new
       ON DUPLICATE KEY UPDATE
         access_token = new.access_token,
         refresh_token = new.refresh_token,
         expires_at = new.expires_at,
         updated_at = CURRENT_TIMESTAMP`,
      [data.xero_tenant_id, data.access_token, data.refresh_token, data.expires_at]
    );
    await conn.commit();
    return propagated;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

// When a refresh token is genuinely rejected, the whole connection is dead — not just the tenant
// that happened to be syncing. Marking only that one left the others showing "connected" in the UI
// when they were not.
async function markConnectionDisconnected(refreshToken, tenantId) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    let affected = 0;
    if (refreshToken) {
      const [result] = await conn.query(
        `UPDATE akrio_organisations SET connection_status = 'disconnected'
         WHERE xero_tenant_id IN (
           SELECT xero_tenant_id FROM akrio_xero_tokens WHERE refresh_token = ?
         )`,
        [refreshToken]
      );
      affected = result.affectedRows;
    }
    if (tenantId) {
      await conn.query(
        `UPDATE akrio_organisations SET connection_status = 'disconnected' WHERE xero_tenant_id = ?`,
        [tenantId]
      );
    }
    await conn.commit();
    return affected;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function getToken(tenantId) {
  const [rows] = await getPool().query(`SELECT * FROM akrio_xero_tokens WHERE xero_tenant_id = ?`, [tenantId]);
  return rows[0] || null;
}

// Tenants sharing one refresh token are one Xero connection; used to explain a dead connection.
async function getTenantsSharingRefreshToken(refreshToken) {
  if (!refreshToken) return [];
  const [rows] = await getPool().query(
    `SELECT t.xero_tenant_id, o.name
     FROM akrio_xero_tokens t LEFT JOIN akrio_organisations o ON o.xero_tenant_id = t.xero_tenant_id
     WHERE t.refresh_token = ?`,
    [refreshToken]
  );
  return rows;
}

async function deleteToken(tenantId) {
  await getPool().query(`DELETE FROM akrio_xero_tokens WHERE xero_tenant_id = ?`, [tenantId]);
}

// freeagent_tokens — one row per company, no shared-refresh-token propagation needed (unlike
// Xero, FreeAgent tokens are always one-company-per-token).
async function getFreeAgentToken(companyId) {
  const [rows] = await getPool().query(
    `SELECT * FROM akrio_freeagent_tokens WHERE freeagent_company_id = ?`, [companyId]
  );
  return rows[0] || null;
}

async function upsertFreeAgentToken(data) {
  await getPool().query(
    `INSERT INTO akrio_freeagent_tokens (freeagent_company_id, access_token, refresh_token, expires_at)
     VALUES (?, ?, ?, ?) AS new
     ON DUPLICATE KEY UPDATE
       access_token = new.access_token,
       refresh_token = new.refresh_token,
       expires_at = new.expires_at,
       updated_at = CURRENT_TIMESTAMP`,
    [data.freeagent_company_id, data.access_token, data.refresh_token, data.expires_at]
  );
}

async function deleteFreeAgentToken(companyId) {
  await getPool().query(`DELETE FROM akrio_freeagent_tokens WHERE freeagent_company_id = ?`, [companyId]);
}

// Creates or updates the Akrio organisation row for a connected FreeAgent company — the
// FreeAgent equivalent of upsertOrganisation, keyed by freeagent_company_id instead of
// xero_tenant_id (a client has exactly one of the two set, never both).
async function upsertFreeAgentOrganisation(data) {
  await getPool().query(
    `INSERT INTO akrio_organisations
       (freeagent_company_id, name, client_ref, tag, connection_status, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?) AS new
     ON DUPLICATE KEY UPDATE
       name = new.name,
       connection_status = new.connection_status,
       last_synced_at = COALESCE(new.last_synced_at, akrio_organisations.last_synced_at)`,
    [data.freeagent_company_id, data.name, data.client_ref, data.tag, data.connection_status, data.last_synced_at]
  );
}

async function getOrganisationByFreeAgentCompanyId(companyId) {
  const [rows] = await getPool().query(`
    SELECT o.*, hs.score, hs.total_issues, hs.total_potential_errors_gbp,
           hs.last_bank_reconciled, hs.most_recent_transaction,
           hs.unreconciled_bank_items, hs.lock_date, hs.score_profile_version,
           hs.score_breakdown_json, hs.calculated_at, hs.period_key, hs.period_type,
           hs.period_start, hs.period_end, hs.period_label,
           (SELECT MAX(completed_at) FROM akrio_sync_runs
            WHERE org_id = o.id AND status = 'succeeded') AS last_successful_sync_at
    FROM akrio_organisations o
    LEFT JOIN akrio_health_scores hs ON hs.org_id = o.id
      AND hs.id = (SELECT MAX(id) FROM akrio_health_scores WHERE org_id = o.id AND is_active = 1)
    WHERE o.freeagent_company_id = ?
  `, [companyId]);
  return rows[0] || null;
}

async function markOrganisationDisconnectedByFreeAgentCompany(companyId) {
  await getPool().query(
    `UPDATE akrio_organisations SET connection_status = 'disconnected' WHERE freeagent_company_id = ?`,
    [companyId]
  );
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

// Bank Balance / Unreconciled Bank Items exclusions — organisation-scoped, per bank account.
function getExcludedBankAccountIds(orgId) {
  const rows = getDb().prepare(`SELECT bank_account_id FROM bank_account_exclusions WHERE org_id = ?`).all(orgId);
  return new Set(rows.map(row => row.bank_account_id));
}

function setBankAccountExcluded(orgId, bankAccountId, excluded) {
  const db = getDb();
  if (excluded) {
    db.prepare(`
      INSERT INTO bank_account_exclusions (org_id, bank_account_id) VALUES (?, ?)
      ON CONFLICT(org_id, bank_account_id) DO NOTHING
    `).run(orgId, bankAccountId);
  } else {
    db.prepare(`DELETE FROM bank_account_exclusions WHERE org_id = ? AND bank_account_id = ?`).run(orgId, bankAccountId);
  }
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
async function updateOrganisationCompanyNumber(orgId, companyNumber) {
  await getPool().query(
    `UPDATE akrio_organisations SET company_number = ? WHERE id = ?`,
    [companyNumber || null, orgId]
  );
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

async function setAccountCheckConfiguration(orgId, configurations) {
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
  // First save flips this org from "never configured" (xeroSync.js still auto-adds Xenon's
  // documented 461/473 defaults if present) to "explicitly configured" (is_capital_candidate is
  // trusted verbatim from here on, including a deliberate 0 on 461 or 473 — a real opt-out).
  // organisations now lives in MySQL, so this runs as a separate step after the SQLite
  // transaction above commits (same two-phase pattern as activateSyncRun).
  await getPool().query(`UPDATE akrio_organisations SET account_settings_initialised = 1 WHERE id = ?`, [orgId]);
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

// validation_snapshots stays on SQLite; organisations moved to MySQL, so the org name/tenant-id
// join is now a separate MySQL lookup merged in JS instead of one SQL join.
async function getValidationSnapshots() {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM validation_snapshots ORDER BY created_at DESC, id DESC`).all();
  const orgIds = [...new Set(rows.map(row => row.org_id))];
  const orgById = new Map();
  if (orgIds.length) {
    const [orgRows] = await getPool().query(
      `SELECT id, name, xero_tenant_id FROM akrio_organisations WHERE id IN (?)`,
      [orgIds]
    );
    for (const org of orgRows) orgById.set(org.id, org);
  }
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
    const org = orgById.get(row.org_id);
    return {
      id: row.id,
      orgId: row.org_id,
      orgName: org?.name,
      tenantId: org?.xero_tenant_id,
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
async function getValidationRunForPeriod(orgId, periodKey) {
  const db = getDb();
  const [scoreRows] = await getPool().query(`
    SELECT hs.*, sr.status AS run_status, sr.completed_at AS run_completed_at
    FROM akrio_health_scores hs
    LEFT JOIN akrio_sync_runs sr ON sr.id = hs.run_id
    WHERE hs.org_id = ? AND hs.period_key = ? AND sr.status = 'succeeded'
    ORDER BY hs.id DESC LIMIT 1
  `, [orgId, periodKey]);
  const score = scoreRows[0];
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

async function getActiveValidationRuns() {
  const db = getDb();
  // The run's provenance travels with it: the gate must be able to tell a score row a real
  // sync produced from one that was edited or left behind by a failed run.
  const [scores] = await getPool().query(`
    SELECT hs.*, sr.status AS run_status, sr.completed_at AS run_completed_at
    FROM akrio_health_scores hs
    LEFT JOIN akrio_sync_runs sr ON sr.id = hs.run_id
    WHERE hs.is_active = 1 AND hs.id = (
      SELECT MAX(latest.id) FROM akrio_health_scores latest
      WHERE latest.org_id = hs.org_id AND latest.is_active = 1
    )
  `);
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
      credit_notes_sales, credit_notes_purchase, bank_processed, journals,
      turnover_pl_value, turnover_pl_mismatch, run_id, is_active)
    VALUES (@org_id, @period, @period_start, @period_end, @months_covered,
      @turnover, @total_transactions, @customer_invoices, @supplier_bills,
      @credit_notes_sales, @credit_notes_purchase, @bank_processed, @journals,
      @turnover_pl_value, @turnover_pl_mismatch, @run_id, @is_active)
  `).run({
    run_id: null, is_active: 1, turnover_pl_value: null, turnover_pl_mismatch: 0,
    org_id: orgId, ...data,
  });
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

// organisations moved to MySQL; transaction_counts stays on SQLite, so the join becomes a
// separate MySQL org list + a SQLite per-org latest-transaction-count lookup, merged in JS.
async function getAllTransactionCounts(periodType = null, periodStart = null, periodEnd = null) {
  const db = getDb();
  const [orgs] = await getPool().query(
    `SELECT id, xero_tenant_id, name, client_ref, connection_status, last_synced_at
     FROM akrio_organisations ORDER BY name`
  );
  const countQuery = db.prepare(`
    SELECT period, period_start, period_end, months_covered, turnover, total_transactions,
           customer_invoices, supplier_bills, credit_notes_sales, credit_notes_purchase,
           bank_processed, journals
    FROM transaction_counts
    WHERE org_id = ? AND is_active = 1 AND (? IS NULL OR period = ?)
      AND (? IS NULL OR period_start = ?) AND (? IS NULL OR period_end = ?)
    ORDER BY synced_at DESC, id DESC LIMIT 1
  `);
  return orgs.map(o => {
    const tc = countQuery.get(o.id, periodType, periodType, periodStart, periodStart, periodEnd, periodEnd) || {};
    return {
      xero_tenant_id: o.xero_tenant_id, name: o.name, client_ref: o.client_ref,
      connection_status: o.connection_status, last_synced_at: o.last_synced_at,
      period: tc.period, period_start: tc.period_start, period_end: tc.period_end,
      months_covered: tc.months_covered, turnover: tc.turnover,
      total_transactions: tc.total_transactions, customer_invoices: tc.customer_invoices,
      supplier_bills: tc.supplier_bills, credit_notes_sales: tc.credit_notes_sales,
      credit_notes_purchase: tc.credit_notes_purchase, bank_processed: tc.bank_processed,
      journals: tc.journals,
    };
  });
}

// organisations/health_scores/sync_runs now live in MySQL; issues stays on SQLite. This used
// to be one SQL query joining all four — now it's a MySQL query for the first three (mirrors
// getAllOrganisations) plus a separate SQLite query for the issue breakdown, merged by org_id
// in JS below (not a SQL join, so no cross-database query is needed).
async function getPanoramaOrganisations() {
  const [orgRows] = await getPool().query(`
    SELECT o.*, hs.score, hs.total_issues, hs.total_potential_errors_gbp,
      hs.last_bank_reconciled, hs.most_recent_transaction, hs.unreconciled_bank_items,
      hs.lock_date, hs.calculated_at, hs.period_key, hs.period_label,
      (SELECT MAX(completed_at) FROM akrio_sync_runs sr
       WHERE sr.org_id = o.id AND sr.status = 'succeeded') AS last_successful_sync_at
    FROM akrio_organisations o
    LEFT JOIN akrio_health_scores hs ON hs.org_id = o.id
      AND hs.id = (SELECT MAX(id) FROM akrio_health_scores WHERE org_id = o.id AND is_active = 1)
    ORDER BY o.name
  `);

  const issueRows = getDb().prepare(`
    SELECT org_id, check_type, importance, count, potential_value_gbp
    FROM issues WHERE is_active = 1 AND COALESCE(count, 0) > 0
  `).all();
  const breakdownByOrg = new Map();
  for (const row of issueRows) {
    const list = breakdownByOrg.get(row.org_id) || [];
    list.push({
      checkType: row.check_type, importance: row.importance,
      count: row.count, potentialValue: row.potential_value_gbp,
    });
    breakdownByOrg.set(row.org_id, list);
  }

  return orgRows.map(row => ({ ...row, issueBreakdown: breakdownByOrg.get(row.id) || [] }));
}

// Staff login / access control — migrated to the shared MySQL database (akrio_staff_users /
// akrio_staff_org_access), see scripts/mysql-schema.sql.
async function getAllStaff() {
  const [rows] = await getPool().query(`SELECT * FROM akrio_staff_users ORDER BY name`);
  return rows;
}

// Case-insensitive/trimmed, matching how MTAKPI itself resolves a login and how the mtakpi
// pairing is meant to be looked up regardless of how the admin originally typed it in.
async function getStaffByMtakpiName(mtakpiStaffName) {
  const name = String(mtakpiStaffName || '').trim();
  const [rows] = await getPool().query(
    `SELECT * FROM akrio_staff_users WHERE LOWER(TRIM(mtakpi_staff_name)) = LOWER(?)`,
    [name]
  );
  return rows[0] || null;
}

async function getStaffById(id) {
  const [rows] = await getPool().query(`SELECT * FROM akrio_staff_users WHERE id = ?`, [id]);
  return rows[0] || null;
}

async function createStaff({ mtakpi_staff_name, name, initials, role }) {
  const [result] = await getPool().query(
    `INSERT INTO akrio_staff_users (mtakpi_staff_name, name, initials, role) VALUES (?, ?, ?, ?)`,
    [mtakpi_staff_name, name, initials, role]
  );
  return getStaffById(result.insertId);
}

// Bulk import from the "Import from MTAKPI" picker — skips (rather than errors on) a name
// already linked, since the picker's own list already excludes them but a race between two
// admins importing at once is still possible.
async function createStaffBulk(entries) {
  if (!entries.length) return 0;
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let created = 0;
    for (const row of entries) {
      const [result] = await conn.query(
        `INSERT IGNORE INTO akrio_staff_users (mtakpi_staff_name, name, initials, role)
         VALUES (?, ?, ?, ?)`,
        [row.mtakpi_staff_name, row.name, row.initials, row.role]
      );
      if (result.affectedRows > 0) created++;
    }
    await conn.commit();
    return created;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function deactivateStaff(id) {
  await getPool().query(`UPDATE akrio_staff_users SET is_active = 0 WHERE id = ?`, [id]);
}

async function reactivateStaff(id) {
  await getPool().query(`UPDATE akrio_staff_users SET is_active = 1 WHERE id = ?`, [id]);
}

async function touchStaffLastLogin(id) {
  await getPool().query(`UPDATE akrio_staff_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
}

// Permission checks (only super_admin may set role to admin/super_admin) live in the route
// layer via src/services/staffPermissions.js — this is a plain write, trusted to have already
// been authorized by the caller.
async function updateStaffRole(id, role) {
  await getPool().query(`UPDATE akrio_staff_users SET role = ? WHERE id = ?`, [role, id]);
}

async function updateStaffInitials(id, initials) {
  await getPool().query(`UPDATE akrio_staff_users SET initials = ? WHERE id = ?`, [initials, id]);
}

async function setStaffCanManageSettings(id, canManage) {
  await getPool().query(
    `UPDATE akrio_staff_users SET can_manage_settings = ? WHERE id = ?`,
    [canManage ? 1 : 0, id]
  );
}

// Hard delete — distinct from deactivateStaff (the soft-delete default used elsewhere in this
// app). Offered explicitly for removing an account added by mistake (e.g. the wrong MTAKPI name
// picked during import) rather than leaving permanent clutter; ON DELETE CASCADE on
// staff_org_access cleans up any access grants for this account automatically.
async function deleteStaff(id) {
  await getPool().query(`DELETE FROM akrio_staff_users WHERE id = ?`, [id]);
}

async function staffHasOrgAccess(staffId, orgId) {
  const [rows] = await getPool().query(
    `SELECT 1 FROM akrio_staff_org_access WHERE staff_id = ? AND org_id = ?`,
    [staffId, orgId]
  );
  return rows.length > 0;
}

async function getOrgIdsForStaff(staffId) {
  const [rows] = await getPool().query(
    `SELECT org_id FROM akrio_staff_org_access WHERE staff_id = ?`,
    [staffId]
  );
  return rows.map(row => row.org_id);
}

// Active staff assigned to an org, for the client-list "Team Member Access" avatar badges.
async function getStaffForOrg(orgId) {
  const [rows] = await getPool().query(
    `SELECT su.id, su.name, su.initials
     FROM akrio_staff_org_access soa
     JOIN akrio_staff_users su ON su.id = soa.staff_id
     WHERE soa.org_id = ? AND su.is_active = 1
     ORDER BY su.name`,
    [orgId]
  );
  return rows;
}

// Replaces a staff member's ENTIRE org-access set in one transaction — the primary editing
// surface (a full-page checklist of every org) submits the whole new set at once.
async function replaceStaffOrgAccess(staffId, orgIds) {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM akrio_staff_org_access WHERE staff_id = ?`, [staffId]);
    for (const orgId of orgIds) {
      await conn.query(
        `INSERT INTO akrio_staff_org_access (staff_id, org_id) VALUES (?, ?)`,
        [staffId, orgId]
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

// Toggles a single (staff, org) pair — the client-list "+" popover's quick-add/remove shortcut,
// writing to the same join table as replaceStaffOrgAccess but scoped to one pair at a time.
async function toggleStaffOrgAccess(staffId, orgId, grant) {
  if (grant) {
    await getPool().query(
      `INSERT IGNORE INTO akrio_staff_org_access (staff_id, org_id) VALUES (?, ?)`,
      [staffId, orgId]
    );
  } else {
    await getPool().query(
      `DELETE FROM akrio_staff_org_access WHERE staff_id = ? AND org_id = ?`,
      [staffId, orgId]
    );
  }
}

// --- Insight cache ---
function saveInsightData(orgId, reportType, data) {
  const db = getDb();
  db.prepare(`
    INSERT INTO insight_cache (org_id, report_type, data_json, fetched_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(org_id, report_type) DO UPDATE SET data_json=excluded.data_json, fetched_at=excluded.fetched_at
  `).run(orgId, reportType, JSON.stringify(data));
}

function getInsightData(orgId, reportType) {
  const db = getDb();
  const row = db.prepare(`SELECT data_json, fetched_at FROM insight_cache WHERE org_id=? AND report_type=?`).get(orgId, reportType);
  if (!row) return null;
  try { return { data: JSON.parse(row.data_json), fetchedAt: row.fetched_at }; } catch { return null; }
}

function getAllInsightData(orgId) {
  const db = getDb();
  const rows = db.prepare(`SELECT report_type, data_json, fetched_at FROM insight_cache WHERE org_id=?`).all(orgId);
  const result = {};
  for (const row of rows) {
    try { result[row.report_type] = { data: JSON.parse(row.data_json), fetchedAt: row.fetched_at }; } catch {}
  }
  return result;
}

// --- Insight account mappings (which Xero accounts feed each KPI) ---
function getInsightAccountMappings(orgId) {
  const db = getDb();
  const rows = db.prepare(`SELECT category, account_code FROM insight_account_mappings WHERE org_id=?`).all(orgId);
  const result = {};
  for (const row of rows) {
    (result[row.category] = result[row.category] || []).push(row.account_code);
  }
  return result;
}

function setInsightAccountMapping(orgId, category, accountCodes) {
  const db = getDb();
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM insight_account_mappings WHERE org_id=? AND category=?`).run(orgId, category);
    const insert = db.prepare(`INSERT INTO insight_account_mappings (org_id, category, account_code) VALUES (?, ?, ?)`);
    for (const code of accountCodes) if (code) insert.run(orgId, category, code);
  });
  run();
}

// --- Insight category settings (Cash Health include/override toggles) ---
function getInsightCategorySettings(orgId) {
  const db = getDb();
  const rows = db.prepare(`SELECT category, enabled, override_enabled, override_value FROM insight_category_settings WHERE org_id=?`).all(orgId);
  const result = {};
  for (const row of rows) {
    result[row.category] = {
      enabled: !!row.enabled,
      overrideEnabled: !!row.override_enabled,
      overrideValue: row.override_value,
    };
  }
  return result;
}

function setInsightCategorySetting(orgId, category, { enabled, overrideEnabled, overrideValue }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO insight_category_settings (org_id, category, enabled, override_enabled, override_value)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(org_id, category) DO UPDATE SET
      enabled=excluded.enabled, override_enabled=excluded.override_enabled, override_value=excluded.override_value
  `).run(orgId, category, enabled ? 1 : 0, overrideEnabled ? 1 : 0, overrideValue ?? null);
}

// --- Insight dashboard widget visibility ---
function getInsightWidgetVisibility(orgId) {
  const db = getDb();
  const rows = db.prepare(`SELECT widget_key, visible, pdf_visible FROM insight_widget_visibility WHERE org_id=?`).all(orgId);
  const result = {};
  for (const row of rows) result[row.widget_key] = { visible: !!row.visible, pdfVisible: !!row.pdf_visible };
  return result;
}

function setInsightWidgetVisibility(orgId, widgetKey, visible, pdfVisible) {
  const db = getDb();
  db.prepare(`
    INSERT INTO insight_widget_visibility (org_id, widget_key, visible, pdf_visible)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(org_id, widget_key) DO UPDATE SET visible=excluded.visible, pdf_visible=excluded.pdf_visible
  `).run(orgId, widgetKey, visible ? 1 : 0, pdfVisible ? 1 : 0);
}

// --- Insight misc key/value settings (target basis, valuation model, etc.) ---
function getInsightSettingsKv(orgId) {
  const db = getDb();
  const rows = db.prepare(`SELECT key, value FROM insight_settings_kv WHERE org_id=?`).all(orgId);
  const result = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

function setInsightSettingsKv(orgId, key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO insight_settings_kv (org_id, key, value)
    VALUES (?, ?, ?)
    ON CONFLICT(org_id, key) DO UPDATE SET value=excluded.value
  `).run(orgId, key, value == null ? null : String(value));
}

// --- Insight corp tax custom rate bands ---
function getInsightCorpTaxRateBands(orgId) {
  const db = getDb();
  return db.prepare(`SELECT id, effective_date, rate_pct FROM insight_corp_tax_rate_bands WHERE org_id=? ORDER BY effective_date DESC`).all(orgId);
}

function addInsightCorpTaxRateBand(orgId, effectiveDate, ratePct) {
  const db = getDb();
  db.prepare(`INSERT INTO insight_corp_tax_rate_bands (org_id, effective_date, rate_pct) VALUES (?, ?, ?)`).run(orgId, effectiveDate, ratePct);
}

function deleteInsightCorpTaxRateBand(orgId, id) {
  const db = getDb();
  db.prepare(`DELETE FROM insight_corp_tax_rate_bands WHERE org_id=? AND id=?`).run(orgId, id);
}

// --- Insight corp tax adjustments (addback / deduct_other / capital_allowance) ---
function getInsightCorpTaxAdjustments(orgId, adjustmentType) {
  const db = getDb();
  return db.prepare(`
    SELECT id, account_code, pct, treatment FROM insight_corp_tax_adjustments WHERE org_id=? AND adjustment_type=?
  `).all(orgId, adjustmentType);
}

function setInsightCorpTaxAdjustment(orgId, adjustmentType, accountCode, { pct, treatment }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO insight_corp_tax_adjustments (org_id, adjustment_type, account_code, pct, treatment)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(org_id, adjustment_type, account_code) DO UPDATE SET pct=excluded.pct, treatment=excluded.treatment
  `).run(orgId, adjustmentType, accountCode, pct ?? null, treatment ?? null);
}

function deleteInsightCorpTaxAdjustment(orgId, adjustmentType, accountCode) {
  const db = getDb();
  db.prepare(`DELETE FROM insight_corp_tax_adjustments WHERE org_id=? AND adjustment_type=? AND account_code=?`).run(orgId, adjustmentType, accountCode);
}

module.exports = {
  upsertOrganisation, getAllOrganisations, getOrganisationByTenantId, getOrganisationById,
  updateOrganisationMeta, updateOrganisationAccountingSettings, updateOrganisationSupplierPatternLookback,
  updateOrganisationMultiAccountPatternLookback, updateOrganisationCheckConfig,
  markOrganisationDisconnected,
  upsertHealthScore, deleteIssuesForOrg, insertIssue, replaceIssueForCheck, refreshLatestHealthScore,
  getIssuesForOrg, getScoringObservations, getIssueByCheckType,
  getIssuesForRun, getScoringObservationsForRun,
  getIssueFindings, getIssueFindingSummary, getReportFindings, setFindingReviewStates,
  setLineReviewState, getLineReviewStates, setFindingNote, getFindingNotes, getAllFindingKeysForIssue,
  addContactExclusion, getContactExclusions, removeContactExclusion,
  upsertToken, upsertTokenForConnection, markConnectionDisconnected,
  getTenantsSharingRefreshToken, getToken, deleteToken, getSetting, setSetting,
  getFreeAgentToken, upsertFreeAgentToken, deleteFreeAgentToken, upsertFreeAgentOrganisation,
  getOrganisationByFreeAgentCompanyId, markOrganisationDisconnectedByFreeAgentCompany,
  upsertTransactionCounts, getTransactionCountsForOrg, getAllTransactionCounts, getPanoramaOrganisations,
  upsertBankReconciliationXeroBalance, updateStatementBalance, getBankReconciliationForOrg,
  getExcludedBankAccountIds, setBankAccountExcluded,
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
  getValidationRunForPeriod, getValidationGateAssurances, setValidationGateAssurance,
  getAllStaff, getStaffByMtakpiName, getStaffById, createStaff, createStaffBulk, deactivateStaff, reactivateStaff,
  touchStaffLastLogin, staffHasOrgAccess, getOrgIdsForStaff, getStaffForOrg,
  replaceStaffOrgAccess, toggleStaffOrgAccess,
  updateStaffRole, updateStaffInitials, setStaffCanManageSettings, deleteStaff,
  saveInsightData, getInsightData, getAllInsightData,
  getInsightAccountMappings, setInsightAccountMapping,
  getInsightCategorySettings, setInsightCategorySetting,
  getInsightWidgetVisibility, setInsightWidgetVisibility,
  getInsightSettingsKv, setInsightSettingsKv,
  getInsightCorpTaxRateBands, addInsightCorpTaxRateBand, deleteInsightCorpTaxRateBand,
  getInsightCorpTaxAdjustments, setInsightCorpTaxAdjustment, deleteInsightCorpTaxAdjustment,
};
