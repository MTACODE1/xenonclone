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
    // organisations/health_scores/sync_runs/sync_jobs/xero_tokens moved to the shared MySQL
    // database — this local organisations table is no longer written to, so every remaining
    // SQLite table's "REFERENCES organisations(id)" foreign key (issues, xero_entity_cache,
    // transaction_counts, bank_reconciliation, etc.) can never be satisfied by ON, since the
    // org ids now come from MySQL and never exist in this local shadow table. Referential
    // integrity for org_id is enforced at the application layer now (every write already comes
    // from an org fetched via a real MySQL lookup), not by SQLite.
    db.pragma('foreign_keys = OFF');
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

    -- Xenon supports excluding individual bank accounts from Bank Balance and Unreconciled Bank
    -- Items — e.g. a dormant/closed account, or a PayPal-style clearing account that generates
    -- permanent false-positive noise. A separate table (not a column on bank_reconciliation) so
    -- exclusion works independently of whether that table has ever been populated for an account
    -- (it's only written after a successful Bank Summary sync). Presence of a row IS the exclusion —
    -- no boolean column needed.
    CREATE TABLE IF NOT EXISTS bank_account_exclusions (
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      bank_account_id TEXT NOT NULL,
      excluded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (org_id, bank_account_id)
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

    -- Per-transaction review state for checks whose findings drill down into individual
    -- transactions (multi_account_suppliers, multi_tax_suppliers) — a lightweight "reviewed this
    -- one line" audit trail, deliberately separate from finding_review_states above: marking one
    -- transaction OK never changes the parent contact-level finding's count, value, or score (those
    -- are computed per contact, not per transaction). line_key is the transaction's own permanent
    -- Xero id (bankTransactionId or invoiceId), stable across resyncs.
    CREATE TABLE IF NOT EXISTS finding_line_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      check_type TEXT NOT NULL,
      finding_key TEXT NOT NULL,
      line_key TEXT NOT NULL,
      ok INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(org_id, check_type, finding_key, line_key)
    );
    CREATE INDEX IF NOT EXISTS idx_finding_line_reviews_lookup
      ON finding_line_reviews(org_id, check_type, finding_key);

    -- A note attached to a finding WITHOUT changing its dismiss/ignore/ok review state (Xenon's
    -- "Add Note" is a separate action from those three). Deliberately its own table rather than
    -- relaxing finding_review_states' state CHECK constraint to add a 4th, always-active value —
    -- that would need a live table rebuild against real client data already stored there; this is
    -- purely additive and carries no state of its own, so it's safe alongside any review state.
    CREATE TABLE IF NOT EXISTS finding_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      check_type TEXT NOT NULL,
      finding_key TEXT NOT NULL,
      notes TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(org_id, check_type, finding_key)
    );
    CREATE INDEX IF NOT EXISTS idx_finding_notes_lookup
      ON finding_notes(org_id, check_type, finding_key);

    -- "Ignore this contact" — a PERMANENT exclusion, unlike finding_review_states' dismiss/ignore
    -- (which only cover findings that already exist). contact_key is normalized (lowercased,
    -- trimmed, whitespace-collapsed) contact NAME, not a Xero contactId — most check finding shapes
    -- only carry the contact's name, not a stable ID, so name is the one field universally
    -- available to match against. insertIssue (queries.js) filters any new finding whose contact
    -- matches an exclusion here BEFORE it's ever persisted, so this applies to every future sync
    -- automatically with no xeroSync.js changes needed per check.
    CREATE TABLE IF NOT EXISTS contact_exclusions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      check_type TEXT NOT NULL,
      contact_key TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(org_id, check_type, contact_key)
    );
    CREATE INDEX IF NOT EXISTS idx_contact_exclusions_lookup
      ON contact_exclusions(org_id, check_type);

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
    CREATE INDEX IF NOT EXISTS idx_sync_runs_org_status
      ON sync_runs(org_id, status, completed_at DESC);

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

    -- Staff login/access-control. No password is stored here at all — authentication happens
    -- against MTAKPI's own UserDataMatch table (see src/services/mtakpiAuth.js) so staff use the
    -- same credentials as the practice's other internal tools. mtakpi_staff_name links a row here
    -- to that real identity (matched case-insensitively/trimmed, same as MTAKPI's own login);
    -- role/initials/is_active are Akrio-specific and independent of MTAKPI's own is_admin/disabled
    -- flags, so who has access to THIS app is a deliberate, separate grant, not automatic just
    -- because someone has any MTAKPI login. is_active is a soft-delete flag (same convention as
    -- issues.is_active/sync_runs.is_active) so deactivating a staff account keeps anything
    -- historically attributed to them intact rather than deleting the row outright.
    -- Three-tier role: super_admin > admin > staff. Only super_admin may grant/revoke admin or
    -- super_admin (see src/services/staffPermissions.js) — a regular admin can only manage
    -- staff-tier accounts (create, deactivate, edit client access). can_manage_settings is a
    -- SEPARATE grantable permission (any admin/super_admin can toggle it on anyone) so someone
    -- can get Settings access without being promoted to a full admin.
    CREATE TABLE IF NOT EXISTS staff_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mtakpi_staff_name TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      initials TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('super_admin', 'admin', 'staff')),
      can_manage_settings INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at DATETIME
    );

    -- Which staff can access which client. Admins/super_admins hold no rows here — access checks
    -- treat role IN ('admin', 'super_admin') as implicit all-access, so this table only ever
    -- holds staff-role grants.
    CREATE TABLE IF NOT EXISTS staff_org_access (
      staff_id INTEGER NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (staff_id, org_id)
    );
    CREATE INDEX IF NOT EXISTS idx_staff_org_access_org ON staff_org_access(org_id);

    -- Persistent express-session store (see src/services/sqliteSessionStore.js) so staff logins
    -- survive server restarts/deploys instead of relying on express-session's default in-memory
    -- store, which would log everyone out on every restart — this app restarts often in practice.
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      session_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  `);

  // staff_users predates the super_admin tier and can_manage_settings — both need a table
  // recreation (SQLite can't ALTER a CHECK constraint in place). Guarded on the CHECK text
  // itself so this only runs once, the first boot after this code ships; existing rows (role
  // was always 'admin' or 'staff') carry over unchanged, can_manage_settings defaults to 0.
  const staffUsersSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='staff_users'`).get()?.sql || '';
  if (staffUsersSql && !staffUsersSql.includes('super_admin')) {
    db.exec(`
      ALTER TABLE staff_users RENAME TO staff_users_pre_super_admin;
      CREATE TABLE staff_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mtakpi_staff_name TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        initials TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('super_admin', 'admin', 'staff')),
        can_manage_settings INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login_at DATETIME
      );
      INSERT INTO staff_users (id, mtakpi_staff_name, name, initials, role, is_active, created_at, last_login_at)
        SELECT id, mtakpi_staff_name, name, initials, role, is_active, created_at, last_login_at FROM staff_users_pre_super_admin;
      DROP TABLE staff_users_pre_super_admin;
    `);
  }

  // The RENAME above silently broke staff_org_access: SQLite auto-rewrites other tables'
  // foreign-key references when a table is renamed (legacy_alter_table is off by default), so
  // staff_org_access.staff_id's "REFERENCES staff_users" became "REFERENCES
  // staff_users_pre_super_admin" the moment staff_users was renamed — and then that table got
  // dropped two lines later, leaving every write to staff_org_access failing with "no such table:
  // main.staff_users_pre_super_admin". Recreate it pointing at staff_users properly; guarded on
  // the FK text so this is a no-op once fixed.
  const staffOrgAccessSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='staff_org_access'`).get()?.sql || '';
  if (staffOrgAccessSql.includes('pre_super_admin')) {
    db.exec(`
      ALTER TABLE staff_org_access RENAME TO staff_org_access_broken_fk;
      CREATE TABLE staff_org_access (
        staff_id INTEGER NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
        org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
        granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (staff_id, org_id)
      );
      INSERT INTO staff_org_access (staff_id, org_id, granted_at)
        SELECT staff_id, org_id, granted_at FROM staff_org_access_broken_fk;
      DROP TABLE staff_org_access_broken_fk;
    `);
  }

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
  // Xenon's own Multi-Account/Multi-Tax Code Suppliers documentation states the pattern-detection
  // lookback is "3 months prior to the period selected" by default, adjustable per client on
  // Xenon's settings page — not a fixed value. NULL here means "not yet configured for this
  // client"; xeroSync.js falls back to the empirically-tuned 12-month default that already
  // matches every currently-validated client, so leaving this unset changes nothing for them.
  if (!organisationColumns.has('supplier_pattern_lookback_months')) {
    db.exec(`ALTER TABLE organisations ADD COLUMN supplier_pattern_lookback_months INTEGER`);
  }
  // Multi-account suppliers documents the identical "3 months prior, changeable per client" rule
  // as multi-tax above, but Xenon lets each check's lookback be configured independently — this
  // was previously hardcoded to a hard 12-month floor shared with nothing. NULL here falls back
  // to the same empirically-tuned 12-month default multi-tax uses when unset, so existing clients
  // are unaffected until explicitly overridden.
  if (!organisationColumns.has('multi_account_pattern_lookback_months')) {
    db.exec(`ALTER TABLE organisations ADD COLUMN multi_account_pattern_lookback_months INTEGER`);
  }

  // Config-isolation pass (2026-09): these six values previously came only from the practice-wide
  // `settings` table (or, for the duplicate windows, a hardcoded constant), so a change intended for
  // one client's genuinely different circumstances had no way to avoid silently changing every other
  // client. Each column here is an organisation-level override that sits ABOVE the existing practice
  // default in the resolver precedence (org override > practice default > documented Xenon default);
  // leaving it NULL changes nothing — every currently-validated client keeps using the same practice
  // default it already matched against, and only a client that genuinely needs a different value
  // gets one set explicitly.
  for (const [name, definition] of [
    ['opening_balance_threshold_gbp', 'REAL'],
    ['capital_review_default_threshold_gbp', 'REAL'],
    ['misallocated_items_default_threshold_gbp', 'REAL'],
    ['multi_account_suppliers_min_value_gbp', 'REAL'],
    ['multi_tax_suppliers_min_value_gbp', 'REAL'],
    ['purchase_tax_missing_exclude_codes', 'TEXT'],
    // Duplicate Invoices/Bills windows were a hardcoded constant (not even a practice-wide setting)
    // calibrated against one client's real Xenon data (4X4: 3-day window). Xenon's own documentation
    // states a 1-day default, configurable per client — so 3 days must become an explicit practice
    // default (kept as the code fallback below, unaffected by this column existing) rather than a
    // claim about Xenon's universal behaviour, with room for a genuinely different client here.
    ['duplicate_invoice_window_days', 'INTEGER'],
    ['duplicate_bill_window_days', 'INTEGER'],
    // Xenon documents two further Duplicate Invoices/Bills toggles: "Exact Reference" (off by
    // default) and "Also check paid invoices/bills" (off by default — i.e. fully-paid groups are
    // excluded unless this is turned on). Both are NULL-means-use-the-documented-default booleans,
    // stored as 0/1/NULL so "explicitly off" (0) is distinguishable from "never configured" (NULL) —
    // not that the two currently differ in outcome, but a future default change must not silently
    // reinterpret an old NULL as a stored 0 or vice versa.
    ['duplicate_invoice_require_exact_reference', 'INTEGER'],
    ['duplicate_invoice_include_fully_paid', 'INTEGER'],
    ['duplicate_bill_require_exact_reference', 'INTEGER'],
    ['duplicate_bill_include_fully_paid', 'INTEGER'],
    // Exact Total is the one duplicate-matching toggle where NULL does NOT mean "use Xenon's
    // documented off default" — Xenon's own documentation doesn't disclose what off actually does,
    // so NULL here means "use this practice's calibrated default (on)" instead. See
    // resolveDuplicateInvoiceRequireExactTotal / resolveDuplicateBillRequireExactTotal.
    ['duplicate_invoice_require_exact_total', 'INTEGER'],
    ['duplicate_bill_require_exact_total', 'INTEGER'],
  ]) {
    if (!organisationColumns.has(name)) db.exec(`ALTER TABLE organisations ADD COLUMN ${name} ${definition}`);
  }

  // Capital Item Review opt-out (2026-09): Xenon monitors account codes 461/473 by default "if
  // they exist," but the previous unconditional auto-add on every sync meant an accountant could
  // never deliberately exclude either one — saving the Per-account Check Settings form with 461
  // unchecked (a real opt-out) looked identical to "never touched this page" (apply the default),
  // since chart_of_accounts_cache.is_capital_candidate is a plain 0/1 with no way to tell those
  // apart. This flag is the tri-state: 0 (the default for every existing org, preserving today's
  // behaviour exactly) means "never explicitly saved — keep auto-adding 461/473 if present"; it is
  // set to 1 the first time setAccountCheckConfiguration runs for an org, after which is_capital_
  // candidate is trusted verbatim, including an explicit 0 on 461 or 473.
  if (!organisationColumns.has('account_settings_initialised')) {
    db.exec(`ALTER TABLE organisations ADD COLUMN account_settings_initialised INTEGER NOT NULL DEFAULT 0`);
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS insight_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      report_type TEXT NOT NULL,
      data_json TEXT,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(org_id, report_type)
    );

    -- Which Xero accounts feed each Insight KPI, set explicitly by the accountant rather than
    -- guessed from account names — mirrors Xenon Insight's own settings model. 'category' is one
    -- of: directors_loan, dividend, wc_trade_debtors, wc_trade_creditors, wc_stock, or a
    -- cash_health_<outgoing_type> bucket (cash_health_suppliers, cash_health_net_wages,
    -- cash_health_paye_nic, cash_health_pension, cash_health_credit_cards, cash_health_other_st,
    -- cash_health_vat_bill, cash_health_corp_tax, cash_health_loans_other). A category can map to
    -- more than one account, so this is a plain join table rather than one row per category.
    CREATE TABLE IF NOT EXISTS insight_account_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      account_code TEXT NOT NULL,
      UNIQUE(org_id, category, account_code)
    );

    -- Per-category overrides that aren't an account mapping: whether a Cash Health outgoing type
    -- is included at all, and a manual cash-requirement figure that overrides whatever the mapped
    -- accounts sum to (Xenon's "Override?" toggle + "Cash Requirement £" field).
    CREATE TABLE IF NOT EXISTS insight_category_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      override_enabled INTEGER NOT NULL DEFAULT 0,
      override_value REAL,
      UNIQUE(org_id, category)
    );

    -- Per-card show/hide on the Insight dashboard tab and (for parity with Xenon's table, even
    -- though Akrio has no Insight PDF export yet) a PDF Report column. Absent row = visible on
    -- both (default on).
    CREATE TABLE IF NOT EXISTS insight_widget_visibility (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      widget_key TEXT NOT NULL,
      visible INTEGER NOT NULL DEFAULT 1,
      pdf_visible INTEGER NOT NULL DEFAULT 1,
      UNIQUE(org_id, widget_key)
    );

    -- Small single-value settings that don't fit the account-mapping or category-toggle shape:
    -- Sales Tracker target basis + % increase, Business Valuation model + multiple.
    CREATE TABLE IF NOT EXISTS insight_settings_kv (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT,
      UNIQUE(org_id, key)
    );

    -- Custom Corporation Tax rate bands (Xenon's "Rate of Corporation Tax" table: an effective
    -- date + flat rate, most recent effective date wins). When a client has these configured they
    -- override the built-in HMRC marginal-relief calculation.
    CREATE TABLE IF NOT EXISTS insight_corp_tax_rate_bands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      effective_date TEXT NOT NULL,
      rate_pct REAL NOT NULL
    );

    -- Corp tax profit adjustments: 'addback' (Disallow/AddBack — % of the account added back to
    -- net profit before tax), 'deduct_other' (% subtracted), and 'capital_allowance' (writing-down
    -- allowance treatment per fixed-asset account — stored for parity with Xenon's settings screen
    -- but not yet applied to the estimate, since correct WDA pool tracking spans multiple years).
    CREATE TABLE IF NOT EXISTS insight_corp_tax_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      adjustment_type TEXT NOT NULL CHECK(adjustment_type IN ('addback', 'deduct_other', 'capital_allowance')),
      account_code TEXT NOT NULL,
      pct REAL,
      treatment TEXT,
      UNIQUE(org_id, adjustment_type, account_code)
    );
  `);

  const widgetVisColumns = new Set(db.prepare(`PRAGMA table_info(insight_widget_visibility)`).all().map(c => c.name));
  if (!widgetVisColumns.has('pdf_visible')) {
    db.exec(`ALTER TABLE insight_widget_visibility ADD COLUMN pdf_visible INTEGER NOT NULL DEFAULT 1`);
  }
}

module.exports = { getDb };
