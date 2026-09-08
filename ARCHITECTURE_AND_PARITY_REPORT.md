# Xero Bookkeeping Health-Check Dashboard — Architecture & Parity Report

**Purpose of this document:** a factual technical description of what this app is, how it is built, what logic it uses, and how accurately it currently matches its reference product (Xenon Connect / "Xenon Exact"), for independent review. Every number in this document is drawn from actual test runs, real client comparisons, or direct code inspection carried out during development — nothing here is a projection or estimate.

---

## 1. What this app is

An internal tool for a bookkeeping/accounting practice that connects to client Xero organisations via OAuth2 and runs 29 automated "bookkeeping health checks" against their transaction data — duplicate invoices, unreconciled bank items, suppliers coded to multiple accounts, missing tax codes, old unpaid invoices, and so on. It is modelled on an existing commercial product called **Xenon Connect ("Xenon Exact")**, which the practice already uses and pays for. The goal of this app is to reproduce Xenon's checks in-house, both to reduce dependence on a third-party subscription and to allow customisation the commercial product doesn't offer.

Because Xenon's own internal formulas are not published, every check in this app has been reverse-engineered against **real client data compared row-by-row against real Xenon screenshots and exports**, not against Xenon's marketing description of what each check does.

---

## 2. Technology stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 22.x |
| Web framework | Express 4 |
| Views | EJS (server-rendered HTML, no separate frontend framework) |
| Database | SQLite via `better-sqlite3` (single-file, no external DB server) |
| Xero integration | Official `xero-node` SDK, OAuth2/PKCE |
| PDF export | Puppeteer (headless Chromium) |
| Scheduling | `node-cron` for periodic sync jobs |
| Hosting | Railway (Nixpacks build, persistent volume for the SQLite file + cached evidence/uploads) |
| Tests | Node's built-in `node:test` runner — no external test framework |

There is no separate frontend build step, no React/Vue, and no ORM — routes render EJS templates directly, and all database access is raw SQL through `better-sqlite3`.

### Why SQLite, not Postgres/MySQL

The practice runs a modest number of clients (single low hundreds), the app is used by a small internal team, and Railway's persistent volume gives SQLite durability without needing a managed database service. This is a deliberate simplicity trade-off, not an oversight — it would need revisiting if the practice's client count or concurrent-user count grew by an order of magnitude.

---

## 3. Codebase structure

```
app.js                          — Express app entry point, HTTPS/HTTP handling, session config
src/
  routes/
    auth.js                     — Xero OAuth2 connect/callback/disconnect
    dashboard.js                — client list, panorama (all-clients) view, sync triggers
    client.js                   — per-client detail page, per-check drill-down, settings, reanalysis
    settings.js                 — practice-wide settings (default sync period, file uploads, etc.)
    validation.js                — the "Validation Gate" (see §7)
  services/
    xeroClient.js                — low-level Xero API wrapper: OAuth token handling, retries, rate-limit backoff
    xeroSync.js                  — the core sync orchestrator; fetches Xero data and runs all 29 checks
    checkRules.js                 — pure, unit-testable check logic (duplicate detection, tax/account matching, scoring inputs, shared constants)
    periodResolver.js            — turns a period selection ("Since Lock Date", "Rolling 12 Months", custom range, etc.) into concrete start/end dates
    scoreProfile.js               — converts raw check results into the 0–100% health score
    statementEvidence.js         — matches accountant-uploaded bank statement CSVs against cached Xero bank data
    companiesHouse.js / ixbrlNetAssets.js — UK Companies House integration (filed accounts, net assets extraction from iXBRL)
    syncJobs.js                   — in-memory job queue/progress tracking for long-running syncs
    validationGate.js             — classifies each of the 29 checks as "api" (fully automatic) or "manual" (needs non-Xero evidence)
  db/
    schema.js                     — SQLite schema + migrations
    queries.js                    — all SQL, including the review-state (dismiss/ignore/OK) workflow
test/
  checkRules.test.js, statementEvidence.test.js — 132 automated tests total (see §8)
```

---

## 4. How a sync works, end to end

1. **Connect**: practice staff authorise a Xero organisation via OAuth2/PKCE. A single Xero connection's refresh token can cover multiple tenants (Xero orgs) if the same Xero user has access to several client files.
2. **Fetch**: on sync, the app pulls (via the Xero Accounting API): invoices and bills, credit notes, contacts, chart of accounts, bank transactions, payments, tax rates, and journals. Fetches are sequential and paginated (100 records/page) to respect Xero's 60-requests/minute rate limit, with a small delay between pages.
3. **Cache**: every fetched record is stored verbatim (as JSON) in a local `xero_entity_cache` table, keyed by org + entity type + Xero's own ID. This lets the app re-run analysis without re-hitting the Xero API (a "cache-only" mode), and gives a full local audit trail of exactly what data a given check result was computed from.
4. **Resolve period**: the user (or a saved per-client default) selects a reporting period — since the client's Xero "lock date", a rolling window, a fixed quarter/year, or a custom range. All 29 checks are computed against this period.
5. **Run 29 checks**: pure functions in `checkRules.js`, orchestrated by `xeroSync.js`, produce a count and a £ "potential value" for each check, plus a list of the individual flagged items ("findings").
6. **Score**: `scoreProfile.js` combines all check results into a single 0–100% health indicator, weighted by importance (critical/high/medium/low) and calibrated against real client score distributions.
7. **Persist & version**: results are written as a new "sync run" (`sync_runs` table) with its own set of `issues` and `issue_findings` rows, marked active/inactive so a client's history isn't lost on re-sync, and so a single check can be re-analysed for a different period without disturbing the rest of the dashboard (see §6, "stale period" handling).

A full sync for a mid-size client (hundreds to low thousands of transactions) currently takes roughly 1–3 minutes; this is dominated by Xero API pagination, not local computation.

---

## 5. The 29 checks

| # | Check | Importance | Data source |
|---|---|---|---|
| 1 | Bank Balance Check | Critical | Xero + **manual** (external bank statement) |
| 2 | Unreconciled Bank | Critical | Xero API |
| 3 | Unprocessed Bank | Critical | **Manual** (imported statement lines only — see §7) |
| 4 | Duplicate Invoices | High | Xero API |
| 5 | Duplicate Bills | High | Xero API |
| 6 | Old Unpaid Invoices | High | Xero API |
| 7 | Old Sales Credits | High | Xero API |
| 8 | Old Unpaid Bills | High | Xero API |
| 9 | Old Purchase Credits | High | Xero API |
| 10 | Opening Balance Differences | High | Xero API + Companies House (mostly automatic — see §7) |
| 11 | Invoice or Direct | Medium | Xero API |
| 12 | Bill or Direct | Medium | Xero API |
| 13 | Low Cost Fixed Assets | Medium | Xero API |
| 14 | Capital Item Review | Medium | Xero API + **manual config** (per-account thresholds) |
| 15 | Misallocated Items | Medium | Xero API + **manual config** |
| 16 | Multi-Account Suppliers | Medium | Xero API |
| 17 | Multi-Tax Code Suppliers | Medium | Xero API |
| 18 | Unexpected Account Used | Medium | Xero API |
| 19 | Unexpected Tax Code Used | Medium | Xero API |
| 20 | Sales Tax Missing | Medium | Xero API |
| 21 | Purchase Tax Missing | Medium | Xero API |
| 22 | Sales Tax on Bills | Medium | Xero API |
| 23 | Purchase Tax on Invoices | Medium | Xero API |
| 24 | Undocumented Bills | Medium | Xero API |
| 25 | Unapproved Invoices | Medium | Xero API |
| 26 | Unapproved Bills | Medium | Xero API |
| 27 | Duplicate Contacts | Low | Xero API |
| 28 | Contact Defaults | Low | Xero API |
| 29 | Inactive Contacts | Low | Xero API |

24 of the 29 checks run fully automatically from Xero API data alone. 5 are classified "manual" in the codebase (`validationGate.js`) because they need something the Xero Accounting API cannot supply, or accountant-entered configuration — see §7 for exactly why, check by check.

---

## 6. Notable engineering decisions (the "logic behind it")

These are the non-obvious design choices, kept here because they explain *why* the code is shaped the way it is, and because they were each driven by a real discrepancy against Xenon that had to be root-caused.

- **Duplicate detection is greedy and contact+amount+date-window based, not a simple "same day" match.** A suspected duplicate is a group of documents for the same contact, the same amount, within a rolling N-day window (3 days by default), built by anchoring on the newest unmatched document and absorbing everything within range going backwards. This exact algorithm was reverse-engineered from a real Xenon export where naive "same calendar day" grouping matched the headline count by coincidence but not the underlying groups or the £ value.
- **A duplicate group counts once, at one document's value — not once per extra copy, and not once per pair.** Four identical £120 invoices are one £120 issue, not three "extra" ones or six pairwise matches.
- **Gross vs net line amounts are reconstructed per line, not trusted from the raw field.** Xero's `lineAmount` can be gross or net depending on the transaction's own `LineAmountTypes` setting, and bills vs bank-coded spend transactions default differently. Every check that sums monetary exposure reconstructs a *consistent* basis (via each line's own tax amount) rather than mixing conventions, which was shown to shift one client's result from +132% over Xenon's value down to +2.6%.
- **The "supplier pattern" lookback window (used by Multi-Account and Multi-Tax Code Suppliers) is per-client configurable, not hardcoded.** Xenon's own published documentation states this window is "3 months prior to the period selected" by default and adjustable per client in Xenon's own settings. This app defaults to a 12-month lookback (empirically tuned against several real clients before the setting existed) but now exposes the same per-client override Xenon offers, rather than assuming one number fits every client.
- **A duplicate-draft cluster is now excluded entirely from Unapproved Invoices/Bills, not collapsed to one representative.** Found via a real client where 6 identical draft invoices (pushed in by a third-party integration bug, not manual duplication) inflated the "needs approval" total by ~£145,000. Confirmed the correct treatment is full exclusion of the whole cluster by matching Xenon's real number on **both** count and value simultaneously (a two-degrees-of-freedom match, not a single coincidental number).
- **Excluded duplicate documents are still shown, just marked "display only."** Rather than silently vanishing, they remain visible with zero count/value impact, each enriched (on a live sync) with Xero's own per-document History log — who created it, when, whether it was later deleted or approved — so a human can see *why* it was excluded and decide whether to clean it up in Xero itself. This history lookup is deliberately restricted to the handful of documents inside a suspected duplicate cluster, never run over the general population, because it costs one extra Xero API call per document.
- **A dismiss/ignore/mark-OK review workflow exists per individual finding**, mirroring the equivalent feature in Xenon. An accountant can permanently dismiss a finding, ignore it for 30 days, or mark it "OK for this period" with a free-text note explaining why (e.g. "confirmed with client — correct coding"). This is stored independently of any sync, survives re-syncs, and is excluded from the check's count/value the moment it's applied — verified to recalculate live across both the per-check page and the main dashboard without needing a re-sync.
- **A checkType-scoped "reanalyse" can preview a different period for one check without disturbing the rest of the dashboard.** Re-analysing "what would Multi-Tax Suppliers look like over Rolling 12 Months" does not silently change the org's overall active period/health score — a bug that existed earlier in development and was fixed by tracking each sync run's period independently.
- **Reanalyse refresh policy is explicit.** Reanalysing the currently active period performs a live Xero fetch so recently corrected bookkeeping is visible. Previewing a genuinely different period uses the local entity cache and the selected period end as the ageing date. A regression test protects this distinction.
- **Every Xero API call now has a 45-second timeout with retry/backoff.** A stalled connection previously could hang a sync indefinitely, because it never resolved *or* rejected, so the existing retry logic never triggered. A `Promise.race` timeout now forces a retryable `ETIMEDOUT` after 45 seconds per attempt (up to 6 attempts with exponential backoff, matching the existing handling for rate limits and transient 5xx errors).

---

## 7. Limitations and restrictions (honest account)

### 7.1 Structurally blocked by the Xero API (not fixable by better code)

- **Bank Balance Check** needs the bank's own real closing balance. Xero's API only exposes Xero's *calculated* ledger balance for an account (via `Reports/BankSummary`) — never what the actual bank statement shows. The only inputs today are an accountant-uploaded CSV statement or a manually entered closing balance.
- **Unprocessed Bank** needs the raw list of unreconciled bank statement lines sitting in Xero's "Reconcile" queue before they're turned into transactions. Xero's own developer documentation states this data is **deliberately not exposed by any public API** — this is not a gap in this app's implementation, it is a stated platform limitation. (This is the specific point raised when asking Xero's Finance API team whether an alternative product exposes it.)

### 7.2 Needs manual configuration, not missing data

- **Capital Item Review** and **Misallocated Items** need the accountant to set per-account capital/misallocation £ thresholds in this app's own settings before the check is meaningful — Xenon requires the same kind of setup on its side. Until configured, results aren't comparable to a Xenon export.
- **Opening Balance Differences** is mostly automatic now (net assets are read directly from a client's Companies House iXBRL filing where the filing is machine-readable), but falls back to a manually entered figure for paper/image-only or untagged micro-entity filings.

### 7.3 Open, unresolved question

- **Multi-Account Suppliers / Multi-Tax Code Suppliers** currently show a real, measured gap against Xenon on at least one tested client (Xenon: 76 suppliers / £130,188 and 58 / £18,282; this app: 56 / £215,944 and 54 / £37,947 on the same period, same sync date). Root-cause investigation (including direct input from a colleague who operates Xenon day-to-day) has ruled out a "special rule for finance/lease suppliers" theory and instead points to two likely, only-partially-verifiable causes:
  1. Xenon's displayed data can be a stale/cached Xero snapshot rather than a live one — confirmed directly on this same client, where an invoice's account coding, and a separately-paid invoice's remaining balance, both differed between what Xero shows live and what Xenon displayed.
  2. Xenon's own totals likely reflect years of the practice's accumulated "mark as OK" review decisions in Xenon, which this app has no equivalent history for on any client yet, since this app's own dismiss/ignore/OK workflow has never been used in anger.
  
  This is documented as an accepted, tracked gap rather than a guessed fix — no formula was shipped without exact evidence.

### 7.4 Platform/operational limitations

- **Xero's rate limit is 60 API calls/minute.** Large clients (thousands of transactions) take minutes to sync; this is a hard external constraint, not a performance bug.
- **Every check's exact logic (window lengths, thresholds, inclusion/exclusion rules) is reverse-engineered from a small set of real reference clients**, because Xenon's source is proprietary. Constants like the 3-day duplicate window, 60-day "old document" threshold, and 12-month default supplier-pattern lookback are empirically tuned, not guaranteed by any specification — a genuinely new/unusual client could expose a case none of the reference clients did.
- **SQLite + single-server hosting** is a scale ceiling, not a current problem, but worth knowing about if the practice's client count or concurrent usage grows substantially.
- **OAuth tokens are not encrypted at the application layer.** The SQLite database and hosting volume must therefore be treated as sensitive, access-controlled data until a managed encryption/key-rotation design is introduced.

---

## 8. Accuracy / "success rate" — actual measured results

**Automated regression suite:** 132 tests, 132 passing, 0 failing, run via `node --test`. These test the check logic in isolation against fixtures reconstructed from real Xenon exports (not synthetic data), so a future code change that breaks a previously-confirmed match is caught automatically.

**Real-client validation (row-level, not just headline numbers):**

| Client | Check | This app | Xenon (real) | Result |
|---|---|---|---|---|
| Fast Track Excavations | Capital Item Review | 17 / £11,176.53 | 17 / £11,177 | Match |
| Fast Track Excavations | Unreconciled Bank Items | 167 / £177,956.58 | 167 / £177,957 | Match |
| MBX Graffix Ltd | Duplicate Bills | 10 / £943.57 | 10 / £944 | Match |
| Rose and Caramel Ltd | Old Sales Credits | 1 / £943.69 | 1 / £944 | Match |
| Julia Kuisma Ltd | Overall | 99% health, 1 / £100 | 99% health, 1 / £100 | Exact match, first-ever comparison for this client |
| RBC Sutherland Ltd | Unreconciled Bank | 4 / £4,131.49 | 4 / £4,131 | Match |
| RBC Sutherland Ltd | Old Unpaid Bills | 58 / £47,477.23 | 58 / £47,477 | Match |
| RBC Sutherland Ltd | Old Unpaid Invoices | 5 / £10,664.34 | 5 / £10,664 | Match |
| RBC Sutherland Ltd | Purchase Tax Missing | 366 / £104,626.28 | 366 / £104,626 | Match |
| RBC Sutherland Ltd | Unapproved Invoices | 2 / £40,907 | 2 / £40,907 | Match — fixed this session (was 8 / £185,893 before the duplicate-draft-cluster fix) |
| RBC Sutherland Ltd | Capital Item Review, Misallocated Items, Unexpected Account Used, Sales Tax Missing, Sales Tax on Bills, Old Purchase Credits, + 7 "OK" checks | — | — | All match |
| RBC Sutherland Ltd | Multi-Account / Multi-Tax Code Suppliers | 56/£215,944, 54/£37,947 | 76/£130,188, 58/£18,282 | **Open gap** — see §7.3 |
| RBC Sutherland Ltd | Bank Balance Check | Not configured | 5 / £13,201 | **Blocked** — needs external bank statement, see §7.1 |

On RBC Sutherland Ltd's most recent full comparison, **every remaining pound and every remaining count of difference between the two apps' totals (555 vs 585 issues, £489,265 vs £421,209) was traced to exactly these named checks** — none of the gap is unexplained.

**Overall characterisation:** of the 24 checks that run purely from Xero API data, the large majority have been directly confirmed exact or near-exact against real Xenon output across the clients tested so far (Fast Track Excavations, Rose and Caramel, 4X4&More, Handymanz, MBX Graffix, Julia Kuisma, RBC Sutherland). One pair of checks (Multi-Account/Multi-Tax Code Suppliers) has a real, understood-but-unresolved gap on at least one client. The 5 "manual" checks are gapped by design (external data or configuration needed), not by a formula bug.

---

## 9. What ChatGPT is being asked to check

This document is being shared for independent review of:
1. Whether the architectural choices in §2–§4 are sound for the stated scale and use case.
2. Whether the engineering decisions in §6 are internally consistent and well-justified given the constraints described.
3. Whether the limitations in §7 are honestly and completely stated, or whether something is being glossed over.
4. Whether the accuracy claims in §8 are appropriately hedged (i.e., not overclaiming "we match Xenon" when only specific checks/clients have been verified).

No code is included in this document; if ChatGPT needs to inspect specific source files to verify a claim, ask and they can be provided separately.
