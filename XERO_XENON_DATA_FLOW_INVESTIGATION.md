# Xero → Xenon → Akrio Verify: data-flow investigation

Investigation only — no code changed as part of this document. Scope: `healthandtransactions`
(this repo). No live Xenon access was used; every finding is code/data evidence from this
repository plus the documented behaviour already captured in `XENON_PARITY_SPEC.md` and
`XENON_PARITY_MATRIX.md`.

**Read this first:** most of the 29-check reverse-engineering this investigation was asked to
produce already exists, rigorously, in two files already in this repo:

- **`XENON_PARITY_SPEC.md`** — a rule-by-rule spec for all 29 checks, each rule tagged confirmed /
  provisional / unavailable, with row-level evidence from real Xenon exports (4X4, Handymanz, Fast
  Track, Rose, MBX). It already documents dozens of the "hidden rules" this brief asked for —
  duplicate-grouping window and direction, the "at least one unpaid" pairing rule, the 60-day-from-
  document-date (not due-date) threshold, VAT-registration gating, exemption keyword lists, the
  multi-tax "NONE counts as a code, £0 lines don't" rule, and more.
- **`XENON_PARITY_MATRIX.md`** — a live-generated, per-client, per-check table of our value vs.
  Xenon's value, EXACT/MISMATCH/CONFIG_REQUIRED/etc., regenerated read-only by
  `scripts/generate-xenon-parity-matrix.js`. Last regenerated 2026-09-07.

This document does not repeat that work. It covers what those two files **don't**: the Turnover
metric (not one of the 29 checks, so outside their scope), the full Xero API surface actually used
vs. available, sync/cache mechanics, the FreeAgent integration's parity with the Xero one, and
duplicate-counting risk analysis. Section 6 gives a compressed pointer-summary of the 29 checks for
completeness, but XENON_PARITY_SPEC.md remains the source of truth for check-level detail.

Evidence labels used throughout, per the brief's requirement:
- **CONFIRMED** — verified directly in code, or already evidence-backed in XENON_PARITY_SPEC.md.
- **STRONGLY INDICATED** — code comments describe past empirical tuning against real Xenon output,
  but the underlying Xenon rule itself was never seen directly (we only see our own past
  convergence toward it).
- **NEEDS VERIFICATION** — a plausible risk or gap identified, not proven either way.

---

## 1. Executive summary

Two production bugs were found and fixed earlier in this engagement, both in the **Turnover**
portfolio metric (not part of the 29-check registry — a separate figure shown on the client list):

1. Turnover was computed by summing raw sales-invoice `SubTotal` values only — no currency
   conversion, no credit-note netting, no bank-booked revenue, no manual journals, and no
   account-type classification (see `git log` — commit `388de40`). Confirmed wrong on 16 real
   clients by exact figures, fixed to a ledger-classified, currency-converted, multi-source
   calculation cross-checked against Xero's own P&L report.
2. That new cross-check itself had two bugs (Xero's P&L report's 365-day range cap, and an
   exclusive-vs-inclusive lock-date boundary mismatch) — both found and fixed via live testing
   against 16 real clients (commit `ded23bd`).

Separately from Turnover, the 29 scored bookkeeping checks are **already** extensively
parity-tested against real Xenon exports (see `XENON_PARITY_MATRIX.md`) — 5 clients, 29 checks
each, most EXACT, a documented and evidence-backed explanation for nearly every remaining
mismatch (mostly date drift between the Xenon snapshot's age and today, or Xenon's own hidden
review-state — dismissed/ignored findings the API can't see).

New findings from this pass:
- A full inventory of every Xero endpoint used vs. available but unused (Items, Tracking
  Categories, the real Fixed Asset API, Purchase Orders, Quotes, Expense Claims, most
  History/Attachment endpoints, Aged Receivables/Payables reports, Trial Balance, Repeating
  Invoices — all unused; Section 4).
- The FreeAgent integration reproduces 9 of its 11 shared checks identically to Xero's logic, but
  has one **genuine rule difference** (`duplicate_contacts` scans all active contacts, not just
  customers/suppliers) and **still has the exact pre-fix Turnover bug** the Xero side just had
  fixed (Section 8).
- One theoretical entity-cache staleness window (up to 7 days) on incremental syncs, mitigated in
  practice by Xero's own update-timestamp behaviour but not structurally guarded against (Section
  9).
- No monetary double-counting risk found in the raw-transaction aggregation logic — Xero's own
  Payment-vs-BankTransaction object separation makes the most obvious double-count scenario
  (invoice + its bank settlement) structurally impossible under normal data (Section 7).

---

## 2. Xero → Xenon data flow (what Xenon appears to consume)

We have no live Xenon access this pass, so nothing here is newly observed — it restates,
compressed, what `XENON_PARITY_SPEC.md` already established through row-level exports:

- Xenon's 29 checks read Invoices, CreditNotes, BankTransactions, Payments, Contacts, and Accounts
  (chart of accounts, for account-type classification) — never a raw Journals feed for the checks
  themselves.
- Xenon's **portfolio-level Turnover** figure (the number on its client list, separate from the 29
  checks) reads Xero's own P&L "Total Turnover"/"Total Income" line — i.e. every ledger posting to
  a Turnover-section account, from whatever source (invoice, credit note, bank line, or journal).
  This was independently re-derived and confirmed this session (see the Turnover Mismatch
  investigation, now fixed) — Xenon's number for all 16 real clients checked matched Xero's live
  P&L exactly, never our old invoice-only figure.
- `bank_balance` and `unprocessed_bank`: Xenon's own figures for these appear to come from data
  outside the standard Accounting API entirely (Xero's closed Finance API `/CashValidation`,
  documented in `XENON_PARITY_SPEC.md`'s "External-evidence checks" section) — this app instead
  reconstructs the same numbers from imported bank statement evidence, which is a genuine parallel
  reconstruction, not a proxy.
- Xenon has its own **application-level review state** (dismissed findings, "Mark as OK",
  per-account ignore settings) that has no Xero representation at all — several documented
  MISMATCH rows in `XENON_PARITY_MATRIX.md` are fully explained by this (e.g. Rose's
  `purchase_tax_missing` gap is ~98% Xenon-side dismissed/ignored state, confirmed row-for-row).

---

## 3. Xero → Akrio Verify (this app) data flow

Full detail in Section 4 (endpoint table) and Section 9 (sync mechanics). Summary: every check and
the Turnover metric are computed from **raw fetched Xero entities** (Invoices, CreditNotes,
BankTransactions, ManualJournals, Payments, Accounts, Contacts, TaxRates, Organisation), cached
locally with incremental sync, never from Xero's report endpoints — with three explicit,
deliberate exceptions where a report endpoint is the *only* or *cross-check* source: `bank_balance`
(Reports/BankSummary), `opening_balance_differences` (Reports/BalanceSheet), and the new Turnover
P&L cross-check (Reports/ProfitAndLoss). See Section 5 for the full raw-vs-report breakdown.

---

## 4. Xero API endpoint inventory

### 4.1 Endpoints used

| Xero endpoint | Object | Used for | Key fields read |
|---|---|---|---|
| `getInvoices` (+ `fetchInvoicesByIds` hydration) | Invoices | Nearly every check; Turnover | `type, status, date, dueDate, total, amountDue, contact, lineItems[].{accountCode,lineAmount,taxAmount}, lineAmountTypes, currencyRate, hasAttachments` |
| `getInvoiceHistory` | Invoice History | Duplicate-draft audit-trail display only | `details, user, dateUTC` |
| `getContacts` | Contacts | duplicate_contacts, contact_defaults, inactive_contacts, unexpected_account/tax_used | `contactStatus, isCustomer, isSupplier, salesDefaultAccountCode, purchasesDefaultAccountCode, accountsReceivableTaxType, accountsPayableTaxType` |
| `getCreditNotes` | CreditNotes | old_sales/purchase_credits, multi-account/tax, Turnover | `type, status, date, remainingCredit, lineItems, currencyRate` |
| `getBankTransactions` | BankTransactions | Nearly every check; Turnover; statement-matching | `type, status, date, total, lineItems, isReconciled` |
| `getManualJournals` | ManualJournals | **Turnover only** | `status, date, journalLines[].{lineAmount,accountCode,taxAmount}` |
| `getPayments` | Payments | unreconciled_bank_items, inactive_contacts, statement-matching cache | `status, date, amount, invoice/creditNote/prepayment/overpayment contact, batchPayment` |
| `getJournals` | Journals (ledger) | Transaction-count "journals" stat only | `journalDate` only |
| `getOrganisations` | Organisation | Lock date, VAT registration gating, Companies House | `periodLockDate, endOfYearLockDate, financialYearEndDay/Month, salesTaxBasis, registrationNumber` |
| `getAccounts` | Chart of accounts | Account-type classification feeding ~10 checks + Turnover | `code, type, _class` |
| `getBankTransfers` | BankTransfers | Statement-matching cache only (both legs excluded from every revenue/expense total) | `fromBankAccount, toBankAccount, amount, date` |
| `getTaxRates` | TaxRates | sales_tax_on_bills / purchase_tax_on_invoices direction check | `taxType, canApplyToRevenue, canApplyToExpenses` |
| `getReportBankSummary` | Reports/BankSummary | bank_balance (Xero-side balance); Insight KPI | closing balance per account |
| `getReportBalanceSheet` | Reports/BalanceSheet | opening_balance_differences (net assets vs. filed accounts); Insight KPI | Net Assets row |
| `getReportProfitAndLoss` | Reports/ProfitAndLoss | **Turnover cross-check** (new, this session); Insight KPI | "Total Income"/"Total Turnover" row |

### 4.2 Endpoints available but NOT used — CONFIRMED

- **Items** — entirely unused.
- **TrackingCategories** — unused; no check segments by tracking category/department.
- **Fixed Asset API** (a separate xero-node API object from Accounting) — never called at all.
  `low_cost_fixed_assets`/`capital_item_review` are derived purely from `Accounts.type === 'FIXED'`
  plus invoice/bank line items — Xero's real Fixed Asset register is never touched.
- **Purchase Orders, Quotes, Expense Claims/Receipts, LinkedTransactions, RepeatingInvoices,
  Employees, Currencies, BrandingThemes, ContactGroups, Budgets** — all unused.
- **Prepayments/Overpayments as standalone endpoints** — unused; only the embedded
  `payment.prepayment`/`payment.overpayment` sub-objects and the `SPEND/RECEIVE-
  PREPAYMENT/OVERPAYMENT` BankTransaction types (already covered by the statement-matching
  type set) are read.
- **History/Notes endpoints beyond Invoice** (`getContactHistory`, `getCreditNoteHistory`,
  `getBankTransactionsHistory`, `getManualJournalsHistory`, `getPaymentHistory`, etc.) — unused.
  Only `getInvoiceHistory` is called, and only for documents inside a detected duplicate-draft
  cluster.
- **Attachments endpoints** (all objects) — unused. `undocumented_bills` relies solely on the
  boolean `hasAttachments` flag already present on the Invoice object; it never calls an
  Attachments endpoint to verify what's actually attached.
- **BatchPayments as a standalone list call** — unused; reconstructed instead from the
  `batchPayment` sub-object on each Payment (so a batch with zero returned member Payments would
  never surface).
- **`getReportAgedReceivablesByContact`/`AgedPayablesByContact`, `getReportTrialBalance`,
  `getReportExecutiveSummary`, `getReportBudgetSummary`** — all unused. Notably, Aged
  Receivables/Payables would be a natural Xero-native alternative to the hand-rolled
  `old_unpaid_invoices`/`old_unpaid_bills` checks; this app reconstructs aging from raw Invoices
  instead (see Section 5).
- `getUser(s)`, CIS-settings endpoints, `getOrganisationActions` — unused.
- Every `create*`/`update*`/`delete*` write endpoint — unused, and could not work regardless: the
  OAuth scopes requested (`xeroClient.js`) are all `.read` scopes.

---

## 5. Xero Report API vs. raw transactions — where each is used

CONFIRMED (agent investigation, cross-checked against code):

| Figure | Source | Notes |
|---|---|---|
| **Turnover** | Both — raw multi-source calc **and** Reports/ProfitAndLoss, deliberately cross-checked | The one place in the codebase where raw and report-derived numbers are reconciled against each other and a mismatch surfaced (`turnover_pl_mismatch`). Report is treated as authoritative when they disagree. Skipped when the period exceeds 365 days (Xero's report hard limit). |
| **bank_balance** | Reports/BankSummary only | The "current"/actual balance always comes from this report — never a raw bank-account balance field, never derived from raw BankTransaction volume (explicit code comment: "must never fall back to unreconciled volume, which counted the same money twice"). The "expected" side is always external evidence (a statement CSV or accountant entry), never Xero data at all. |
| **opening_balance_differences** | Reports/BalanceSheet only | Net assets "as of" each Companies-House filing date, compared against the figure read from the filed statutory accounts (iXBRL) or entered manually. No raw transaction data used for either side. |
| **old_unpaid_invoices / old_unpaid_bills** | Raw Invoices/Bills only | Xero's Aged Receivables/Payables report endpoints are never called; aging is computed client-side from each document's own `date` + `amountDue`, entirely independent of the report-based checks above. |
| Everything else (duplicates, multi-account/tax, tax-missing, misallocated, unexpected, unapproved, contact checks) | Raw entities exclusively | No report-endpoint counterpart exists for any of these. |

A separate, previously undocumented finding: **`src/services/insightSync.js`** is an isolated
"Insight KPI" dashboard-display path (monthly P&L trend, cash movements, Corp Tax estimate,
Balance Sheet KPIs) that also calls Reports/ProfitAndLoss, Reports/BankSummary, and
Reports/BalanceSheet — but for different date ranges/purposes than the scored checks above, and
with **no cross-validation** against them. It runs once, as the last step of every full sync, and
its own failure is caught and logged as non-fatal so it never blocks a sync. STRONGLY INDICATED
this is purely a display-layer computation with no bearing on check correctness or the health
score.

---

## 6. The 29 checks — pointer summary

Full detail (data source, statuses, date logic, thresholds, and verbatim Xenon-evidence comments
for every one of the 29 checks) is already documented in **`XENON_PARITY_SPEC.md`**'s check
registry table, cross-referenced with live per-client results in **`XENON_PARITY_MATRIX.md`**. Key
points not to lose:

- 9 checks are EXACT or near-EXACT against Xenon on every client currently compared (duplicate
  invoices/bills, old sales/purchase credits, invoice/bill-or-direct, low-cost fixed assets, most
  tax-direction checks).
- Nearly every remaining MISMATCH row has a written, evidence-backed explanation already on file —
  overwhelmingly either (a) date drift, since the Xenon exports are ~1 month old relative to live
  data, or (b) Xenon's own hidden review state (dismissed findings, "Mark as OK") which the Xero
  API cannot see at all.
- Two checks (`opening_balance_differences`, `unprocessed_bank`) live in `statementEvidence.js`,
  not the main check block in `xeroSync.js`.
- One structural note this pass surfaced: `bank_balance` is computed in **two places** in
  `xeroSync.js` — an inline legacy block, then superseded later in the same sync run by
  `recomputeEvidenceIssues` (which persists last and wins). The inline version is effectively
  dead-code-adjacent. Not a correctness bug (the final persisted value is right), but worth
  cleaning up so a future reader doesn't assume the first block is the live path.
- `RBC Sutherland` and `Julia Kuisma Ltd` have **no stored Xenon comparison at all** — any parity
  claim about those two specific clients is unresolved, not verified-clean, per
  `XENON_PARITY_SPEC.md`'s own Phase 5 note.

---

## 7. Duplicate-counting risk analysis

CONFIRMED, no monetary double-count found in the raw-transaction aggregation:

- **Payments vs. BankTransactions vs. Invoices**: Xero's own data model keeps these mutually
  exclusive object types — an invoice settled by any method (including bank transfer) is recorded
  as a `Payment` referencing the Invoice, never as a second standalone `BankTransaction` with its
  own revenue-coded line items. Since the Turnover calculation and every check only reads
  `line.accountCode` off Invoice/CreditNote/BankTransaction/ManualJournal line items — and a
  Payment object carries no line items of its own — a Payment can never contribute to a revenue
  total in the first place. This makes the most obvious double-count scenario (invoice revenue
  counted once via the invoice, again via its bank settlement) structurally impossible under normal
  Xero data.
- **`total_transactions`**: Journals are deliberately excluded from this sum, with an explicit,
  evidence-backed comment in the code (a prior bug where including them double- to 100×-counted
  activity already summed via invoices/bills/bank/credit-notes, confirmed against a 16-client
  comparison). Payments are also never added to this sum.
- **Bank transfers**: both legs of an inter-account transfer are explicitly excluded from every
  revenue/expense total and from the statement-matching candidate pool (a dedicated comment
  explains why: including both `getBankTransfers` legs and Xero's own
  `SPEND-TRANSFER`/`RECEIVE-TRANSFER` bank transaction records would double-represent the same
  movement).
- **NEEDS VERIFICATION (a client-bookkeeping-error edge case, not a code flaw)**: if a client's own
  bookkeeper manually double-enters a sale — both invoicing it AND separately logging its bank
  receipt as unlinked cash income, instead of reconciling the bank line against the invoice's
  Payment — Turnover would count it twice. This is a genuine data-quality risk in the client's Xero
  file, not a flaw in this app's aggregation logic, and no check currently flags this specific
  pattern (invoice + unlinked same-amount/contact/date bank receive on the same revenue account).
  Worth considering as a future data-quality check if the practice wants a guard against it.
- A related non-monetary finding: the statement-matching **evidence cache** (used only for bank
  reconciliation UI display, not for any financial total) can legitimately hold two separate
  candidates for the same real bank movement — a Payment-side candidate and a BankTransaction-side
  candidate — when both happen to exist for the same event. This doesn't inflate any total (nothing
  sums the candidate pool), but could theoretically let two different imported statement lines each
  claim one of the two candidates for what's really one bank movement. Flagged as NEEDS
  VERIFICATION — no evidence found that this actually happens in practice, since Payments and
  BankTransactions are normally mutually exclusive per the point above.

---

## 8. FreeAgent vs. Xero — parity between the two integrations

This app has two accounting-system integrations meant to reproduce the same Xenon-parity checks:
Xero (`xeroSync.js`, mature, all 29 checks + Turnover) and FreeAgent (`freeagentSync.js` +
`freeagentAdapter.js`, documented in-repo as "Stage 1", 11 of 29 checks).

**9 of 11 shared checks are logic-identical** between the two (duplicate_invoices, duplicate_bills,
old_unpaid_invoices, old_sales_credits, old_unpaid_bills, unapproved_invoices, unapproved_bills,
undocumented_bills — same filters, same windows, same thresholds).

**Genuine rule difference found — `duplicate_contacts` (CONFIRMED):** Xero's version restricts the
scan to contacts flagged `isCustomer || isSupplier`; FreeAgent's version scans **every** active
contact, because FreeAgent's contact model has no equivalent customer/supplier flag at all (the
adapter never sets those fields — they're silently absent, not defaulted). This is a real
behavioral gap that will make FreeAgent's duplicate-contact counts diverge from what a
customer/supplier-scoped implementation (i.e. Xenon, per the Xero-side spec) would report — not
just a "not yet built" gap.

**Labeling inconsistency (CONFIRMED, cosmetic not logical):** `unapproved_invoices`,
`unapproved_bills`, and `undocumented_bills` compute the exact same date window on both sides
(`sinceLD === inPeriod`, confirmed identical), but persist a different `period_checked` string —
Xero always writes the literal `'since_lock_date'`, FreeAgent writes the resolved `period.key`.
Same underlying data, different label — could cause inconsistent grouping/display text between the
two integrations even though nothing is actually wrong.

**Turnover — CONFIRMED still has the exact bug the Xero side just had fixed.** FreeAgent's
turnover calculation (`freeagentSync.js:374-376`) is unchanged: `sum of subTotal for
AUTHORISED/PAID ACCREC invoices`. It has none of the fixes just shipped for Xero: no account-type
classification (FreeAgent never fetches or classifies a chart of accounts at all — the structural
reason 6 other checks also have no FreeAgent equivalent), no currency conversion, no credit-note
netting, no bank-revenue inclusion (FreeAgent doesn't fetch bank transactions at this stage), no
manual-journal inclusion, and no P&L cross-check. This was already scoped as follow-up work earlier
in this engagement (split fix: ship currency conversion + credit-note netting now since those don't
need FreeAgent's own classification system solved first; defer account-classification mapping
separately) — this investigation independently confirms that scoping is still correct and the work
is still outstanding.

**Documented, structural (not hidden) gaps** — 18 of Xero's 29 checks have no FreeAgent
implementation at all, because they depend on data FreeAgent doesn't expose yet in this
integration stage: bank transactions/reconciliation (bank_balance, unreconciled_bank_items),
chart-of-accounts classification (multi_account/tax_suppliers, misallocated_items,
unexpected_account/tax_used, capital_item_review, low_cost_fixed_assets, purchase/sales_tax_missing
and _on_bills/_on_invoices), and Xero-only concepts (old_purchase_credits — FreeAgent's credit
notes are sales-side only; contact_defaults — FreeAgent contacts carry no default account/tax
fields). All of this is already clearly documented in-code (`freeagentSync.js`'s top-of-file
comment), not hidden.

---

## 9. Sync / cache mechanics and data-freshness findings

CONFIRMED:

- **Incremental sync**: `ifModifiedSince` is set to the cached watermark minus 5 minutes (overlap
  guard against races), and a full unfiltered refetch is forced automatically every
  `XERO_FULL_REFRESH_DAYS` (default 7). `organisation`, `account`, `tax_rate`, and `bank_transfer`
  always force a full refresh regardless of this cadence — they're small, settings-like datasets
  refetched wholesale every sync.
- **Pagination**: page-number based for most entities (Xero's 100-per-page limit, 1-second delay
  between pages for rate-limit compliance); **offset-based** for Journals specifically (by
  JournalNumber, with a safety check against an offset that fails to advance); no pagination at all
  for Accounts/TaxRates (Xero returns the full set in one call). A shared `getAllPages` helper
  exists in `xeroClient.js` but is dead code — every fetch-all function reimplements its own page
  loop inline instead of using it.
- **Rate limiting / retry**: up to 6 attempts per call, honours Xero's `Retry-After` header
  verbatim for 429s, exponential backoff with jitter otherwise, every call additionally wrapped in
  a 45-second timeout that manufactures a synthetic transient error if a connection truly stalls.
- **Entity cache staleness — NEEDS VERIFICATION / theoretical, not proven to occur in practice**:
  stale-row deletion from the local cache (`mergeEntityCache`) only runs on a **full** refresh —
  an incremental sync is upsert-only and never deletes a row. In practice this is very likely safe:
  a status change to VOIDED/DELETED is itself an update to Xero's own `UpdatedDateUTC` for every
  affected entity type, so it should come back within the normal incremental `ifModifiedSince`
  window and get corrected in place via upsert, not require deletion. But there is no code path
  that treats "this entity no longer appears in a modified-since scan" as informative on its own —
  deletion detection relies entirely on the periodic 7-day full refresh. If Xero's own
  `UpdatedDateUTC` guarantee were ever to not hold for some edge case, a stale row could persist
  for up to 7 days. Worth a synthetic test (void a document in a sandbox org, confirm it's corrected
  on the very next incremental sync) if this is a priority to close out definitively.

---

## 10. Recommended investigation tests still required

Genuine unknowns, not yet resolvable from code alone:

1. **Live Xenon black-box testing** (scenario A–H from the original brief: invoice-only, invoice
   + payment, bill, manual journal, bank transaction, credit note, expense, refund) — this
   requires actual Xenon access, which was explicitly out of scope for this pass. Would sharpen
   several STRONGLY INDICATED findings in `XENON_PARITY_SPEC.md` to CONFIRMED.
2. **Void-in-sandbox test** for the entity-cache staleness question in Section 9 — create a
   document, sync, void it in Xero, confirm it's corrected on the very next incremental sync
   without waiting for a full refresh.
3. **Fresh Xenon exports** for the 5 already-compared clients (4X4, Handymanz, Fast Track, Rose,
   MBX) — `XENON_PARITY_MATRIX.md` is dated 2026-09-07; a same-day comparison would separate
   genuine rule drift from ordinary trading activity for the remaining MISMATCH rows.
4. **RBC Sutherland and Julia Kuisma Ltd** have never had a Xenon export entered at all — any
   parity claim about those two clients specifically is unresolved.
5. **FreeAgent live sandbox testing** — the FreeAgent status-mapping tables
   (`INVOICE_STATUS_MAP`/`BILL_STATUS_MAP` in `freeagentAdapter.js`) were built from FreeAgent's
   documented status list, not validated against live sandbox data per the code's own comment.
