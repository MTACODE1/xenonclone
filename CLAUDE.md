# Claude Code Build Prompt: Xero Bookkeeping Health Dashboard

## Project Overview
Build a local Node.js web application that replicates the core features of Xenon Connect — a bookkeeping quality dashboard for accounting practices. It connects to Xero via OAuth 2.0, pulls client organisation data, runs bookkeeping health checks, and stores everything in a local SQLite database. No user login system needed — this is a single-practice internal tool.

---

## Tech Stack
- **Runtime:** Node.js (Express)
- **Database:** SQLite via `better-sqlite3`
- **Auth:** Xero OAuth 2.0 (PKCE flow) using `xero-node` SDK
- **Frontend:** Server-rendered HTML with Tailwind CSS (CDN), vanilla JS
- **PDF Export:** `puppeteer` for generating health check reports
- **Scheduling:** `node-cron` for periodic data refresh

---

## Phase 1: Project Setup & Xero OAuth

### 1.1 Folder Structure
```
/xero-dashboard
  /src
    /routes         → Express route files
    /services       → Xero API calls, data processing
    /db             → SQLite schema + query helpers
    /views          → HTML templates (or use a template engine like EJS)
    /public         → CSS, JS assets
  app.js            → Express entry point
  .env.example      → Environment variable template
  README.md         → Setup instructions including Xero app creation steps
```

### 1.2 Environment Variables (.env)
```
XERO_CLIENT_ID=
XERO_CLIENT_SECRET=
XERO_REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=some_random_string
PORT=3000
```

### 1.3 README — Xero Developer App Setup
Include clear step-by-step instructions in README.md:
1. Go to https://developer.xero.com/app/manage
2. Click "New App"
3. App name: anything (e.g. "My Practice Dashboard")
4. Company URL: http://localhost:3000
5. OAuth 2.0 redirect URI: http://localhost:3000/auth/callback
6. Scopes needed: `openid profile email accounting.transactions.read accounting.reports.read accounting.settings.read offline_access`
7. Copy Client ID and Client Secret into .env file

---

## Phase 2: SQLite Database Schema

Create all tables on app startup via a migration file.

### Tables Required:

**organisations** — one row per connected Xero client
```sql
CREATE TABLE organisations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  xero_tenant_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  client_ref TEXT,
  tag TEXT,
  connection_status TEXT DEFAULT 'connected', -- connected | disconnected
  last_synced_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**health_scores** — calculated health score per org, updated on each sync
```sql
CREATE TABLE health_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER REFERENCES organisations(id),
  score INTEGER,                    -- 0-100
  total_issues INTEGER DEFAULT 0,
  total_potential_errors_gbp REAL DEFAULT 0,
  last_bank_reconciled DATE,
  most_recent_transaction DATE,
  unreconciled_bank_items INTEGER DEFAULT 0,
  lock_date DATE,
  calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**issues** — individual bookkeeping issues per org
```sql
CREATE TABLE issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER REFERENCES organisations(id),
  check_type TEXT NOT NULL,         -- e.g. 'duplicate_invoices', 'old_unpaid_bills'
  importance TEXT NOT NULL,         -- critical | high | medium | low
  count INTEGER DEFAULT 0,
  potential_value_gbp REAL DEFAULT 0,
  detail_json TEXT,                 -- JSON blob of the actual offending items
  period_checked TEXT,              -- e.g. 'since_lock_date'
  synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**xero_tokens** — store OAuth tokens per tenant
```sql
CREATE TABLE xero_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  xero_tenant_id TEXT UNIQUE NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## Phase 3: Xero OAuth Flow

### Routes: `/auth`
- `GET /auth/connect` → redirect to Xero authorisation URL
  - Scopes: openid, profile, email, accounting.transactions.read, accounting.reports.read, accounting.settings.read, offline_access
  - Use state parameter for CSRF protection
- `GET /auth/callback` → exchange code for tokens, fetch tenant list, store all in SQLite, redirect to dashboard
- `GET /auth/disconnect/:tenantId` → revoke token and mark org as disconnected

### Token Management Service
- On every API call, check if access token is expired
- If expired, use refresh token to get a new one automatically
- Store updated tokens back to SQLite
- If refresh fails, mark org as disconnected

---

## Phase 4: Xero Data Sync Service

Create `src/services/xeroSync.js` that runs all of these checks for a given tenant:

### 4.1 Organisation Info
- Fetch org name, base currency, tax number, financial year end, lock date
- Store/update in `organisations` table

### 4.2 Bookkeeping Health Checks
For each check, fetch data from Xero API and count issues. Store results in `issues` table.

**CRITICAL importance:**
- **Bank Balance Check** — GET `/BankTransactions` + compare with bank statement balances via `/Reports/BalanceSheet`. Flag accounts where Xero balance differs from bank feed balance.
- **Unreconciled Bank Items** — GET `/BankTransactions?where=IsReconciled=false` — count items older than 30 days

**HIGH importance:**
- **Duplicate Invoices** — GET `/Invoices?Status=AUTHORISED,SUBMITTED` — find invoices with same contact + same amount + same date (within 7 days)
- **Duplicate Bills** — same as above but for bills (Type=ACCPAY)
- **Old Unpaid Invoices** — GET `/Invoices?Status=AUTHORISED&where=Type="ACCREC"` — filter those with DueDate > 60 days ago
- **Old Unpaid Bills** — same for ACCPAY type, DueDate > 60 days ago
- **Old Sales Credits** — GET `/CreditNotes?Status=AUTHORISED&Type=ACCREC` — older than 60 days, unallocated
- **Old Purchase Credits** — same for ACCPAY credit notes

**MEDIUM importance:**
- **Unapproved Invoices** — GET `/Invoices?Status=DRAFT,SUBMITTED&Type=ACCREC`
- **Unapproved Bills** — GET `/Invoices?Status=DRAFT,SUBMITTED&Type=ACCPAY`
- **Invoice or Direct** — Find bank receipts coded to income accounts where an unpaid invoice exists for same contact + similar amount within 7 days
- **Bill or Direct** — Same logic for payments vs outstanding bills
- **Multi-Account Suppliers** — Group all bills/bank payments by contact, flag contacts where more than 1 distinct account code is used
- **Multi-Tax Code Suppliers** — Same but for tax codes
- **Purchase Tax Missing** — Bills/payments to expense account codes with no tax code or "No VAT" tax code
- **Sales Tax Missing** — Invoices/receipts to income account codes with no tax code

**LOW importance:**
- **Duplicate Contacts** — GET `/Contacts` — find contacts with very similar names (use Levenshtein distance ≤ 2 or matching first+last name with different spacing/spelling)
- **Contact Defaults** — GET `/Contacts` — flag contacts with no DefaultAccountCode or no DefaultTaxType set
- **Inactive Contacts** — Contacts with no transactions in the last 12 months

### 4.3 Health Score Calculation
After running all checks, calculate a 0–100 score:
```
Base score: 100
Deductions:
  - Each CRITICAL issue with count > 0: -15 points
  - Each HIGH issue with count > 0: -8 points  
  - Each MEDIUM issue with count > 0: -3 points
  - Each LOW issue with count > 0: -1 point
  - Scale deductions by severity of count (more issues = more deduction, capped per category)
Minimum score: 0
```
Store in `health_scores` table.

### 4.4 Transaction Counts
Fetch and store per org:
- Turnover (sum of ACCREC invoice amounts for the period)
- Total transactions count
- Customer invoices count
- Supplier bills count
- Bank transactions processed count

---

## Phase 5: Dashboard UI

### 5.1 Client List Page — `GET /`
Replicate the Xenon Connect client list. Show a table with:
- Client reference number (editable inline)
- Business name (clickable → goes to individual health check page)
- Connection status icon (green connected / red disconnected)
- Tag/label (editable — stored locally in SQLite, not in Xero)
- Last synced time
- Quick "Sync Now" button per client
- "Connect New Client" button → triggers OAuth flow

Filters at top:
- Search by name
- Filter by tag
- Filter by connection status (connected/disconnected)

Show overall stats bar:
- Total connected organisations
- Average health score across all clients

### 5.2 Data Quality / Client Panorama Page — `GET /panorama`
Table view showing all clients with:
- Business name + client ref
- Connection status icons
- **Bookkeeping Health Score** — circular donut chart (use Chart.js) showing percentage, coloured:
  - Green: 80–100%
  - Orange: 60–79%
  - Red: 0–59%
- **Issues count** + total potential errors in £
- Clickable issues count → dropdown showing breakdown by check type with links
- Most Recent Transaction date (and days ago)
- Last Bank Item Reconciled date
- Unreconciled Bank Items count
- Lock Date
- Actions menu (Open, Sync, Edit details)

Sort options:
- Business Name A–Z
- Health Score (lowest first)
- Health Score (highest first)
- Number of Issues
- Most Recent Transaction
- Lock Date

Filter options:
- By tag
- By connection status

Summary stats cards at top:
- Average Health Score (with donut chart)
- Total Issues across all clients
- Total Potential Errors £
- Total Unreconciled Bank Items
- Number of organisations shown

### 5.3 Individual Client Health Check Page — `GET /client/:tenantId`
Left sidebar:
- Period selector dropdown (Since Lock Date, Current Month, Previous Month, Rolling 12 Months, Current FY, Previous FY, Custom Date Range)
- Health score donut chart
- Issues count + potential errors total
- Improvement checklist — list of all 25 check types with count in brackets
- "Show all checks" toggle

Main content area:
- "Basis of check" summary cards (Period Checked, Items Checked, Number of Checks)
- "Summary of results" cards (Potential Issues, Potential Financial Errors £, Health Indicator %)
- "Detailed results" accordion — one card per check type showing:
  - Check name + importance level (colour coded)
  - Issue count + potential value
  - Green tick (OK) or orange ! (issues found)
  - Expand/collapse description (Issue / So What? / Solution)
  - "View Issues" link → goes to detail page for that check

Download button → PDF report (see Phase 6)
Sync button → re-runs all checks for this client

### 5.4 Issue Detail Page — `GET /client/:tenantId/check/:checkType`
Table of all offending items for that specific check. For example:
- Bill or Direct: shows contact name, date, bill amount, payment amount, difference
- Old Unpaid Invoices: shows invoice number, contact, date, amount, days overdue
- Multi-Account Suppliers: grouped by supplier, showing all transactions and account codes used
- Purchase Tax Missing: table of all transactions with no tax code

Each row should have a direct link to the item in Xero (`https://go.xero.com/AccountsPayable/...`).

---

## Phase 6: PDF Report Export

### `GET /client/:tenantId/report.pdf`
Use Puppeteer to render the health check page as a PDF with:
- Practice logo placeholder (configurable via settings)
- Client name and report date at top
- Basis of Report table
- Key Findings summary
- Detailed Results table (all 25 checks in a clean table format)
- Separate sections for each check that has issues, showing the full detail table

Match the style of the PDF in the reference documents — clean two-column layout, colour-coded importance labels (Critical in red, High in orange, Medium in amber, Low in grey).

---

## Phase 7: Auto-Sync & Settings

### Background Sync
Use `node-cron` to run a full sync for all connected organisations:
- Every night at 2am: sync all clients
- On demand: "Sync All" button on dashboard, "Sync" button per client

### Settings Page — `GET /settings`
Simple form to configure:
- Practice name (shown on PDF reports)
- Practice logo upload (stored locally, shown on reports)
- Default sync period preference
- Per-client: client reference number, custom tag, notes

---

## Phase 8: Error Handling & UX

- Show clear loading spinners during sync operations (use SSE or polling to show progress)
- If Xero connection is broken (token expired beyond refresh), show "Reconnect" button
- Handle Xero API rate limits (429 errors) with automatic retry + exponential backoff
- Show last sync time on all pages
- If a check has never been run, show "Not yet synced" rather than 0
- All monetary values formatted as £X,XXX.XX
- All dates formatted as DD/MM/YYYY

---

## Dependencies to Install
```json
{
  "dependencies": {
    "express": "^4.18.0",
    "express-session": "^1.17.0",
    "better-sqlite3": "^9.0.0",
    "xero-node": "^4.34.0",
    "dotenv": "^16.0.0",
    "ejs": "^3.1.0",
    "node-cron": "^3.0.0",
    "puppeteer": "^21.0.0",
    "multer": "^1.4.0",
    "fast-levenshtein": "^3.0.0",
    "date-fns": "^2.30.0"
  }
}
```

---

## Key Notes for Claude Code
1. Use `xero-node` SDK — do not make raw HTTP calls to Xero API
2. The Xero API uses pagination — always loop through all pages when fetching invoices/bills/contacts
3. Store raw Xero data as JSON in SQLite so the UI can be rebuilt without re-fetching from Xero
4. All Xero API calls should go through a single wrapper function that handles token refresh automatically
5. The health score and issue checks should be re-runnable on stored data (so we can recalculate without hitting Xero API again)
6. Build the OAuth flow first and test it connects before building any other features
7. Add a `/health` endpoint that shows connection status for all tenants and last sync times
