# Check Contracts — 29-Check Ledger

Generated 2026-09-07. This documents what each check's implementation **actually does today**,
verified against the code (not against Xenon's UI or documentation) — a Phase 4 baseline for
reconciling implementation against intended behaviour. Where a genuine gap or inconsistency was
found while writing this, it's called out explicitly rather than smoothed over.

Every check's data-fetch and comparison logic lives inline in `src/services/syncOrganisation`
(file: `src/services/xeroSync.js`) unless noted otherwise. Shared pure logic lives in
`src/services/checkRules.js`. Three checks (`bank_balance`, `unprocessed_bank`,
`opening_balance_differences`) are evidence-driven and live in `src/services/statementEvidence.js`.

## Cross-cutting findings (read this first)

### 1. Several checks' own `period_checked` label is silently discarded — fixed for the one real gap

`persistIssue` (xeroSync.js:399-409) runs **every** issue through:

```js
period_checked: resolvePeriodChecked(issue.period_checked, period.key)
```

`resolvePeriodChecked` (checkRules.js:16-22) only keeps a check's own label if it's one of
`RESERVED_PERIOD_LABELS` (defined in `src/services/periodStatus.js` as the union of
`NOT_APPLICABLE_PERIODS`, `NOT_CONFIGURED_PERIODS`, and `UNAVAILABLE_PERIODS` —
`['not_vat_registered', 'not_configured', 'needs_sync', 'out_of_scope', 'unavailable']`).
Anything else — including elaborate, purpose-built strings like
`` `supplier_pattern_from_${start}_value_since_lock_date` `` or `'active_customer_supplier_contacts'`
— is silently replaced by `period.key` before it ever reaches the database. This is intentional
and correct for the common case (the UI should show the real period checked, not an internal
label) and is why the reserved states exist as an explicit escape hatch.

**Update (post-Phase-4 fix)**: `sales_tax_missing` and `purchase_tax_missing` write
`period_checked: 'not_vat_registered'` when the org isn't VAT registered (xeroSync.js:1215, 1272).
This label is now a member of `RESERVED_PERIOD_LABELS` via `NOT_APPLICABLE_PERIODS`
(`src/services/periodStatus.js`), so it survives `persistIssue` unchanged instead of being
overwritten by `period.key`. `resolveCheckDisplayStatus` (checkRules.js) maps it to the
`not_applicable` display status, distinguishing a VAT-unregistered client (shown as "Not
applicable") from a VAT-registered client that's genuinely clean (shown as "OK") — both score zero
deduction, but for different, distinguishable reasons (see `scoreObservation`'s `excludedReason`
and `test/scoreProfile.test.js`). No further action needed here.

Every check contract below that writes a non-reserved literal (`'since_lock_date'`,
`'older_than_60_days'`, `` `fixed_asset_accounts_lte_200_since_lock_date` ``, etc.) is annotated —
the literal exists in the code as documentation of intent, but the value actually stored is
`period.key` except in the specific reserved states.

### 2. `bank_balance` has two write sites — verified not a live bug

xeroSync.js:764 (inline, using `getBankReconciliationForOrg` + a live Bank Summary report) and
statementEvidence.js:486 (`recomputeEvidenceIssues`, evidence-aware: CSV imports, manual balances,
bank-account exclusions, `needs_sync`/`not_configured` distinction) both write
`check_type: 'bank_balance'`.

Verified safe: the local `insertIssue` (`= persistIssue`, xeroSync.js:399-411) gates **every**
write in xeroSync.js by `options.checkType`, and `recomputeEvidenceIssues`'s own `replace()` helper
(statementEvidence.js) applies the identical gate. On a **full sync** (`options.checkType` unset),
both fire, and `recomputeEvidenceIssues` runs later in the same `syncOrganisation` call
(xeroSync.js:1947) and wins — the earlier write is redundant but harmless. On a **per-check
reanalysis** of anything other than `bank_balance`, both writes are skipped (checkType mismatch),
so neither touches the existing stored value. No scenario was found where the simpler xeroSync.js
version is the one left standing. The redundant computation on a full sync is a minor efficiency
note, not a correctness issue.

### 3. Two intentional asymmetries, confirmed by design comments (not bugs)

- **Draft status differs between invoices and bills** in the duplicate/direct-match/unapproved
  checks: invoice drafts use `SUBMITTED`, bill drafts use `DRAFT`. Confirmed deliberate per Xenon
  parity evidence at each call site (e.g. xeroSync.js:820-821 vs 850-853, and 1768-1769).
- **`old_purchase_credits` is AUTHORISED-only; `old_sales_credits` allows AUTHORISED + SUBMITTED.**
  Confirmed deliberate — comment at xeroSync.js:932 cites the exact client evidence
  ("MBX: SUBMITTED+AUTH=6 vs AUTH=4=Xenon").

### 4. `unapproved_invoices`/`unapproved_bills`' internal dedup window is hardcoded, not the org override

Both call `findDuplicates(draftInvoices)` / `findDuplicates(draftBills)` with **no** `windowDays`
argument, so they fall through to the function's default parameter
(`CHECK_DEFAULTS.duplicateWindowDays`, 3 days) — not `resolveDuplicateInvoiceWindowDays(org)` /
`resolveDuplicateBillWindowDays(org)`, which the *actual* `duplicate_invoices`/`duplicate_bills`
checks use. This is very likely correct as-is: the purpose here is different (collapsing repeat
saves of the *same still-unapproved draft*, not flagging suspected duplicate transactions as an
issue in their own right) and was never in scope for the duplicate-matching config work. Documented
here so a future reader doesn't assume the org override applies here too.

---

## 1. bank_balance

*(also see Cross-cutting Finding #2 — two write sites)*

1. **Data source & endpoint**: Xero `Reports/BankSummary` (Xero's calculated closing balance per
   bank account) vs external evidence — an imported CSV statement's closing balance, or a manually
   entered closing balance.
2. **Included/excluded**: N/A (no invoice/bill statuses). Per-account exclusion via
   `bank_account_exclusions` table — excluded accounts drop out of both the evidence list and the
   comparison entirely.
3. **Date field & boundary**: Point-in-time balance comparison, not a date range. Uses the
   statement's own date and the Bank Summary "as of" date (`period.end`).
4. **Period scoping**: Evidence-date-range. Computed as
   `period_checked = statement_comparison_as_of_<latest statement date>`, but this string is **not**
   in `RESERVED_PERIOD_LABELS`, so `recomputeEvidenceIssues`'s `replace()` wrapper — which applies
   the exact same `resolvePeriodChecked` rule as `xeroSync.js`'s `persistIssue` — overwrites it with
   `effectivePeriodKey` whenever that's truthy. In the normal full-sync codepath
   (`xeroSync.js:1947` passes `period.key` explicitly), `effectivePeriodKey` is always truthy, so
   the computed statement-comparison label is **overwritten by `period.key`**, exactly like every
   other non-reserved label — it does not survive to storage. It only survives on a call with no
   explicit `periodKey` (e.g. an interactive statement-balance update) where no prior non-reserved
   `bank_balance`/`unprocessed_bank` label exists to fall back to either — a narrow, non-default
   path. **Correction to an earlier draft of this document**, which claimed the opposite.
5. **Grouping identity & count unit**: one bank account = one item.
6. **Amount basis**: absolute discrepancy in GBP, `|statementBalance − xeroBalance|` (tolerance
   `0.01`, hardcoded, not configurable).
7. **Defaults & overrides**: per-account exclusion (organisation-scoped, `bank_account_exclusions`
   table). No configurable discrepancy tolerance.
8. **Finding-key recipe**: `ACCOUNT_FINDING_CHECKS` → `{kind: 'account', accountId}`.
9. **Display-only vs scored**: scored.
10. **Not-configured/unavailable**: `not_configured` if no evidence exists for any included
    account. `needs_sync` if some accounts have evidence but not all are yet comparable to a Xero
    balance. Excluding every evidenced account correctly reports `not_configured`, not a false 0
    (verified by test).
11. **Test coverage**: `test/statementEvidence.test.js` — the `not_configured`/`needs_sync`
    persistence tests, plus the two bank-exclusion tests added this session.

---

## 2. unreconciled_bank_items

1. **Data source & endpoint**: Xero `BankTransactions` + `Payments`.
2. **Included/excluded**: `status === 'AUTHORISED' && isReconciled === false` on both sides.
   Restricted to genuine BANK-type accounts (excludes Suspense/Directors' Loan-type postings).
   Per-org excluded bank accounts dropped from **both** sides (bank transactions *and* payments —
   fixed this session; previously only payments were filtered by account).
3. **Date field & boundary**: transaction/payment date, filtered by the standard period-boundary
   rule (`since_lock_date`: start exclusive, end inclusive; other period types: both inclusive).
4. **Period scoping**: period-scoped — explicitly restricted to the selected period, not a backlog.
5. **Grouping identity & count unit**: one bank transaction OR one payment = one item.
6. **Amount basis**: absolute exposure, never netted.
7. **Defaults & overrides**: organisation-level bank-account exclusion list. No hardcoded constant,
   no practice setting.
8. **Finding-key recipe**: generic fallback → **always** `'document'` kind. **Correction to an
   earlier draft**, which claimed a `'line'` kind was typical: `addFindingKeys`'s generic fallback
   only takes the `'line'` branch when an item carries `lineItemId` or `(documentId &&
   (accountCode || description))` (checkRules.js:583-598), but the items this check constructs
   (xeroSync.js:796-803) only ever carry `id`/`date`/`amount`/`contact`/`type`/`account`/`source` —
   no `accountCode`, `description`, or `lineItemId` — so the `'line'` branch is unreachable here and
   every finding falls through to `'document'` kind (keyed by `documentId`/`number`/`date`/`amount`).
9. **Display-only vs scored**: scored.
10. **Not-configured/unavailable**: no reserved label; `period_checked = period.key` always. Failure
    is caught/logged and the issue write is skipped ("Not synced").
11. **Test coverage**: `test/checkRules.test.js` (selection/exclusion unit tests),
    `test/xenonParity.test.js` (Fast Track Excavations parity lock).

---

## 3. unprocessed_bank

1. **Data source & endpoint**: CSV bank-statement import, matched against a cached Xero bank-item
   snapshot. No live Xero call at compute time.
2. **Included/excluded**: only statement lines with `match_confidence === 'unmatched'`.
3. **Date field & boundary**: evidence-date-range — driven entirely by whatever statements have
   been imported, not the app's selected period.
4. **Period scoping**: evidence-date-range.
5. **Grouping identity & count unit**: one statement line = one item.
6. **Amount basis**: absolute exposure.
7. **Defaults & overrides**: bank-matching tolerances (±3 day window, <£0.01 amount tolerance) are
   hardcoded, not organisation-configurable.
8. **Finding-key recipe**: generic fallback, typically `'document'` kind.
9. **Display-only vs scored**: scored.
10. **Not-configured/unavailable**: `not_configured` when no statement imports exist at all
    (`count: null` in that case).
11. **Test coverage**: `test/statementEvidence.test.js` (persistence + matching-algorithm tests).

---

## 4. duplicate_invoices

1. **Data source & endpoint**: Xero `Invoices` (ACCREC).
2. **Included/excluded**: `AUTHORISED` + `SUBMITTED` drafts. Plain `DRAFT` excluded (surfaces under
   `unapproved_invoices` instead). Fully-paid groups excluded by default (Xenon's own documented
   default), toggleable per org.
3. **Date field & boundary**: invoice date; candidate pool is period-scoped, then grouped via a
   rolling `windowDays` lookback (default 3, inclusive both ends) from the newest ungrouped
   document backward.
4. **Period scoping**: period-scoped pool + internal grouping lookback within that pool.
5. **Grouping identity & count unit**: one suspected-duplicate GROUP = one item (not per pair, not
   per extra document). Grouping key: contact + (by default) exact total in pence, chained by date
   window; optionally narrowed further by exact reference.
6. **Amount basis**: gross document total of the group's latest/anchor member (not summed across
   the group).
7. **Defaults & overrides** (all organisation-scoped, all default to preserving pre-existing
   calibrated behaviour):
   - `duplicate_invoice_window_days` — default 3 (practice default; Xenon's documented default is
     1 day).
   - `duplicate_invoice_require_exact_reference` — default **off** (matches Xenon's documented
     default; the code's baseline grouping never checked reference at all).
   - `duplicate_invoice_include_fully_paid` — default **off** (matches Xenon's documented default).
   - `duplicate_invoice_require_exact_total` — default **on**, the *opposite* of Xenon's documented
     default, deliberately: Xenon's own docs don't disclose what "off" looks like, so "on" preserves
     every currently-validated client's grouping; "off" (contact + date window only, no amount
     check) is only for a client confirmed via real Xenon evidence to need it.
8. **Finding-key recipe**: `PAIR_FINDING_CHECKS` → `{kind: 'pair', ids: [id1, id2].sort()}`,
   order-independent.
9. **Display-only vs scored**: scored.
10. **Not-configured/unavailable**: no reserved label; `period_checked = period.key`. Failure skips
    the write.
11. **Test coverage**: extensive — `test/checkRules.test.js` (grouping algorithm, all 4 toggles,
    isolation tests), `test/xenonParity.test.js` (per-client locks: 4X4, Handymanz, Fast Track,
    Rose, MBX).

---

## 5. duplicate_bills

Same algorithm and toggle set as `duplicate_invoices`, on the ACCPAY side, with these differences:

1. **Data source & endpoint**: Xero `Invoices` (ACCPAY).
2. **Included/excluded**: `AUTHORISED`/`PAID` + `DRAFT` (not `SUBMITTED` — see Cross-cutting
   Finding #3).
3-6. Identical mechanism to duplicate_invoices.
7. **Defaults & overrides**: `duplicate_bill_window_days` (default 3),
   `duplicate_bill_require_exact_reference` (default off),
   `duplicate_bill_include_fully_paid` (default off),
   `duplicate_bill_require_exact_total` (default on, same rationale as invoices).
8. **Finding-key recipe**: same pair mechanism.
9-10. Identical to duplicate_invoices.
11. **Test coverage**: shares the toggle-resolver test block with duplicate_invoices;
    `test/xenonParity.test.js` locks (4X4, MBX, Handymanz, Rose, Fast Track).

---

## 6. old_unpaid_invoices

1. **Data source & endpoint**: Xero `Invoices` (ACCREC), `AUTHORISED`/`PAID`.
2. **Included/excluded**: `amountDue > 0` and older than 60 days by document date.
3. **Date field & boundary**: document date; `isOldDocument` is strictly `> 60 days` (60 days
   exactly is NOT flagged — exclusive boundary). Candidate pool is "all dates ≤ period.end",
   unrestricted by period.start.
4. **Period scoping**: as-of/backlog — age measured from `period.end` regardless of how far back
   the invoice was raised. Note: `period_checked` literal is
   `'document_date_over_60_days_ago_all_time'`, but per Finding #1 this gets overwritten by
   `period.key` at persistence (it's not a reserved label).
5. **Grouping identity & count unit**: one invoice = one item.
6. **Amount basis**: amount due (not gross total, not net).
7. **Defaults & overrides**: `CHECK_DEFAULTS.oldDocumentDays = 60`, hardcoded — no organisation
   override exists for this threshold.
8. **Finding-key recipe**: generic `'document'` fallback.
9. **Display-only vs scored**: scored.
10. **Not-configured/unavailable**: none; failure skips the write.
11. **Test coverage**: `isOldDocument` boundary logic in `test/checkRules.test.js`. Deliberately
    **not** locked in `test/xenonParity.test.js` — the file's own header comment explains that a
    "today's date"-dependent check can't be frozen in a fixture without stopping testing what
    actually matters (the 60-day boundary itself, which is covered).

---

## 7. old_sales_credits

1. **Data source & endpoint**: Xero `CreditNotes` (ACCRECCREDIT).
2. **Included/excluded**: `status` in `['AUTHORISED', 'SUBMITTED']`, `remainingCredit > 0`, older
   than 60 days.
3. **Date field & boundary**: same `isOldDocument` exclusive `> 60 days` rule.
4. **Period scoping**: as-of/backlog from `period.end`. Literal `period_checked =
   'older_than_60_days'` — overwritten by `period.key` per Finding #1.
5. **Grouping identity & count unit**: one credit note = one item.
6. **Amount basis**: remaining (unallocated) credit amount.
7. **Defaults & overrides**: `CHECK_DEFAULTS.oldDocumentDays = 60`, hardcoded, no override.
8. **Finding-key recipe**: generic `'document'` fallback.
9. **Display-only vs scored**: scored.
10. **Not-configured/unavailable**: none; failure skips the write.
11. **Test coverage**: `selectOldCredits` unit test in `test/checkRules.test.js`; per-client lock in
    `test/xenonParity.test.js` (Rose and Caramel).

---

## 8. old_unpaid_bills

Mirrors `old_unpaid_invoices` on the ACCPAY side.

1. **Data source & endpoint**: Xero `Invoices` (ACCPAY), `AUTHORISED`/`PAID`.
2. **Included/excluded**: `amountDue > 0`, older than 60 days.
3-4. Same as old_unpaid_invoices — as-of/backlog from `period.end`. Literal `period_checked =
    'document_date_over_60_days_ago'` (note: missing the `_all_time` suffix old_unpaid_invoices
    has, though the actual scoping is identical) — overwritten by `period.key` per Finding #1.
5. **Grouping identity & count unit**: one bill = one item.
6. **Amount basis**: amount due.
7. **Defaults & overrides**: `CHECK_DEFAULTS.oldDocumentDays = 60`, no override.
8. **Finding-key recipe**: generic `'document'` fallback.
9-10. Same as old_unpaid_invoices.
11. **Test coverage**: shares `isOldDocument` coverage; deliberately not locked in xenonParity for
    the same "today's date"-dependent reason.

---

## 9. old_purchase_credits

1. **Data source & endpoint**: Xero `CreditNotes` (ACCPAYCREDIT).
2. **Included/excluded**: `status === 'AUTHORISED'` ONLY (see Cross-cutting Finding #3 — asymmetric
   vs old_sales_credits by design), `remainingCredit > 0`, older than 60 days.
3-4. As-of/backlog from `period.end`. Literal `period_checked = 'older_than_60_days'` — same
    literal as old_sales_credits, overwritten by `period.key` per Finding #1.
5. **Grouping identity & count unit**: one credit note = one item.
6. **Amount basis**: remaining credit.
7. **Defaults & overrides**: `CHECK_DEFAULTS.oldDocumentDays = 60`, no override. AUTHORISED-only
   restriction is hardcoded (not a configurable choice).
8. **Finding-key recipe**: generic `'document'` fallback.
9. **Display-only vs scored**: scored.
10. **Not-configured/unavailable**: none; failure skips the write.
11. **Test coverage**: shares `selectOldCredits` unit test with old_sales_credits. No dedicated
    per-client xenonParity lock.

---

## 10. opening_balance_differences

*(File: `src/services/statementEvidence.js`, not xeroSync.js)*

1. **Data source & endpoint**: `filed_accounts` table (Companies House filings) vs a live Xero
   `Reports/BalanceSheet` fetched **as-of each filing's own date** — every eligible filing is
   compared, not just the latest (fixed this session).
2. **Included/excluded**: N/A (Balance Sheet report row match on net assets/liabilities/equity).
3. **Date field & boundary**: `filing_date` (Companies House "made up to" date); each comparison is
   a point-in-time as-of match, not a range.
4. **Period scoping**: filing-date comparison — independent of the sync's selected period entirely.
5. **Grouping identity & count unit**: one filed year-end = one item.
6. **Amount basis**: absolute difference in net assets.
7. **Defaults & overrides**:
   - Documented default: £1 threshold (Xenon's own stated default), with a rounding floor (£1 if
     the filed figure is a whole pound, else £0.01) taken as the max of the two — never lets the
     floor override an explicit higher threshold.
   - Practice-wide `getSetting('opening_balance_threshold_gbp')`.
   - Organisation-level override: `opening_balance_threshold_gbp` column — highest precedence.
8. **Finding-key recipe**: generic `'document'` fallback, keyed by the filing's own `date` field
   (added this session specifically so multiple filings key distinctly rather than colliding on
   their shared £ amount).
9. **Display-only vs scored**: scored.
10. **Not-configured/unavailable**: `not_configured` (no filings at all); `<dates>`-labelled real
    key when every filing is comparable; `needs_sync` (some filing never synced);
    `unavailable` (some filing synced but genuinely has no comparable Balance Sheet data).
11. **Test coverage**: `test/statementEvidence.test.js` — threshold tests (£1 default, null-safety,
    org override), plus the three multi-filing tests added this session (both-bad, one-clean,
    partial-sync-stays-pending).

---

## 11. invoice_or_direct

1. **Data source & endpoint**: Xero `Invoices` (ACCREC) + `BankTransactions` (RECEIVE).
2. **Included/excluded**: bank receives = `AUTHORISED`, period-filtered. Documents = ACCREC
   `AUTHORISED`/`PAID` with `amountDue > 0`, plus ALL `DRAFT`/`SUBMITTED` ACCREC (drafts are treated
   as fully outstanding, since `amountDue == total` while unapproved). Eligible account codes =
   REVENUE class.
3. **Date field & boundary**: invoice dated 0–30 days **before** the bank receive, inclusive both
   ends (`CHECK_DEFAULTS.directMatchWindowDays = 30`).
4. **Period scoping**: bank-transaction side is period-scoped; document side has a bounded 30-day
   lookback before that.
5. **Grouping identity & count unit**: one matched (bank transaction, invoice) pair, one-to-one,
   nearest-date wins.
6. **Amount basis**: exact match required — gross/total basis, not net.
7. **Defaults & overrides**: `CHECK_DEFAULTS.directMatchWindowDays = 30`, hardcoded — **no**
   organisation override exists for this window (unlike the duplicate-matching windows).
8. **Finding-key recipe**: `PAIR_FINDING_CHECKS` → pair of `[bankTransactionId, invoiceId]`.
9. **Display-only vs scored**: scored.
10. **Not-configured/unavailable**: literal `period_checked = 'since_lock_date'` written in code —
    per Finding #1, this is NOT reserved and gets overwritten by the real `period.key` at
    persistence.
11. **Test coverage**: `findDirectMatches` unit tests in `test/checkRules.test.js` (30-day window,
    one-to-one nearest-date matching). No dedicated xenonParity lock.

---

## 12. bill_or_direct

Mirrors invoice_or_direct on the purchase side.

1. **Data source & endpoint**: Xero `BankTransactions` (SPEND) + `Invoices` (ACCPAY).
2. **Included/excluded**: bank spends = `AUTHORISED`, period-filtered. Documents = ACCPAY
   `AUTHORISED` with `amountDue > 0`, plus `DRAFT` only (NOT `SUBMITTED` — confirmed deliberate,
   validated against a real Xenon export: "DRAFT bills are included, SUBMITTED are not"). Eligible
   account codes = EXPENSE class.
3-6. Same mechanism as invoice_or_direct (30-day lookback, exact amount match, gross basis,
    one-to-one pairing).
7. **Defaults & overrides**: same single hardcoded `directMatchWindowDays = 30`, no override.
8. **Finding-key recipe**: same pair mechanism.
9-10. Same as invoice_or_direct — literal `'since_lock_date'` gets overwritten per Finding #1.
11. **Test coverage**: shares `findDirectMatches` tests with invoice_or_direct.

---

## 13. low_cost_fixed_assets

1. **Data source & endpoint**: Xero `Invoices` (ACCPAY) + `BankTransactions` (SPEND). No Money-In
   side is checked (unlike capital_item_review).
2. **Included/excluded**: `AUTHORISED`/`PAID` bills, `AUTHORISED` bank spend, on an account
   classified `type === 'FIXED'` in the chart of accounts.
3. **Date field & boundary**: period-scoped (`since_lock_date`: start exclusive, end inclusive).
4. **Period scoping**: period-scoped.
5. **Grouping identity & count unit**: one line item = one item.
6. **Amount basis**: net (ex-VAT); flagged when `0 < amount <= LOW_COST_THRESHOLD`.
7. **Defaults & overrides**: `LOW_COST_THRESHOLD = 200`, hardcoded inline — the **only** one of the
   threshold-based checks with zero configurability anywhere (no practice setting, no organisation
   column, no account-level override).
8. **Finding-key recipe**: `'line'` kind (documentId + accountCode + description).
9. **Display-only vs scored**: scored.
10. **Not-configured/unavailable**: throws and is skipped entirely if chart of accounts is
    unavailable ("Not synced") — no `not_configured` state. Literal
    `` `fixed_asset_accounts_lte_200_since_lock_date` `` gets overwritten per Finding #1.
11. **Test coverage**: none dedicated by name — covered only indirectly via the shared
    `netLineAmount`/`grossLineAmount` unit tests.

---

## 14. capital_item_review

1. **Data source & endpoint**: Xero `Invoices` (ACCPAY) + `BankTransactions` (SPEND **and**
   RECEIVE — uniquely among the threshold checks, e.g. an overpayment refunded onto a monitored
   expense account still counts).
2. **Included/excluded**: `AUTHORISED`/`PAID` bills, `AUTHORISED` bank spend/receive, on an account
   in the resolved capital-review candidate set.
3-4. Period-scoped (since lock date).
5. **Grouping identity & count unit**: one line item = one item.
6. **Amount basis**: net (ex-VAT).
7. **Defaults & overrides** — the most heavily layered stack of any check:
   - Documented default: Xenon monitors account codes **461** and **473** "if they exist."
   - Practice setting: `getSetting('capital_review_threshold')`, fallback £500.
   - Organisation override: `capital_review_default_threshold_gbp` column, precedence over
     practice.
   - Account-level override: `chart_of_accounts_cache.capital_review_threshold` per account,
     precedence over org/practice for that account.
   - Candidate-code override: `chart_of_accounts_cache.is_capital_candidate` per account.
   - **`account_settings_initialised` tri-state** (fixed this session): before the Per-account
     Check Settings page has ever been saved for an org, 461/473 auto-add whenever present
     (alongside any explicit `is_capital_candidate` rows); after the first save, `is_capital_
     candidate` is trusted verbatim, including an explicit 0 on 461/473 — a genuine opt-out.
8. **Finding-key recipe**: `'line'` kind.
9. **Display-only vs scored**: scored.
10. **Not-configured/unavailable**: `not_configured` (reserved label, survives) when the candidate
    code set is empty. Throws/skips entirely if chart of accounts unavailable.
11. **Test coverage**: extensive — `resolveCapitalReviewDefaultThreshold` tests, the full
    `resolveCapitalReviewCandidateCodes` tri-state test suite (never-configured default, opt-out
    after save, explicit-zero-before-save-still-auto-added), plus a cross-client isolation test.

---

## 15. misallocated_items

1. **Data source & endpoint**: Xero `Invoices` (ACCPAY + ACCREC) + `BankTransactions` (SPEND +
   RECEIVE) — all **four** of Xenon's documented sources (fixed this session; previously only
   bills + Money Out).
2. **Included/excluded**: `AUTHORISED`/`PAID` on both invoice types, `AUTHORISED` on both bank
   transaction types, on a monitored account.
3-4. Period-scoped (since lock date), all four sources share the same window.
5. **Grouping identity & count unit**: one line item = one item, across all four sources.
6. **Amount basis**: net (ex-VAT).
7. **Defaults & overrides**:
   - Universal fallback: `VAGUE_ACCOUNT_NAME` regex (general/miscellaneous/misc/sundry/other/
     various) — only applies when nothing is explicitly configured.
   - Practice setting: `getSetting('misallocated_items_threshold')`, fallback £100.
   - Organisation override: `misallocated_items_default_threshold_gbp`, precedence over practice.
   - Account-level override: `chart_of_accounts_cache.monitor_misallocated` (which accounts to
     watch — a configured list replaces the vague-name fallback entirely, shared **unfiltered**
     across both expense and revenue sides) and `misallocated_threshold` (per-account £ override).
8. **Finding-key recipe**: `'line'` kind.
9. **Display-only vs scored**: scored.
10. **Not-configured/unavailable**: no `not_configured` state — throws/skips if chart of accounts
    unavailable. Literal labels (`'configured_accounts_and_thresholds_since_lock_date'` or
    `` `vague_account_fallback_gte_${threshold}_since_lock_date` ``) overwritten per Finding #1.
11. **Test coverage**: `findMisallocatedLines` unit tests (threshold, per-account override,
    expense/revenue independence, net-amount consistency), plus the resolver tests. Verified live
    this session on 7 real clients — purely additive, 2 clients gained genuine new findings.

---

## 16. multi_account_suppliers

1. **Data source & endpoint**: Xero `Invoices` (ACCPAY) + purchase `CreditNotes` (ACCPAYCREDIT,
   `AUTHORISED`/`PAID`) + `BankTransactions` (SPEND, `AUTHORISED`). Drafts excluded.
2. **Included/excluded**: as above; purchase credit notes deliberately included (confirmed 4th
   supplier on a real client via credit-note-only account usage).
3. **Date field & boundary**: comparison-lookback window, both ends inclusive.
4. **Period scoping — comparison-lookback**: detection window =
   `min(period.start, period.end − lookbackMonths)`, i.e. reaches back to whichever is further in
   the past. The £ **value** is restricted to lines also within the normal since-lock-date period,
   so widening detection never inflates reported exposure.
5. **Grouping identity & count unit**: one contact/supplier with activity on ≥2 distinct account
   codes in the lookback window AND ≥1 line within the since-lock-date period = one item.
6. **Amount basis**: gross (bills are usually net/Exclusive, bank spend usually gross/Inclusive —
   gross is the consistent basis across both). Value = sum of since-lock-date amounts on
   non-dominant account codes; dominant = highest all-time (lookback) total.
7. **Defaults & overrides**:
   - `DEFAULT_SUPPLIER_PATTERN_LOOKBACK_MONTHS = 12` (shared fallback constant).
   - Practice setting: `getSetting('multi_account_suppliers_min_value')`, fallback £0 (Xenon
     applies no materiality floor by default).
   - Organisation override (lookback): `multi_account_pattern_lookback_months` — **independently**
     configurable from multi-tax's own lookback column.
   - Organisation override (floor): `multi_account_suppliers_min_value_gbp`.
8. **Finding-key recipe**: `CONTACT_FINDING_CHECKS` → `{kind: 'contact', contactId}`.
9. **Display-only vs scored**: scored.
10. **Not-configured/unavailable**: no gating condition — always runs. Literal
    `` `supplier_pattern_from_${start}_value_since_lock_date` `` overwritten per Finding #1.
11. **Test coverage**: lookback resolver tests (default, independence from multi-tax), min-value
    resolver tests. **Correction**: no per-client xenonParity locks cover this check — the logic is
    inline in `xeroSync.js`, not exported as a pure function, so `test/xenonParity.test.js` cannot
    lock it directly (confirmed by grep: the file has no `multi_account_suppliers` reference).

---

## 17. multi_tax_suppliers

Mirrors multi_account_suppliers with an independent lookback and different amount basis.

1. **Data source & endpoint**: same three sources as multi_account_suppliers.
2. **Included/excluded**: same, plus internal "Mileage"/"Mileage expense" reimbursement contacts
   excluded entirely (confirmed false-positive fix on a real client). Zero-amount lines skipped
   (checked pre-net-conversion, so a genuine VAT-only line that nets to £0 isn't wrongly dropped).
3-4. Same comparison-lookback mechanism, independently configured lookback.
5. **Grouping identity & count unit**: one contact with ≥2 distinct tax codes in the lookback
   window (NONE counts as a real code) AND ≥1 line in the since-lock-date period.
6. **Amount basis**: net (ex-VAT). Dominant = highest all-time total (NONE eligible to be
   dominant). Value = sum of non-dominant, **non-NONE** amounts only — NONE stays eligible for
   multiplicity/dominant-selection but never contributes to the £ figure (closed a client from
   +132% over Xenon's value to +2.6%).
7. **Defaults & overrides**:
   - Same shared `DEFAULT_SUPPLIER_PATTERN_LOOKBACK_MONTHS = 12` fallback.
   - Practice setting: `getSetting('multi_tax_suppliers_min_value')`, fallback £0.
   - Organisation override (lookback): `supplier_pattern_lookback_months` — independent of
     multi-account's column (e.g. one real client's multi-tax lookback was widened to 18 months
     without affecting their multi-account setting).
   - Organisation override (floor): `multi_tax_suppliers_min_value_gbp`.
8. **Finding-key recipe**: same `{kind: 'contact', contactId}` mechanism.
9-10. Same as multi_account_suppliers.
11. **Test coverage**: lookback/min-value resolver tests. **Correction**: no per-client xenonParity
    locks cover this check either, for the same reason as multi_account_suppliers (inline logic,
    not a pure exported function).

---

## 18. unexpected_account_used

1. **Data source & endpoint**: Xero `Invoices` (ACCPAY + ACCREC) + `BankTransactions` (SPEND +
   RECEIVE) + `Contacts` (native `purchasesDefaultAccountCode`/`salesDefaultAccountCode`).
2. **Included/excluded**: `AUTHORISED`/`PAID` on both invoice types, `AUTHORISED` on both
   transaction types. Only checked when the contact HAS a default set — a missing default is
   `contact_defaults`' job, so the two checks don't double-flag the same root cause.
3-4. Period-scoped (uses the resolved period generally, not hardcoded to since-lock-date).
5. **Grouping identity & count unit**: one offending line = one item, across all four sources.
6. **Amount basis**: net (ex-VAT).
7. **Defaults & overrides**: none — entirely driven by each contact's own Xero-native default
   fields, no exemption list, no organisation/account override.
8. **Finding-key recipe**: `'line'` kind (documentId + accountCode).
9. **Display-only vs scored**: scored.
10. **Not-configured/unavailable**: no chart-of-accounts dependency; underlying fetch failure is
    caught and skipped.
11. **Test coverage**: shared `findUnexpectedDefaultLines` unit test.

---

## 19. unexpected_tax_code_used

Mirrors unexpected_account_used on tax type instead of account code.

1-6. Identical sources, statuses, period scoping, grouping, and amount basis to
    unexpected_account_used, checking `accountsPayableTaxType`/`accountsReceivableTaxType` instead.
7. **Defaults & overrides**: none, same as unexpected_account_used.
8. **Finding-key recipe**: `'line'` kind (documentId + description — no accountCode present, so it
   resolves via the description-present branch).
9-10. Same as unexpected_account_used.
11. **Test coverage**: shares `findUnexpectedDefaultLines` unit test (tax-type variant).

---

## 20. sales_tax_missing

*(See Cross-cutting Finding #1 — the `'not_vat_registered'` label is now reserved and survives to storage.)*

1. **Data source & endpoint**: Xero `Invoices` (ACCREC) + `BankTransactions` (RECEIVE) +
   `Accounts` (REVENUE class) + `Organisation` (`salesTaxBasis`, for VAT-registration gating).
2. **Included/excluded**: `AUTHORISED`/`PAID` invoices, `AUTHORISED` bank receive. Flagged when
   `taxType` is falsy/`'NONE'`, `lineAmount > 0`, and the account is REVENUE class.
3-4. Period-scoped.
5. **Grouping identity & count unit**: one offending line = one item (explicitly not per document).
6. **Amount basis**: net (ex-VAT) — there's no tax amount to sum since tax is the thing missing.
7. **Defaults & overrides**: gated entirely by VAT-registration status
   (`orgInfo.salesTaxBasis !== 'NONE'`). No per-account exemption list exists for this check
   (unlike purchase_tax_missing).
8. **Finding-key recipe**: `'line'` kind.
9. **Display-only vs scored**: scored.
10. **Not-configured/unavailable**: not-VAT-registered → deliberate `count: 0`,
    `period_checked: 'not_vat_registered'` — **see Finding #1**, this label is reserved and
    survives to storage, and displays as `not_applicable` via `resolveCheckDisplayStatus`.
    Chart-of-accounts-unavailable throws and skips.
11. **Test coverage**: none dedicated — logic is inline, not exported as a pure function.

---

## 21. purchase_tax_missing

*(See Cross-cutting Finding #1 — the `'not_vat_registered'` label is now reserved and survives to storage.)*

1. **Data source & endpoint**: Xero `Invoices` (ACCPAY) + `BankTransactions` (SPEND) + `Accounts`
   (EXPENSE/FIXED/PREPAYMENT classes) + per-account config + organisation exclude-codes setting.
2. **Included/excluded**: `AUTHORISED`/`PAID` bills, `AUTHORISED` bank spend. Flagged when
   `taxType` falsy/`'NONE'`, `lineAmount > 0`, and the account is in scope per the full exemption
   stack below.
3-4. Period-scoped.
5. **Grouping identity & count unit**: one offending line = one item (verified against a real
   client: 26 per-invoice vs 76 per-line, same £ total — per-line is correct).
6. **Amount basis**: net (ex-VAT).
7. **Defaults & overrides — the full exemption stack, in evaluation order**:
   1. Account-level `purchase_tax_ignore` — excludes outright, checked first.
   2. Account-level `purchase_tax_include_asset_prepayment` — force-includes, checked second,
      before any exemption keyword logic.
   3. In-scope class test: EXPENSE, or FIXED-type asset, or **PREPAYMENT-type (auto-included by
      default, this session's fix)**.
   4. Universal exemption `isPurchaseTaxExemptAccount`, applied last:
      - Organisation-level `purchase_tax_missing_exclude_codes` override (an explicit `''` means
        "no exclusions," distinct from unset falling to the practice setting).
      - Hardcoded "Rates"-only regex (not "Rent & Rates" — rent is ordinarily VATable).
      - Hardcoded keyword list: payroll, statutory, wages, salary, PAYE, National Insurance,
        pensions, bank interest, bank revaluations, depreciation, amortisation, drawings,
        corporation tax, deferred tax, penalties, directors' remuneration, charitable/political
        donations, mileage. Plain "Interest Paid" and bank/processor fees (Bank Fees, PayPal,
        merchant charges) are deliberately **not** exempt.
   Gated overall by VAT-registration status, same as sales_tax_missing.
8. **Finding-key recipe**: `'line'` kind.
9. **Display-only vs scored**: scored.
10. **Not-configured/unavailable**: not-VAT-registered → `'not_vat_registered'`, reserved and
    displayed as `not_applicable` (see Finding #1). Chart-of-accounts-unavailable throws/skips.
11. **Test coverage**: `isPurchaseTaxExemptAccount` unit tests (the full keyword-exemption
    behaviour), `resolvePurchaseTaxMissingExcludeCodes` tests (including the empty-string-vs-null
    distinction).

---

## 22. sales_tax_on_bills

1. **Data source & endpoint**: Xero `Invoices` (ACCPAY) + `BankTransactions` (SPEND,
   display-only) + `TaxRates` (`canApplyToRevenue`/`canApplyToExpenses` flags).
2. **Included/excluded**: `AUTHORISED`/`PAID` bills; bank-spend lines only surfaced if coded to an
   EXPENSE account. Flagged when the line's tax type is sales-only
   (`canApplyToRevenue && !canApplyToExpenses`) — regardless of which account it's coded to (a
   supplier discount booked to a revenue account with a sales tax code is still a bill-side
   miscoding).
3-4. Period-scoped, but written with the literal `period_checked = 'since_lock_date'` — overwritten
    by `period.key` per Finding #1.
5. **Grouping identity & count unit**: one offending bill line = one item. Bank-spend observations
   are separate, `displayOnly: true` — they appear in the detail but never contribute to count/£.
6. **Amount basis**: **the tax amount itself**, not net/gross — the risk here is which rate
   applied, not the transaction size.
7. **Defaults & overrides**: none — entirely derived from Xero's own `TaxRate` direction flags.
8. **Finding-key recipe**: `'line'` kind.
9. **Display-only vs scored**: the check is scored; its bank-spend observations are internally
   display-only (a check-level distinction, separate from `NON_SCORED_CHECKS`).
10. **Not-configured/unavailable**: throws/skips (shared with purchase_tax_on_invoices) if tax
    rates or chart of accounts are unavailable — **both checks fail together** since they share one
    try block.
11. **Test coverage**: `withDisplayOnlyBankFindings` unit test.

---

## 23. purchase_tax_on_invoices

Mirrors sales_tax_on_bills on the sales side.

1. **Data source & endpoint**: Xero `Invoices` (ACCREC) + `BankTransactions` (RECEIVE,
   display-only) + `TaxRates`.
2. **Included/excluded**: `AUTHORISED`/`PAID` invoices; bank-receive lines only surfaced if coded
   to a REVENUE account. Flagged when the tax type is purchase-only
   (`canApplyToExpenses && !canApplyToRevenue`).
3-6. Same mechanism as sales_tax_on_bills — literal `'since_lock_date'` (overwritten per Finding
   #1), tax-amount basis, display-only bank-side observations.
7. **Defaults & overrides**: none, same as sales_tax_on_bills.
8. **Finding-key recipe**: `'line'` kind.
9. **Display-only vs scored**: same internal distinction as sales_tax_on_bills.
10. **Not-configured/unavailable**: shares the same try block and guard as sales_tax_on_bills —
    both checks fail together if either dependency is missing.
11. **Test coverage**: shares `withDisplayOnlyBankFindings` test.

---

## 24. undocumented_bills

1. **Data source & endpoint**: Xero `Invoices` (ACCPAY) — specifically the `hasAttachments` flag.
2. **Included/excluded**: `status === 'AUTHORISED'` ONLY — **PAID bills are explicitly excluded**
   (a single paid bill without an attachment would otherwise keep this permanently non-zero on a
   real client where Xenon reports 0).
3-4. Period-scoped, literal `period_checked = 'since_lock_date'` — overwritten per Finding #1.
5. **Grouping identity & count unit**: one bill (document) = one item — not line-level, since
   attachment presence is a document property.
6. **Amount basis**: N/A — `potential_value_gbp` is always 0; the bill's gross total is carried in
   the detail purely for display.
7. **Defaults & overrides**: none — no exemption list, no VAT-registration gating (attachment
   presence is unrelated to tax scheme).
8. **Finding-key recipe**: falls all the way to the final `'document'` fallback (no accountCode, no
   contactId field — only a contact *name* string).
9. **Display-only vs scored**: **NON-SCORED** — one of four checks explicitly excluded from health
   scoring, despite producing real findings.
10. **Not-configured/unavailable**: no gating condition beyond the invoice fetch succeeding.
11. **Test coverage**: none dedicated.

---

## 25. unapproved_invoices

*(See Cross-cutting Finding #4 — internal dedup window is hardcoded, not org-configurable.)*

1. **Data source & endpoint**: Xero `Invoices` (ACCREC), `DRAFT` or `SUBMITTED`.
2. **Included/excluded**: repeat-saved copies of the same still-unapproved draft are excluded from
   the counted set (via `findDuplicates` + `excludeDuplicateDrafts`, both using the hardcoded
   3-day default) but surfaced separately as `displayOnly: true` findings so an accountant can see
   why the number dropped.
3-4. Since-lock-date scoped ("to avoid historical noise" per the code comment).
5. **Grouping identity & count unit**: one document (invoice) = one counted item.
6. **Amount basis**: absolute exposure (`sumAbsoluteExposure` on `total`) — a negative draft (e.g.
   an opening-balance adjustment) adds to the exposure rather than cancelling other drafts out.
7. **Defaults & overrides**: the internal dedup window uses `CHECK_DEFAULTS.duplicateWindowDays`
   (3 days) directly, NOT the org-overridable `resolveDuplicateInvoiceWindowDays` the real
   `duplicate_invoices` check uses.
8. **Finding-key recipe**: generic `'document'` fallback.
9. **Display-only vs scored**: the check itself is scored; the excluded-duplicate rows within its
   own detail are `displayOnly: true`.
10. **Not-configured/unavailable**: no reserved label; failure skips the write.
11. **Test coverage**: no test named for this check specifically; the underlying
    `excludeDuplicateDrafts` behaviour is covered generically.

---

## 26. unapproved_bills

Mirrors unapproved_invoices on the ACCPAY side.

1. **Data source & endpoint**: Xero `Invoices` (ACCPAY), `DRAFT` or `SUBMITTED`.
2-9. Identical mechanism to unapproved_invoices, including the same hardcoded 3-day internal dedup
    window (not the org-overridable `resolveDuplicateBillWindowDays`).
10. **Not-configured/unavailable**: no reserved label; failure skips the write.
11. **Test coverage**: shares the same `excludeDuplicateDrafts` coverage.

---

## 27. duplicate_contacts

1. **Data source & endpoint**: Xero `Contacts`.
2. **Included/excluded**: `contactStatus === 'ACTIVE'` AND (`isCustomer` or `isSupplier`) — strict
   matching, not every contact.
3-4. N/A — no date field; a current-state snapshot of active contacts.
5. **Grouping identity & count unit**: one duplicate-name **pair** = one item (pairwise
   comparison, not clusters).
6. **Amount basis**: N/A — always £0.
7. **Defaults & overrides**: `CHECK_DEFAULTS.contactSimilarityThreshold = 0.7` (normalized
   Levenshtein similarity), hardcoded — no organisation override.
8. **Finding-key recipe**: `PAIR_FINDING_CHECKS` → `{kind: 'pair', ids: [id1, id2].sort()}`.
9. **Display-only vs scored**: **NON-SCORED**. UI renders it with a `(!)` badge instead of a
   numeric count.
10. **Not-configured/unavailable**: none; failure skips the write.
11. **Test coverage**: `contactNameSimilarity`/`findDuplicateContacts` unit test.

---

## 28. contact_defaults

1. **Data source & endpoint**: Xero `Contacts`.
2. **Included/excluded**: `contactStatus === 'ACTIVE'`; customers missing
   `salesDefaultAccountCode` or `accountsReceivableTaxType`; suppliers missing
   `purchasesDefaultAccountCode` or `accountsPayableTaxType`.
3-4. N/A — current-state snapshot, no date field.
5. **Grouping identity & count unit**: one contact = one item.
6. **Amount basis**: N/A — always £0.
7. **Defaults & overrides**: none — pure presence/absence field check.
8. **Finding-key recipe**: `CONTACT_FINDING_CHECKS` → `{kind: 'contact', contactId}`.
9. **Display-only vs scored**: **NON-SCORED**. Same `(!)` badge treatment.
10. **Not-configured/unavailable**: none; failure skips the write.
11. **Test coverage**: none dedicated.

---

## 29. inactive_contacts

1. **Data source & endpoint**: Xero `Contacts`, cross-referenced against `Invoices`,
   `CreditNotes`, `BankTransactions`, and `Payments` for activity.
2. **Included/excluded**: only `ACTIVE` contacts that are customers/suppliers. `VOIDED`/`DELETED`
   documents are excluded from counting as activity (on one real client, 20,764 deleted documents
   would otherwise mask 20 dormant contacts). `DELETED` payments excluded for the same reason.
3. **Date field & boundary**: "last activity" = the MAX date across all invoice/credit/bank-txn/
   payment dates for that contact — a payment's own date is tracked as independent activity from
   its document's date (measured to fix 34 wrongly-listed contacts across five reference clients).
   Falls back to `contact.updatedDateUTC` only if the contact has never transacted at all (so a
   just-created contact isn't wrongly flagged). Boundary: `lastSeen < cutoff` — the cutoff date
   itself still counts as active (exclusive).
4. **Period scoping**: cutoff = `period.end` minus 18 months, but then scans the contact's *entire*
   activity history with no lower bound — functionally an all-time backlog scan against a rolling
   window, not the reporting period range.
5. **Grouping identity & count unit**: one contact = one item.
6. **Amount basis**: N/A — always £0.
7. **Defaults & overrides**: **18 months, hardcoded, not configurable** — and explicitly documented
   in the code as Xenon's own confirmed UI-stated threshold ("contacts that have a most recent
   transaction of 18 months or older"), not an internal guess. A separate, unrelated constant
   (`DEFAULT_SUPPLIER_PATTERN_LOOKBACK_MONTHS = 12`, used only by multi_account_suppliers/
   multi_tax_suppliers) should not be conflated with this one — they are genuinely different
   checks with genuinely different thresholds, not a drifted spec. The code also notes that a
   Xenon "OK" here may reflect their "Show dismissed" toggle hiding previously-reviewed contacts,
   not a genuinely empty result — a source of apparent-but-not-real parity mismatches.
8. **Finding-key recipe**: `CONTACT_FINDING_CHECKS` → `{kind: 'contact', contactId}`.
9. **Display-only vs scored**: **NON-SCORED**. Same `(!)` badge treatment.
10. **Not-configured/unavailable**: `period_checked` is a dynamic (non-reserved) label
    `` `no_transaction_in_18_months_before_${period.end}` `` — overwritten per Finding #1; failure
    skips the write.
11. **Test coverage**: none dedicated.

---

## Summary: NON_SCORED_CHECKS

Exactly four of the 29 checks are excluded from health-score calculation despite producing real,
displayed findings: `duplicate_contacts`, `contact_defaults`, `inactive_contacts`,
`undocumented_bills`. The first three render with a `(!)` badge in the UI rather than a numeric
count; `undocumented_bills` renders normally (a count/value) but simply doesn't feed the score.

## Summary: checks with zero organisation-level configurability

`unreconciled_bank_items` (bank-account exclusion aside), `unprocessed_bank`, `invoice_or_direct`,
`bill_or_direct`, `low_cost_fixed_assets`, `sales_tax_missing` (exemptions aside — none exist for
this one), `sales_tax_on_bills`, `purchase_tax_on_invoices`, `undocumented_bills`,
`duplicate_contacts`, `contact_defaults`, `inactive_contacts`, `old_unpaid_invoices`,
`old_sales_credits`, `old_unpaid_bills`, `old_purchase_credits` (the 60-day age threshold is
hardcoded everywhere it's used, with no per-org override anywhere in the codebase).
