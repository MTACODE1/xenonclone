-- Akrio Verify - MySQL schema for the shared mtakpi database (kpimanagementmysqldb).
--
-- Run this ONCE, directly in DBeaver, connected to kpimanagementmysqldb, using a user with
-- CREATE TABLE privileges (mtakpi's own write user). All tables are prefixed `akrio_` so they
-- can't collide with mtakpi's own tables (leads, tasks, forms, etc.) in the same database.
--
-- Translated from the app's existing SQLite schema (src/db/schema.js). Two groups of tables were
-- folded into a single JSON-blob table each, since they're pure per-client settings that are
-- always read/written as a whole and never queried row-by-row:
--   - the six insight_* config tables -> akrio_insight_settings
--   - validation_snapshot_checks (always fetched with its parent) -> a JSON column on
--     akrio_validation_snapshots
-- Everything else keeps its original shape 1:1, including the two places where SQLite used a
-- PARTIAL unique index (`... WHERE is_active = 1` / `WHERE status IN (...)`) to enforce 'only one
-- active row per client' - MySQL has no partial index, so those use the standard MySQL
-- equivalent: a generated column that's NULL except when the condition holds, with a normal
-- UNIQUE key on it (a UNIQUE key allows unlimited NULLs, so only the 'active' rows can collide).
--
-- After this file has been run, the app's own data-access code (src/db/schema.js,
-- src/db/queries.js, and its callers) still needs to be rewritten to use MySQL instead of
-- SQLite - that is tracked as separate, later work, not part of this script.

SET NAMES utf8mb4;

-- Core client data

CREATE TABLE IF NOT EXISTS akrio_organisations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  xero_tenant_id VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  client_ref VARCHAR(255),
  tag VARCHAR(255),
  connection_status VARCHAR(50) NOT NULL DEFAULT 'connected',
  last_synced_at DATETIME,
  financial_year_end_day INT,
  financial_year_end_month INT,
  company_number VARCHAR(50),
  supplier_pattern_lookback_months INT,
  multi_account_pattern_lookback_months INT,
  opening_balance_threshold_gbp DOUBLE,
  capital_review_default_threshold_gbp DOUBLE,
  misallocated_items_default_threshold_gbp DOUBLE,
  multi_account_suppliers_min_value_gbp DOUBLE,
  multi_tax_suppliers_min_value_gbp DOUBLE,
  purchase_tax_missing_exclude_codes TEXT,
  duplicate_invoice_window_days INT,
  duplicate_bill_window_days INT,
  duplicate_invoice_require_exact_reference TINYINT(1),
  duplicate_invoice_include_fully_paid TINYINT(1),
  duplicate_bill_require_exact_reference TINYINT(1),
  duplicate_bill_include_fully_paid TINYINT(1),
  duplicate_invoice_require_exact_total TINYINT(1),
  duplicate_bill_require_exact_total TINYINT(1),
  account_settings_initialised TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_organisations_tenant (xero_tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_xero_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  xero_tenant_id VARCHAR(255) NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_xero_tokens_tenant (xero_tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_settings (
  `key` VARCHAR(255) PRIMARY KEY,
  value TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Staff & access control

CREATE TABLE IF NOT EXISTS akrio_staff_users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  mtakpi_staff_name VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  initials VARCHAR(10) NOT NULL,
  role VARCHAR(20) NOT NULL,
  can_manage_settings TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME,
  UNIQUE KEY uq_staff_users_mtakpi_name (mtakpi_staff_name),
  CONSTRAINT chk_staff_users_role CHECK (role IN ('super_admin', 'admin', 'staff'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_staff_org_access (
  staff_id INT NOT NULL,
  org_id INT NOT NULL,
  granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (staff_id, org_id),
  CONSTRAINT fk_staff_org_access_staff FOREIGN KEY (staff_id) REFERENCES akrio_staff_users(id) ON DELETE CASCADE,
  CONSTRAINT fk_staff_org_access_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id) ON DELETE CASCADE,
  KEY idx_staff_org_access_org (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_sessions (
  sid VARCHAR(255) PRIMARY KEY,
  session_json LONGTEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  KEY idx_sessions_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sync mechanics

CREATE TABLE IF NOT EXISTS akrio_sync_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NOT NULL,
  mode VARCHAR(50) NOT NULL DEFAULT 'full',
  status VARCHAR(20) NOT NULL,
  period_key VARCHAR(255),
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  error TEXT,
  is_active TINYINT(1) NOT NULL DEFAULT 0,
  -- NULL unless is_active=1, so the UNIQUE key below only ever collides across active rows -
  -- MySQL's stand-in for SQLite's `CREATE UNIQUE INDEX ... WHERE is_active = 1`.
  active_slot TINYINT AS (CASE WHEN is_active = 1 THEN 1 ELSE NULL END) STORED,
  CONSTRAINT chk_sync_runs_status CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT fk_sync_runs_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id) ON DELETE CASCADE,
  UNIQUE KEY idx_sync_runs_one_active (org_id, active_slot),
  KEY idx_sync_runs_history (org_id, started_at DESC),
  KEY idx_sync_runs_org_status (org_id, status, completed_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_sync_jobs (
  id VARCHAR(36) PRIMARY KEY,
  org_id INT NOT NULL,
  tenant_id VARCHAR(255) NOT NULL,
  mode VARCHAR(50) NOT NULL,
  dedupe_key VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL,
  attempt INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  payload_json JSON,
  progress_json JSON,
  result_json JSON,
  error TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  progress_at DATETIME,
  finished_at DATETIME,
  next_attempt_at DATETIME,
  -- Same partial-unique-index trick as akrio_sync_runs.active_slot: enforces 'only one
  -- queued-or-running job per (org, mode)', matching SQLite's
  -- `WHERE status IN ('queued','running')` partial index.
  active_slot TINYINT AS (CASE WHEN status IN ('queued', 'running') THEN 1 ELSE NULL END) STORED,
  CONSTRAINT chk_sync_jobs_status CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT fk_sync_jobs_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id) ON DELETE CASCADE,
  UNIQUE KEY idx_sync_jobs_one_active (org_id, mode, active_slot),
  KEY idx_sync_jobs_queue (status, next_attempt_at, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_xero_entity_cache (
  org_id INT NOT NULL,
  entity_type VARCHAR(100) NOT NULL,
  entity_id VARCHAR(255) NOT NULL,
  json JSON NOT NULL,
  modified_at DATETIME,
  fetched_at DATETIME NOT NULL,
  source_run_id INT,
  PRIMARY KEY (org_id, entity_type, entity_id),
  CONSTRAINT fk_xero_entity_cache_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id) ON DELETE CASCADE,
  CONSTRAINT fk_xero_entity_cache_run FOREIGN KEY (source_run_id) REFERENCES akrio_sync_runs(id),
  KEY idx_xero_entity_cache_type (org_id, entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Health check results

CREATE TABLE IF NOT EXISTS akrio_health_scores (
  id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NOT NULL,
  score INT,
  total_issues INT NOT NULL DEFAULT 0,
  total_potential_errors_gbp DOUBLE NOT NULL DEFAULT 0,
  last_bank_reconciled DATE,
  most_recent_transaction DATE,
  unreconciled_bank_items INT NOT NULL DEFAULT 0,
  lock_date DATE,
  period_key VARCHAR(255),
  period_type VARCHAR(50),
  period_start DATE,
  period_end DATE,
  period_label VARCHAR(255),
  score_profile_version VARCHAR(50),
  score_breakdown_json JSON,
  run_id INT,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  calculated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_health_scores_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id),
  CONSTRAINT fk_health_scores_run FOREIGN KEY (run_id) REFERENCES akrio_sync_runs(id),
  KEY idx_health_scores_active (org_id, is_active, id DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_issues (
  id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NOT NULL,
  check_type VARCHAR(100) NOT NULL,
  importance VARCHAR(20) NOT NULL,
  count INT NOT NULL DEFAULT 0,
  potential_value_gbp DOUBLE NOT NULL DEFAULT 0,
  detail_json JSON,
  period_checked VARCHAR(255),
  run_id INT,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_issues_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id),
  CONSTRAINT fk_issues_run FOREIGN KEY (run_id) REFERENCES akrio_sync_runs(id),
  KEY idx_issues_org_check (org_id, is_active, check_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_issue_findings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  issue_id INT NOT NULL,
  org_id INT NOT NULL,
  check_type VARCHAR(100) NOT NULL,
  finding_key VARCHAR(255) NOT NULL,
  detail_json JSON NOT NULL,
  display_only TINYINT(1) NOT NULL DEFAULT 0,
  potential_value_gbp DOUBLE NOT NULL DEFAULT 0,
  run_id INT,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT fk_issue_findings_issue FOREIGN KEY (issue_id) REFERENCES akrio_issues(id) ON DELETE CASCADE,
  CONSTRAINT fk_issue_findings_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id) ON DELETE CASCADE,
  CONSTRAINT fk_issue_findings_run FOREIGN KEY (run_id) REFERENCES akrio_sync_runs(id),
  UNIQUE KEY uq_issue_findings (issue_id, finding_key),
  KEY idx_issue_findings_issue_page (issue_id, id),
  KEY idx_issue_findings_org_check (org_id, check_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_finding_review_states (
  id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NOT NULL,
  check_type VARCHAR(100) NOT NULL,
  finding_key VARCHAR(255) NOT NULL,
  state VARCHAR(20) NOT NULL,
  ignored_until DATETIME,
  period_key VARCHAR(255),
  notes TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_finding_review_states_state CHECK (state IN ('dismissed', 'ignored', 'ok')),
  CONSTRAINT fk_finding_review_states_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id) ON DELETE CASCADE,
  UNIQUE KEY uq_finding_review_states (org_id, check_type, finding_key),
  KEY idx_finding_review_lookup (org_id, check_type, finding_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_finding_review_audit (
  id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NOT NULL,
  check_type VARCHAR(100) NOT NULL,
  finding_key VARCHAR(255) NOT NULL,
  action VARCHAR(50) NOT NULL,
  previous_state VARCHAR(20),
  new_state VARCHAR(20),
  ignored_until DATETIME,
  period_key VARCHAR(255),
  notes TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_finding_review_audit_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id) ON DELETE CASCADE,
  KEY idx_finding_review_audit (org_id, check_type, finding_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_finding_line_reviews (
  id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NOT NULL,
  check_type VARCHAR(100) NOT NULL,
  finding_key VARCHAR(255) NOT NULL,
  line_key VARCHAR(255) NOT NULL,
  ok TINYINT(1) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_finding_line_reviews_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id) ON DELETE CASCADE,
  UNIQUE KEY uq_finding_line_reviews (org_id, check_type, finding_key, line_key),
  KEY idx_finding_line_reviews_lookup (org_id, check_type, finding_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_finding_notes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NOT NULL,
  check_type VARCHAR(100) NOT NULL,
  finding_key VARCHAR(255) NOT NULL,
  notes TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_finding_notes_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id) ON DELETE CASCADE,
  UNIQUE KEY uq_finding_notes (org_id, check_type, finding_key),
  KEY idx_finding_notes_lookup (org_id, check_type, finding_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_contact_exclusions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NOT NULL,
  check_type VARCHAR(100) NOT NULL,
  contact_key VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_contact_exclusions_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id) ON DELETE CASCADE,
  UNIQUE KEY uq_contact_exclusions (org_id, check_type, contact_key),
  KEY idx_contact_exclusions_lookup (org_id, check_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_transaction_counts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NOT NULL,
  period VARCHAR(50) NOT NULL DEFAULT 'rolling_12_months',
  period_start DATE,
  period_end DATE,
  months_covered DOUBLE NOT NULL DEFAULT 12,
  turnover DOUBLE NOT NULL DEFAULT 0,
  total_transactions INT NOT NULL DEFAULT 0,
  customer_invoices INT NOT NULL DEFAULT 0,
  supplier_bills INT NOT NULL DEFAULT 0,
  credit_notes_sales INT NOT NULL DEFAULT 0,
  credit_notes_purchase INT NOT NULL DEFAULT 0,
  bank_processed INT NOT NULL DEFAULT 0,
  journals INT NOT NULL DEFAULT 0,
  run_id INT,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_transaction_counts_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id),
  CONSTRAINT fk_transaction_counts_run FOREIGN KEY (run_id) REFERENCES akrio_sync_runs(id),
  KEY idx_transaction_counts_org_period (org_id, is_active, period, synced_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bank reconciliation

CREATE TABLE IF NOT EXISTS akrio_bank_reconciliation (
  id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NOT NULL,
  bank_account_id VARCHAR(255) NOT NULL,
  bank_account_name VARCHAR(255),
  xero_calculated_balance DOUBLE,
  xero_balance_as_of DATE,
  statement_balance DOUBLE,
  statement_balance_updated_at DATETIME,
  CONSTRAINT fk_bank_reconciliation_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id),
  UNIQUE KEY uq_bank_reconciliation (org_id, bank_account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_bank_account_exclusions (
  org_id INT NOT NULL,
  bank_account_id VARCHAR(255) NOT NULL,
  excluded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id, bank_account_id),
  CONSTRAINT fk_bank_account_exclusions_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_statement_imports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NOT NULL,
  bank_account_id VARCHAR(255) NOT NULL,
  bank_account_name VARCHAR(255),
  original_filename VARCHAR(255) NOT NULL,
  stored_filename VARCHAR(255) NOT NULL,
  file_sha256 VARCHAR(64) NOT NULL,
  statement_start_date DATE NOT NULL,
  statement_end_date DATE NOT NULL,
  opening_balance DOUBLE,
  closing_balance DOUBLE NOT NULL,
  column_mapping_json JSON NOT NULL,
  row_count INT NOT NULL DEFAULT 0,
  imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_statement_imports_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id) ON DELETE CASCADE,
  UNIQUE KEY uq_statement_imports (org_id, file_sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_statement_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  import_id INT NOT NULL,
  org_id INT NOT NULL,
  bank_account_id VARCHAR(255) NOT NULL,
  line_number INT NOT NULL,
  transaction_date DATE NOT NULL,
  amount DOUBLE NOT NULL,
  reference VARCHAR(255),
  description TEXT,
  match_confidence VARCHAR(20) NOT NULL,
  matched_xero_item_id VARCHAR(255),
  match_candidates INT NOT NULL DEFAULT 0,
  CONSTRAINT chk_statement_lines_confidence CHECK (match_confidence IN ('exact', 'probable', 'ambiguous', 'unmatched')),
  CONSTRAINT fk_statement_lines_import FOREIGN KEY (import_id) REFERENCES akrio_statement_imports(id) ON DELETE CASCADE,
  CONSTRAINT fk_statement_lines_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id) ON DELETE CASCADE,
  KEY idx_statement_lines_import (import_id),
  KEY idx_statement_lines_matching (org_id, bank_account_id, transaction_date, amount)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_xero_bank_items_cache (
  id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NOT NULL,
  cache_key VARCHAR(255) NOT NULL,
  source_type VARCHAR(50) NOT NULL,
  source_id VARCHAR(255) NOT NULL,
  bank_account_id VARCHAR(255),
  bank_account_name VARCHAR(255),
  transaction_date DATE,
  amount DOUBLE NOT NULL,
  reference VARCHAR(255),
  description TEXT,
  synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_xero_bank_items_cache_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id) ON DELETE CASCADE,
  UNIQUE KEY uq_xero_bank_items_cache (org_id, cache_key),
  KEY idx_xero_bank_cache_match (org_id, bank_account_id, transaction_date, amount)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_chart_of_accounts_cache (
  id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NOT NULL,
  account_code VARCHAR(50) NOT NULL,
  account_name VARCHAR(255),
  account_class VARCHAR(100),
  account_type VARCHAR(100),
  is_capital_candidate TINYINT(1) NOT NULL DEFAULT 0,
  capital_review_threshold DOUBLE,
  monitor_misallocated TINYINT(1) NOT NULL DEFAULT 0,
  misallocated_threshold DOUBLE,
  purchase_tax_ignore TINYINT(1) NOT NULL DEFAULT 0,
  purchase_tax_include_asset_prepayment TINYINT(1) NOT NULL DEFAULT 0,
  CONSTRAINT fk_chart_of_accounts_cache_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id),
  UNIQUE KEY uq_chart_of_accounts_cache (org_id, account_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Companies House / filed accounts

CREATE TABLE IF NOT EXISTS akrio_companies_house_profile (
  org_id INT PRIMARY KEY,
  company_number VARCHAR(50),
  company_name VARCHAR(255),
  company_status VARCHAR(100),
  company_type VARCHAR(100),
  incorporation_date DATE,
  accounts_next_due DATE,
  accounts_last_made_up_to DATE,
  accounts_overdue TINYINT(1) NOT NULL DEFAULT 0,
  confirmation_next_due DATE,
  confirmation_last_made_up_to DATE,
  confirmation_overdue TINYINT(1) NOT NULL DEFAULT 0,
  sic_codes VARCHAR(255),
  registered_office TEXT,
  raw_json JSON,
  fetch_error TEXT,
  fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_companies_house_profile_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_filed_accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NOT NULL,
  filing_date DATE NOT NULL,
  net_assets DOUBLE NOT NULL,
  source_note TEXT,
  source_document_path VARCHAR(500),
  xero_net_assets DOUBLE,
  xero_balance_as_of DATE,
  xero_synced_at DATETIME,
  source VARCHAR(20) NOT NULL DEFAULT 'manual',
  made_up_to DATE,
  ch_transaction_id VARCHAR(100),
  ch_document_id VARCHAR(100),
  taxonomy_concept VARCHAR(255),
  context_ref VARCHAR(255),
  context_date DATE,
  extraction_method VARCHAR(100),
  extraction_confidence VARCHAR(50),
  extracted_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_filed_accounts_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id) ON DELETE CASCADE,
  UNIQUE KEY uq_filed_accounts (org_id, filing_date),
  KEY idx_filed_accounts_latest (org_id, filing_date DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_filed_accounts_extractions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NOT NULL,
  made_up_to DATE NOT NULL,
  company_number VARCHAR(50),
  ch_transaction_id VARCHAR(100),
  ch_document_id VARCHAR(100),
  filing_date DATE,
  filing_description VARCHAR(255),
  content_type VARCHAR(100),
  taxonomy_concept VARCHAR(255),
  context_ref VARCHAR(255),
  context_date DATE,
  extracted_value DOUBLE,
  extraction_method VARCHAR(100),
  extraction_confidence VARCHAR(50),
  failure_reason TEXT,
  available_dates TEXT,
  candidates_json JSON,
  applied TINYINT(1) NOT NULL DEFAULT 0,
  attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_filed_accounts_extractions_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id) ON DELETE CASCADE,
  UNIQUE KEY uq_filed_accounts_extractions (org_id, made_up_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Xenon parity validation (QA only - never feeds the health score)

CREATE TABLE IF NOT EXISTS akrio_validation_snapshots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NOT NULL,
  period_key VARCHAR(255) NOT NULL,
  xenon_score DOUBLE NOT NULL,
  xenon_issues INT NOT NULL,
  xenon_value_gbp DOUBLE NOT NULL,
  source_date DATE NOT NULL,
  source_filename VARCHAR(255),
  source_file_sha256 VARCHAR(64) NOT NULL,
  evidence_path VARCHAR(500),
  notes TEXT,
  score_reason TEXT,
  profile_tags_json JSON NOT NULL,
  evidence_kind VARCHAR(20) NOT NULL,
  counts_toward_gate TINYINT(1) NOT NULL DEFAULT 1,
  -- Folded from the old validation_snapshot_checks child table: an array of
  -- {check_type, xenon_count, xenon_value_gbp, support_type, mismatch_note}, always fetched
  -- together with the parent snapshot and never queried on its own.
  checks_json JSON,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_validation_snapshots_evidence_kind CHECK (evidence_kind IN ('json', 'csv', 'manual', 'draft')),
  CONSTRAINT chk_validation_snapshots_gate CHECK (counts_toward_gate IN (0, 1)),
  CONSTRAINT fk_validation_snapshots_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id) ON DELETE CASCADE,
  UNIQUE KEY uq_validation_snapshots (org_id, period_key, source_file_sha256),
  KEY idx_validation_snapshot_match (org_id, period_key, counts_toward_gate, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS akrio_validation_gate_assurances (
  assurance_type VARCHAR(50) PRIMARY KEY,
  status VARCHAR(20) NOT NULL,
  evidence_date DATE,
  notes TEXT,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_validation_gate_assurances_type CHECK (
    assurance_type IN ('review_state_survival', 'no_data_loss_sync', 'workflow_readiness')
  ),
  CONSTRAINT chk_validation_gate_assurances_status CHECK (status IN ('not_tested', 'failed', 'passed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insight KPI dashboard settings
-- Folded from six SQLite tables (insight_account_mappings, insight_category_settings,
-- insight_widget_visibility, insight_settings_kv, insight_corp_tax_rate_bands,
-- insight_corp_tax_adjustments) into one JSON blob per org - all six were pure per-client
-- config, always read/written as a whole, never queried row-by-row.
--
-- Expected shape of settings_json (Phase 2's query layer will read/write exactly this):
-- {
--   'account_mappings': [{ 'category': '...', 'account_code': '...' }, ...],
--   'category_settings': { '<category>': { 'enabled': true, 'override_enabled': false, 'override_value': null }, ... },
--   'widget_visibility': { '<widget_key>': { 'visible': true, 'pdf_visible': true }, ... },
--   'settings_kv': { '<key>': '<value>', ... },
--   'corp_tax_rate_bands': [{ 'effective_date': '...', 'rate_pct': 19 }, ...],
--   'corp_tax_adjustments': [{ 'adjustment_type': 'addback', 'account_code': '...', 'pct': null, 'treatment': null }, ...]
-- }

CREATE TABLE IF NOT EXISTS akrio_insight_settings (
  org_id INT PRIMARY KEY,
  settings_json JSON NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_insight_settings_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- insight_cache (cached computed report output per org+report_type) is NOT part of the fold
-- above - unlike the six settings tables, it can hold many rows per org (one per report_type)
-- and is a cache, not configuration, so it keeps its own table.
CREATE TABLE IF NOT EXISTS akrio_insight_cache (
  id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NOT NULL,
  report_type VARCHAR(100) NOT NULL,
  data_json JSON,
  fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_insight_cache_org FOREIGN KEY (org_id) REFERENCES akrio_organisations(id) ON DELETE CASCADE,
  UNIQUE KEY uq_insight_cache (org_id, report_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
