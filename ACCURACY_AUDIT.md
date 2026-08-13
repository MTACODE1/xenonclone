# Health Check Accuracy Audit — Session Findings

> **Purpose:** Log of an accuracy audit comparing this app's health-check output against the real Xenon Connect reports for two live clients (Fast Track Excavations, MBX Graffix Limited). Captures what was found, what was fixed, and what's still open — so the next session (or the next developer) doesn't have to re-derive it. See `APP_CONTEXT.md` for how the app works in general; this file is about *whether its numbers are trustworthy*.

---

## Why this audit happened

The practice pasted real Xenon Connect output side-by-side with this app's output for two clients. The brief was simple: find out why the numbers don't match, and fix whatever is actually broken — without just chasing Xenon's numbers blindly, since Xenon's snapshots turned out to often be from an earlier point in time than our live sync.

The single most important thing learned this session: **a numeric mismatch against Xenon is not evidence of a bug on its own.** Every discrepancy had to be individually diagnosed against live Xero data before deciding whether it was:
1. a real bug in our check logic,
2. **data drift** — Xenon's report is a snapshot from an earlier date, and the demo Xero tenant's data has since changed (more bills added, more unreconciled items accumulated, etc.), or
3. a legitimate design difference (e.g. a check that inherently requires per-client manual configuration).

Roughly half of the large discrepancies found turned out to be (2) or (3), not bugs. Fixing those would have made the numbers *worse*, not better.

---

## Fixes shipped this session

### Fast Track Excavations

| Check | Before | After | Root cause |
|---|---|---|---|
| Sales/Purchase Tax Missing | counted distinct invoices | counted individual lines | An invoice with 5 lines missing tax is 5 issues to fix, not 1. The £ total already summed per-line, which is why the money matched (£66,782) while the count was off by 50 (76 vs 26). **Now exact match to Xenon (76).** |
| Unreconciled Bank Items | 0 (false "OK") | 74 | Check was scoped to an invented "7–90 days old" window. This client's unreconciled items were *all* older than 90 days, so the check silently found nothing. Also fixed: the underlying fetch only requested page 1 with no pagination loop. |
| Capital Item Review | keyword-guessed accounts | "Not configured" until set up | The keyword heuristic (`equipment`, `machinery`, etc., excluding `hire`) wrongly excluded this client's real asset account, literally named **"Equipment hire"**. Proved the whole keyword-based approach can't generalize across industries. Replaced with a proper per-client feature (see below). |

### MBX Graffix Limited

| Check | Before | After | Root cause |
|---|---|---|---|
| Sales Tax Missing | 2 / £760 | 72 / £29,326 | Only checked invoices. Its sibling check (`purchase_tax_missing`) already checked bank *spend* transactions coded to expense accounts, but the sales-side equivalent (bank *receive* transactions coded to revenue accounts) was missing entirely. This client receives a lot of income as direct deposits (PayPal transfers, a government grant) that bypass invoicing. |
| Unexpected Account Used | 396 / £54,254 | 10 / £54,254 | One contact's stored `purchasesDefaultAccountCode` had simply gone stale — 357 of 361 real bill lines (99%) used a *different* account, consistently, for years. Every one of those 357 lines was being counted as a separate issue. Fixed by **grouping findings by (contact, code actually used)** instead of flagging every line — same pattern `Multi-Account Suppliers` already used. |
| Unexpected Tax Code Used | 82 / £47 | 5 / £47 | Same stale-default-multiplication bug, same contact (ORO2U, 65 of 82 issues). Fixed with the same grouping approach. |
| Purchase Tax Missing | 2,577 / £79,417 | 1,376 / £42,326 | The exempt-account keyword list (`bank fee`, `pension`, etc.) had a **regex pluralization bug** — `\bfee\b` never matches "Fees" because there's no word boundary between "fee" and the trailing "s". So accounts literally named "Bank Fees", "Bank Charges", and "Pensions Costs" were never actually exempted despite being conceptually on the list. Also added PayPal/card/merchant processing fees as an exempt category (same financial-services-fee logic as bank fees, just a different processor). |
| Multi-Account/Tax Code Suppliers | 90+53 / £61,727+£24,339 | 71+25 / £61,480+£24,232 | No materiality floor — a contact using two account codes where the "wrong" one totals £3 was counted the same as one where it totals £10,000. Added a configurable minimum (`multi_account_suppliers_min_value` / `multi_tax_suppliers_min_value`, default £25). **Only partially closes the gap to Xenon (71 vs 39) — see Open Items.** |

Confirmed **not bugs** (investigated and left alone):
- At the time, `Bank Balance Check` and `Unreconciled Bank Items` intentionally summed the same
  pool differently. The later Xenon comparison below superseded that decision: this was not an
  accurate implementation of Xenon's bank-balance check and double-counted potential errors.
- `Old Unpaid Bills` (424) and `Unapproved Bills` (475) for MBX, where Xenon shows "OK" — sample data confirmed these are real, dated, aged bills (some back to 2020). Xenon's snapshot almost certainly predates this backlog.

---

## Follow-up MBX alignment pass — 7 August 2026

A newer Xenon report for MBX showed 5,087 issues / £769,118 / 32%, versus this app's
3,653 / £902,150 / 66%. It also showed that some earlier design choices improved conceptual
grouping but moved the displayed figures away from Xenon's counting rules.

Changes made:

- `unexpected_account_used` and `unexpected_tax_code_used` now count each offending line, as
  Xenon does, while retaining contact/default information in each detail row. Direct bank
  SPEND/RECEIVE lines are included as well as bills and invoices.
- `low_cost_fixed_assets` now includes direct bank SPEND lines, not only supplier bills.
- `bank_balance` no longer reuses gross unreconciled volume. It uses Xero's calculated balance
  against an accountant-entered statement balance; without statement balances it reports
  **Not configured**. This removes the previous double-counting with Unreconciled Bank.
- `unprocessed_bank` and `opening_balance_differences` now store a null count and display
  **Unavailable**, rather than a misleading zero/OK.

Still deliberately unchanged pending issue-row evidence:

- ~~Unreconciled Bank (829 vs Xenon's 117): Xenon's subset rule is not yet known.~~
  **Resolved from Xenon CSVs (7 Aug 2026):** count AUTHORISED bank transactions with
  `IsReconciled=false` **plus** AUTHORISED payments with `IsReconciled=false`. The previous
  query included DELETED bank transactions (752 of 829 on MBX). Live recompute against those
  CSVs: 77 bank + 44 payments = 121; the 4-item overage were posted after Xenon's 05/08 snapshot.
- Purchase Tax Missing (1,376 vs 2,411): exact per-client exempt accounts are not known.
  **Partial fix (7 Aug 2026):** removed PayPal/card/merchant auto-exemptions after live recount
  showed those alone suppressed 967 MBX lines (£23,269). Keeping core statutory + bank-fee
  exemptions yields ~2,342 / £65,546 vs Xenon's 2,411 / £55,630 (count within ~3%). Remaining
  £ gap may be Xenon dismissals or additional per-client exceptions.
- Bill or Direct (87 vs 42): exact matching/consumption rule is not known.
- Health score formula: recalibration must wait until the underlying check counts converge.

---

## The new Capital Item Review design

This was the one check that needed an architectural change, not just a bug fix. Xenon's own description says the threshold is "set for that particular account **in settings**" — i.e. it's inherently a per-client, accountant-configured judgment call, not something a keyword rule can infer from an account name. Built:

- `chart_of_accounts_cache` table — caches each org's chart of accounts every sync, with an `is_capital_candidate` flag that sync never touches (only the accountant sets it).
- A picker panel on the client page (`/client/:tenantId` → "Capital Item Review — Account Setup") listing that client's actual expense accounts with checkboxes.
- Until configured, the check shows **"Not configured"** — a distinct state from "OK" — rather than guessing (or silently under/over-flagging).

---

## Recurring bug patterns (useful if auditing another client)

1. **Line vs. entity granularity.** Several checks summed money per-line but counted issues per-invoice/transaction. If the £ total matches but the count doesn't, check this first.
2. **Missing the bank-transaction half of a check.** A few "sales vs purchase" check pairs only had one side wired up to bank Spend/Receive transactions. If a check's Xenon count is *much* higher than ours, check whether direct bank deposits/payments are included.
3. **Stale contact defaults multiplying into volume.** `purchasesDefaultAccountCode`/`accountsPayableTaxType` etc. are point-in-time fields that can silently drift from actual behavior. Xenon nevertheless counts each offending line. Keep the line-level headline count for parity, but retain contact/code fields so the UI can also group rows for efficient remediation.
4. **No materiality floor.** Several aggregate/pattern checks (Multi-Account Suppliers, Multi-Tax Code Suppliers) had no minimum £ before counting a pattern as an "issue," so £3 noise counted the same as £10,000 problems.
5. **Regex word-boundary bugs with plurals.** `\bfee\b` doesn't match "Fees". Worth grep-checking every keyword-exclusion regex in this codebase for the same issue.
6. **Keyword-based account classification doesn't generalize.** Anything that tries to guess "which accounts are X" from account *names* (not explicit config) will break on some client's naming convention. Capital Item Review already learned this lesson; worth remembering if a similar heuristic is proposed elsewhere.

---

## Open items (known, not yet closed)

- **Multi-Account / Multi-Tax Suppliers for MBX**: latest comparison is 71 vs Xenon's 81 and
  25 vs Xenon's 65. The £ totals move in the opposite direction, confirming a different issue
  and potential-value definition rather than one simple threshold.
- **Purchase Tax Missing for MBX**: latest comparison is 1,376 / £42,326 vs Xenon's
  2,411 / £55,630. Xenon's per-client account exemptions are still unknown.
- Neither of the above blocks correctness — both are *closer* than before, just not exact. Given how much of this session was "Xenon's own number was stale, not ours," it's not obvious either of these needs further chasing without more evidence.
- Fast Track Excavations and MBX Graffix Limited are the only two clients audited this way so far. Other connected clients haven't been checked against a real Xenon report.
- No client except Fast Track has had its Capital Item Review accounts configured yet (only "Equipment hire" was set up, as a demonstration).

---

## What this means for the project going forward

The check logic is broadly sound in *design* (the CLAUDE.md spec's check definitions are reasonable), but several checks had real, specific implementation bugs that inflated or deflated counts by 10-50x in ways that would mislead a bookkeeper using this tool for real decisions. All fixes above were verified against live Xero data (not just theory) before being shipped — synced, checked the DB, and in several cases pulled raw Xero API data directly to confirm the root cause before writing a fix.

The deeper lesson: this tool's job is to be *correct*, not to *match Xenon*. Xenon's numbers were a useful signal for "something's off, go look here," but treating them as ground truth would have been a mistake in at least half of the cases investigated.
