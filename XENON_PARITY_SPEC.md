# Xenon 29-check parity specification

## Purpose and evidence standard

This is the executable target for the dashboard's 29-check registry. It combines the implemented
data flow in `APP_CONTEXT.md`, the MBX/Fast Track findings in `ACCURACY_AUDIT.md`, and the researched
defaults confirmed for this phase. The anonymized audit snapshots are regression evidence, not a
promise that live totals will always equal an older Xenon export.

Rules marked **confirmed** may drive code and fixtures. **Provisional** rules preserve the current
implementation until issue-row evidence proves a replacement. **Unavailable** checks must return a
null count and must never be presented or scored as clean.

## Cross-check contract

- Registry: exactly 29 unique `type` values, with a label and importance.
- Granularity: counts represent offending lines unless a row below explicitly says document,
  contact, account, or pair.
- Exposure: sum the absolute magnitude of every counted finding. Credits and negative adjustments
  must not cancel positive findings. Where the risk is tax coding, exposure is absolute tax amount.
- Fail-safe: missing prerequisites produce no scored result for that cycle. Null, zero, unavailable,
  and not-configured values do not deduct health-score points.
- Period: every check is bounded by both ends of the selected period, including the ones that look
  like cumulative backlogs. A failed fetch is not an empty dataset.
- Detail safety: persist only the fields needed to explain a finding. Tests use synthetic identifiers
  and amounts and contain no tokens, tenant IDs, or raw personal data.

## Confirmed defaults

- Duplicate invoice/bill grouping: same contact and exact total, **grouped greedily from the newest
  document within a 3-day window** — anchor on the latest ungrouped document, absorb every match
  dated 0–3 days before it, emit, repeat. **One group is one issue worth one document amount.**
  Row-exact against Xenon's 4X4 View Issues (31 groups / £3,509.90 invoices; 6 / £492.63 bills).
  Forward date-gap chaining cannot reproduce Xenon's boundaries: its groups 5 and 7 sit two days
  apart yet stay separate, while group 4 spans three days internally.
- Old document threshold: **more than 60 days from document date**, not due date.
- Invoice-or-direct / bill-or-direct: same contact and exact penny amount; direct transaction occurs
  **on or up to 30 days after** the document. A direct transaction before the document does not match.
- Supplier pattern scope: **the selected reporting period**, with no materiality floor by default.
- Duplicate-contact similarity: normalized name similarity **at least 70%**.
- Purchase-tax missing exemptions: payroll, statutory, financing/non-cash and bank-fee categories are
  excluded. PayPal, card, merchant, and other processor fees remain included unless explicitly
  excluded by client account code.
- Wrong-direction tax: invoice/bill findings are counted. Bank transaction observations are optional,
  display-only context and do not affect count, exposure, or score.

## Check registry

| # | Type | Importance | Selection and finding | Count / exposure | Evidence |
|---:|---|---|---|---|---|
| 1 | `bank_balance` | critical | Compare Xero's calculated closing balance (`Reports/BankSummary`) with the external statement balance from a statement CSV or accountant entry. Requires external bank statement evidence — the Xero side is fully available; only the bank's own balance is not, and it cannot be derived from balances, transactions or reports because Xero's reconciliation flags mean "matched inside Xero", never "settled at the bank". | Account discrepancies over £0.01 / absolute balance difference. Not configured when no statement balance exists. | The bank's own balance is `statementBalance` in the closed Finance API `/CashValidation`; on the open Accounting API it needs statement evidence — see "External-evidence checks" |
| 2 | `unreconciled_bank_items` | critical | Union AUTHORISED bank transactions where `IsReconciled=false` and AUTHORISED payments where `IsReconciled=false` **whose payment account is type `BANK`**; exclude DELETED. Dated **within the selected period**, not across all history. | Item / absolute transaction or payment amount. | Confirmed on 3 clients |
| 3 | `unprocessed_bank` | critical | Imported statement lines with no remaining Xero counterpart, matched one-to-one within each statement against AUTHORISED bank transactions, AUTHORISED payments, batch-payment totals and transfer legs. Equals the "Reconcile (N)" count in Xero's UI. Obtainable directly as `bankStatement.statementLines.unreconciledLines` from the Finance API `/CashValidation`, but that API is closed to Financial Services partners only — see "External-evidence checks" below. | Unmatched statement line / absolute amount. Not configured until a statement is imported. | Closed-API figure exists; reconstructed locally from imported statements |
| 4 | `duplicate_invoices` | high | AUTHORISED + SUBMITTED sales invoices, same contact and exact total, grouped greedily newest-first within 3 days. | **Group** / the group's document amount counted once. | Row-exact on 4X4 (31 groups / £3,509.90). Supersedes an earlier "same calendar day, count extras" rule that matched the count by coincidence while overstating value by £715 |
| 5 | `duplicate_bills` | high | DRAFT + AUTHORISED + PAID purchase bills (not SUBMITTED), same contact and exact total, grouped greedily newest-first within 3 days; group kept only if at least one member still has amountDue > 0. | **Group** / the group's document amount counted once. | Row-exact on 4X4 (6/£492.63) and MBX (10/£943.57); Rose/Handymanz/Fast Track exact 0 |
| 6 | `old_unpaid_invoices` | high | Sales invoice has amount due and document date is more than 60 days before run date. | Document / absolute amount due. | Confirmed default |
| 7 | `old_sales_credits` | high | AUTHORISED or SUBMITTED sales credit has remaining credit and document date is over 60 days old. | Document / absolute remaining credit. | Confirmed default |
| 8 | `old_unpaid_bills` | high | Purchase bill has amount due and document date is more than 60 days before run date. | Document / absolute amount due. | Confirmed default |
| 9 | `old_purchase_credits` | high | AUTHORISED or SUBMITTED purchase credit has remaining credit and document date is over 60 days old. | Document / absolute remaining credit. | Confirmed default |
| 10 | `opening_balance_differences` | high | Compare filed net assets at the last filed balance-sheet date with Xero's `Reports/BalanceSheet` net assets at the same date. The filed figure is read automatically from the Companies House accounts document when it is iXBRL-tagged (concept tiers: net assets, then total equity; GBP, undimensioned, instant context matching the made-up date exactly); otherwise accountant-entered. | Difference over £0.01 / absolute difference. Not configured when no filed figure is available from either source. | Automated where the filing is machine-readable; manual fallback otherwise |
| 11 | `invoice_or_direct` | medium | Revenue-coded RECEIVE has same contact and exact amount as an unpaid/draft sales invoice dated 0–30 days earlier. | Direct transaction / absolute direct amount. | Confirmed default |
| 12 | `bill_or_direct` | medium | Expense-coded SPEND has same contact and exact amount as an unpaid AUTHORISED or DRAFT (not SUBMITTED) purchase bill dated 0–30 days earlier; one-to-one consumption, nearest bill wins. | Direct transaction / absolute direct amount. | Row-level confirmed (MBX 44/44) |
| 13 | `low_cost_fixed_assets` | medium | Positive bill or SPEND line on a FIXED account, at or below £200, since lock date. | Line / absolute line amount. | Provisional threshold |
| 14 | `capital_item_review` | medium | Bill or SPEND line on an accountant-selected capital-candidate account, at or above configured threshold (default £500), since lock date. | Line / absolute line amount. Not configured if no accounts selected. | Confirmed configuration model |
| 15 | `misallocated_items` | medium | Bill or SPEND line on a vague expense account name, at or above configured threshold (default £100), since lock date. | Line / absolute line amount. | Provisional heuristic |
| 16 | `multi_account_suppliers` | medium | Detection over the period or the trailing twelve months, whichever reaches further back; supplier must have activity inside the checked period to be listed. Dominant account is highest absolute volume; the configurable non-dominant floor defaults to £0. | Supplier / absolute non-dominant period value. | Exact on 4X4/MBX/Handymanz/Rose after in-period listing filter (Rose dropped Aldi) |
| 17 | `multi_tax_suppliers` | medium | Detection over the period or the trailing twelve months, whichever reaches further back; NONE counts as a tax code; £0.00 lines ignored; supplier must have activity inside the checked period to be listed. Dominant tax is highest absolute volume; the configurable non-dominant floor defaults to £0. | Supplier / absolute non-dominant period value. | Fast Track exact. Rose 29 v 28 (Canva only residual). Handymanz SET-correct at 5 of Xenon's 7 (2 missing Zero-Rated lines not in cache). 4X4 / MBX still short. See "Multi-tax lookback evidence" below |
| 18 | `unexpected_account_used` | medium | Period-scoped AUTHORISED bill/invoice/SPEND/RECEIVE line account differs from that contact role's configured default; contacts without a default are skipped. DELETED bank txns excluded. | Offending line / absolute line amount. | Confirmed on Handymanz/MBX/4X4 |
| 19 | `unexpected_tax_code_used` | medium | Period-scoped AUTHORISED bill/invoice/SPEND/RECEIVE line tax type differs from that contact role's configured default; contacts without a default are skipped. DELETED bank txns excluded. | Offending line / absolute line amount. | Confirmed on Handymanz/MBX/4X4 |
| 20 | `sales_tax_missing` | medium | VAT-registered client; positive sales-invoice or revenue-coded RECEIVE line since lock date has no tax type or NONE. | Offending line / absolute line amount. | Confirmed line and bank coverage |
| 21 | `purchase_tax_missing` | medium | VAT-registered client; positive purchase-bill or expense-coded SPEND line since lock date has no tax type or NONE and account is not exempt. Processor fees are included; payroll/statutory/bank fees are exempt. | Offending line / absolute line amount. | Confirmed line/exemption behavior |
| 22 | `sales_tax_on_bills` | medium | Purchase-bill line uses a sales-only tax rate. Qualifying SPEND lines may be retained only as display-only observations. | Counted bill line / absolute tax amount; bank observations contribute zero. | Confirmed default |
| 23 | `purchase_tax_on_invoices` | medium | Sales-invoice line uses a purchase-only tax rate. Qualifying RECEIVE lines may be retained only as display-only observations. | Counted invoice line / absolute tax amount; bank observations contribute zero. | Confirmed default |
| 24 | `undocumented_bills` | medium | AUTHORISED purchase bill since lock date has no attachment. | Document / £0; displayed but excluded from headline totals and score. | Implemented, non-scored |
| 25 | `unapproved_invoices` | medium | DRAFT or SUBMITTED sales invoice since lock date. | Document / absolute total. | Implemented |
| 26 | `unapproved_bills` | medium | DRAFT or SUBMITTED purchase bill since lock date. | Document / absolute total. | Implemented |
| 27 | `duplicate_contacts` | low | Active customer/supplier contact pair has normalized-name similarity at least 70%. | Pair / £0; displayed but excluded from headline totals and score. | Confirmed default |
| 28 | `contact_defaults` | low | Active customer lacks sales account/tax default or active supplier lacks purchase account/tax default. | Contact / £0; displayed but excluded from headline totals and score. | Implemented, non-scored |
| 29 | `inactive_contacts` | low | Active customer/supplier whose latest activity is more than 12 months before period end. Activity is the latest of: newest non-voided, non-deleted invoice, credit note or bank transaction date, **and newest AUTHORISED payment date** — settling an invoice is activity in its own right and its date is independent of the document's. Contacts that never transacted fall back to `updatedDateUTC`. | Contact / £0; displayed but excluded from headline totals and score. | Transaction-derived; payment leg measured on 6 clients (34 false findings removed, 0 added, displayed activity date corrected on 764 more) |

## Health score

The current score starts at 100. A positive, finite count deducts by importance using base weights
critical 3, high 3, medium 0.8, low 1; the per-check multiplier rises linearly from 1× at one issue
to 2× at 21 issues. Category deductions are capped at critical 18, high 14, medium 10, and low 4,
then the rounded score is clamped to 0–100. `duplicate_contacts`, `contact_defaults`,
`inactive_contacts`, and `undocumented_bills` are non-scored.

This formula is an explicit application baseline, not proven exact Xenon parity. Recalibration is
blocked on converged issue-row evidence. Null/unavailable and zero counts are always ignored.

## Multi-tax lookback evidence (row-level, Aug 2026)

Xenon's View Issues header on every multi-tax supplier reads:
**"Tax Codes used (including 3 months earlier than date range checked)"**.

### Proven and shipped
1. **£0.00 lines do not count as using a tax code.** 4X4 extras TPS Huddersfield and MANDMORELTD were flagged only because of a £0.00 No-VAT line on the same bill as a real 20% line. Suppliers with a £0.01+ Zero-Rated rounding line (Volkswagen Group, Napa, Vertu) stay flagged. Shipped: skip `amt === 0` when collecting tax codes.
2. **Listing requires in-period activity.** Tax-code history may come from before the period, but Xenon only lists suppliers that traded inside the period. Confirmed by full Rose 28-name export (dropped JS, Metis HR, Aldi, FORGN) and Handymanz 7-name export (dropped ebay, Pest Control Supermarket). Shipped: skip contacts with no since-lock-date activity.

### Handymanz set truth (was a fake exact)
Our previous count match of 7 was coincidence: Amazon, EE, Edf Energy, PLUMBINBITS, LOVE MOBILE DATA matched, but we wrongly included ebay + Pest Control and missed Stationery Island + Surfshark. After the activity filter we correctly keep the five Xenon suppliers our cache can see. Stationery Island and Surfshark are shown by Xenon with a Zero-Rated code that is **absent from our Xero cache** (same class of data gap as 4X4 RRG Huddersfield / plain Volkswagen).

### Residuals closed as stale-data ghosts (11 Aug 2026, full-list diffs)
Every remaining multi-tax miss shares one signature: **Xenon's header claims a second tax
code, but Xenon's own displayed rows contain no line with that code.** The supporting line
no longer exists in Xero (rounding line removed, spend deleted, or contact merged after
Xenon's 07/08 sync), or was individually marked "Tax Code OK" (which hides the row but
keeps the contact flagged). Diffed name-for-name against full Xenon exports:
- **MBX 64 v 65:** only miss is Metamark UK — 5 bills shown by Xenon, all 20%; no
  Zero-Rated row displayed, none in Xero.
- **4X4 11 v 13:** RRG Huddersfield (single 20% bill; claimed Zero-Rated absent) and plain
  "Volkswagen" — the bills Xenon lists under it (245050158, 244432454) now sit under
  "Volkswagen Group United Kingdom" in Xero: contacts were merged after Xenon synced.
- **Handymanz 5 v 7:** Stationery Island (claimed Zero-Rated absent) and Surfshark, whose
  matching £49.46 No-VAT spend exists in our cache with status DELETED.
- **Rose 29 v 28:** Canva extra unresolved — its No-VAT lines exist only in the 3-month
  lookback, exactly like JustAnswer which Xenon *does* list, so the exclusion is user
  state (marked OK), not a window rule.
We produce **zero extra names** on all four clients; every miss is a row Xenon itself
cannot display. No further rule can close these without hard-coding.

Earlier count-only experiments that "falsified" requiring period activity were wrong: they preserved Handymanz's coincidental 7. Row-level exports overturn that.

## Bill or Direct evidence (row-level, MBX 44-item export, Aug 2026)

Xenon's full 44-row list decomposed as 12 Draft-bill pairs + 32 unpaid-bill pairs, gaps of
0–30 days, every pair one-to-one. Reconstructed exactly (44/44 rows) with:
1. **Candidate documents:** unpaid AUTHORISED bills (matched on `amountDue`) plus DRAFT
   bills (matched on `total`). SUBMITTED bills are excluded — including them produced 55
   false pairs (Cheaper Waste / All Print 2020–21) that Xenon does not list.
2. **One-to-one consumption:** each bill can explain at most one payment; the
   nearest-dated bill wins; payments processed in date order.
3. **Window:** bill date ≤ payment date ≤ bill date + 30 days, exact amount, same contact,
   spend coded to an expense account.
Shipped in `findDirectMatches` + the `bill_or_direct` pool. Our count is 48 v Xenon 44:
the 4 extras are More Than Accountants £214.80 recurring-fee pairs — the practice's own
fees, almost certainly dismissed in Xenon (the page has a "Show dismissed" toggle; a
newer £496.80 MTA pair *is* listed). Not ambiguity (each has exactly 1 candidate), not
PAID-bill blocking (tested, no effect). Cross-client regression: 0 matches on 4X4,
Handymanz, Fast Track, Rose — matching Xenon's 0 for all four.

## External-evidence checks (what is and is not a Xero API gap)

Re-investigated 12 Aug 2026 against the live integration rather than assumed. The distinction that
matters is between a value Xero does not return directly and a value that cannot be derived at all.

- **`bank_balance` and `unprocessed_bank` — available in a CLOSED Xero API; blocked commercially,
  not technically.** Corrected 13 Aug 2026 after a colleague demonstrated the Xero UI showing
  "211.98 Statement Balance" beside "(60.88) Balance in Xero", and "Reconcile (N)" as the
  unprocessed count. An earlier version of this section claimed the statement balance and the
  unprocessed count could not be derived from any Xero API. **That was wrong.** The Finance API's
  `GET /CashValidation` returns, per bank account, exactly both figures:
  - `statementBalance` + `statementBalanceDate` → the bank's own balance for `bank_balance`
  - `cashAccount.accountBalance` → the Xero ledger balance to compare it against
  - `bankStatement.statementLines.unreconciledLines` → the unprocessed **count** (the UI's
    "Reconcile (N)"), plus `unreconciledAmountPos` / `unreconciledAmountNeg` for exposure,
    `earliestUnreconciledTransaction` / `latestUnreconciledTransaction`, `avgDaysUnreconciled*`
    for ageing, and a `dataSource` split across direct bank feed / file upload / manual.

  The blocker is eligibility: the Finance API is *"a closed API that is only available to those that
  have an established (Financial Services) partnership with Xero for lending purposes"*. A practice
  is not a lender, so this is very unlikely to be granted — but it is worth one question to the Xero
  partner manager, because if granted both critical checks become fully automatic. Scope required:
  `finance.cashvalidation.read` (rate limited to 10 calls/minute, 4,000/day shared across all apps —
  ample for ~50 clients at one call each). `GET /BankStatementsPlus/statements`
  (`finance.bankstatementsplus.read`, same partnership) additionally returns individual
  `statementLineId` rows with `startBalance` / `endBalance` / `indicativeStartBalance`, which would
  supply detail rows as well as totals.

  What remains true: the **Accounting API** does not expose this. Its Bank Statements page states
  unreconciled bank statement data is not exposed "due to regulatory, contractual and risk
  constraints", and it cannot be reconstructed from BankTransactions, which is a different dataset
  (records already in Xero, versus feed lines never entered). `Reports/BankStatement` did exist but
  was restricted on 2 April 2024 behind a signed developer-terms addendum plus
  `accounting.reports.bankstatement.read`; that scope appears in neither the current public reports
  list nor the current public scopes list, so it is not available to this app.

  Until a partnership exists, both checks stay on imported statement evidence — which is a genuine
  reconstruction of the same numbers, not a proxy.
- **Scope debt to clear before the next reauthorisation.** `accounting.reports.read` is deprecated
  (broad scopes work until September 2027). `bank_balance` depends on `Reports/BankSummary`, whose
  granular replacement scope `accounting.reports.banksummary.read` is **not** currently requested.
  Add it before clients next reauthorise, or bank_balance silently loses its Xero-side balance when
  broad scopes retire.
- **`opening_balance_differences` — was mislabelled unavailable; now automated.** Both halves are
  obtainable: Xero supplies net assets via `Reports/BalanceSheet` at the filing date, and the filed
  figure is public at Companies House. Filing history → document metadata → iXBRL content is read
  automatically. Manual entry remains for filings with no machine-readable document.
- **Contact checks — no gap.** `duplicate_contacts`, `contact_defaults` and `inactive_contacts` are
  fully derivable from Contacts plus cached documents; the only historical unknown was Xenon's
  matching thresholds, not data availability.
- **Xenon review state and thresholds — genuinely absent from Xero, correctly application-owned.**
  Dismissed / "Mark as OK" / ignored state and per-account thresholds are Xenon application state
  with no Xero representation. This app keeps its own equivalents (`finding_review_states`,
  per-account configuration); Xenon's existing values cannot be imported without a Xenon API.

## Known parity blockers

- Purchase-tax per-client exclusions beyond confirmed core exemptions require accountant
  configuration. The mechanism exists: per-account **Ignore** and **Include asset/prepayment**
  toggles on the client page, plus a global `purchase_tax_missing_exclude_codes` setting.
  Remaining variance is per-client setup, not missing capability.
- Filed net assets cannot be extracted from accounts filed as paper/image or as untagged
  micro-entity accounts; those clients still need the figure entered once per filing.
- `inactive_contacts` counts payments as activity on the reasoning that a settled invoice is a
  ledger transaction against that contact. No Xenon row-level export for this check exists yet, so
  the payment leg is evidence-backed for correctness but not yet Xenon-confirmed.
- The health-score formula cannot be called Xenon-exact until underlying issue counts converge.
- User state in Xenon (dismissed matches, lines marked "Tax Code OK") is invisible to the
  API and accounts for the MBX bill_or_direct +4 and the Rose Canva +1.
- **Rose `purchase_tax_missing` 2758 → 5 is confirmed Xenon user-state, not a rule change.**
  View Issues paste (11/08/2026): checklist header still says `(5 Items) / £323`, but the
  table lists 20 Money Out rows all labeled **"Ignore this contact"** totaling ~£1,957 —
  i.e. **Show dismissed** is on. All 20 rows match our Xero cache exactly. Xenon's own copy
  says to dismiss items and ignore contacts; account exceptions are "ignored in settings".
  The same purchase-tax rule remains EXACT on 4X4 (116), Handymanz (10), Fast Track (309),
  and MBX (2416). Rose headline 3254 → 511 is exact arithmetic (purchase tax −2753, +10
  elsewhere). Active 5 are not on the dismissed page — need Show dismissed OFF to list them.
  No code change: forcing Rose to 5 would break the four exact clients.
- Xero data drift between Xenon's sync and ours accounts for the remaining multi-tax
  misses (removed rounding lines, deleted spends, merged contacts).

## Inactive Contacts: last activity is transaction-derived (11 Aug 2026)

Xenon's definition is "contacts with no transactions in the last 12 months". We previously
used `contact.updatedDateUTC`, which is a record-edit timestamp, not trading activity — it
was wrong in both directions. Last activity is now the newest non-voided, non-deleted
invoice, credit note or bank transaction for the contact; `updatedDateUTC` is only a
fallback for contacts that have never transacted, so a newly created contact is not
reported as dormant. Voided/deleted documents are excluded because they never happened
(Rose holds 20,764 deleted documents, which were masking 20 dormant contacts).

Effect: MBX 387 → 276. 115 contacts stopped being flagged because they genuinely trade
despite a stale contact record (Digital Ink Direct: record last edited 2021-03-19, last
real transaction 2026-07-09), and 4 started being flagged because a recent record edit was
hiding real dormancy (Cafe Mila: record edited 2026-04-15, last transaction 2025-06-18).
Also Handymanz 204 → 186, Fast Track 152 → 148, Rose 314 → 273, 4X4 277 → 276.
Not gate-scored: Xenon renders contact checks as "(!)" rather than a count.
