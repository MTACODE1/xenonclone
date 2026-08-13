# Xero Bookkeeping Health Dashboard — App Context

> **Purpose:** This document explains how this application works so AI assistants and developers can work on it without re-discovering the codebase. It reflects the **actual implementation**, not the original build spec.

---

## What This App Does

A **local, single-practice internal tool** that connects to Xero via OAuth 2.0, syncs client organisation data, runs **29 bookkeeping health checks**, calculates a **0–100 health score**, and displays results in a web dashboard styled to **MTA (More Than Accountants) design standards**.

Inspired by **Xenon Connect** — a bookkeeping quality dashboard for accounting practices.

**No user login system.** Anyone with access to `localhost` can use it. OAuth tokens are stored per Xero tenant in SQLite.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + Express (`app.js`) |
| Database | SQLite via `better-sqlite3` → `data/xero_dashboard.db` |
| Xero API | `xero-node` SDK (not raw HTTP) |
| Views | EJS templates in `src/views/` |
| Styling | Custom CSS (`public/style.css`) — MTA design tokens, not Tailwind |
| PDF | Puppeteer renders a dedicated printable report template |
| Scheduling | `node-cron` enqueues nightly work in the persistent sync queue |
| Fonts | Plus Jakarta Sans (Google Fonts CDN) |

---

## Project Structure

```
healthandtransactions/
├── app.js                    # Express entry, cron, HTTPS optional
├── src/
│   ├── routes/
│   │   ├── auth.js           # OAuth connect/callback/disconnect
│   │   ├── dashboard.js      # /, /panorama, /transactions, /health, sync endpoints
│   │   ├── client.js         # Client detail, check detail, PDF, per-client sync
│   │   ├── settings.js       # Practice name, logo, preferences
│   │   └── validation.js     # Xenon evidence imports and cancellation gate
│   ├── services/
│   │   ├── xeroClient.js     # Token refresh, apiCall wrapper, rate-limit retry
│   │   ├── xeroSync.js       # Versioned fetch/check orchestration
│   │   ├── checkRules.js     # Pure deterministic check rules
│   │   ├── scoreProfile.js   # Versioned explainable scoring model
│   │   ├── syncJobs.js       # Persistent bounded queue and progress
│   │   ├── statementEvidence.js # Private bank-statement evidence
│   │   ├── periodResolver.js # Report-period boundaries
│   │   └── validationGate.js # Cancellation-gate evaluator
│   ├── db/
│   │   ├── schema.js         # Table creation on startup
│   │   └── queries.js        # All SQLite read/write helpers
│   └── views/                # EJS pages + partials (header, footer)
├── public/style.css          # MTA design system CSS
├── data/xero_dashboard.db    # SQLite database (created at runtime)
├── certs/                    # Optional localhost HTTPS certs
├── CLAUDE.md                 # Original build specification
├── DESIGN_STANDARDS.md       # MTA React/MUI design reference (for styling guidance)
└── APP_CONTEXT.md            # This file
```

---

## Routes & Pages

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | Client list — search, tag/status filters, sync buttons |
| `/panorama` | GET | Data quality overview — health scores, issues, reconciliation stats |
| `/transactions` | GET | Rolling 12-month transaction counts per client |
| `/settings` | GET/POST | Practice name, logo upload, sync preferences |
| `/client/:tenantId` | GET | Individual health check page with all 29 checks |
| `/client/:tenantId/check/:checkType` | GET | Issue detail table for one check |
| `/client/:tenantId/report.pdf` | GET | Dedicated report PDF via Puppeteer |
| `/client/:tenantId/sync` | POST | Enqueue a period-aware client sync |
| `/client/:tenantId/check/:checkType/reanalyse` | POST | Reanalyse one check without replacing the others |
| `/sync/:tenantId` | POST | Enqueue sync from dashboard |
| `/sync-all` | POST | Enqueue all connected organisations |
| `/validation` | GET | Xenon comparison and cancellation gate |
| `/validation/import` | POST | Import a private JSON/CSV Xenon snapshot |
| `/auth/connect` | GET | Start Xero OAuth flow |
| `/auth/callback` | GET | OAuth callback — store tokens, redirect to dashboard |
| `/auth/disconnect/:tenantId` | GET | Revoke and mark org disconnected |
| `/health` | GET | JSON status of all orgs (connection, last sync, score) |

---

## Data Flow

```
User clicks Connect
  → OAuth PKCE flow via xero-node
  → Tokens stored in xero_tokens table
  → Organisation row created in organisations

User clicks Sync (or cron at 2am)
  → persistent bounded queue creates a sync job/run
  → syncOrganisation(tenantId, options) in xeroSync.js
  → apiCall() refreshes token if needed, retries on 429
  → Incrementally fetch and merge raw entities into xero_entity_cache
  → Run deterministic checks against one reused in-memory dataset
  → Stage issues, normalized findings, score and transaction counts under sync_run_id
  → Atomically activate the completed run; a failed run leaves the prior report active
  → UI reads only the active SQLite snapshot (no live Xero calls on page load)
```

---

## Database Tables

- **organisations** — Connected Xero clients (`xero_tenant_id`, name, client_ref, tag, connection_status, last_synced_at)
- **health_scores** — Score 0–100, total_issues, total_potential_errors_gbp, lock_date, unreconciled_bank_items, most_recent_transaction
- **issues** — One row per check per sync (`check_type`, `importance`, `count`, `potential_value_gbp`, `detail_json`)
- **issue_findings** — Full normalized, paginated finding rows with stable keys
- **finding_review_states / finding_review_audit** — dismiss, ignore, period OK and audit history
- **xero_tokens** — access_token, refresh_token, expires_at per tenant
- **settings** — Key-value (practice_name, logo path, etc.)
- **transaction_counts** — Period-aware volumes (turnover, invoices, bills, bank, journals)
- **sync_runs / sync_jobs** — Atomic report snapshots plus persistent queue/history
- **xero_entity_cache** — Reusable incremental raw Xero entity cache
- **statement_imports / statement_lines** — Private statement evidence and normalized lines
- **filed_accounts** — Filed net-assets evidence for opening-balance comparison
- **validation_snapshots / validation_snapshot_checks / validation_gate_assurances** — Xenon parity evidence and cancellation gate

---

## Health Checks (29 total)

Defined in `CHECK_DEFINITIONS` in `src/services/checkRules.js`; the evidence status and formulas are documented in `XENON_PARITY_SPEC.md`.

### Scoring

- Start at **100**
- The versioned provisional profile in `scoreProfile.js` applies bounded severity, count, value and
  age signals per active check and stores an explainable breakdown with each score.
- The current global scale is fitted only to the verified partial MBX observation and must remain
  labelled provisional until several independent Xenon observations are imported.
- **Non-scored checks:** `duplicate_contacts`, `contact_defaults`, `inactive_contacts`, and
  `undocumented_bills` (shown in UI but excluded from score and headline issue totals)
- Minimum score: 0
- **A check that failed to sync this cycle (Xero API error, rate limit, etc.) is excluded from
  the score entirely** — it is never scored as "0 issues found." See "Fail-safe sync" below.

### Fail-safe sync

If a Xero fetch a check depends on fails mid-sync, that check is **not** written to the database
this cycle — it is left out entirely rather than recorded as a false "0 issues" clean result. The
existing "Not synced" UI state (`count == null`, used for checks that have never run) is reused to
surface this, so a transient API failure can never look identical to a verified-clean check.

### Implemented checks

| Type | Importance | Label |
|---|---|---|
| `bank_balance` | critical | Bank Balance Check |
| `unreconciled_bank_items` | critical | Unreconciled Bank |
| `unprocessed_bank` | critical | Unprocessed Bank (unavailable with current API) |
| `duplicate_invoices` | high | Duplicate Invoices |
| `duplicate_bills` | high | Duplicate Bills |
| `old_unpaid_invoices` | high | Old Unpaid Invoices |
| `old_unpaid_bills` | high | Old Unpaid Bills |
| `old_sales_credits` | high | Old Sales Credits |
| `old_purchase_credits` | high | Old Purchase Credits |
| `opening_balance_differences` | high | Opening Balance Differences (unavailable without filed accounts data) |
| `invoice_or_direct` | medium | Invoice or Direct |
| `bill_or_direct` | medium | Bill or Direct |
| `low_cost_fixed_assets` | medium | Low Cost Fixed Assets |
| `capital_item_review` | medium | Capital Item Review |
| `misallocated_items` | medium | Misallocated Items |
| `multi_account_suppliers` | medium | Multi-Account Suppliers |
| `multi_tax_suppliers` | medium | Multi-Tax Code Suppliers |
| `unexpected_account_used` | medium | Unexpected Account Used |
| `unexpected_tax_code_used` | medium | Unexpected Tax Code Used |
| `sales_tax_missing` | medium | Sales Tax Missing |
| `purchase_tax_missing` | medium | Purchase Tax Missing |
| `sales_tax_on_bills` | medium | Sales Tax on Bills |
| `purchase_tax_on_invoices` | medium | Purchase Tax on Invoices |
| `undocumented_bills` | medium | Undocumented Bills |
| `unapproved_invoices` | medium | Unapproved Invoices |
| `unapproved_bills` | medium | Unapproved Bills |
| `duplicate_contacts` | low | Duplicate Contacts |
| `contact_defaults` | low | Contact Defaults |
| `inactive_contacts` | low | Inactive Contacts |

### Manual-evidence checks

`opening_balance_differences` is driven by filed-accounts evidence plus a Xero Balance Sheet value.
`unprocessed_bank` is driven by privately imported statement lines and explicitly labelled local
matching confidence. Without the required evidence they are unavailable/not configured and unscored,
never presented as verified-clean.

### Known limitation: Bank Balance Check

Xero's standard Accounting API provides Xero's calculated bank balance but not the external
statement/feed balance. The accountant imports statement CSV evidence or enters a closing balance
in the client page. Until at least one account is configured, the check shows **Not configured**.
Once configured, it reports the absolute difference between the Xero calculated balance and the
evidenced statement balance; it does not reuse unreconciled volume as a proxy.

### Unreconciled Bank: two filters that matter

The check counts AUTHORISED bank transactions and AUTHORISED payments with `IsReconciled=false`,
subject to two restrictions that were each worth thousands of false findings:

- **Period-scoped.** Items are bounded by both ends of the selected period, not just its end.
  Xenon reports a cumulative backlog from before the lock date as clean.
- **Bank accounts only.** Xero leaves `IsReconciled=false` on every payment posted to a non-bank
  ledger account (Suspense, Sales Control, Directors' Loan) because there is no feed to reconcile
  it against. Only payments whose account is type `BANK` are counted.

Together these took two reference clients from 2,467 and 391 findings to Xenon's zero, while the
client whose payments sit on real bank accounts stayed at 121 against Xenon's 117.

---

## Xero API Patterns

All API calls go through **`apiCall(tenantId, fn)`** in `xeroClient.js`:

1. Load token from SQLite
2. Refresh if expired (60s buffer)
3. Execute callback with authenticated `xero` client
4. On 429: exponential backoff, up to 6 retries

**Pagination:** Invoice fetches use `fetchAllInvoices()` with 100/page and 1s delay between pages (Xero rate limit ~60 req/min).

**Scopes** (in `xeroClient.js`): openid, profile, email, offline_access, accounting.settings.read, accounting.contacts.read, accounting.invoices.read, accounting.banktransactions.read, accounting.manualjournals.read, accounting.payments.read, accounting.reports.read, accounting.reports.balancesheet.read

---

## UI & Design

- **Server-rendered EJS** — not React (DESIGN_STANDARDS.md describes a separate React/MUI app; use it for colors, spacing, and layout guidance only)
- **MTA CSS variables** in `public/style.css`: `--mta-dark-blue: #01406A`, `--primary: #5D87FF`, `--success: #13DEB9`, 270px sidebar, 70px header, 7px border radius
- **Health score colors:** Green 80–100%, Orange 60–79%, Red 0–59%
- **Importance colors:** Critical (red), High (orange), Medium (amber), Low (grey)
- **Date format:** DD/MM/YYYY | **Currency:** £X,XXX.XX

---

## Environment Variables (.env)

```
XERO_CLIENT_ID=
XERO_CLIENT_SECRET=
XERO_REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=some_random_string
PORT=3000
```

If `XERO_REDIRECT_URI` starts with `https://`, the app serves over HTTPS using certs in `certs/`.

---

## Running the App

```bash
npm install
# If better-sqlite3 fails: npm rebuild better-sqlite3
npm start          # or npm run dev
```

Open http://localhost:3000 → Connect Client → Sync.

---

## Key Conventions for Contributors

1. **Never make raw Xero HTTP calls** — use `apiCall()` via `xero-node`
2. **Always paginate** large Xero datasets
3. **Store issue details as JSON** in `issues.detail_json` for the detail pages
4. **Add new checks** to `CHECK_DEFINITIONS` and implement in `syncOrganisation()`
5. **Match existing EJS + CSS patterns** — see `src/views/partials/header.ejs` and `public/style.css`
6. **Contact checks** must stay excluded from `calculateHealthScore()` and total issue counts
7. **Rate limiting** — sequential fetches with delays; don't parallelise bulk Xero calls

---

## Related Documentation

| File | Use when |
|---|---|
| `APP_CONTEXT.md` | Understanding how this app actually works |
| `CLAUDE.md` | Original feature spec and build phases |
| `DESIGN_STANDARDS.md` | MTA brand colors, typography, component patterns |
| `README.md` | Setup instructions and feature overview |
