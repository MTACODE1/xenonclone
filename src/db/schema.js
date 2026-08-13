const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.XERO_DASHBOARD_DB_PATH || path.join(__dirname, '../../data/xero_dashboard.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organisations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      xero_tenant_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      client_ref TEXT,
      tag TEXT,
      connection_status TEXT DEFAULT 'connected',
      last_synced_at DATETIME,
      financial_year_end_day INTEGER,
      financial_year_end_month INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS health_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER REFERENCES organisations(id),
      score INTEGER,
      total_issues INTEGER DEFAULT 0,
      total_potential_errors_gbp REAL DEFAULT 0,
      last_bank_reconciled DATE,
      most_recent_transaction DATE,
      unreconciled_bank_items INTEGER DEFAULT 0,
      lock_date DATE,
      period_key TEXT,
      period_type TEXT,
      period_start DATE,
      period_end DATE,
      period_label TEXT,
      score_profile_version TEXT,
      score_breakdown_json TEXT,
      calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER REFERENCES organisations(id),
      check_type TEXT NOT NULL,
      importance TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      potential_value_gbp REAL DEFAULT 0,
      detail_json TEXT,
      period_checked TEXT,
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS xero_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      xero_tenant_id TEXT UNIQUE NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Bank Balance Check: xero_calculated_balance is refreshed every sync from
    -- the Bank Summary report; statement_balance is typed in by the accountant from the actual
    -- bank statement and is never touched by sync. Comparing the two gives the genuine balance
    -- discrepancy used by bank_balance.
    CREATE TABLE IF NOT EXISTS bank_reconciliation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER REFERENCES organisations(id),
      bank_account_id TEXT NOT NULL,
      bank_account_name TEXT,
      xero_calculated_balance REAL,
      xero_balance_as_of DATE,
      statement_balance REAL,
      statement_balance_updated_at DATETIME,
      UNIQUE(org_id, bank_account_id)
    );

    CREATE TABLE IF NOT EXISTS statement_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      bank_account_id TEXT NOT NULL,
      bank_account_name TEXT,
      original_filename TEXT NOT NULL,
      stored_filename TEXT NOT NULL,
      file_sha256 TEXT NOT NULL,
      statement_start_date DATE NOT NULL,
      statement_end_date DATE NOT NULL,
      opening_balance REAL,
      closing_balance REAL NOT NULL,
      column_mapping_json TEXT NOT NULL,
      row_count INTEGER NOT NULL DEFAULT 0,
      imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(org_id, file_sha256)
    );

    CREATE TABLE IF NOT EXISTS statement_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL REFERENCES statement_imports(id) ON DELETE CASCADE,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      bank_account_id TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      transaction_date DATE NOT NULL,
      amount REAL NOT NULL,
      reference TEXT,
      description TEXT,
      match_confidence TEXT NOT NULL
        CHECK(match_confidence IN ('exact', 'probable', 'ambiguous', 'unmatched')),
      matched_xero_item_id TEXT,
      match_candidates INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_statement_lines_import ON statement_lines(import_id);
    CREATE INDEX IF NOT EXISTS idx_statement_lines_matching
      ON statement_lines(org_id, bank_account_id, transaction_date, amount);
    CREATE INDEX IF NOT EXISTS idx_statement_imports_latest
      ON statement_imports(org_id, bank_account_id, statement_end_date DESC, imported_at DESC);

    CREATE TABLE IF NOT EXISTS xero_bank_items_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      cache_key TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      bank_account_id TEXT,
      bank_account_name TEXT,
      transaction_date DATE,
      amount REAL NOT NULL,
      reference TEXT,
      description TEXT,
      synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(org_id, cache_key)
    );
    CREATE INDEX IF NOT EXISTS idx_xero_bank_cache_match
      ON xero_bank_items_cache(org_id, bank_account_id, transaction_date, amount);

    CREATE TABLE IF NOT EXISTS filed_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      filing_date DATE NOT NULL,
      net_assets REAL NOT NULL,
      source_note TEXT,
      source_document_path TEXT,
      xero_net_assets REAL,
      xero_balance_as_of DATE,
      xero_synced_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(org_id, filing_date)
    );
    CREATE INDEX IF NOT EXISTS idx_filed_accounts_latest
      ON filed_accounts(org_id, filing_date DESC);

    -- Which of this client's expense accounts should be treated as capital-item candidates is
    -- an accountant judgment call (account naming conventions vary by industry — no keyword rule
    -- generalizes), so it's stored per org/account here rather than guessed. is_capital_candidate
    -- is only ever set by the accountant; sync refreshes name/class but never touches the flag.
    CREATE TABLE IF NOT EXISTS chart_of_accounts_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER REFERENCES organisations(id),
      account_code TEXT NOT NULL,
      account_name TEXT,
      account_class TEXT,
      account_type TEXT,
      is_capital_candidate INTEGER DEFAULT 0,
      capital_review_threshold REAL,
      monitor_misallocated INTEGER DEFAULT 0,
      misallocated_threshold REAL,
      purchase_tax_ignore INTEGER DEFAULT 0,
      purchase_tax_include_asset_prepayment INTEGER DEFAULT 0,
      UNIQUE(org_id, account_code)
    );

    CREATE TABLE IF NOT EXISTS issue_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      check_type TEXT NOT NULL,
      finding_key TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      display_only INTEGER DEFAULT 0,
      potential_value_gbp REAL DEFAULT 0,
      UNIQUE(issue_id, finding_key)
    );

    CREATE INDEX IF NOT EXISTS idx_issue_findings_issue_page
      ON issue_findings(issue_id, id);
    CREATE INDEX IF NOT EXISTS idx_issue_findings_org_check
      ON issue_findings(org_id, check_type);

    CREATE TABLE IF NOT EXISTS finding_review_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      check_type TEXT NOT NULL,
      finding_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('dismissed', 'ignored', 'ok')),
      ignored_until DATETIME,
      period_key TEXT,
      notes TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(org_id, check_type, finding_key)
    );
    CREATE INDEX IF NOT EXISTS idx_finding_review_lookup
      ON finding_review_states(org_id, check_type, finding_key);

    CREATE TABLE IF NOT EXISTS finding_review_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      check_type TEXT NOT NULL,
      finding_key TEXT NOT NULL,
      action TEXT NOT NULL,
      previous_state TEXT,
      new_state TEXT,
      ignored_until DATETIME,
      period_key TEXT,
      notes TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_finding_review_audit
      ON finding_review_audit(org_id, check_type, finding_key, created_at);

    CREATE TABLE IF NOT EXISTS transaction_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER REFERENCES organisations(id),
      period TEXT NOT NULL DEFAULT 'rolling_12_months',
      period_start DATE,
      period_end DATE,
      months_covered REAL DEFAULT 12,
      turnover REAL DEFAULT 0,
      total_transactions INTEGER DEFAULT 0,
      customer_invoices INTEGER DEFAULT 0,
      supplier_bills INTEGER DEFAULT 0,
      credit_notes_sales INTEGER DEFAULT 0,
      credit_notes_purchase INTEGER DEFAULT 0,
      bank_processed INTEGER DEFAULT 0,
      journals INTEGER DEFAULT 0,
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      mode TEXT NOT NULL DEFAULT 'full',
      status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed', 'cancelled')),
      period_key TEXT,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      error TEXT,
      is_active INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_runs_one_active
      ON sync_runs(org_id) WHERE is_active = 1;
    CREATE INDEX IF NOT EXISTS idx_sync_runs_history
      ON sync_runs(org_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS xero_entity_cache (
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      json TEXT NOT NULL,
      modified_at DATETIME,
      fetched_at DATETIME NOT NULL,
      source_run_id INTEGER REFERENCES sync_runs(id),
      PRIMARY KEY(org_id, entity_type, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_xero_entity_cache_type
      ON xero_entity_cache(org_id, entity_type, entity_id);

    CREATE TABLE IF NOT EXISTS sync_jobs (
      id TEXT PRIMARY KEY,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      payload_json TEXT,
      progress_json TEXT,
      result_json TEXT,
      error TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      progress_at DATETIME,
      finished_at DATETIME,
      next_attempt_at DATETIME
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_jobs_one_active
      ON sync_jobs(org_id, mode) WHERE status IN ('queued', 'running');
    CREATE INDEX IF NOT EXISTS idx_sync_jobs_queue
      ON sync_jobs(status, next_attempt_at, created_at);

    CREATE TABLE IF NOT EXISTS validation_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      period_key TEXT NOT NULL,
      xenon_score REAL NOT NULL,
      xenon_issues INTEGER NOT NULL,
      xenon_value_gbp REAL NOT NULL,
      source_date DATE NOT NULL,
      source_filename TEXT,
      source_file_sha256 TEXT NOT NULL,
      evidence_path TEXT,
      notes TEXT,
      score_reason TEXT,
      profile_tags_json TEXT NOT NULL,
      evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('json', 'csv', 'manual', 'draft')),
      counts_toward_gate INTEGER NOT NULL DEFAULT 1 CHECK(counts_toward_gate IN (0, 1)),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(org_id, period_key, source_file_sha256)
    );
    CREATE INDEX IF NOT EXISTS idx_validation_snapshot_match
      ON validation_snapshots(org_id, period_key, counts_toward_gate, created_at DESC);

    CREATE TABLE IF NOT EXISTS validation_snapshot_checks (
      snapshot_id INTEGER NOT NULL REFERENCES validation_snapshots(id) ON DELETE CASCADE,
      check_type TEXT NOT NULL,
      xenon_count INTEGER,
      xenon_value_gbp REAL,
      support_type TEXT NOT NULL CHECK(support_type IN ('api', 'manual')),
      mismatch_note TEXT,
      PRIMARY KEY(snapshot_id, check_type)
    );

    -- One Companies House public-register snapshot per client, refreshed on sync when an API key
    -- is configured. Purely informational (company status + filing deadlines); never feeds the
    -- health score or Xenon parity gate.
    CREATE TABLE IF NOT EXISTS companies_house_profile (
      org_id INTEGER PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
      company_number TEXT,
      company_name TEXT,
      company_status TEXT,
      company_type TEXT,
      incorporation_date DATE,
      accounts_next_due DATE,
      accounts_last_made_up_to DATE,
      accounts_overdue INTEGER DEFAULT 0,
      confirmation_next_due DATE,
      confirmation_last_made_up_to DATE,
      confirmation_overdue INTEGER DEFAULT 0,
      sic_codes TEXT,
      registered_office TEXT,
      raw_json TEXT,
      fetch_error TEXT,
      fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Every attempt to read a filed net-assets figure out of a Companies House accounts document,
    -- successful or not. Kept separately from filed_accounts so that a FAILED extraction is still
    -- auditable evidence ("why is this still asking me to type the number in?") rather than an
    -- invisible no-op. filed_accounts holds only figures actually used for comparison.
    CREATE TABLE IF NOT EXISTS filed_accounts_extractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      made_up_to DATE NOT NULL,
      company_number TEXT,
      ch_transaction_id TEXT,
      ch_document_id TEXT,
      filing_date DATE,
      filing_description TEXT,
      content_type TEXT,
      taxonomy_concept TEXT,
      context_ref TEXT,
      context_date DATE,
      extracted_value REAL,
      extraction_method TEXT,
      extraction_confidence TEXT,
      failure_reason TEXT,
      available_dates TEXT,
      candidates_json TEXT,
      applied INTEGER NOT NULL DEFAULT 0,
      attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(org_id, made_up_to)
    );

    CREATE TABLE IF NOT EXISTS validation_gate_assurances (
      assurance_type TEXT PRIMARY KEY CHECK(
        assurance_type IN ('review_state_survival', 'no_data_loss_sync', 'workflow_readiness')
      ),
      status TEXT NOT NULL CHECK(status IN ('not_tested', 'failed', 'passed')),
      evidence_date DATE,
      notes TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const accountColumns = new Set(db.prepare(`PRAGMA table_info(chart_of_accounts_cache)`).all().map(column => column.name));
  const migrations = [
    ['capital_review_threshold', 'REAL'],
    ['monitor_misallocated', 'INTEGER DEFAULT 0'],
    ['misallocated_threshold', 'REAL'],
    ['purchase_tax_ignore', 'INTEGER DEFAULT 0'],
    ['purchase_tax_include_asset_prepayment', 'INTEGER DEFAULT 0'],
  ];
  for (const [name, definition] of migrations) {
    if (!accountColumns.has(name)) {
      db.exec(`ALTER TABLE chart_of_accounts_cache ADD COLUMN ${name} ${definition}`);
    }
  }

  const findingColumns = new Set(db.prepare(`PRAGMA table_info(issue_findings)`).all().map(column => column.name));
  if (!findingColumns.has('potential_value_gbp')) {
    db.exec(`ALTER TABLE issue_findings ADD COLUMN potential_value_gbp REAL DEFAULT 0`);
  }

  const healthScoreColumns = new Set(db.prepare(`PRAGMA table_info(health_scores)`).all().map(column => column.name));
  if (!healthScoreColumns.has('score_profile_version')) {
    db.exec(`ALTER TABLE health_scores ADD COLUMN score_profile_version TEXT`);
  }
  if (!healthScoreColumns.has('score_breakdown_json')) {
    db.exec(`ALTER TABLE health_scores ADD COLUMN score_breakdown_json TEXT`);
  }
  for (const [name, definition] of [
    ['period_key', 'TEXT'], ['period_type', 'TEXT'], ['period_start', 'DATE'],
    ['period_end', 'DATE'], ['period_label', 'TEXT'],
  ]) {
    if (!healthScoreColumns.has(name)) db.exec(`ALTER TABLE health_scores ADD COLUMN ${name} ${definition}`);
  }

  const organisationColumns = new Set(db.prepare(`PRAGMA table_info(organisations)`).all().map(column => column.name));
  if (!organisationColumns.has('financial_year_end_day')) {
    db.exec(`ALTER TABLE organisations ADD COLUMN financial_year_end_day INTEGER`);
  }
  if (!organisationColumns.has('financial_year_end_month')) {
    db.exec(`ALTER TABLE organisations ADD COLUMN financial_year_end_month INTEGER`);
  }
  if (!organisationColumns.has('company_number')) {
    db.exec(`ALTER TABLE organisations ADD COLUMN company_number TEXT`);
  }

  // filed_accounts predates automatic extraction, so existing rows are accountant-entered. The
  // default of 'manual' is what protects them: an auto-extracted figure must never overwrite a
  // number an accountant typed in.
  const filedAccountColumns = new Set(db.prepare(`PRAGMA table_info(filed_accounts)`).all().map(column => column.name));
  for (const [name, definition] of [
    ['source', `TEXT NOT NULL DEFAULT 'manual'`],
    ['made_up_to', 'DATE'],
    ['ch_transaction_id', 'TEXT'],
    ['ch_document_id', 'TEXT'],
    ['taxonomy_concept', 'TEXT'],
    ['context_ref', 'TEXT'],
    ['context_date', 'DATE'],
    ['extraction_method', 'TEXT'],
    ['extraction_confidence', 'TEXT'],
    ['extracted_at', 'DATETIME'],
  ]) {
    if (!filedAccountColumns.has(name)) db.exec(`ALTER TABLE filed_accounts ADD COLUMN ${name} ${definition}`);
  }

  for (const table of ['issues', 'health_scores', 'transaction_counts']) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
    if (!columns.has('run_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN run_id INTEGER REFERENCES sync_runs(id)`);
    if (!columns.has('is_active')) db.exec(`ALTER TABLE ${table} ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`);
  }
  const issueFindingColumns = new Set(db.prepare(`PRAGMA table_info(issue_findings)`).all().map(column => column.name));
  if (!issueFindingColumns.has('run_id')) {
    db.exec(`ALTER TABLE issue_findings ADD COLUMN run_id INTEGER REFERENCES sync_runs(id)`);
  }
  if (!issueFindingColumns.has('is_active')) {
    db.exec(`ALTER TABLE issue_findings ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`);
  }
  db.exec(`
    UPDATE sync_runs SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
      error = COALESCE(error, 'Process restarted before activation')
    WHERE status = 'running';
    INSERT INTO sync_runs
      (org_id, mode, status, started_at, completed_at, is_active)
    SELECT o.id, 'legacy', 'succeeded', o.last_synced_at, o.last_synced_at, 1
    FROM organisations o
    WHERE o.last_synced_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM sync_runs sr WHERE sr.org_id = o.id AND sr.status = 'succeeded')
      AND (
        EXISTS (SELECT 1 FROM issues i WHERE i.org_id = o.id AND i.is_active = 1)
        OR EXISTS (SELECT 1 FROM health_scores hs WHERE hs.org_id = o.id AND hs.is_active = 1)
      );
    UPDATE issues SET run_id = (
      SELECT id FROM sync_runs sr WHERE sr.org_id = issues.org_id AND sr.is_active = 1
    ) WHERE run_id IS NULL AND is_active = 1;
    UPDATE issue_findings SET run_id = (
      SELECT id FROM sync_runs sr WHERE sr.org_id = issue_findings.org_id AND sr.is_active = 1
    ) WHERE run_id IS NULL AND is_active = 1;
    UPDATE health_scores SET run_id = (
      SELECT id FROM sync_runs sr WHERE sr.org_id = health_scores.org_id AND sr.is_active = 1
    ) WHERE run_id IS NULL AND is_active = 1;
    UPDATE transaction_counts SET run_id = (
      SELECT id FROM sync_runs sr WHERE sr.org_id = transaction_counts.org_id AND sr.is_active = 1
    ) WHERE run_id IS NULL AND is_active = 1;
  `);
  db.exec(`
    DROP INDEX IF EXISTS idx_issues_org_check;
    DROP INDEX IF EXISTS idx_transaction_counts_org_period;
    CREATE INDEX IF NOT EXISTS idx_issues_org_check ON issues(org_id, is_active, check_type);
    CREATE INDEX IF NOT EXISTS idx_transaction_counts_org_period ON transaction_counts(org_id, is_active, period, synced_at DESC);
    CREATE INDEX IF NOT EXISTS idx_health_scores_active ON health_scores(org_id, is_active, id DESC);
  `);
}

module.exports = { getDb };
