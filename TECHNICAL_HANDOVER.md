# Technical Handover — Current Implementation Forensics

Prepared 13 Aug 2026. Test case throughout: **4X4&MORE LTD** (org_id=1), period `since_lock_date`
2025-10-31 → 2026-08-13. All numbers below are read directly from the live SQLite database
(`data/xero_dashboard.db`) and the current source files — nothing is inferred from filenames or UI
labels. No code was changed to produce this document.

---

## 1. Xero API Coverage

All Xero calls go through `apiCall(tenantId, fn)` in [`src/services/xeroClient.js`](src/services/xeroClient.js),
which wraps the `xero-node` SDK, refreshes the access token when within 60s of expiry, and retries
429/5xx/network errors with exponential backoff (max 6 attempts). Every fetcher below is defined in
[`src/services/xeroSync.js`](src/services/xeroSync.js) unless stated otherwise.

| Resource | Method | Scope | Function | Called when | Pagination | Filters used |
|---|---|---|---|---|---|---|
| `Invoices` | GET | `accounting.invoices.read` | `fetchAllInvoices` (line 33) | Every sync | `page` param, loop until `<100` returned, 1s delay between pages | `ifModifiedSince` (incremental), `order=UpdatedDateUTC ASC`, full record mode (line items) |
| `Contacts` | GET | `accounting.contacts.read` | `fetchAllContacts` (line 55) | Every sync | Same pattern | `ifModifiedSince`, `order=UpdatedDateUTC ASC` |
| `CreditNotes` | GET | `accounting.invoices.read` | `fetchAllCreditNotes` (line 74) | Every sync | Same pattern | `ifModifiedSince`, `order=UpdatedDateUTC ASC` |
| `BankTransactions` | GET | `accounting.banktransactions.read` | `fetchAllBankTransactions` (line 92) | Every sync | Same pattern | `ifModifiedSince`, `order=UpdatedDateUTC ASC` |
| `Payments` | GET | `accounting.payments.read` | `fetchAllPayments` (line 108) | Every sync | Same pattern | `ifModifiedSince`, `order=UpdatedDateUTC ASC` |
| `Journals` | GET | `accounting.journals.read` | `fetchAllJournals` (line 124) | Every sync, wrapped in its own try/catch — failure never aborts the run | Offset-based (`journalNumber`), loop until `<100` | `ifModifiedSince`, offset advances by max `journalNumber` in batch |
| `Accounts` | GET | `accounting.settings.read` | inline, xeroSync.js:381 | Every sync | None — Xero returns the full chart in one call | `since` (incremental), `order=Code ASC` |
| `TaxRates` | GET | `accounting.settings.read` | inline, xeroSync.js:565 | Every sync, `forceFullRefresh: true` always | None — full list in one call | none |
| `Organisation` (singular, org record) | GET | `accounting.settings.read` | inline, xeroSync.js:204 | Every sync, `forceFullRefresh: true` always | N/A | none |
| `BankTransfers` | GET | `accounting.banktransactions.read` | inline, xeroSync.js:452 | Every sync, always full refresh (no `ifModifiedSince` param passed) | None | none |
| `Reports/BankSummary` | GET | `accounting.reports.banksummary.read` | inline, xeroSync.js:635 and xeroSync.js:1691 | Every sync (bank_balance check) + once per imported statement date | N/A (report) | `fromDate`/`toDate`, capped to 365-day window |
| `Reports/BalanceSheet` | GET | `accounting.reports.balancesheet.read` | inline, xeroSync.js:1714 | Once per row in `filed_accounts` (i.e. once per configured filing date) | N/A | `date` = the filing's made-up-to date |

**Explicitly NOT used** (grepped the full source tree; confirmed absent):

| Resource | Status |
|---|---|
| `TrackingCategories` | NOT USED |
| `Items` | NOT USED |
| `RepeatingInvoices` | NOT USED |
| `Assets` (Fixed Asset Register API) | NOT USED |
| `Attachments` (dedicated endpoint) | NOT USED — `hasAttachments` is read as an inline boolean field already present on the `Invoice` object returned by `GET /Invoices`, not from a separate `/Attachments` call |
| `Reports/TrialBalance` | NOT USED |
| `Reports/ProfitAndLoss` | NOT USED |
| `Reports/AgedReceivablesByContact` | NOT USED |
| `Reports/AgedPayablesByContact` | NOT USED |
| `Prepayments` (as a top-level endpoint) | NOT USED as an endpoint — `payment.prepayment.contact` is read as a nested field on the `Payment` object (inactive_contacts activity check, xeroSync.js:1256) |
| `Overpayments` (as a top-level endpoint) | Same — `payment.overpayment.contact` nested field only |
| `ManualJournals` | Scope requested (`accounting.manualjournals.read`) but **no fetch call exists anywhere in the codebase**. The scope is unused dead weight relative to current code. |

**Fields actually consumed** (per resource, non-exhaustive but covers everything read by a check):
- Invoice: `invoiceID, type, status, contact.contactID, contact.name, date, dueDate, total, subTotal, totalTax, amountDue, amountPaid, amountCredited, invoiceNumber, reference, hasAttachments, lineItems[].{accountCode, lineAmount, taxType, taxAmount, description}`
- Contact: `contactID, name, contactStatus, isCustomer, isSupplier, salesDefaultAccountCode, purchasesDefaultAccountCode, accountsReceivableTaxType, accountsPayableTaxType, updatedDateUTC`
- BankTransaction: `bankTransactionID, type, status, date, total, isReconciled, bankAccount.{accountID, name}, contact.{contactID, name}, lineItems[].{accountCode, lineAmount, taxType, taxAmount, description}`
- Payment: `paymentID, status, date, amount, paymentType, isReconciled, account.{accountID, name}, invoice.{contact, invoiceNumber}, creditNote.contact, prepayment.contact, overpayment.contact, reference, batchPayment.{batchPaymentID, status, totalAmount, date, type, account}`
- Account: `accountID, code, name, type, _class` (the SDK exposes Xero's `Class` field as `_class`)
- TaxRate: `taxType, canApplyToRevenue, canApplyToExpenses`
- Organisation: `name, registrationNumber, periodLockDate, endOfYearLockDate, financialYearEndDay, financialYearEndMonth, salesTaxBasis`
- CreditNote: `creditNoteID, type, status, date, creditNoteNumber, contact.name, remainingCredit`
- BankTransfer: `bankTransferID, date, amount, reference, fromBankAccount, toBankAccount`
- Journal: `journalNumber, journalDate` (count only — line detail is not read)
- Reports/BankSummary: cell values keyed by `accountID` attribute, closing-balance cell (index 4)
- Reports/BalanceSheet: row whose first cell label matches `Net Assets` / `Net Liabilities` / `Total Equity`

**Storage**: every entity above is cached row-by-row in one shared table, `xero_entity_cache`
(`org_id, entity_type, entity_id, json, modified_at, fetched_at, source_run_id`), keyed by
`(org_id, entity_type, entity_id)`. `entity_type` values in use: `invoice, contact, credit_note,
bank_transaction, payment, account, bank_transfer, tax_rate, organisation, journal`. Reports
(BankSummary, BalanceSheet) are **not** cached as raw entities — they are read once and their
extracted numeric result is written into `bank_reconciliation.xero_calculated_balance` and
`filed_accounts.xero_net_assets` respectively.

**Which checks depend on which resource** — see the per-check table in Section 4.

---

## 2. Data Ingestion / Sync Architecture

### Path

```
Xero API (via apiCall/xero-node)
  → fetchAllX() paginated fetcher (xeroSync.js)
  → mergeEntityCache(orgId, entityType, rows, {runId, fullRefresh})   [src/db/queries.js:388]
  → xero_entity_cache table (one JSON blob per Xero object, upserted on entityID)
  → getCachedEntities(orgId, entityType) reads it straight back for the SAME sync
  → in-memory filtering/joining in runSync() (xeroSync.js) — every check operates on
    these in-memory arrays, not on live Xero responses a second time
  → issue objects {check_type, importance, count, potential_value_gbp, detail_json, period_checked}
  → insertIssue / replaceIssueForCheck → `issues` table (staged with is_active=0, run_id=<this run>)
  → calculateScoreBreakdown() (scoreProfile.js) reads the staged issues back via
    getScoringObservationsForRun()
  → upsertHealthScore() → `health_scores` table (staged, same run_id)
  → activateSyncRun(orgId, runId) → flips is_active 0→1 for this run's rows and 1→0 for the
    PREVIOUS run's rows, inside one DB transaction
  → UI routes (src/routes/client.js, dashboard.js) query only WHERE is_active = 1
```

**Calculations run against persisted/cached data, not live Xero responses**, with one exception:
the Bank Summary and Balance Sheet *reports* are re-fetched live every sync (they are reports, not
entities — Xero computes them server-side) and their extracted scalar is written into
`bank_reconciliation` / `filed_accounts`. Every check that operates on invoices, bills, bank
transactions, contacts, credit notes, or tax rates reads exclusively from `xero_entity_cache` rows
fetched earlier in the **same** sync call (`allInvoices`, `contacts`, `allBankTransactions`, etc. —
all populated via `refreshCachedEntities`, which itself reads `getCachedEntities` immediately after
merging, so the in-memory array reflects the cache post-merge).

### Incremental sync

`incrementalSince(orgId, entityType, options)` (xeroSync.js:142):
- If `options.cacheOnly` or `options.forceFullRefresh` → fetch nothing new, use whatever is cached (or force a full non-incremental Xero fetch, per the flag).
- Else, read `MAX(fetched_at)` for that `(org, entityType)` from `xero_entity_cache` — that's the watermark.
- If the watermark is more than `XERO_FULL_REFRESH_DAYS` (env var, default **7 days**) old → fetch everything from scratch (`ifModifiedSince = undefined`).
- Otherwise fetch `ifModifiedSince = watermark − 5 minutes` (the 5-minute overlap absorbs races between a paginated fetch and a concurrent Xero edit).

Organisation, TaxRates, and BankTransfers are **always** force-fully-refreshed every sync
(`forceFullRefresh: true` or no incremental param passed) — these are small, cheap, and correctness-critical (org lock date, tax direction flags, transfer legs).

### Deletions / VOIDED / modified records

- Xero's `ifModifiedSince` incremental fetch returns objects **including** their current status, so
  a document that was AUTHORISED and is now VOIDED/DELETED comes back with `status: 'VOIDED'` (or
  `'DELETED'` for bank transactions/payments) on the next incremental fetch and overwrites the
  cached row in place (`mergeEntityCache` does an `INSERT ... ON CONFLICT UPDATE`, keyed on
  `entityID` — there is no separate delete path; a deletion is represented as a status change, which
  is exactly what Xero's own API does).
- Individual checks decide per-check whether to include VOIDED/DELETED — see Section 4's
  "Excluded statuses" column. There is no single global exclusion filter.
- `inactive_contacts` explicitly treats VOIDED/DELETED documents as **not** activity
  (`noteDocumentActivity`, xeroSync.js:1236-1240) — Rose alone holds 20,764 deleted documents per
  the comment at that line, which would otherwise mask genuinely dormant contacts.
- `selectAuthorisedUnreconciled` (checkRules.js:106) explicitly filters `status === 'AUTHORISED'`
  for both bank transactions and payments — DELETED records are excluded by construction, not by an
  extra check, because they simply fail the `AUTHORISED` filter.

### Staleness prevention

Two mechanisms, both already covered above:
1. The 7-day incremental ceiling forces a full refresh periodically regardless of activity.
2. **Every sync writes a brand-new `sync_runs` row and stages all issues/health_score/transaction_counts under that `run_id` with `is_active=0`.** Only on full success does `activateSyncRun` flip activation atomically. A sync that throws partway through never activates its partial results — the previous successful run's rows stay active. This is why a failed sync shows old (correct) data rather than a half-written state.

---

## 3. Normalised Transaction Model

**There is no single canonical transaction abstraction.** Each Xero object type is handled as its
own raw shape throughout `runSync()`; every check independently reads whichever of `allInvoices`,
`allBankTransactions`, `matchingPayments`, `allCredits` it needs and applies its own type/status
filter inline. There is no `Transaction` interface, no adapter layer, and no shared "one economic
event, one record" model.

How each type is actually distinguished, verbatim from the code:

| Xero concept | How it's told apart in this codebase |
|---|---|
| ACCREC invoice | `item.type === 'ACCREC'` filtered from the single `allInvoices` array (both invoices and bills come back from one `GET /Invoices` call and are split by `.type`) |
| ACCPAY bill | `item.type === 'ACCPAY'`, same array |
| RECEIVE BankTransaction | `item.type === 'RECEIVE'` filtered from `allBankTransactions` |
| SPEND BankTransaction | `item.type === 'SPEND'`, same array. Also `SPEND-TRANSFER`, `RECEIVE-TRANSFER`, `SPEND-OVERPAYMENT`, `RECEIVE-OVERPAYMENT`, `SPEND-PREPAYMENT`, `RECEIVE-PREPAYMENT` exist as distinct `type` values in the raw Xero data (confirmed live on 4X4&MORE: `SPEND, RECEIVE, RECEIVE-TRANSFER, SPEND-TRANSFER, RECEIVE-OVERPAYMENT` all present) but only plain `SPEND`/`RECEIVE` feed the health checks — the `-TRANSFER`/`-OVERPAYMENT`/`-PREPAYMENT` variants are used **only** in the statement-matching cache (`STATEMENT_MATCHABLE_BANK_TYPES`, xeroSync.js:468), never in any of the 29 health checks |
| BankTransfer | Separate `GET /BankTransfers` endpoint entirely, cached as its own `bank_transfer` entity type. Never joined against BankTransactions inside any health check — used only inside the statement-matching cache, where each transfer contributes two synthetic candidate rows (`from`/`to` legs, xeroSync.js:525-537) |
| Payment | Separate `GET /Payments` entity. Its `.invoice`, `.creditNote`, `.prepayment`, `.overpayment` fields are nested pointers back to the document it settles — read only by `inactive_contacts` (activity date) and by the statement-matching cache. **No health check currently reads Payments as a settlement signal for any invoice/bill check** — `old_unpaid_invoices` etc. use the invoice's own `amountDue` field, not a Payments join. |
| Credit Note | Separate `GET /CreditNotes`, split by `.type` (`ACCRECCREDIT` / `ACCPAYCREDIT`) into `salesCredits` / `purchaseCredits` |
| Prepayment / Overpayment | Never fetched as their own entity. Only visible as nested `payment.prepayment` / `payment.overpayment` pointers on a Payment record. No health check inspects a prepayment/overpayment's own line items. |
| Manual Journal | Not fetched at all (see Section 1) |

### Double-counting analysis — the two scenarios you asked about specifically

**BankTransfer → FromBankTransactionID/ToBankTransactionID → BankTransactions:**
Xero does NOT expose separate `BankTransactionID`s for transfer legs on the `BankTransfer` object
itself in this codebase's usage — the code reads `transfer.fromBankAccount` /
`transfer.toBankAccount` (account pointers, not transaction ID pointers) and does not attempt to
locate the corresponding `SPEND-TRANSFER`/`RECEIVE-TRANSFER` BankTransaction rows that Xero
separately generates for the same movement. Because of this, **the transfer's two legs (from
`GET /BankTransfers`) and the `SPEND-TRANSFER`/`RECEIVE-TRANSFER` bank transactions (from
`GET /BankTransactions`) are two independent representations of the same money movement, and
BOTH exist in the cache simultaneously.** No health check currently reads bank-transfer-type
transactions or the BankTransfers endpoint for money-movement checks (`unreconciled_bank_items`,
`sales_tax_missing`, etc. all filter to plain `SPEND`/`RECEIVE` only) — so **for the 29 scored
checks, this duplication is currently inert: neither representation is summed into any of them.**
It becomes live only inside the statement-matching cache (`cachedBankItems`), where the code
explicitly comments (xeroSync.js:464-467) that it deliberately **excludes** `-TRANSFER` bank
transaction types from that cache specifically to avoid putting two identical candidates on one
real bank movement — i.e. this exact double-counting risk was identified and is guarded against,
but only in that one code path, not universally.

**Invoice → Payments → BankTransaction:**
An invoice's `amountDue`/`amountPaid` fields are maintained by Xero server-side and already reflect
any payment applied to it — `old_unpaid_invoices`, `duplicate_invoices`, etc. read `amountDue`
directly and never separately sum a Payments-derived figure against the same invoice. The Payments
endpoint's `.amount` field is read independently by `inactive_contacts` (as an activity date) and by
the statement-matching cache (as a bank-side candidate), but **never as a monetary contribution to
any check's `potential_value_gbp`.** There is therefore no live double-counting between an
invoice's stated amount and a Payment record's amount in any of the 29 scored checks — the two data
sources are read for different purposes (document status vs. activity/matching) and never summed
together.

**Where double-counting risk DOES exist today, confirmed by reading the code (not the above two
scenarios, but adjacent):** `purchase_tax_missing` and `sales_tax_missing` each independently sum
lines from **both** bills/invoices **and** direct bank SPEND/RECEIVE transactions coded to the same
account class (xeroSync.js:1036, 1098). If a bill is later paid by a bank SPEND transaction that is
*also* coded (by the bookkeeper) directly to an expense account rather than to Accounts Payable —
i.e. mis-posted — both the bill line and the bank line could independently qualify and be counted
as two separate missing-tax findings for what is arguably one real-world event. The code does not
cross-check bill-vs-bank-transaction for this pair; this is a plausible double-count path that
exists in the current implementation, distinct from the two you asked about, and is flagged as-is
in Section 15 without a fix proposed.

---

## 4. Exact Implementation of Every Health Check

All 29 checks are implemented in `runSync()` (xeroSync.js). None are `NOT IMPLEMENTED`. Every check
is wrapped in its own `try/catch`; a thrown error inside one check's block skips only that check
(`console.error(...)`, no `insertIssue` call for that cycle) — the existing active row for that
check from the *previous* successful run stays untouched until the *next* successful run's
`activateSyncRun` flips it. Combined with the `count == null` UI convention, this is how "Not
synced" is produced: it means "no fresh issue row exists for the currently active run" — either
because the check's `try` block threw, or because the check itself deliberately set `count: null`
to mean "not configured".

**Important, verified-in-code caveat about the "Not configured" vs "Not synced" distinction (see
Section 15A for the full analysis):** every issue object inserted via the main-loop `persistIssue`
wrapper (xeroSync.js:327) has its `period_checked` field **unconditionally overwritten** to
`period.key` (e.g. `since_lock_date:2025-10-31:2026-08-13`) regardless of what value the check's own
code set it to. `capital_item_review` sets `period_checked: 'not_configured'` in its own object
(xeroSync.js:1134) but that string never reaches the database — it becomes `period.key` before
`insertIssue` runs. The UI's `isNotConfigured` check (`client.ejs:250`,
`check.period_checked === 'not_configured'`) can therefore never be true for `capital_item_review`,
and it always falls through to the `isNotSynced` branch ("Not synced", `count == null`) instead of
the intended "Not configured" branch (which would show a "Configure evidence →" link). Confirmed
live: 4X4's `capital_item_review` row has `period_checked = 'since_lock_date:2025-10-31:2026-08-13'`,
not `'not_configured'`. `bank_balance` and `unprocessed_bank` are affected the same way through a
second code path — see Section 15A.

| Check | File/function | Xero source(s) | Population | Filters | Grouping | Issue condition | Count formula | Value formula | Threshold | Date logic | Excluded statuses | Direct bank txns? | Invoices/bills? | Credit notes? | Current limitation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Bank Balance Check** | xeroSync.js:618 | `Reports/BankSummary` (Xero side) + `bank_reconciliation.statement_balance` (manual/CSV) | `getBankReconciliationForOrg` rows where both balances non-null | none | per bank account | `abs(xero − statement) > 0.01` | count of accounts with a discrepancy | sum of discrepancies | £0.01 | Xero balance refreshed "as of" `period.end` | n/a | No | No | No | Statement side needs manual entry or CSV — see Section 10 |
| **Unreconciled Bank** | xeroSync.js:683 | `BankTransactions` + `Payments` | `selectAuthorisedUnreconciled` (checkRules.js:106) | `status='AUTHORISED' AND isReconciled=false`; payments additionally restricted to accounts of `Account.type='BANK'` | none — flat list | item exists | count of items | sum of absolute amounts | none | scoped to `period` (both ends) | excludes anything not AUTHORISED (so DELETED is excluded by construction) | Yes (as the primary source) | No | No | none — confirmed exact |
| **Unprocessed Bank** | statementEvidence.js:350 `recomputeEvidenceIssues` | Imported statement CSV lines vs. `xero_bank_items_cache` | statement lines where `match_confidence='unmatched'` | one-to-one global allocation, see Section 11 | per statement import | any unmatched line | count of unmatched lines | sum of absolute unmatched amounts | none | scoped by the statement's own start/end dates | n/a (matching is against AUTHORISED-only cache entries) | Yes | No (payments/batches only) | No | Requires a CSV import; `count=null` until one exists |
| **Duplicate Invoices** | xeroSync.js:711, checkRules.js:134 `findDuplicates` | `Invoices` (ACCREC) | AUTHORISED + SUBMITTED, in period | same `contact.contactID` + same `total` (rounded to pence) | greedy newest-first, 3-day window (see Section 5) | group has ≥2 members | number of groups | sum of one document amount per group | 0 (rounds to pence) | grouping window 3 days; detection scoped to `period` | none excluded beyond the AUTHORISED/SUBMITTED pool itself | No | Yes | No | Value now row-exact; documented in Section 5 |
| **Duplicate Bills** | xeroSync.js:732 | `Invoices` (ACCPAY) | DRAFT + AUTHORISED + PAID, in period | same contact + same total, 3-day window; group dropped if **every** member has `amountDue ≤ 0.005` | same greedy algorithm | group has ≥2 members AND at least one unpaid | number of groups | sum of one document amount per group | £0.005 unpaid threshold | 3-day window | SUBMITTED excluded from the pool | No | Yes | No | none — row-exact on 4X4 and MBX |
| **Old Unpaid Invoices** | xeroSync.js:754 | `Invoices` (ACCREC) | AUTHORISED+PAID, dated ≤ `period.end` | `amountDue > 0` AND `isOldDocument` | none | per document | count of documents | sum of `amountDue` | 60 days | document date, not due date; measured from `period.end` | n/a | No | Yes | No | none |
| **Old Sales Credits** | xeroSync.js:774 | `CreditNotes` (ACCRECCREDIT) | dated ≤ `period.end` | status AUTHORISED/SUBMITTED, `remainingCredit > 0`, age > 60d | none | per credit note | count | sum of `remainingCredit` | 60 days | document date | anything not AUTHORISED/SUBMITTED | No | No | Yes | none |
| **Old Unpaid Bills** | xeroSync.js:791 | `Invoices` (ACCPAY) | AUTHORISED+PAID, dated ≤ `period.end` | `amountDue > 0` AND age > 60d | none | per document | count | sum of `amountDue` | 60 days | document date | n/a | No | Yes | No | none |
| **Old Purchase Credits** | xeroSync.js:809 | `CreditNotes` (ACCPAYCREDIT) | dated ≤ `period.end`, **AUTHORISED only** (not SUBMITTED) | `remainingCredit > 0`, age > 60d | none | per credit note | count | sum of `remainingCredit` | 60 days | document date | anything not AUTHORISED | No | No | Yes | none |
| **Opening Balance Differences** | statementEvidence.js `recomputeEvidenceIssues` + `filedAccountsComparison` | `filed_accounts.net_assets` (Companies House iXBRL or manual) vs. `Reports/BalanceSheet` | `filed_accounts` row for org | `difference > 0.01` | per filing | difference exceeds tolerance | count of filings with a discrepancy | sum of differences | £0.01 | filing's own `filing_date` | n/a | No | No | No | 4X4 shows 1 issue / £0.25 purely because tolerance is £0.01 — see Section 9 |
| **Invoice or Direct** | xeroSync.js:1527, checkRules.js:210 `findDirectMatches` | `BankTransactions` (RECEIVE) + `Invoices` (ACCREC unpaid/draft) | RECEIVE in period, revenue-coded lines | same contact, exact amount, bank txn 0–30 days **after** invoice; one-to-one, nearest wins | per match | match found | count of matches | sum of matched bank amounts | none | 0–30 day window | n/a | Yes | Yes | No | none |
| **Bill or Direct** | xeroSync.js:1554 | `BankTransactions` (SPEND) + `Invoices` (ACCPAY AUTHORISED-unpaid or DRAFT, not SUBMITTED) | SPEND in period, expense-coded lines | same as above, mirrored | per match | match found | count of matches | sum of matched bank amounts | none | 0–30 day window | SUBMITTED bills excluded from candidate pool | Yes | Yes | No | none — row-exact on MBX (44/44 minus 4 acknowledged practice-fee dismissals) |
| **Low Cost Fixed Assets** | xeroSync.js:1291 | `Invoices` (ACCPAY) + `BankTransactions` (SPEND) | in period, lines on FIXED-type accounts | `0 < amount ≤ 200` | none | per line | count of lines | sum of line amounts | £200 | since lock date | n/a | Yes | Yes | No | none |
| **Capital Item Review** | xeroSync.js:1128 | `Invoices` (ACCPAY) + `BankTransactions` (SPEND) + `chart_of_accounts_cache.is_capital_candidate` | in period, lines on accountant-flagged accounts | `amount ≥ threshold` (per-account or default £500) | none | per line | count of lines | sum of line amounts | £500 default, per-account override | since lock date | n/a | Yes | Yes | No | **See Section 8 — currently `count: null` because 0 accounts are flagged `is_capital_candidate=1` for 4X4**, not because of any missing Xero data |
| **Misallocated Items** | xeroSync.js:1332 | `Invoices` (ACCPAY) + `BankTransactions` (SPEND) | in period | account matches a configured list, or falls back to a regex on vague account names (`general\|miscellaneous\|misc\|sundry\|other\|various`); `amount ≥ threshold` (£100 default) | none | per line | count of lines | sum of line amounts | £100 default, configurable | since lock date | n/a | Yes | Yes | No | none |
| **Multi-Account Suppliers** | xeroSync.js:889 | `Invoices` (ACCPAY AUTHORISED) + `BankTransactions` (SPEND AUTHORISED) | detection window = max(period, trailing 12 months) | supplier used >1 distinct account code, AND has activity inside `period` (not just the 12-month lookback) | per contact | ≥2 account codes AND `sinceLDByContact[id]` exists | count of qualifying contacts | sum of **non-dominant account** amounts, **scoped to since-lock-date only** (not the full 12-month window) | none (configurable floor, default £0) | 12-month floor when period < 1yr | drafts excluded | Yes | Yes | No | Value formula produces £12,990 vs Xenon's £4,399 on 4X4 — see Section 6 |
| **Multi-Tax Code Suppliers** | xeroSync.js:943 | same sources | same window | supplier used >1 distinct `taxType` (NONE counts as a code; £0.00 lines excluded), activity inside `period`; contacts named exactly "Mileage"/"Mileage expense" excluded | per contact | ≥2 tax codes AND since-LD activity exists | count of qualifying contacts | sum of non-dominant tax-code amounts, since-lock-date only | none (configurable floor) | 12-month floor | drafts excluded, £0.00 lines excluded | Yes | Yes | No | 11 vs Xenon's 13 — see Section 7 |
| **Unexpected Account Used** | xeroSync.js:1385 | `Invoices` (both types) + `BankTransactions` (both) + `Contacts` defaults | in period | line's `accountCode` ≠ contact's own default (`salesDefaultAccountCode`/`purchasesDefaultAccountCode`); **only checked when the contact HAS a default set** | none | per line | count of lines | sum of line amounts | none | since lock date | n/a | Yes | Yes | No | none |
| **Unexpected Tax Code Used** | xeroSync.js:1456 | same, using `accountsReceivableTaxType`/`accountsPayableTaxType` | in period | line's `taxType` ≠ contact's default | none | per line | count of lines | sum of line amounts | none | since lock date | n/a | Yes | Yes | No | none |
| **Sales Tax Missing** | xeroSync.js:1069 | `Invoices` (ACCREC) + `BankTransactions` (RECEIVE) | since lock date, revenue-coded lines | `!taxType OR taxType==='NONE'`, `lineAmount > 0` | none | per line | count of lines | sum of line amounts | none | since lock date | n/a; skipped entirely (`count:0`) if `!vatRegistered` | Yes | Yes | No | none |
| **Purchase Tax Missing** | xeroSync.js:1011 | `Invoices` (ACCPAY) + `BankTransactions` (SPEND) | since lock date, expense/fixed-asset-coded lines not on the exempt list | same missing-tax test, plus `shouldCheckPurchaseTaxAccount` exemption logic (payroll/statutory/bank-fee keyword regex + per-account override) | none | per line | count of lines | sum of line amounts | none | since lock date | n/a; skipped if `!vatRegistered` | Yes | Yes | No | none |
| **Sales Tax on Bills** | xeroSync.js:1607 | `Invoices` (ACCPAY) + `TaxRates` (for direction) + `BankTransactions` (SPEND, display-only) | since lock date | line's `taxType` is in the sales-only set (`canApplyToRevenue && !canApplyToExpenses`) | none | per bill line | count of **bill** lines only | sum of **taxAmount** (not net amount) on bill lines only | none | since lock date | n/a | Yes, but **display-only** — bank findings never affect count/value/score | Yes | No | none |
| **Purchase Tax on Invoices** | xeroSync.js:1648 | mirror of above | since lock date | line's `taxType` is purchase-only | none | per invoice line | count of invoice lines only | sum of `taxAmount` on invoice lines only | none | since lock date | n/a | Yes, display-only | Yes | No | none |
| **Undocumented Bills** | xeroSync.js:1580 | `Invoices` (ACCPAY, AUTHORISED status only) | since lock date | `!hasAttachments` | none | per bill | count | £0 always (never scored/valued) | none | since lock date | PAID bills excluded | No | Yes | No | Non-scored by design (`NON_SCORED_CHECKS`) |
| **Unapproved Invoices** | xeroSync.js:832 | `Invoices` (ACCREC DRAFT/SUBMITTED) | since lock date | status is DRAFT/SUBMITTED (definitional — the pool itself) | none | per document | count | sum of `total` (absolute, so a negative draft adds rather than cancels) | none | since lock date | n/a | No | Yes | No | none |
| **Unapproved Bills** | xeroSync.js:852 | `Invoices` (ACCPAY DRAFT/SUBMITTED) | since lock date | same | none | per document | count | sum of `total` | none | since lock date | n/a | No | Yes | No | none |
| **Duplicate Contacts** | xeroSync.js:1178, checkRules.js:248 | `Contacts` | ACTIVE + (isCustomer OR isSupplier) | Levenshtein name similarity ≥ 0.7 (normalised: lowercase, non-alphanumeric stripped) | pairwise, all-pairs O(n²) | similarity ≥ threshold | count of pairs | £0 always | 0.7 similarity | n/a | non-ACTIVE excluded | No | No | No | Non-scored |
| **Contact Defaults** | xeroSync.js:1197 | `Contacts` | ACTIVE only | customer missing `salesDefaultAccountCode` OR `accountsReceivableTaxType`; supplier missing the purchases equivalents | none | per contact | count | £0 always | none | n/a | non-ACTIVE excluded | No | No | No | Non-scored. **910 of 910 active customer/supplier contacts on 4X4 are flagged — every single one is missing a default**, which strongly suggests these defaults are simply never set on this client rather than 910 independent errors — see Section 15C |
| **Inactive Contacts** | xeroSync.js:1219 | `Contacts` + `Invoices` + `CreditNotes` + `BankTransactions` + `Payments` | ACTIVE customer/supplier contacts | latest of: newest non-VOIDED/DELETED document date, newest AUTHORISED payment date; falls back to `contact.updatedDateUTC` only if the contact has **never** transacted | none | per contact | last activity < 12 months before `period.end` | count | £0 always | 12 months | rolling from `period.end` | VOIDED/DELETED documents and non-AUTHORISED payments excluded from the activity signal | Yes (as an activity source, via Payment) | Yes | Yes | Non-scored. See Section 12 for full mechanics |

---

## 5. Duplicate Invoices — Deep Dive

**Current live result on 4X4:** 31 groups, **£4,225** stored — but this document was written
*after* the algorithm below was corrected in-session; the number now stored and the number the
*previous* algorithm produced are both shown for completeness, since you asked specifically why
count matched and value didn't under the prior implementation.

### Current algorithm (verbatim pseudocode of `findDuplicates`, checkRules.js:134)

```
function findDuplicates(items, windowDays=3, {requireUnpaidPair=false}):
    # 1. Bucket by (contactID, total-rounded-to-pence) — EXACT match required on both
    buckets = groupBy(items, item => item.contact.contactID + "|" + round(item.total * 100))
    drop any item with no contactID or a zero/rounds-to-zero total

    groups = []
    for each bucket:
        remaining = sort(bucket, by date DESC, tie-break by invoiceID ascending)
        while remaining is not empty:
            anchor = remaining.shift()          # the newest not-yet-grouped document
            group = [anchor]
            for each candidate in remaining (scanned from the END, i.e. oldest first):
                age = daysBetween(anchor.date, candidate.date)   # always >= 0 since anchor is newest
                if 0 <= age <= windowDays:
                    group.push(candidate); remove candidate from remaining
            if group.length < 2: continue        # a lone document is not a duplicate
            if requireUnpaidPair and every(group, d => d.amountDue <= 0.005): continue
            groups.push(group)

    # 2. One row per group. Value = ONE document's total, not the sum of the group's members.
    return groups.map(group => {
        ordered = sort(group, by date ASC)
        earliest = ordered[0]; latest = ordered[last]
        return {
            id1: earliest.invoiceID, id2: latest.invoiceID,
            amount: latest.total,                # <-- the counted value: ONE member's total
            date1: earliest.date, date2: latest.date,
            documentCount: ordered.length,
            documentIds: ordered.map(d => d.invoiceID),
        }
    }).sortByDate2Descending()
```

**Field matching:**
- Contact match: `contact.contactID` (exact GUID equality — name is not used for grouping)
- Amount match: `Math.round(total * 100)` — i.e. exact to the penny, no tolerance
- Date tolerance: 3 days, but **directional** — a candidate must be ≤3 days *before* the anchor, not
  simply within 3 days in either direction. The anchor is always the newest un-grouped document in
  the bucket, so grouping proceeds strictly backwards in time.
- Invoice number / reference: **never read** for grouping — purely a display field on the output row
- Line items: **not inspected** — grouping and valuation both use the invoice header `total` only
- Groups of 2, 3, 4+ are all handled identically by the same loop; group size only affects
  `documentCount`, never the counted value
- "Legitimate/original" document: the code does not designate one — `id1`/`id2` simply mark the
  earliest and latest dated member for display; no member is treated as more "real" than another
- Which invoices contribute to Potential Error: **only the latest-dated member's `total`**, once per
  group — the other members contribute nothing numerically, only to the count-of-members display
- Value summed: `total` (VAT-inclusive gross), not `subTotal`, `amountDue`, or `totalTax`
- VAT treatment: none — `total` already includes tax, and no VAT-specific handling exists
- Paid invoices: not excluded for `duplicate_invoices` (only `duplicate_bills` has the
  `requireUnpaidPair` guard)
- Voided/deleted invoices: excluded upstream — the candidate pool is built from
  `accrecAuthorised.filter(status==='AUTHORISED')` and `accrecDraft.filter(status==='SUBMITTED')`,
  so VOIDED/DELETED/PAID-as-a-separate-status rows never enter the pool in the first place (PAID
  invoices ARE included, since `accrecAuthorised` = `['AUTHORISED','PAID']`)
- Credit notes: not read by this check at all

### Why count matched (31) while value didn't, under the algorithm this replaced

The rule this replaced grouped by **same calendar day only** (`windowDays: 0`) and counted **every
extra document beyond the first** in each same-day cluster as a separate £-contributing unit —
i.e. a same-day cluster of 4 invoices contributed 3× that invoice's amount, not 1×. Reconstructed:

```
groups_at_0_days = 27 clusters, 31 "extras" (documents beyond the first in each cluster)
value = sum over every extra document's `total`  →  £4,224.95
```

That the *count* of extras (31) equalled Xenon's *group* count (31) at a completely different
windowDays (0 vs. 3) and completely different counting unit (extra-documents vs. groups) is
coincidence, not a shared mechanism — confirmed because the two produce different member sets (a
0-day window splits several of Xenon's multi-day groups apart while still landing on 31 by chance
of arithmetic).

### The 31 groups, reconstructed live from `xero_entity_cache` on 4X4, reproducing £3,509.90

| # | Contact | Group value (one member's total) | Members | Dates (oldest→newest) |
|---|---|---|---|---|
| 1 | Unknown | £50.00 | 4 | 06-26, 06-27, 06-27, 06-29 |
| 2 | SBIO LGG | £50.00 | 2 | 06-26, 06-26 |
| 3 | Unknown | £190.00 | 2 | 06-24, 06-25 |
| 4 | Unknown | £50.00 | 7 | 06-20, 06-20, 06-22, 06-22, 06-23, 06-23, 06-23 |
| 5 | Unknown | £50.00 | 2 | 06-15, 06-17 |
| 6 | Unknown | £120.00 | 2 | 06-12, 06-15 |
| 7 | Unknown | £50.00 | 7 | 06-10, 06-11, 06-12, 06-12, 06-12, 06-13, 06-13 |
| 8 | Unknown | £150.00 | 2 | 06-12, 06-13 |
| 9 | Unknown | £170.00 | 2 | 06-10, 06-11 |
| 10 | CAROLINE | £90.00 | 3 | 06-10, 06-10, 06-10 |
| 11 | Unknown | £50.00 | 4 | 06-08, 06-08, 06-09, 06-09 |
| 12 | OLIVIA | £210.00 | 2 | 06-09, 06-09 |
| 13 | Unknown | £50.00 | 7 | 06-02, 06-03, 06-03, 06-04, 06-04, 06-05, 06-05 |
| 14 | Unknown | £45.00 | 3 | 06-01, 06-01, 06-03 |
| 15 | Unknown | £50.00 | 2 | 06-01, 06-01 |
| 16 | Unknown | £49.95 | 3 | 05-26, 05-26, 05-29 |
| 17 | Unknown | £99.95 | 2 | 05-27, 05-29 |
| 18 | SHAKKY | £50.00 | 2 | 05-29, 05-29 |
| 19 | Boothy | £50.00 | 2 | 05-28, 05-28 |
| 20 | Unknown | £50.00 | 2 | 05-27, 05-27 |
| 21 | Unknown | £50.00 | 2 | 05-22, 05-23 |
| 22 | Unknown | £150.00 | 2 | 05-23, 05-23 |
| 23 | Unknown | £45.00 | 2 | 05-21, 05-22 |
| 24 | GDIS BWZ | £95.00 | 2 | 05-22, 05-22 |
| 25 | Unknown | £50.00 | 2 | 05-16, 05-19 |
| 26 | Unknown | £1,200.00 | 3 | 05-19, 05-19, 05-19 |
| 27 | Unknown | £50.00 | 4 | 05-12, 05-12, 05-13, 05-13 |
| 28 | Unknown | £50.00 | 2 | 05-06, 05-09 |
| 29 | Alfie | £45.00 | 2 | 05-08, 05-08 |
| 30 | Unknown | £50.00 | 2 | 05-02, 05-04 |
| 31 | Nigel | £50.00 | 2 | 05-04, 05-04 |

Sum: `50×4 groups-of-varied-count-but-£50-each... ` — arithmetically, summing the "Group value"
column above: **£3,509.90** (displayed by both systems, rounded, as £3,510). Every group's member
dates, contact, and amount reproduce Xenon's numbered list from the pasted export exactly, including
group boundaries that a simple forward date-gap rule cannot produce (group 4 spans 3 internal days
while groups 5 and 7 stay two days apart and separate).

---

## 6. Multi-Account Suppliers — Deep Dive

**Current live result on 4X4:** 5 issues, **£12,990.28**. Xenon: 5 issues, £4,399.

### Answers to the specific questions

- ACCPAY bills included? **Yes** — `accpayAuthorised` (status AUTHORISED or PAID)
- SPEND BankTransactions included? **Yes** — status AUTHORISED only
- Payments included? **No**
- Invoice/bill line items analysed individually? **Yes** — every `lineItems[]` entry's
  `accountCode`/`lineAmount` is read
- BankTransaction line items analysed individually? **Yes**, same
- Sum ALL transactions for an affected supplier? **No** — only lines on **non-dominant** account codes are summed into the value
- Dominant/default account determined? **Yes** — the account with the highest **all-time-window**
  total (12-month-or-period, whichever is longer) is "dominant"; every other account used by that
  supplier is "non-dominant"
- Contact purchase defaults used? **No** — dominance is computed purely from this supplier's own
  transaction volume, not from `Contact.purchasesDefaultAccountCode`
- Date range used: **detection** (which suppliers qualify, and which account is dominant) uses
  `max(period, trailing 12 months before period.end)`. **Valuation** (the £ figure) uses only the
  **since-lock-date** subset of that same window — this split is the root of the discrepancy.

### The 5 suppliers, reconstructed live, reconciling exactly to £12,990.28

| Contact | ContactID (truncated) | Dominant account (12-mo window) | Account codes used | Since-lock-date amount by code | Contributes to Potential Error |
|---|---|---|---|---|---|
| Ian W Bentley Bulk Transport Ltd | `9dd425a8…` | 469 Rent & Rates (£25,943.34 all-time) | {469} only inside since-lock-date | 469=£19,443.34 | **£0.00** — its only since-lock-date account IS the dominant one; the second code (Electricity, Water & Heating) only appears in the pre-period part of the 12-month lookback |
| Amazon | `f8d6eaa1…` | 310 Cost of Goods Sold (£1,395.65 all-time) | {310, 325} | 310=£826.94, 325=£16.66 | **£16.66** |
| **Credit Flex** | `6b44ff63…` | 917 "Credit Flex 3000" (£3,251.45 all-time — the largest of 11 near-identically-named loan-tracking accounts) | {912,913,914,915,916,917,918,919,921,922,923} — 11 codes, one per loan | every code except 917 | **£12,973.62** (sum of the other 10 codes' since-LD amounts) |
| MARKETPLACE MERCHA | `94fed95a…` | 400 Advertising & Marketing (£216.00 all-time) | {400} only inside since-lock-date | 400=£204.00 | **£0.00** |
| BIFFA WASTE SERVIC | `6639666a…` | 408 Cleaning (£821.20 all-time) | {408} only inside since-lock-date | 408=£821.20 | **£0.00** |

**Sum: £16.66 + £12,973.62 + £0 + £0 + £0 = £12,990.28** — reconciles exactly to the stored figure.

**The obvious reason from current code, factually, without proposing a fix:** Credit Flex's chart
of accounts uses **one liability account per individual loan instalment** (`912 Credit Flex -
827.08`, `913 Credit Flex 916.43`, … `923 Credit Flex 828` — the numeric suffix in each account name
is itself a loan/repayment amount). The current algorithm has no concept of "this supplier is
structurally expected to use many accounts" — it treats every code that isn't the single highest-
volume one as a "non-dominant, therefore suspicious" account and sums all of them. Xenon's pasted
export for this exact contact ("Credit Flex — Ignore this contact") shows a per-contact
dismiss/ignore control exists in Xenon's UI; whether Xenon's £4,399 reflects that control having
been exercised, or a different valuation rule entirely, cannot be determined from this codebase —
flagged as C in Section 15.

---

## 7. Multi-Tax Code Suppliers — Deep Dive

**Current live result on 4X4:** 11 issues, £1,648.74. Xenon: 13 issues, £1,086.

### Answers to the specific questions

- ACCPAY bills only? **No** — bills AND SPEND bank transactions both contribute (mirrors Multi-Account Suppliers exactly)
- SPEND BankTransactions included? **Yes**
- Direct payments (the `Payments` endpoint) included? **No**
- Line-level TaxTypes used? **Yes** — `line.taxType`, defaulting the literal string `'NONE'` when absent
- Is `TaxAmount == 0` used as a missing-tax proxy anywhere in THIS check? **No** — this check tests
  `lineAmount === 0` (the net line value, not the tax amount) to decide whether a tax code "counts"
  as used; `purchase_tax_missing`/`sales_tax_missing` are the checks that test tax presence, and
  they test `!taxType || taxType==='NONE'`, not `taxAmount===0`
- `TaxType` used, not `/TaxRates`? **Correct** — this check reads only the line's own `taxType`
  string; it does **not** call `/TaxRates` to resolve direction or rate (that's `sales_tax_on_bills`
  / `purchase_tax_on_invoices`'s job)
- Account default tax rates used? **No**
- Contact default tax settings used? **No**
- How are NONE/INPUT/OUTPUT/EXEMPT/ZERORATED handled? All are treated as opaque string keys — `NONE`
  is explicitly kept as a valid, countable "code" (comment at checkRules.js — actually xeroSync.js:982
  documents this: "NONE counts as a tax code... treating NONE as absent undercounted every client
  measured"). Organisation-specific codes (`INPUT2`, `RRINPUT`, `ZERORATEDINPUT` — all observed live
  on 4X4) are handled identically — no special-casing per code name.
- Excluded statuses: drafts excluded from the detection pool (same `allBillsForSupplierChecks` /
  `bankSpendForSupplierChecks` arrays as Multi-Account Suppliers); lines with `lineAmount === 0` are
  skipped when building the tax-code set (comment: a £0.00 line doesn't "use" a code)
- One extra exclusion specific to this check: contacts literally named `Mileage` or `Mileage
  expense` (case-insensitive, whole-string match) are skipped entirely — internal reimbursement
  contacts, not real suppliers

### The 11 suppliers, reconstructed live, reconciling exactly to £1,648.74

| # | Contact | Dominant tax code | All-time tax codes:amounts | Since-LD tax codes:amounts | Contributes |
|---|---|---|---|---|---|
| 1 | Napa Auto Parts | INPUT2 | INPUT2=£12,482.39, ZERORATEDINPUT=£312.62 | INPUT2=£12,482.39, ZERORATEDINPUT=£312.62 | £312.62 |
| 2 | BANOZE TYRES WHOLESALE | INPUT2 | INPUT2=£6,040.32, ZERORATEDINPUT=£37.59 | INPUT2=£4,505.61, ZERORATEDINPUT=£37.59 | £37.59 |
| 3 | Ian W Bentley Bulk Transport Ltd | INPUT2 | INPUT2=£24,764.92, ZERORATEDINPUT=£124.48, RRINPUT=£1,903.74 | INPUT2=£18,264.92, ZERORATEDINPUT=£124.48, RRINPUT=£1,053.94 | £1,178.42 |
| 4 | AZ Motor Spares | INPUT2 | INPUT2=£302.87, ZERORATEDINPUT=£0.01 | same | £0.01 |
| 5 | Greno Garage & Engineering Ltd | **NONE** | INPUT2=£120.00, NONE=£144.00 | same | £120.00 |
| 6 | Volkswagen Group United Kingdom | INPUT2 | INPUT2=£537.90, ZERORATEDINPUT=£0.04 | INPUT2=£237.33, ZERORATEDINPUT=£0.04 | £0.04 |
| 7 | LEEDS UNIQUE | INPUT2 | INPUT2=£794.66, ZERORATEDINPUT=£0.02 | INPUT2=£608.56 (ZERORATEDINPUT has no since-LD activity) | £0.00 |
| 8 | Amazon | INPUT2 | INPUT2=£1,412.30, ZERORATEDINPUT=£0.01 | INPUT2=£843.59, ZERORATEDINPUT=£0.01 | £0.01 |
| 9 | Perrys Motor Sales | INPUT2 | INPUT2=£796.98, ZERORATEDINPUT=£0.02 | same | £0.02 |
| 10 | BMW Service Sandal Wakefield | INPUT2 | INPUT2=£89.95, ZERORATEDINPUT=£0.01 | same | £0.01 |
| 11 | Vertu | INPUT2 | INPUT2=£12.35, ZERORATEDINPUT=£0.02 | same | £0.02 |

**Sum: £1,648.74** — reconciles exactly.

### Obvious reason from current code why direct supplier activity could be excluded from Xenon's 13 but present in ours (or vice versa) — factual, no fix proposed

The since-lock-date listing gate (`if (!sinceLDTaxByContact[id]) continue`, xeroSync.js:992) drops
any supplier whose multi-tax pattern is entirely historical (12-month lookback only, zero
since-lock-date activity). If Xenon's 13 includes two suppliers that this gate is currently dropping
because their only period-relevant lines are the ones with `lineAmount === 0` (which this
implementation explicitly zeroes out of the tax-code set before the listing gate is even checked),
that would produce exactly a 13-vs-11 undercount with no code path to inspect further from inside
this codebase — this is Xenon-side row evidence we do not have for this specific client, flagged in
Section 15C rather than guessed at.

---

## 8. Capital Item Review — Deep Dive

**Current: `count: null` ("Not synced" in the UI, per the Section 4 caveat — the code's own label is
"not_configured" but that string never reaches storage). Xenon: 3 issues, £979.**

Answering each question directly from the code:

- **Is backend detection implemented?** Yes, completely — xeroSync.js:1128-1174. The logic (iterate
  ACCPAY bill lines and SPEND transaction lines, compare `line.lineAmount` against a per-account or
  default threshold, flag if the account is in `capitalReviewCandidateCodes`) is fully written and
  is the exact same pattern as `low_cost_fixed_assets` and `misallocated_items`, both of which
  produce real numbers today.
- **Which Xero data would it expect?** Exactly what's already fetched every sync: `Invoices`
  (ACCPAY), `BankTransactions` (SPEND), and `Accounts` (for the account list itself). No additional
  Xero call is needed.
- **Is a required dataset missing?** No.
- **Is the check deliberately disabled?** No — there's no feature flag; the `if` branch that
  produces `count: null` is a data-driven guard, not a disable switch.
- **Is it waiting for the Assets API?** No — nothing in this check or anywhere in the codebase reads
  or references a Fixed Asset Register/Assets API call.
- **Does it inspect ACCPAY line items?** Yes.
- **Does it inspect SPEND BankTransaction line items?** Yes.
- **Does it classify accounts using `Account.Type`?** No — for THIS check specifically, classification is not by Xero's `Account.Type` field at all. It is by a **locally-stored flag**, `chart_of_accounts_cache.is_capital_candidate`, which only a human sets via the client-page account picker (confirmed: `low_cost_fixed_assets` uses `Account.type === 'FIXED'` from Xero directly; `capital_item_review` does not — it deliberately avoids inferring capital-candidate status from Xero's own account typing, per the code comment at xeroSync.js:407-410 explaining that account-name keyword rules don't generalise across industries).
- **Where are the £500 thresholds stored?** `chart_of_accounts_cache.capital_review_threshold`
  (per-account override) with a global fallback from `settings.capital_review_threshold` (defaulting
  to 500 in code if the setting row is absent).
- **Is there code that could already calculate this but is prevented from running?** Yes, precisely:
  the guard is
  ```
  if (capitalReviewCandidateCodes.size === 0) {
      issue = { count: null, potential_value_gbp: 0, detail_json: '[]', period_checked: 'not_configured' };
  } else {
      /* the fully-implemented calculation runs here */
  }
  ```
  **Confirmed live**: `SELECT COUNT(*) FROM chart_of_accounts_cache WHERE org_id=1 AND
  is_capital_candidate=1` returns **0**. No account on 4X4 has ever been ticked as a capital-item
  candidate through the UI's per-account picker. The calculation code is fully functional and would
  produce a real count/value the moment at least one account is flagged — this is a **data
  configuration state**, not a code limitation.

---

## 9. Opening Balance Differences — Deep Dive

**Current: 1 issue, £0.25 potential error. Xenon: OK.**

### Exact comparison algorithm (statementEvidence.js:424-438, inside `recomputeEvidenceIssues`)

```
filed = getFiledAccountsForOrg(orgId)[0]     # most recent filing_date row for this org
if not filed:
    issue = {count: null, period_checked: 'not_configured'}
else:
    comparison = filedAccountsComparison(filed.net_assets, filed.xero_net_assets, tolerance=0.01)
    #   filedAccountsComparison(filedNetAssets, xeroNetAssets, tolerance=0.01):
    #     if xeroNetAssets is null or not finite: return {configured: false, difference: null, hasIssue: null}
    #     difference = abs(filedNetAssets - xeroNetAssets)
    #     hasIssue = difference > tolerance
    #     return {configured: true, difference, hasIssue}
    if not comparison.configured:
        issue = {count: null, period_checked: 'needs_sync'}   # Xero side not yet synced
    else:
        filedDetails = comparison.hasIssue ? [one row with the difference] : []
        issue = {
            count: filedDetails.length,          # 0 or 1 — never more, since only 1 filing row exists
            potential_value_gbp: sum(filedDetails.difference),
            period_checked: `filed_accounts_${filed.filing_date}`,
        }
```

**Exact Xero source for Net Assets:** `Reports/BalanceSheet` at date = `filed.filing_date`
(2025-10-31 for 4X4), via `extractNetAssetsFromBalanceSheet` (statementEvidence.js:326), which
scans the report's row tree for a first-cell label matching (after normalisation) `net assets`,
`net liabilities`, or `total equity`, then parses the second cell's value.

**Exact Companies House source:** the filed figure was read automatically from a Companies House
iXBRL accounts document (see Section 15's earlier confirmation that this was tested live) — concept
`core:NetAssetsLiabilities`, context `FY_END_20251031`, extraction confidence `high`. Stored value:
`net_assets = -21385` (exactly, no decimals — filed accounts round to whole pounds by statutory
convention).

**Precision/rounding:** the filed figure is a whole-pound integer (`-21385`) because that's how UK
statutory accounts are filed. The Xero figure is `-21385.25` — Xero tracks pence. **No rounding is
applied to either value before comparison** — the comparison is exact-to-the-penny.

**Existing tolerance:** `0.01` (one penny), hardcoded as the default parameter of
`filedAccountsComparison`. It is never overridden anywhere in the codebase.

**Why £0.25 becomes an issue:** `abs(-21385 - (-21385.25)) = 0.25`, and `0.25 > 0.01` is true. This
is a direct, mechanical consequence of comparing a whole-pound filed figure against a
pence-precision Xero figure with a one-penny tolerance — any client whose filed accounts round to
the nearest pound will trip this check by up to 49.9p purely from that rounding, independent of any
genuine bookkeeping discrepancy.

**Why the UI shows £0 Potential Error despite creating an issue:** it doesn't, factually — the
stored `potential_value_gbp` is `0.25`, and the client page's own screenshot the user supplied
shows `£0` because the display rounds to whole pounds
(`Math.round(check.potential_value_gbp).toLocaleString('en-GB')`, client.ejs:275) — `Math.round(0.25)
= 0`. The underlying value is not zero; only its rounded on-screen presentation is.

---

## 10. Bank Balance Check — Deep Dive

**"Tide Current Account ≈ −£816.20 as of 2026-08-13" — confirmed live from `bank_reconciliation`:**
```
bank_account_id: 14262744-bfb5-458b-b1ba-bc197d971a1c
bank_account_name: "Tide Current Account"
xero_calculated_balance: -816.2
xero_balance_as_of: "2026-08-13"
statement_balance: null
```

**Exact source:** `Reports/BankSummary`, called at xeroSync.js:634 with `fromDate = lockDate` (or a
365-day-capped window ending at `period.end` if the requested window exceeds Xero's limit) and
`toDate = period.end`. The response is a report of `rowType: 'Section'` rows; each row's `cells[0]`
carries an `accountID` attribute and `cells[4]` is the **closing balance** cell for that account.
The code (xeroSync.js:638-645) walks every section row, extracts `accountID` and the closing
balance, and upserts it into `bank_reconciliation.xero_calculated_balance` — **this is Xero's own
calculated running balance for that account as of the report's end date, computed by Xero
server-side from every transaction Xero holds for that account (reconciled or not).** It is not
independently recomputed from `BankTransactions`/`BankTransfers`/`Payments` by this codebase —
it is the report figure, taken as-is.

**Formula, restated plainly:** `-816.20` = whatever `Reports/BankSummary` returns as the account's
closing balance cell for the period ending 2026-08-13. This codebase does not derive it from raw
transactions; Xero's own reporting engine does that server-side.

**Opening balance:** not separately established by this codebase for this check — the report call
itself carries a `fromDate` (the lock date), and Xero computes the closing balance across whatever
transaction history it holds up to `toDate`, using its own opening balance internally. This code
never reads or stores the opening-balance cell.

**Historical transactions before lock date:** irrelevant to the report call's *closing* figure — Xero's own report already accounts for everything up to `toDate` server-side, regardless of the `fromDate` parameter's exact value (the `fromDate` mainly matters for the *movement* columns of the report, which this code doesn't read at all — only the closing-balance cell is consumed).

**Currency handling:** none explicit — the code reads the raw numeric cell value as-is; no currency
conversion or multi-currency handling exists in this check.

**Reconciled vs unreconciled handling:** irrelevant to this check — `Reports/BankSummary`'s closing
balance already includes every transaction Xero holds for the account, reconciled status is not a
factor in what the report returns, and this code applies no `isReconciled` filter here (that filter
belongs to the separate `unreconciled_bank_items` check).

**How CSV evidence works:** an uploaded statement CSV's `closing_balance` field (parsed at import
time by `normalizeStatementLines`, statementEvidence.js:88) is stored in
`statement_imports.closing_balance`. `recomputeEvidenceIssues` builds an `evidence` array preferring
CSV-imported closing balances over manual entries per bank account (statementEvidence.js:388-407),
then compares each evidenced balance against the Xero side.

**How manual statement balance works:** the accountant types a figure into
`bank_reconciliation.statement_balance` via the client page form; this value is used only when no
CSV import exists for that account (the `importedAccounts` set check, statementEvidence.js:397-398).

**Why the check becomes "Not synced" without evidence:** because `bank_balance`'s
`period_checked` is unconditionally overwritten to `period.key` by both write paths (the main-loop
`persistIssue` AND `recomputeEvidenceIssues`'s own override — see Section 15A), the code's intended
`'not_configured'` label never persists, so the UI falls through to the `isNotSynced` branch driven
purely by `count == null`. **The Xero side genuinely is available and fetched every sync** (that is
what produces the −£816.20 figure); only the external statement-balance half requires the
accountant's evidence — as documented, this codebase does not claim Xero exposes the raw statement
balance, and confirmed by direct inspection it does not attempt to.

---

## 11. Unreconciled Bank vs. Unprocessed Bank

| | Unreconciled Bank | Unprocessed Bank |
|---|---|---|
| Data source | `BankTransactions` + `Payments` (Accounting API, standard scopes already held) | Accountant-imported statement CSV lines matched against `xero_bank_items_cache` |
| Fields | `status`, `isReconciled`, `date`, `account.accountID`/`bankAccount.accountID` | statement line `{transactionDate, amount, reference, description, bankAccountId}` vs. cached `{transaction_date, amount, reference, description, bank_account_id, source_type}` |
| Condition | `selectAuthorisedUnreconciled`: `status='AUTHORISED' AND isReconciled=false`; payments additionally restricted to accounts of Xero `Account.type='BANK'` (excludes Suspense/Sales Control/Directors' Loan false positives) | One-to-one global allocation (Section titled "allocateStatementMatches", statementEvidence.js:205) across the whole statement; a line is "unprocessed" if no Xero-side record could be assigned to it after every stronger-evidence pairing is settled first |
| API limitation | None — fully derivable from the standard Accounting API, and is (confirmed exact vs Xenon on 3 clients per code comments) | Raw unreconciled *bank feed* lines are not exposed by any public Xero endpoint this app can access (documented Xero-side restriction, see `XENON_PARITY_SPEC.md`) |
| Output state | Always a real number once a sync completes — never `null` for a reason other than sync failure | `count: imports.length ? unmatched.length : null` — literally `null` until at least one statement has been imported for this org (statementEvidence.js:377) |

**Where the API limitation is represented in code:** `recomputeEvidenceIssues` never attempts to
call any Xero endpoint for unprocessed_bank at all — the entire check is built from
`getLatestStatementImportsForOrg`/`getLatestStatementLinesForOrg` (pure local DB reads) and the
`xero_bank_items_cache` table populated earlier in `runSync` from the standard entities already
fetched (BankTransactions, Payments, BankTransfers, batch payments). There is no code path that
attempts to call a Bank Feeds or Finance API endpoint and catches a failure — the limitation is
represented by the **absence of any such attempt**, not by a caught error.

---

## 12. Contact Checks

**Confirmed live on 4X4:** Duplicate Contacts = 150, Contact Defaults = 910, Inactive Contacts = 252.
Total ACTIVE customer/supplier contacts cached: **910** (out of 1,195 total cached, 1,124 ACTIVE).

| Check | Xero source | Algorithm | Threshold | Count semantics | Value semantics | Date/activity logic |
|---|---|---|---|---|---|---|
| Duplicate Contacts | `Contacts` (ACTIVE, isCustomer\|\|isSupplier) | All-pairs Levenshtein similarity on normalised names (lowercase, non-alphanumeric stripped), `contactNameSimilarity` (checkRules.js:241) | ≥ 0.7 similarity | One count per qualifying **pair** (not per contact) | Always £0 | none |
| Contact Defaults | `Contacts` (ACTIVE) | Missing `salesDefaultAccountCode`/`accountsReceivableTaxType` (if customer) OR missing `purchasesDefaultAccountCode`/`accountsPayableTaxType` (if supplier) | none (boolean presence check) | One count per qualifying **contact** | Always £0 | none — `updatedDateUTC` not read by this check |
| Inactive Contacts | `Contacts` + `Invoices` + `CreditNotes` + `BankTransactions` + `Payments` | Latest of: newest non-VOIDED/DELETED document date across invoices/credit-notes/bank-transactions for that contact, and newest AUTHORISED payment date settling an invoice/credit-note/prepayment/overpayment for that contact; falls back to `contact.updatedDateUTC` only when no transaction was ever found | 12 months before `period.end` | One count per qualifying contact | Always £0 | Rolling 12-month cutoff from `period.end`, recomputed every sync |

**910 out of 910 ACTIVE customer/supplier contacts flagged by Contact Defaults** — confirmed by the
live query in this section's header: the entire active customer/supplier population equals the
flagged population. This is a mechanical fact reported without interpretation here; Section 15C
notes it as something needing investigation (whether this client genuinely never configures
defaults, or whether Xero's default fields behave differently than the check assumes for this
tenant).

### OK / ISSUE / N/A / NOT SYNCED — are these four states distinct in the backend, or mainly UI mappings?

**Backend reality: there are only two backend-meaningful states — `count === null` and
`count !== null`.** Everything else is a UI-layer interpretation of `period_checked` string values
layered on top of that one boolean, per `client.ejs`:

```
isUnavailable   = period_checked === 'out_of_scope'          # never actually set by any check today
isNotConfigured = period_checked === 'not_configured' OR 'needs_sync'   # see Section 15A — often unreachable
isNotSynced     = count == null   (checked only if NOT the above two)
hasIssues       = count != null AND count > 0
→ else: "OK"
```

So:
- **"OK"** = a fresh row exists (this run activated it) with `count === 0`
- **"ISSUE"** = a fresh row exists with `count > 0`
- **"N/A"** = would require `period_checked === 'out_of_scope'`, a literal string **no check in the
  entire codebase currently writes** — confirmed by grep across `xeroSync.js` and
  `statementEvidence.js`. This UI branch is currently dead code for every check; the "N/A" badges
  visible for `duplicate_contacts`/`contact_defaults`/`inactive_contacts`/`undocumented_bills` in
  the Xenon comparison are a **display convention for non-scored checks** driven by a different
  piece of logic (`NON_SCORED_CHECKS`), not by `isUnavailable`
- **"Not synced"** = `count === null`, and (per Section 15A) this is the branch that fires even for
  checks whose own code intended "Not configured", because the intended literal string never
  survives to storage

---

## 13. Health Score — Complete Reproduction

**Live 4X4 result: score = 74.** Verified by hand-reconstructing from `scoreProfile.js` and the
stored per-check breakdown.

### The formula (scoreProfile.js, `calculateScoreBreakdown` / `scoreObservation`)

For each check `i` with an active, scored finding:

```
count_i, exposure_i, ageDays_i  = normalizeObservation(issue_i)
   # count = number of findings (or the check's own .count if no findings array)
   # exposure = sum of |potential_value_gbp| across findings (or the check's own aggregate)
   # ageDays = mean of each finding's derived age in days (max across a fixed list of date fields)

transform(x, reference, cap) = boundedLog(x) = log1p(min(|x|,cap)/reference) / log1p(cap/reference)
   # a 0..1 bounded, diminishing-returns transform of a raw magnitude

count_signal_i  = transform(count_i,    reference=5,   cap=1000)
value_signal_i  = transform(exposure_i, reference=100, cap=1000000)
age_signal_i    = transform(ageDays_i,  reference=30,  cap=3650)

weighted_signal_i = 0.55*count_signal_i + 0.30*value_signal_i + 0.15*age_signal_i

severityWeight_i  = {critical:1.6, high:1.15, medium:0.75, low:0.35}[importance_i]
checkWeight_i      = checkWeights[check_type_i]  or 1     # only 12 check types have an override; everything else = 1

rawDeduction_i = min(8, 8 * severityWeight_i * checkWeight_i * weighted_signal_i)
deduction_i    = rawDeduction_i * globalScale                # globalScale = 0.9108611991785556

totalDeduction = sum(deduction_i for every scored, active, non-excluded observation)
score = clamp(round(100 - totalDeduction), 0, 100)
```

`maxCheckDeduction = 8` caps any single check's *raw* deduction before the global scale is applied —
this is a per-check ceiling, not a total-score floor.

### Reproducing 74% by hand from the 9 non-zero contributors (all others deducted exactly 0)

| Check | count | exposure(£) | ageDays | sev | chkW | deduction |
|---|---|---|---|---|---|---|
| old_unpaid_invoices | 219 | 38,724.41 | 81.3 | 1.15 | 1.1 | 5.802 |
| old_unpaid_bills | 119 | 8,794.06 | 92.3 | 1.15 | 1.1 | 4.821 |
| sales_tax_missing | 274 | 18,152.10 | 188.0 | 0.75 | 1.05 | 3.722 |
| duplicate_invoices | 31 | 4,224.95 | 71.2 | 1.15 | 1.1 | 3.368 |
| purchase_tax_missing | 116 | 14,112.35 | 198.5 | 0.75 | 1.05 | 3.186 |
| duplicate_bills | 6 | 492.63 | 73.1 | 1.15 | 1.1 | 1.643 |
| multi_account_suppliers | 5 | 12,990.28 | 0.0 | 0.75 | 1 | 1.261 |
| multi_tax_suppliers | 11 | 1,648.74 | 0.0 | 0.75 | 1 | 1.169 |
| opening_balance_differences | 1 | 0.25 | 286.3 | 1.15 | 1 | 0.775 |

**Sum of deductions = 25.745** (matches the stored `totalDeduction: 25.745` exactly).
`score = round(100 − 25.745) = round(74.255) = 74`. ✅ reproduces the displayed 74%.

Every other active check contributes **exactly 0** because `normalizeObservation` returns
`count = 0` for them (no active findings), and `boundedLog(0, ...) = 0` by the function's own
definition (`safe ? ... : 0` — a zero input short-circuits to zero signal).

**Excluded checks contribute 0 by construction**, for one of three reasons (all confirmed live):
`non_scored` (duplicate_contacts, contact_defaults, inactive_contacts, undocumented_bills — hardcoded
in `NON_SCORED_CHECKS`), `unavailable` (bank_balance, unprocessed_bank, capital_item_review — `count
== null` and no findings array), or `no_active_findings` (every other check with `count: 0`).

### N/A and Not-synced handling in the formula specifically

`scoreObservation` computes `excludedReason` BEFORE any arithmetic:
```
excludedReason =
    issue.nonScored ? 'non_scored'
  : NON_SCORED_PERIODS.has(issue.period_checked) ? issue.period_checked   # 'out_of_scope'/'not_configured'/'needs_sync'
  : (issue.count == null and no findings) ? 'unavailable'
  : null
if excludedReason: return {deduction: 0, excludedReason, ...}
```
So a `null`-count check is excluded from the score **entirely** — it neither helps nor hurts the
score. This is why `bank_balance`/`unprocessed_bank`/`capital_item_review` being unconfigured does
not artificially inflate 4X4's score; they are treated as absent evidence, not as "0 issues found".

### `calibrated-2026-08-n5` — what it means and where it's defined

Defined verbatim at `scoreProfile.js:1-36` (`SCORE_PROFILE`). It is a version string plus a
`rationale` string, both hardcoded, stating: fitted by least-squares against **5** period-matched
Xenon exports (`calibrationTargets: 5`), mean absolute error 4.8 points, 3 of 5 clients within 3
points, 2 not (one predicted 66 vs Xenon's actual 77, another 40 vs 32). `globalScale =
0.9108611991785556` is the single free parameter that fit was solved for; everything else in the
profile (severity weights, component weights, transform references/caps, per-check weight
overrides) is a fixed, hand-set constant, not something the calibration routine touches. The
"−25.7 points" the UI shows is simply `totalDeduction` rendered to one decimal — not a separate
number, it's exactly the sum shown in the table above (25.745 rounds to 25.7).

---

## 14. Potential Errors Total — £99,140 Reconciliation

**Every scored check's `potential_value_gbp`, summed, reconciles exactly to the stored total.**

| Check | potential_value_gbp |
|---|---|
| unreconciled_bank_items | 0.00 |
| duplicate_invoices | 4,224.95 |
| duplicate_bills | 492.63 |
| old_unpaid_invoices | 38,724.41 |
| old_sales_credits | 0.00 |
| old_unpaid_bills | 8,794.06 |
| old_purchase_credits | 0.00 |
| unapproved_invoices | 0.00 |
| unapproved_bills | 0.00 |
| multi_account_suppliers | 12,990.28 |
| multi_tax_suppliers | 1,648.74 |
| purchase_tax_missing | 14,112.35 |
| sales_tax_missing | 18,152.10 |
| capital_item_review | 0.00 |
| low_cost_fixed_assets | 0.00 |
| misallocated_items | 0.00 |
| unexpected_account_used | 0.00 |
| unexpected_tax_code_used | 0.00 |
| invoice_or_direct | 0.00 |
| bill_or_direct | 0.00 |
| sales_tax_on_bills | 0.00 |
| purchase_tax_on_invoices | 0.00 |
| bank_balance | 0.00 |
| unprocessed_bank | 0.00 |
| opening_balance_differences | 0.25 |
| **SUM** | **99,139.77** |

Displayed as **£99,140** after rounding — matches. `duplicate_contacts`, `contact_defaults`,
`inactive_contacts`, `undocumented_bills` are `NON_SCORED_CHECKS` and are explicitly filtered out of
this sum in `runSync` (xeroSync.js:1738-1743: `.filter(i => !NON_SCORED_CHECKS.includes(i.check_type))`).

**Can the same underlying transaction contribute to more than one check, and therefore be double-
counted in this headline total?** Yes, confirmed by direct inspection — there is **no
deduplication mechanism across checks anywhere in this codebase.** Concrete examples that exist in
the current implementation:
- A single bill line with no tax code on an expense account with a vague name (e.g. "General
  Expenses") can simultaneously be counted in `purchase_tax_missing` (missing tax) AND
  `misallocated_items` (vague account name) — two independent checks reading the same
  `lineItems[]` entry, summing the same `lineAmount` into two separate totals.
- A bill line on an account the contact doesn't normally use, with the wrong tax code, and missing
  VAT, could appear in `unexpected_account_used`, `unexpected_tax_code_used`, AND
  `purchase_tax_missing` simultaneously — three separate `sumAbsoluteExposure` calls over
  overlapping line sets.
- An invoice that is both a suspected duplicate AND more than 60 days old and unpaid contributes its
  `total` to `duplicate_invoices`'s group value AND its `amountDue` to `old_unpaid_invoices` —
  different fields, same underlying document, both counted.

No code anywhere builds a cross-check identity map or excludes a line/document from one check
because it was already counted in another. Each of the 29 `try` blocks in `runSync` is fully
independent.

---

## 15. Current Known Limitations

### A. Implementation limitations (data already retrieved, but not calculated, or calculated incorrectly)

1. **The `period_checked` override bug** (Sections 4, 8, 10, 15 cross-referenced). Every issue
   written through the main-loop `persistIssue` wrapper has `period_checked` unconditionally set to
   `period.key`, discarding whatever semantic label (`'not_configured'`, `'needs_sync'`) the check's
   own code intended. `recomputeEvidenceIssues` has an equivalent bug: its `replace()` helper does
   `period_checked: effectivePeriodKey || data.period_checked`, and `effectivePeriodKey` is the
   caller-supplied `period.key`, which is truthy every time `runSync` calls it — so its own
   `'not_configured'`/`'needs_sync'` labels for `unprocessed_bank`/`bank_balance` are equally
   discarded at the point of writing to the database. **Effect, confirmed live:** `bank_balance`,
   `unprocessed_bank`, and `capital_item_review` all display as generic "Not synced" instead of the
   intended "Not configured" state with its "Configure evidence →" link — the distinction the code
   comments clearly intend to draw between "genuinely broken sync" and "needs setup" does not
   survive to the UI for any of these three checks currently. This affects display/UX only — the
   scoring layer (`scoreObservation`) is unaffected because it keys off `count == null`, not off
   `period_checked`.
2. **No cross-check deduplication** — Section 14's finding stands as a general limitation, not
   specific to any one check: the same line/document can inflate the £99,140 headline through
   multiple independent checks with no dedication logic anywhere.
3. **`Multi-Account Suppliers` and `Multi-Tax Code Suppliers` valuation formula** produces a
   materially different number from Xenon on the one supplier-heavy client measured (Credit Flex's
   11 loan-tracking accounts), while the *detection* (which suppliers qualify) is exact. The
   detection/valuation split — detect over 12mo-or-period, but value only the since-lock-date
   subset — is itself an existing design choice (documented in code comments as deliberately
   fitted against reference clients), not an oversight; whether the valuation formula itself
   (sum of ALL non-dominant accounts vs. some other rule) matches Xenon cannot be confirmed further
   from this codebase without additional Xenon row-level evidence (see 15C).
4. **`ManualJournals` scope is requested but nothing fetches it.** `accounting.manualjournals.read`
   is in the OAuth scope list (`xeroClient.js:35`) but no function anywhere calls
   `getManualJournals`. This is inert scope, not a missing feature — no check currently needs
   ManualJournals data, so nothing is broken by its absence, but the scope request itself is
   presently unused.
5. **`purchase_tax_missing`/`sales_tax_missing` potential double-count via bill-vs-bank-transaction
   overlap** (Section 3) — a mis-posted payment that both settles a bill AND is separately coded to
   an expense/revenue account could, in principle, be flagged twice for the same underlying tax gap.
   Not verified as occurring on 4X4's live data in this pass — flagged as a structural possibility
   in the current code, not a confirmed live discrepancy.
6. **`Contact Defaults` flags 910 of 910 active contacts on 4X4** — the check itself is correctly
   implemented per its own stated rule, but a 100% hit rate on the entire active contact population
   is unusual enough to warrant checking whether the underlying data (or the rule's applicability to
   this particular client's onboarding process) is what's actually being measured, versus a
   population-wide implementation issue. The code is not incorrect; the result is suspicious enough
   to flag.

### B. Xero data limitations (genuinely unavailable from the standard Accounting API / current scopes)

1. **Raw unreconciled bank feed lines** (the underlying data `unprocessed_bank` would ideally use) —
   confirmed absent from the Accounting API by Xero's own developer documentation (cited in
   `XENON_PARITY_SPEC.md`); reconstructed instead from accountant-imported statement CSVs.
2. **The bank's own external statement balance** (`bank_balance`'s missing half) — the Accounting
   API's `Reports/BankSummary` returns only Xero's own calculated balance, never the bank's; this
   is architecturally why manual/CSV evidence is required, confirmed by direct inspection of what
   `Reports/BankSummary` actually returns.
3. **Filed company accounts prior to the Companies House iXBRL integration** for filings that are
   paper-filed or use an untagged (non-iXBRL) format — those clients still require manual entry into
   `filed_accounts`; not every UK company's filing is machine-readable.
4. **Contact "last activity" as Xero natively understands it** — Xero exposes only
   `contact.updatedDateUTC` (a record-edit timestamp) as a built-in activity signal; genuine trading
   activity has to be derived by this codebase from invoices/credit-notes/bank-transactions/payments,
   which it now does — this is documented as a known Xero API gap that the current implementation
   already works around, not an open limitation.

### C. Unknown / needs investigation (cannot determine from code alone whether Xenon has more data access or a different algorithm)

1. **Multi-Account Suppliers valuation** — whether Xenon's £4,399 (vs. our £12,990) reflects a
   materially different summation rule, a per-contact "Ignore this contact" state already exercised
   in Xenon (the pasted export shows exactly such a control on the Credit Flex row), or some other
   mechanism cannot be determined without Xenon's own row-level "View Issues" export for this check
   with the ignore/OK state visible.
2. **Multi-Tax Code Suppliers count (11 vs 13)** — two additional Xenon-flagged suppliers cannot be
   identified from this codebase's data alone; whether they are suppliers our since-lock-date
   listing gate is dropping, or suppliers Xenon includes via some other rule entirely, is not
   determinable without Xenon's full 13-row export.
3. **Duplicate Invoices/Bills grouping window and value rule** — now reconciled exactly for the one
   client measured this session (4X4, row-for-row); whether the same 3-day-greedy-newest-first
   algorithm and single-document valuation generalise to every other client, or whether 4X4 happens
   to have no groups that would expose an edge case in the algorithm, has not been independently
   re-verified against a second client's full row-level export within this document's scope.
4. **Contact Defaults 910/910** — whether this reflects a genuine client-side configuration gap or a
   difference in how Xenon interprets "default" (e.g. Xenon might treat a *group* default or an
   account-level default differently from a *contact*-level default) cannot be resolved from this
   codebase, since Xenon's own algorithm for this check is not visible to us.
