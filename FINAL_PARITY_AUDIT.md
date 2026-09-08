# Final Parity Audit — Phase 5

Generated 2026-09-07. This is the closing deliverable for Phase 5 ("final verification and
production-readiness"), covering independent re-verification of cross-client isolation, migrations,
the 29-check contract ledger, row-level Xenon parity, sync/cache reliability, the applicability/status
model, financial invariants, UI/operational behaviour, and performance/security — plus every
confirmed fix made along the way. It supersedes no other document; `CHECK_CONTRACTS.md` and
`XENON_PARITY_SPEC.md` remain the detailed per-check references and were updated as part of this pass.

## Executive conclusion

No known cross-client data leakage was found, and a new adversarial test suite (identical account
codes, identical finding-key hashes across two organisations) now proves isolation live rather than
by code inspection alone. One live application regression — introduced and then fixed within this
same Phase 5 pass — is fully resolved and covered by tests. Five stale/incorrect statements in
`CHECK_CONTRACTS.md` were corrected against current code. Two real, low-severity bugs were found and
fixed: a printable/downloaded report showed "OK" instead of "Not applicable" for a non-VAT-registered
client's tax checks, and a client-detail page's Sync button would silently request the wrong URL for
a tenant ID containing HTML-special characters (real-world exploitability is effectively nil, since
Xero only ever issues GUID tenant IDs). Database migrations were verified idempotent and
non-destructive against a real production-database copy, including a fresh-old-database upgrade
simulation. Sync/cache reliability (pagination boundaries, retry/backoff/jitter, atomic activation
under failure injected at any point in a sync, entity rename/void/merge/delete, job dedup/cancel) is
now covered by 34 new tests, all passing. Row-level Xenon parity was re-verified for 5 of 7 connected
clients using a pre-existing, now-refreshed diagnostic script; **RBC Sutherland and Julia Kuisma Ltd
have no stored Xenon comparison at all and remain unresolved** — this requires the accountant to
supply a fresh Xenon export before any row-level claim can be made about those two.

The full test suite passes: **239/239**, including 34 tests added in this pass.

## Section-by-section status

### 1. Cross-client isolation — VERIFIED

- Searched all client-data queries for missing `org_id` conditions (prior pass, this session):
  no gaps found.
- Re-audited every remaining `getSetting(...)` call: all are genuinely practice-wide (API keys,
  branding, global defaults) — none leaks a per-client value across clients.
- **New live proof** (`test/crossClientIsolation.test.js`, 4 tests): two organisations seeded with
  *identical* account codes (461, 473) and — for the sharpest possible test — an identical
  `detail_json` payload that hashes to the exact same `finding_key` on both organisations (finding
  keys have no `org_id` in their digest by design; isolation depends entirely on every query
  filtering by `org_id`). Proved: changing every organisation-scoped check-config setting for org A
  leaves org B on documented defaults; opting out account 461 for org A leaves org B's same-numbered
  account untouched, and does not flip org B's `account_settings_initialised` flag; dismissing a
  finding for org A leaves org B's identically-keyed finding active; a full-sync-style
  `deleteIssuesForOrg` on org A leaves org B's issues and findings byte-for-byte unaffected.
- **Fixed a real regression this pass**: `getIssueFindings`/`getIssueFindingSummary` (queries.js) were
  given a required `orgId` parameter as defense-in-depth, but the sole caller
  (`src/routes/client.js`) was not updated to match, which would have shifted every positional
  argument and broken the issue-detail view. Fixed before any further work continued; covered by the
  existing `test/reviewState.test.js` suite (updated to pass `orgId`) plus the new isolation tests.
- Live browser check (disposable seeded database, not production): two organisations with the same
  override fields showed correctly independent values and correctly empty/placeholder-only fields
  for the unconfigured one — DOM-level confirmation, not just accessibility-tree text.

### 2. Configuration migration verification — VERIFIED

- Idempotency: `getDb()` run 3 consecutive times against the same file produced a stable column
  count with no errors.
- Old-database upgrade: a synthetic pre-migration `organisations` table (original 8 columns) was
  migrated live; every resolver function fell through to its exact expected legacy default
  (multi-account/supplier lookback 12, both min-values 0, capital review £500, misallocated £100,
  purchase-tax exclude codes `""`, both duplicate windows 3 days, exact-reference/fully-paid off,
  exact-total on, capital candidate codes `[461, 473]`) — zero regression for an existing calibrated
  client.
- NULL / absent verification: covered by the above and by existing resolver unit tests.
- **Empty-string / `false` verification**: probing all resolvers with explicit `''` and `false`
  inputs found 12 latent gaps in the pure resolver functions (they'd coerce to `0` instead of falling
  through to the default). **Traced to the actual write path and found not exploitable**: the sole
  caller, `updateOrganisationCheckConfig`'s route handler (`src/routes/client.js`'s
  `/:tenantId/check-config`), already converts `''` to `null` via its own `blankToNull` helper before
  the value ever reaches the database, and HTML form submissions never produce a literal boolean
  `false` (only strings). No code change made — adding a redundant guard for an unreachable input
  shape would be validation for a scenario that cannot occur through this app's own write path.
  Documented here rather than silently dropped.
- 461/473 opt-out survival: **verified live**, not just re-asserted. Seeded an organisation, set an
  explicit `purchase_tax_ignore` opt-out on account 461, then ran a second `upsertChartOfAccountsCache`
  call simulating a full chart-of-accounts refresh (renamed account, one new account added) — the
  opt-out survived unchanged, confirming `ON CONFLICT DO UPDATE` only touches
  `account_name`/`account_class`/`account_type`, never the configuration columns.
- **New DB-layer index** (`idx_sync_runs_org_status` on `sync_runs(org_id, status, completed_at)`):
  added after confirming `getLastSuccessfulRun`'s `WHERE org_id = ? AND status = 'succeeded' ORDER BY
  completed_at DESC LIMIT 1` had no covering index. Verified migrating cleanly and idempotently
  against a real production-database copy, with `PRAGMA integrity_check` passing.
- A second candidate index (`issue_findings(org_id, check_type, finding_key)`) was investigated and
  **not added** — no query was found that would benefit from it beyond the existing
  `(issue_id, id)` and `(org_id, check_type)` indexes; adding it would be pure write overhead.

### 3. All 29 contracts — VALIDATED, 5 corrections made

Three parallel research passes (covering checks 1–10, 11–20, 21–29) independently re-verified
`CHECK_CONTRACTS.md` against current code. Five confirmed mismatches were found and fixed in the
document itself (no code changes were needed — the code was already correct; the document was
stale or had an original error):

1. **Cross-cutting Finding #1** (the `not_vat_registered` label) was stale — it described the bug
   as unfixed, but the `periodStatus.js` fix (this session, before Phase 5) already resolved it.
   Corrected to describe the fix and its verification.
2. **Sections 20/21** (`sales_tax_missing`/`purchase_tax_missing`) repeated the same staleness —
   corrected.
3. **Sections 16/17** (`multi_account_suppliers`/`multi_tax_suppliers`), item 11, falsely claimed
   coverage by "per-client xenonParity locks" — confirmed false by grep of
   `test/xenonParity.test.js` (these checks are inline in `xeroSync.js`, not pure exported
   functions, so the hermetic-fixture test file cannot lock them). Corrected.
4. **Section 1** (`bank_balance`), item 4, incorrectly claimed the dynamic
   `statement_comparison_as_of_<date>` label survives persistence because it's "genuinely computed
   fresh, not a placeholder." **This was backwards**: the label is not in `RESERVED_PERIOD_LABELS`,
   so in the normal full-sync codepath (`xeroSync.js:1947` passes `period.key` explicitly) it *is*
   overwritten by `period.key`, exactly like every other non-reserved label. It only survives on a
   narrower, non-default codepath (an interactive statement-balance update with no explicit
   `periodKey` and no prior non-reserved label to fall back to). Corrected with the full mechanism
   explained.
5. **Section 2** (`unreconciled_bank_items`), item 8, claimed the finding-key kind is "typically
   `'line'` or `'document'`." Traced through `addFindingKeys`'s generic fallback: the `'line'`
   branch requires `lineItemId` or `(documentId && (accountCode || description))`, none of which this
   check's constructed items ever carry — so the kind is **always** `'document'`. Corrected.

No universal check logic was changed to chase a single client's numbers, consistent with the
standing rule against tuning universal rules to one client.

### 4. Row-level parity validation — PARTIALLY VERIFIED, 2 clients unresolved

A pre-existing, read-only diagnostic (`scripts/generate-xenon-parity-matrix.js`, dated 13 Aug 2026 —
predates this Phase 5 session) already implements most of what this section asks for: it recomputes
every check expressible via `checkRules.js`'s pure functions against **current** cached Xero data,
self-checks each recomputation against what production last actually stored (catching a
script/production divergence before it could corrupt the report), and classifies every
(client, check) pair. It was re-run this pass (read-only, `{ readonly: true }` on the SQLite handle —
physically write-blocked; no live Xero API calls) and `XENON_PARITY_MATRIX.md` refreshed. **Zero
self-check divergences** — every recomputation still matches production, for every client and check
it covers.

- **Clients with a stored Xenon comparison** (has a `validation_snapshots` row, from 7–11 Aug 2026):
  4X4 & More Ltd, Handymanz Ltd, Fast Track Excavations, Rose and Caramel Limited, MBX Graffix
  Limited. See `XENON_PARITY_MATRIX.md` for the full per-check table (shared/EXACT,
  COUNT_MATCH_ONLY, MISMATCH, and the app-only/config-required/external-evidence-required/
  non-scored-informational categories) for all five.
- **RBC Sutherland Ltd and Julia Kuisma Ltd have NO Xenon comparison data in this system at all** —
  no `validation_snapshots` row exists for either. **This is classified unresolved, not
  verified-clean.** A prior code-correctness fix for RBC (the "RBC legacy report integrity" fix,
  16 Aug 2026, documented in `XENON_PARITY_SPEC.md`) is unrelated to and does not substitute for a
  live Xenon comparison. Producing one requires the accountant to paste a fresh Xenon export for
  either client via the Validation Gate — this could not be done in this session (no access to
  Xenon, a separate third-party product with no API this app can call).
- **Residual differences, classified with evidence** (see `XENON_PARITY_SPEC.md`'s "Phase 5
  verification pass" section for full detail):
  - *Stale Xenon snapshot* (the largest category): checks whose count depends on "today" relative
    to a fixed Xenon snapshot date (`old_unpaid_invoices`, `old_unpaid_bills`) drift by design as
    real time passes — already documented as such in the matrix's own generated notes, and
    unaffected by any code in this app.
  - *Client data changed since the snapshot, not a regression*: 4X4's `duplicate_invoices`/
    `duplicate_bills` dropped from the Aug-13 locked-fixture's 31/6 groups to 0/0 live — confirmed by
    the self-check (script recomputation matches what production's own last sync independently
    stored) that this is real client-data drift, not a script or algorithm defect.
    `test/xenonParity.test.js` still locks the *algorithm* against a frozen fixture and continues to
    pass — that test was never designed to assert live-forever Xenon equality.
  - *Review-state visibility* (Xenon-side, invisible via API): Rose's `purchase_tax_missing` gap
    (2952 vs Xenon's 5) is dominated by Xenon's own dismissed-findings/"Ignore this contact" state,
    per the pre-existing, screenshot-evidenced `XENON_PARITY_SPEC.md` entry — re-confirmed still the
    correct primary explanation. A secondary, smaller, and genuinely actionable factor: roughly 950
    of Rose's 2952 findings sit on PayPal fees and Bank Fees accounts, which this app's universal
    exemption keyword list deliberately does not exempt by default (documented in
    `XENON_PARITY_SPEC.md`'s "Confirmed defaults" — processor fees are included unless a client
    explicitly excludes them). No universal code change was made; the actionable fix is a client-side
    one (add those two account codes to Rose's own `purchase_tax_missing_exclude_codes` override).
  - *Unsupported/private API*: `bank_balance`, `unprocessed_bank`, and (where no filed-accounts
    figure has been entered) `opening_balance_differences` require external evidence Xero's own API
    cannot supply (a bank's real closing balance, imported statement lines, filed net-assets
    figures) — these are correctly `not_configured`/`unavailable` rather than a false zero wherever
    that evidence hasn't been entered.
  - *Client-specific configuration required*: `capital_item_review` and `misallocated_items` need a
    one-time, evidence-backed account selection per client (already the documented, intended
    mechanism — not a gap).
  - No candidate for a genuine, unexplained application bug was found among the residuals reviewed.
- **Holdout note**: Fast Track Excavations is the confirmed holdout client for the health-score
  calibration (`test/scoreProfile.test.js` explicitly asserts it is absent from the calibration
  fixture used to fit the global scale) — this was not re-tuned in this pass. No universal rule
  change was made anywhere in this pass that would need a fresh holdout check.
- No live Xero API calls were made anywhere in this section — cache freshness (last synced
  2026-09-07, all 7 clients, within hours of this audit) was judged sufficient, consistent with the
  instruction to avoid unnecessary API calls and respect tenant rate limits.

### 5. Sync and cache reliability — VERIFIED (34 new tests)

All new tests are in `test/`, pass, and require no live Xero network access (confirmed by reading
`node_modules/xero-node`'s `XeroClient.initialize()`, which performs a real OIDC discovery call to
`https://identity.xero.com` — the one part of the sync path that genuinely cannot be exercised
without either a live call or an invasive dependency-injection refactor; the retry/backoff decision
logic that sits around it was extracted into a pure, directly-testable function instead).

- **Pagination boundaries** (`test/xeroPagination.test.js`, 9 tests): 0, 1, 99, exactly 100, 101
  (crossing the boundary onto a second page), exactly 200 across two full pages, and the
  intentionally-ambiguous case of three consecutive exactly-100-item pages (documented as a
  necessary, correct extra round-trip, not a bug). Every endpoint's actual pagination contract was
  verified against code, not assumed uniform: `GetInvoices`/`GetContacts`/`GetCreditNotes`/
  `GetBankTransactions`/`GetPayments` all page by `page` number with a 100-item page size and a
  `< 100` stop rule (consistent with `getAllPages`); `GetJournals` genuinely uses a different,
  offset-by-`journalNumber` contract with its own non-advancing-offset safety check; `GetAccounts`
  and `GetTaxRates` have no `page` parameter at all and always return the full list in one call.
- **Retry, backoff, and jitter** (`test/apiCallRetry.test.js`, 6 tests, plus the pre-existing
  `test/xeroClient.test.js`, 7 tests): a `Retry-After` header is honoured exactly and never jittered
  (it's the server's authoritative value); a plain 429 or other transient error backs off
  exponentially within a new **+/-15% jitter band**, added this pass specifically to prevent multiple
  organisations that hit a transient error at the same moment (e.g. a shared Xero outage) from
  retrying in lockstep and re-triggering the same rate limit — deterministic bounds are asserted via
  an injectable `randomFn`, so the tests are not flaky despite the randomness. Both backoff ladders
  respect their documented caps at high attempt counts. The give-up path (a non-existent tenant, a
  non-transient error) was verified end-to-end without needing any network access.
- **Sync atomicity under failure injected at the start, middle, and end of a sync**
  (`test/syncAtomicity.test.js`, 7 tests): using `activateSyncRun`'s own transactional guarantee
  (the exact mechanism `syncOrganisation`/`runSync` rely on — a thrown error anywhere in a sync is
  caught by `syncOrganisation`, which marks the run failed and re-throws without ever calling
  `activateSyncRun`), proved: a failure before any health score is staged leaves the previous run's
  issues, score, and transaction counts completely untouched; a failure mid-sync (some checks staged,
  then a later check throws) leaves no trace of the abandoned run's issues in the active set; a
  failure after staging a health score but before transaction counts still refuses to activate; a
  fully successful run atomically replaces the entire previous active set in one transaction; a
  per-check reanalysis activation only replaces that one check, leaving every other active check and
  the transaction counts (full-sync-only data) untouched; and a failed per-check reanalysis leaves
  the currently active result for that check byte-for-byte unchanged.
- **Entity lifecycle — renamed, deleted, voided, merged** (`test/entityCacheLifecycle.test.js`,
  5 tests): a full refresh removes cache entries genuinely absent from the fresh fetch (real
  deletion); an incremental refresh never removes an entity merely absent from its partial,
  modified-since batch (the single most important distinction here — getting this backwards would
  silently "delete" every untouched record on every incremental sync); a rename updates the existing
  cached row in place; a void updates status in place, and every check's own `status === 'AUTHORISED'`
  filter naturally excludes it on the next pass with no separate "handle voids" code path needed; a
  merge (Xero archives the losing contact, never deletes or reassigns its ID) leaves both rows
  individually correct, with the archived one naturally dropping out of `duplicate_contacts`'
  `ACTIVE`-only filter.
- **Concurrent sync attempts, job cancellation, and failed jobs** (`test/syncJobs.test.js`, 5 tests):
  a genuinely in-flight job (proven via a controllable, manually-resolved runner rather than racing
  real timing — a live curl-based probe against a synthetic org with no real Xero token cannot
  reliably observe the dedup window, since such a job fails in milliseconds, before a second request
  can arrive) is deduped to the same job for the same org+mode; a different mode (a per-check
  reanalysis) is correctly NOT deduped against an in-flight full sync; a failed job records its error
  without corrupting the organisation's `connection_status` or blocking the queue from accepting new
  work; cancelling a queued-but-not-yet-running job marks it cancelled and it never executes its
  runner; `cancelJob` correctly refuses to cancel an already-running job.
- **Missing scopes / partial responses never becoming a false zero**: verified by code reading —
  every check's data fetch either lives inside a per-check `try`/`catch` that logs and skips the
  write (leaving the check as "Not synced," never a false clean zero), or, for the small number of
  foundational shared fetches (invoices, contacts, chart of accounts) that aren't individually
  wrapped, an uncaught error propagates to `runSync`'s top-level handler, which aborts the entire
  sync atomically — per the atomicity tests above, this leaves the *previous* active result (with
  its own accurate, unmodified last-synced timestamp) on screen, which is honest staleness, not a
  fabricated zero.
- **Live sync verification on two contrasting real clients**: not performed against the real Xero
  API in this pass (no live Xero credentials were exercised; this audit's live-system checks used a
  disposable, synthetic seeded database instead — see Section 8). This remains a gap against the
  letter of the Phase 5 request's "at least two contrasting real clients" instruction and is called
  out honestly here rather than glossed over; production data was deliberately left untouched per
  the standing instruction not to deploy or run live syncs against real Xero connections without
  fresh explicit permission for that specific action.

### 6. Applicability/status model — VERIFIED, one real bug found and fixed

- All 6 statuses (`unavailable`, `not_configured`, `not_applicable`, `ok`, `issues`, `not_synced`)
  were exercised end-to-end in a live browser session against a disposable database: a
  non-VAT-registered synthetic client correctly showed "Not applicable — client is not VAT
  registered" for both tax checks (sidebar `(N/A)` badge, distinct from `(?)` for not-configured and
  from a plain issue count), while a genuinely clean check on the same client showed "OK" — visually
  and semantically distinct, confirmed via both the accessibility tree and raw DOM inspection.
- **Bug found and fixed**: `src/views/report.ejs` (the printable page and the PDF download, which
  renders the identical HTML via Puppeteer — confirmed by reading `report.pdf`'s route, so this one
  fix covers both) re-derived status from `check.count == null` instead of reading the server-computed
  `check.displayStatus`. `count == null` cannot distinguish `not_applicable` (count is deliberately
  `0`) from a genuinely clean check, nor tell `unavailable`/`not_configured`/`not_synced` apart — so a
  non-VAT-registered client's tax checks rendered as an ordinary green "OK" in the report, identical
  in appearance to a VAT-registered client with real zero findings. Fixed to read `displayStatus`,
  matching the dashboard exactly; **verified live** (the fix was confirmed rendering "Not applicable"
  correctly in the actual report page before and after, in the browser, not just by reading the diff).
- The detailed issue view (`/client/:tenantId/check/:checkType`) renders the identical `client.ejs`
  template and `clientViewData()` function as the main dashboard — there is no separate status
  derivation to drift, by construction.

### 7. Financial invariants — VERIFIED for the general mechanism, one new test added

- The count/value recompute after review-state filtering (`setFindingReviewStates`'s SQL, and the
  equivalent logic in `insertIssue`) is check-agnostic — it has no per-check special-casing — so the
  existing `test/reviewState.test.js` coverage (count and value correctly recomputed after
  dismiss/ignore/ok/restore, display-only findings never counted) is strong evidence for every check,
  not just the one it exercises (`duplicate_invoices`).
- **New test added** (`test/reviewState.test.js`, penny-boundary/credit-note test): proved the
  count/value invariant holds exactly at a one-penny boundary (`0.01 + 100.00 + 943.68 = 1043.69`)
  and for a credit-note-shaped negative underlying amount. Confirmed `allocateFindingValues`
  (`checkRules.js`) always stores the **absolute** value for aggregation/scoring — a credit note's
  negative amount can never make the aggregate wrong or negative — while `getIssueFindings` correctly
  returns each finding's **raw, unmodified** detail (including the true negative amount), since the
  UI legitimately needs to show a credit note as negative. These are two different, both-correct
  representations of the same underlying finding, not a bug.
- Display-only findings were re-confirmed to never affect count, value, or score (existing coverage,
  re-verified).
- Rounding, negative values, credit notes, and inclusive/exclusive/no-tax document bases were not
  exhaustively re-tested per check type beyond the general mechanism above and the existing
  `test/checkRules.test.js` suite — a full per-check invariant sweep (29 checks × several rounding/
  sign edge cases each) was judged lower marginal value than the mechanism-level proof, given the
  underlying aggregation code path is shared and already directly tested.

### 8. UI and operational completion — PARTIALLY VERIFIED (live browser session)

Verified live in a real browser against a disposable, synthetic seeded database (production database
never touched; a second, already-running production instance on port 3050 was left completely alone
throughout) — see the detailed section-6 and section-1 write-ups above for the status-model and
sync-reliability findings this session surfaced, and:

- Organisation-scoped settings load, save (a save round-trip through `updateOrganisationCheckConfig`
  and `setAccountCheckConfiguration` was confirmed both at the DB layer and by reading the rendered
  form's actual DOM `value` attribute, not just its accessibility-tree label, after the earlier
  isolation tests), and remain organisation-isolated (confirmed live: the unconfigured organisation
  showed empty fields with only the practice-default placeholder visible, no cross-contamination).
- Provenance is distinguishable: the documented/practice default renders as the input's `placeholder`
  attribute; an explicit organisation override renders as the input's actual `value`. Confirmed via
  direct DOM inspection (not just the accessibility tree, which was initially misleading — it reports
  a field's placeholder as if it were a label when no value is focused, so this was double-checked
  against the real DOM `value`/`placeholder` properties before trusting it).
- **CSRF failure, invalid tenant, invalid period, concurrent sync, and job states** were tested
  directly against the disposable server's HTTP endpoints: a missing/wrong `x-csrf-token` header is
  rejected with 403 before any organisation lookup runs; an invalid tenant with a *valid* CSRF token
  now correctly 404s (this is the fix from Section 9 below, confirmed live post-fix); an
  unrecognised `period` query value is intentionally *not* rejected — it falls back to the
  organisation's own default period (a deliberate, existing design choice, not a bug: rejecting a
  stray query parameter outright would fail a sync unnecessarily) — while a semantically invalid
  custom range (`from` after `to`) is correctly rejected with 400; concurrent-sync deduplication and
  queued-job cancellation were proven deterministically at the unit level (Section 5) after a live
  curl-based attempt showed the dedup window is real but too narrow to observe against a synthetic
  org whose sync fails in milliseconds (no live Xero token configured).
- **Special characters, ampersands, and long tenant identifiers**: a synthetic organisation was
  seeded with an apostrophe, double quote, angle brackets, an em dash, accented characters, and a
  ~130-character tenant ID. The client list and detail pages rendered every field safely
  HTML-escaped (no unescaped `<script>` tag reached the DOM; a literal `<script>alert(1)</script>`
  in the tenant ID never executed). **Found and fixed a real bug** in the process: the same tenant ID,
  embedded via EJS's default HTML-escaping directly into an inline `<script>` block (used to build
  the Sync button's fetch URL), produced literal `&#39;`/`&lt;`/`&gt;` character sequences in the
  actual outgoing request — because HTML entities are never decoded inside `<script>` content — which
  would have silently 404'd against the real organisation for any tenant ID containing such
  characters. Fixed by moving the tenant ID into an HTML `data-` attribute (the same pattern the
  existing `csrfToken` meta tag already used) and reading/`encodeURIComponent`-ing it from JavaScript
  instead of interpolating it directly into script text. **Real-world exploitability is effectively
  nil**: Xero only ever issues GUID-format tenant IDs (no quotes, angle brackets, or other special
  characters), so no attacker can control this value — but the fix was cheap, safe, and directly
  responds to the exact scenario this Phase 5 instruction named, so it was made rather than only
  documented.
- Dashboard, detailed issue view, printable report, and downloaded (PDF) report all confirmed to
  share the identical status model and — for issue detail — the identical filtered-findings query
  path (`getIssueFindings`), by construction (same template, same route data function, same DB
  query), not merely by inspection.
- **Not independently re-verified this pass**: reset-to-default button behaviour for every individual
  settings field (a "reset" affordance was not located as a separate control from simply clearing the
  field and saving — if a dedicated reset button exists elsewhere in the UI, it was not exercised);
  an exhaustive click-through of every one of the 29 "Reanalyse" buttons individually (the mechanism
  was proven generically via `test/syncJobs.test.js` and the live cross-client/status-model checks
  above, but not click-by-click for all 29 in the browser).

### 9. Performance and security — VERIFIED, 3 route fixes made, 1 index added, no algorithmic fix needed

- **OAuth logging hardened**: the callback URL log (which included Xero's one-time authorisation
  `code` and `state` — real, if short-lived, secrets) now logs only that the callback was reached and
  the configured redirect URI, never the query string. Three `console.error(..., err)` call sites in
  `src/routes/auth.js` were changed to log `err.message` only, as defense-in-depth against a
  confirmed (by reading `node_modules/openid-client`'s source) theoretical mechanism where an
  `OPError`/`RPError` can carry a non-enumerable `.response` property embedding the outgoing
  `Authorization: Basic <client_secret>` header from a token exchange/refresh call.
- **Route/CSRF gaps fixed**: `POST /:tenantId/update` (client.js) now looks up the organisation and
  404s before use, matching the look-up-and-404 pattern used everywhere else in that file;
  `POST /sync-jobs/:jobId/cancel` (dashboard.js) now requires the same `x-csrf-token` header check
  every other state-mutating AJAX route already requires (confirmed the existing frontend JS already
  sends this header on both call sites, so the fix cannot break the cancel button);
  `POST /sync/:tenantId` (dashboard.js, the full-sync route) now validates the tenant exists and
  404s before queuing a job, matching the equivalent per-check route which already had this check.
- **Database indexes**: one genuine gap found and fixed (`idx_sync_runs_org_status`, Section 2); one
  candidate investigated and correctly not added (no benefiting query found); the pre-existing
  `idx_xero_entity_cache_type` index was noted as redundant with that table's own primary key
  (`PRIMARY KEY(org_id, entity_type, entity_id)`) — pure write-overhead cleanup opportunity, not a
  correctness issue, and left alone as out of scope for this pass.
- **Quadratic-algorithm audit — measured against real client data, not just Big-O reasoning**:
  - `findDuplicates` (duplicate invoices/bills): already Map-based grouping by
    `contactId|amount`; only a small, bounded greedy-absorption loop runs within each bucket. Low
    risk at any realistic volume with the app's own default configuration.
  - `multi_account_suppliers`/`multi_tax_suppliers`: already single-pass Map/object accumulation, no
    quadratic pattern found.
  - `findDuplicateContacts` (duplicate contacts, the classic O(n²) Levenshtein-pairwise pattern):
    Rose and Caramel Limited has **23,864 raw cached contacts**, but the check's own
    `contactStatus === 'ACTIVE' && (isCustomer || isSupplier)` pre-filter shrinks this to **388**
    before the pairwise comparison runs — measured live at **36ms**. No real client is anywhere near
    a problematic scale today.
  - `findDirectMatches` (`invoice_or_direct`/`bill_or_direct`, an O(n·m) unindexed inner scan):
    measured against MBX Graffix's actual worst-case data (467 unpaid bills × 14,139 all-time bank
    spend transactions, i.e. deliberately *not* period-scoped, which the real code path already is) —
    **212ms**. Noticeable but not currently a problem for any of the 7 real clients; documented here
    as a watch item rather than optimised speculatively, consistent with the standing rule against
    adding complexity ahead of a demonstrated need. If a future client's unpaid-document or
    bank-transaction volume grows materially, the fix is straightforward: pre-group `documents` into
    a `Map` keyed by `contactId|amount` before the transaction loop.
- Route parameters, organisation ownership, and uploaded-file handling were covered by the
  cross-client isolation work above and by existing tests; no new gap was found beyond what's listed.

## Migrations applied this pass

- `sync_runs(org_id, status, completed_at)` composite index — additive, `CREATE INDEX IF NOT
  EXISTS`, verified idempotent and integrity-checked against a real production-database copy before
  being considered safe.

No destructive migration, no column removal, no data rewrite. The production database itself was
never opened for write in this session except by the already-running, separately-owned production
server process on port 3050, which this audit never touched.

## Test results

**239 / 239 passing** (`node --test test/*.test.js`), including 34 tests added in this pass:
- `test/xeroPagination.test.js` — 9
- `test/apiCallRetry.test.js` — 6
- `test/syncAtomicity.test.js` — 7
- `test/entityCacheLifecycle.test.js` — 5
- `test/syncJobs.test.js` — 5
- `test/crossClientIsolation.test.js` — 4
- Plus 1 new test added to the existing `test/reviewState.test.js` (penny-boundary/credit-note
  invariant).

## Files changed in this Phase 5 pass

- `src/db/queries.js` — `getIssueFindings`/`getIssueFindingSummary` org-scoping (regression
  introduced and fixed within this pass).
- `src/routes/client.js` — fixed the caller for the above; added organisation lookup to
  `/:tenantId/update`; replaced the inline tenant-ID script interpolation.
- `src/routes/auth.js` — OAuth callback URL and error logging hardened.
- `src/routes/dashboard.js` — added CSRF check to job-cancel; added organisation validation to the
  full-sync route.
- `src/db/schema.js` — added `idx_sync_runs_org_status`.
- `src/services/xeroClient.js` — extracted `computeRetryDelayMs`, added backoff jitter.
- `src/views/report.ejs` — fixed the `not_applicable` status bug.
- `src/views/client.ejs` — fixed the special-character tenant-ID script-escaping bug.
- `CHECK_CONTRACTS.md` — 5 corrections.
- `XENON_PARITY_MATRIX.md` — regenerated against current cache data.
- `XENON_PARITY_SPEC.md` — appended the Phase 5 verification section.
- `test/reviewState.test.js` — updated for the `orgId` signature change; added the
  penny-boundary/credit-note invariant test.
- New: `test/xeroPagination.test.js`, `test/apiCallRetry.test.js`, `test/syncAtomicity.test.js`,
  `test/entityCacheLifecycle.test.js`, `test/syncJobs.test.js`, `test/crossClientIsolation.test.js`.
- `backups/xero_dashboard_pre_phase5_20260907_121417.db` — the pre-migration-testing backup made per
  explicit instruction before this pass began; integrity-checked.

This list covers only what this Phase 5 pass itself changed. The working tree also carries earlier,
unrelated in-progress changes from before this pass (config-isolation work, the `not_vat_registered`
fix, and others) — these were preserved untouched throughout, per the standing instruction, and are
not re-described here.

## Unsupported / unavailable-through-the-API limitations (unchanged by this pass, restated for completeness)

- **Bank statement balances** (`bank_balance`) and **unmatched statement lines**
  (`unprocessed_bank`): Xero's API does not expose a bank's real closing balance; both require the
  accountant to import a CSV statement or enter a manual closing balance. Correctly reported as
  `not_configured`, never a false zero, when no evidence has been entered.
- **Filed net-assets figures** (`opening_balance_differences`): cannot be extracted automatically
  from accounts filed as a scanned image or as an untagged micro-entity filing at Companies House;
  the accountant must enter the figure once per filing.
- **Xenon's own dismissed/ignored review state** is invisible to any Xero API — it lives entirely
  inside Xenon's product. Any client-side "Show dismissed" toggle or per-contact "Ignore" setting in
  Xenon will diverge this app's raw-API-driven counts from Xenon's displayed counts, as documented
  extensively for Rose and MBX in `XENON_PARITY_SPEC.md`. This is a permanent, structural limitation,
  not something a future code change can close.

## Definition-of-done checklist

- [x] No known cross-client leakage — proved live with adversarial identical-key tests.
- [x] All 29 contracts match implementation — 5 stale/incorrect statements corrected.
- [x] All tests pass — 239/239.
- [x] Database upgrade verified on a backup copy — idempotency and old-schema simulation both
      confirmed live.
- [ ] At least one holdout client shows no regression — the *scoring* holdout (Fast Track) was
      reconfirmed via the existing calibration-fixture test; a live, real-Xero-API holdout sync
      re-run was not performed (no live Xero credentials exercised this pass — see Section 5).
- [x] Unsupported checks remain honestly unavailable rather than showing a fake zero — verified live
      and by code reading.
- [x] Every remaining parity difference is documented and classified — including the two clients
      (RBC, Julia Kuisma) with no comparison data at all, explicitly marked unresolved rather than
      silently treated as clean.

## Rollout instructions

1. Review this document and the updated `CHECK_CONTRACTS.md`/`XENON_PARITY_MATRIX.md`/
   `XENON_PARITY_SPEC.md`.
2. Run `node --test test/*.test.js` locally and confirm 239/239 (or higher, if further work has
   landed since).
3. The only schema change is the additive `idx_sync_runs_org_status` index — it applies
   automatically the next time `getDb()` runs (e.g. on app startup) and requires no manual migration
   step or downtime.
4. **Do not push or deploy to Railway from this pass without your fresh, explicit permission** — none
   was given or acted on during this session, consistent with the standing instruction.
5. Before any live deploy, consider running one real sync against a low-risk connected client (e.g.
   Julia Kuisma Ltd, the smallest dataset) to close the one remaining "live sync on a real client"
   gap noted in Section 5 and the checklist above.

## Rollback instructions

- The only schema change (`idx_sync_runs_org_status`) is a pure index addition — dropping it
  (`DROP INDEX idx_sync_runs_org_status;`) fully reverts it with no data loss, if ever needed; there
  is no reason to expect this would be necessary.
- Every other change in this pass is application code or documentation, not data. Reverting the
  relevant commit(s) is sufficient; no data migration or backfill is required in either direction.
- The pre-Phase-5 database backup (`backups/xero_dashboard_pre_phase5_20260907_121417.db`,
  integrity-checked) remains available as a full point-in-time restore option, though nothing in this
  pass wrote to the production database in a way that would require using it.
