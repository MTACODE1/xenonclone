# Xero Bookkeeping Health Dashboard

A local Node.js web application replicating core features of Xenon Connect — a bookkeeping quality dashboard for accounting practices.

**Styled with MTA (More Than Accountants) Design Standards:**
- Plus Jakarta Sans typography
- Brand colors: #01406A (primary), #5D87FF (secondary), #13DEB9 (success)
- 270px fixed sidebar with navigation
- 70px sticky header
- 7px border radius on all cards and buttons
- Consistent spacing and elevation system

## Features

- **Xero OAuth 2.0 Integration** — Connect multiple Xero organisations
- **25 Bookkeeping Health Checks** — Automated checks for common bookkeeping issues across Critical / High / Medium / Low importance levels
- **0–100 Health Score** — Calculated per client based on severity and count of issues
- **Nightly Auto-Sync** — Scheduled data refresh for all connected clients at 2am
- **PDF Report Export** — Generate professional health check reports per client
- **Data Quality Panorama** — Overview table showing health metrics across all clients
- **Transaction Counts** — View transaction volumes with period filtering
- **Settings** — Configure practice name, logo, and sync preferences

## Tech Stack

- **Backend:** Node.js + Express
- **Database:** SQLite (better-sqlite3)
- **Auth:** Xero OAuth 2.0 (xero-node SDK)
- **Frontend:** Server-rendered EJS templates with MTA design system
- **PDF:** Puppeteer
- **Scheduling:** node-cron

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Create Xero Developer App
1. Go to https://developer.xero.com/app/manage
2. Click "New App"
3. App name: anything (e.g. "My Practice Dashboard")
4. Company URL: http://localhost:3000
5. OAuth 2.0 redirect URI: http://localhost:3000/auth/callback
6. Scopes needed: `openid profile email accounting.transactions.read accounting.reports.read accounting.settings.read offline_access`
7. Copy Client ID and Client Secret into your `.env` file

### 3. Configure environment
```bash
cp .env.example .env
# Edit .env with your Xero credentials:
# XERO_CLIENT_ID=your_client_id
# XERO_CLIENT_SECRET=your_client_secret
# XERO_REDIRECT_URI=http://localhost:3000/auth/callback
# SESSION_SECRET=some_random_string
# PORT=3000
```

### 4. Start the server
```bash
npm start
```

Open **http://localhost:3000** in your browser.

## Usage

1. Click "Connect Client" to authorize a Xero organisation
2. After connecting, click "Sync" to run all 25 health checks
3. View the client list, panorama, or individual client health reports
4. Download PDF reports for any client
5. View transaction counts across all clients

## Health Checks

The dashboard runs 25 automated checks grouped by importance:

**Critical:**
- Bank Balance Check
- Unreconciled Bank Items

**High:**
- Duplicate Invoices
- Duplicate Bills
- Old Unpaid Invoices (>60 days)
- Old Unpaid Bills (>60 days)
- Old Sales Credits (>60 days)
- Old Purchase Credits (>60 days)
- Opening Balance Differences

**Medium:**
- Invoice or Direct (potential double-counting)
- Bill or Direct (potential double-counting)
- Low Cost Fixed Assets (<£200)
- Capital Item Review
- Misallocated Items
- Multi-Account Suppliers
- Multi-Tax Code Suppliers
- Unexpected Account Used
- Unexpected Tax Code Used
- Sales Tax Missing
- Purchase Tax Missing

**Low:**
- Unapproved Invoices
- Unapproved Bills
- Duplicate Contacts
- Contact Defaults Missing
- Inactive Contacts

## Database Schema

SQLite database with 5 tables:
- `organisations` — Connected Xero clients
- `health_scores` — Calculated health scores per org
- `issues` — Individual check results
- `xero_tokens` — OAuth tokens (encrypted)
- `settings` — Practice configuration
- `transaction_counts` — Transaction volume data

## Scheduled Tasks

- **Nightly Sync:** Runs at 2:00 AM daily for all connected organisations
- **Token Refresh:** Automatic before each API call if expired

## Development

```bash
# Run with auto-restart on file changes
npm run dev
```

## License

MIT
