const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

test('legacy report rows migrate into an active synthetic run', () => {
  const dbPath = path.join(os.tmpdir(), `xero-phase8-migration-${process.pid}-${Date.now()}.db`);
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE organisations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, xero_tenant_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL, client_ref TEXT, tag TEXT, connection_status TEXT DEFAULT 'connected',
      last_synced_at DATETIME, financial_year_end_day INTEGER,
      financial_year_end_month INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE health_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER, score INTEGER,
      total_issues INTEGER DEFAULT 0, total_potential_errors_gbp REAL DEFAULT 0,
      last_bank_reconciled DATE, most_recent_transaction DATE,
      unreconciled_bank_items INTEGER DEFAULT 0, lock_date DATE, period_key TEXT,
      period_type TEXT, period_start DATE, period_end DATE, period_label TEXT,
      score_profile_version TEXT, score_breakdown_json TEXT,
      calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER, check_type TEXT NOT NULL,
      importance TEXT NOT NULL, count INTEGER DEFAULT 0, potential_value_gbp REAL DEFAULT 0,
      detail_json TEXT, period_checked TEXT, synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE issue_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL, org_id INTEGER NOT NULL,
      check_type TEXT NOT NULL, finding_key TEXT NOT NULL, detail_json TEXT NOT NULL,
      display_only INTEGER DEFAULT 0, potential_value_gbp REAL DEFAULT 0,
      UNIQUE(issue_id, finding_key)
    );
    CREATE TABLE transaction_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER, period TEXT NOT NULL,
      period_start DATE, period_end DATE, months_covered REAL DEFAULT 12,
      turnover REAL DEFAULT 0, total_transactions INTEGER DEFAULT 0,
      customer_invoices INTEGER DEFAULT 0, supplier_bills INTEGER DEFAULT 0,
      credit_notes_sales INTEGER DEFAULT 0, credit_notes_purchase INTEGER DEFAULT 0,
      bank_processed INTEGER DEFAULT 0, journals INTEGER DEFAULT 0,
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO organisations (xero_tenant_id, name, last_synced_at)
      VALUES ('legacy', 'Legacy Ltd', '2026-08-06T02:00:00Z');
    INSERT INTO health_scores (org_id, score) VALUES (1, 88);
    INSERT INTO issues (org_id, check_type, importance, count)
      VALUES (1, 'unapproved_bills', 'medium', 2);
  `);
  legacy.close();

  process.env.XERO_DASHBOARD_DB_PATH = dbPath;
  const { getDb } = require('../src/db/schema');
  const migrated = getDb();
  const run = migrated.prepare(`SELECT * FROM sync_runs WHERE org_id = 1 AND is_active = 1`).get();
  assert.equal(run.status, 'succeeded');
  assert.equal(migrated.prepare(`SELECT is_active FROM issues WHERE id = 1`).get().is_active, 1);
  assert.equal(migrated.prepare(`SELECT run_id FROM health_scores WHERE id = 1`).get().run_id, run.id);
  // Legacy aggregate rows have no normalized issue_findings. Reading the report must preserve
  // their stored count instead of replacing it with COUNT(issue_findings) = 0.
  const { getIssuesForOrg } = require('../src/db/queries');
  assert.equal(getIssuesForOrg(1)[0].count, 2);
});
