# Xenon Row-Level Evidence — 4X4&MORE LTD and Cross-Client Diagnostics

Prepared 13 Aug 2026. **Evidence extraction only — no code, formula, threshold, or database change was
made to produce this report.** All raw data was read via a standalone script using a `{readonly:
true}` SQLite connection (physically write-blocked) against `data/xero_dashboard.db`, plus two pure
logic modules (`checkRules.js`, `periodResolver.js` — both verified to contain zero database imports).
No `db/queries.js`, `xeroSync.js`, or `statementEvidence.js` was required by the extraction script, so
nothing in this pass could have triggered a write anywhere. The application, its database, and the
live running process were not touched.

Companion files (same directory): `multi_account_4x4_evidence.csv`, `multi_tax_4x4_evidence.csv`,
`capital_review_4x4_candidates.csv`, `opening_balance_cross_client_evidence.csv`.

---

## Verdict summary

| Check | Classification |
|---|---|
| **Multi-Account Suppliers** | **Xenon dual-display problem (leading hypothesis), unproven** — no row-level 4X4 evidence exists to confirm which of Xenon's two totals (if 4X4 has both) £4,399 represents. Detection is proven exact; valuation cannot be checked further without new evidence. |
| **Multi-Tax Code Suppliers** | **Unknown — insufficient evidence.** Every near-miss contact traced from our own gates has an already-documented, Xenon-consistent reason for exclusion. The two missing suppliers are not visible from anything in our own data. |
| **Capital Item Review** | **Rule-discovery problem, likely configuration-shaped.** One exact numeric match exists (account 461) but is not explainable by any keyword/type/class/threshold rule — it can only be explained by a manually curated per-account list, which is exactly how Xenon itself describes this check, and exactly how our own app already models it (currently unconfigured for this client). |
| **Opening Balance Differences** | **Insufficient evidence for a proven tolerance; two data points only.** Both known samples (4X4 £0.25, Rose £0.99) are consistent with any tolerance from just above £0.99 up to a very large bound — the true boundary cannot be pinned down further with what's available. |

---

## 1. Multi-Account Suppliers

### 1.1 Full line-level evidence, all 5 suppliers

Full detail in `multi_account_4x4_evidence.csv` (159 rows: every bill/bank-spend line for exactly
these 5 contacts, nothing else). Summary:

| Contact | ContactID | Total activity (12-mo window) | Dominant account | Why dominant | Non-dominant since-lock-date activity | Contribution |
|---|---|---|---|---|---|---|
| Ian W Bentley Bulk Transport Ltd | `9dd425a8…` | £25,943.34 across 2 codes (469, 445) | **469 Rent & Rates** | Highest all-time volume: £25,943.34 vs £849.80 on 445 | £0 — the only since-lock-date activity is on 469 itself; account 445 activity is entirely pre-period (lookback-only) | **£0.00** |
| Amazon | `f8d6eaa1…` | £1,412.30 across 2 codes (310, 325) | **310 Cost of Goods Sold** | Highest all-time volume: £1,395.65 vs £16.66 | Bill `35c1d466` (28/05/2026), account 325 Direct Expenses, split £16.65+£0.01 | **£16.66** |
| **Credit Flex** | `6b44ff63…` | £26,741.87 across 11 codes (912–923) | **917 "Credit Flex 3000"** | Highest all-time volume: £3,251.45, marginally ahead of the next-highest code | Since-lock-date activity on every one of the other 10 codes | **£12,973.62** |
| MARKETPLACE MERCHA | `94fed95a…` | £216.00 across 2 codes (485, 400) | **400 Advertising & Marketing** | Highest all-time volume: £204.00 vs £12.00 | £0 — the 485 Subscriptions activity is entirely pre-period | **£0.00** |
| BIFFA WASTE SERVIC | `6639666a…` | £1,231.80 across 2 codes (408, 491) | **408 Cleaning** | Highest all-time volume: £821.20 vs £410.60 | £0 — see 1.2 below | **£0.00** |
| **TOTAL** | | | | | | **£12,990.28** ✓ reconciles exactly |

### 1.2 A genuine coding-consistency signal our formula currently scores as zero

BIFFA WASTE SERVIC's full transaction history shows a clean account switch exactly at the lock date:
`491 Waste Disposal` used exclusively before 31/10/2025, `408 Cleaning` used exclusively from
31/10/2025 onward. This is a real "the bookkeeper started using a different code" pattern — but our
valuation formula only sums non-dominant amounts **inside** the selected period, and since only one
code (408) has any activity inside the period, the contribution is mechanically £0. The same
structural cause (all pre-period activity on the non-dominant code) also explains Ian W Bentley and
MARKETPLACE MERCHA's £0 contributions — **3 of our 5 flagged suppliers contribute nothing at all**,
and only Amazon (£16.66) and Credit Flex (£12,973.62) carry the entire £12,990.28.

### 1.3 Credit Flex — full account breakdown

All 77 transactions are `SPEND` bank transactions, `AUTHORISED` status, tax type `NONE`, contact
`6b44ff63-ed7b-407c-a35f-eff543440100`. Every code is a distinct loan-instalment liability account:

| Code | Account name | Transactions | Since-lock-date total |
|---|---|---|---|
| 912 | Credit Flex - 827.08 | 4 | £897.11 |
| 913 | Credit Flex 916.43 | 4 | £994.02 |
| 914 | Credit Flex 1530.15 | 4 | £1,657.92 |
| 915 | Credit Flex 1650 | multiple | £1,845.17 |
| 916 | Credit Flex - 760.80 | multiple | £849.98 |
| **917** | **Credit Flex 3000 (dominant)** | multiple | £3,251.45 (all-time; not counted, it's the dominant code) |
| 918 | Credit Flex 3800 | multiple | £2,331.72 |
| 919 | Credit Flex 950 | multiple | £885.60 |
| 921 | Credit Flex 3500 | multiple | £1,789.70 |
| 922 | Credit Flex 850 | multiple | £950.55 |
| 923 | Credit Flex 828 | multiple | £771.85 |

Full 77-row detail (date, Xero transaction ID, account code, amount for every single transaction) is
in `multi_account_4x4_evidence.csv`.

### 1.4 Search for existing row-level Xenon evidence — result

Searched every fixture, snapshot, JSON export, and evidence file in the project:
- `validation_snapshots` / `validation_snapshot_checks` tables — org 1 (4X4), snapshot 5: contains
  only the **summary** figure `count=5, £4,399, support_type='api'`, no supplier names, no
  `mismatch_note`.
- The evidence file this summary was extracted from, `data/validation-evidence/1-2026-08-06-cf46f702b125.json`,
  was read in full. Its schema is `{periodKey, sourceDate, xenonScore, xenonIssues, xenonValue,
  checks: [{type, count, value, supportType, mismatchNote}]}` — **the same 29-row summary shape as
  every other client's evidence file in the project.** No file anywhere contains a per-supplier
  breakdown for any client's Multi-Account check.
- Grep across every `.json` file under `data/validation-evidence/` for `suppliers`, `rows`, `names`
  arrays — none found in any file.

**NO ROW-LEVEL XENON EVIDENCE AVAILABLE FOR 4X4 MULTI-ACCOUNT.**

The only row-level Multi-Account evidence that exists anywhere in this project for *any* client is
the pasted screenshot you supplied earlier this session for 4X4 itself, which is what proved the
5-supplier detection match and which is already fully reconciled in Section 1.1 above.

### 1.5 Xenon dual-total evidence — found, and directly relevant

Searched every `mismatch_note` in `validation_snapshot_checks` for "scoreboard" / "View Issues"
language. **Three confirmed instances exist, all for Fast Track Excavations, none for 4X4:**

| Client | Check | Supplier count | Scoreboard value | View Issues value | Which did our formula match |
|---|---|---|---|---|---|
| Fast Track Excavations | `multi_account_suppliers` | 66 (same suppliers both views) | £324,839 | £347,707 | **Scoreboard, exactly** |
| Fast Track Excavations | `multi_tax_suppliers` | 45 (same suppliers both views) | £102,659 | £44,186 | **Scoreboard, exactly** |
| Fast Track Excavations | `capital_item_review` | 54 (scoreboard) / 17 (View Issues) | £149,935 | £11,177 | **Scoreboard, exactly** (unconfigured thresholds) |

This evidence pre-existed in the project (dated 2026-08-10, before this session) — it was not
generated now. For **every one of the three checks measured on Fast Track**, our current formula
matches Xenon's own internal **scoreboard** total exactly, while Xenon's separately-computed
**View Issues** total is a different number using a formula this project has never been able to
determine (the capital_item_review case is explained: View Issues reflects per-account thresholds
configured in Xenon's own settings, which we cannot see).

**No such dual-total evidence exists specifically for 4X4's Multi-Account check** — 4X4 has never
had a scoreboard-vs-View-Issues comparison recorded. Given that the *same mechanism* (Xenon scoreboard
≠ Xenon View Issues, same supplier set) is confirmed real on a different client for this exact check
type, it is a live, evidence-backed possibility — not proof — that our £12,990.28 is correct against
Xenon's own scoreboard arithmetic, and £4,399 is Xenon's separately-computed View Issues figure.

---

## 2. Multi-Tax Code Suppliers

### 2.1 Population A — the current 11, reconciling exactly to £1,648.74

| # | Contact | ContactID | Dominant tax code | Since-LD tax codes : amounts | Contribution |
|---|---|---|---|---|---|
| 1 | Napa Auto Parts | `48dda2fb…` | INPUT2 | INPUT2=£12,482.39, ZERORATEDINPUT=£312.62 | £312.62 |
| 2 | BANOZE TYRES WHOLESALE | `fc2caaae…` | INPUT2 | INPUT2=£4,505.61, ZERORATEDINPUT=£37.59 | £37.59 |
| 3 | Ian W Bentley Bulk Transport Ltd | `9dd425a8…` | INPUT2 | INPUT2=£18,264.92, ZERORATEDINPUT=£124.48, RRINPUT=£1,053.94 | £1,178.42 |
| 4 | AZ Motor Spares | `1301c62f…` | INPUT2 | INPUT2=£302.87, ZERORATEDINPUT=£0.01 | £0.01 |
| 5 | Greno Garage & Engineering Ltd | `e30e073d…` | NONE | INPUT2=£120.00, NONE=£144.00 | £120.00 |
| 6 | Volkswagen Group United Kingdom | `68a687f2…` | INPUT2 | INPUT2=£237.33, ZERORATEDINPUT=£0.04 | £0.04 |
| 7 | LEEDS UNIQUE | `18b4cfdf…` | INPUT2 | INPUT2=£608.56 only (ZERORATEDINPUT has zero since-LD activity) | £0.00 |
| 8 | Amazon | `f8d6eaa1…` | INPUT2 | INPUT2=£843.59, ZERORATEDINPUT=£0.01 | £0.01 |
| 9 | Perrys Motor Sales | `041ca753…` | INPUT2 | INPUT2=£725.58, ZERORATEDINPUT=£0.02 | £0.02 |
| 10 | BMW Service Sandal Wakefield | `8e41cf9e…` | INPUT2 | INPUT2=£89.95, ZERORATEDINPUT=£0.01 | £0.01 |
| 11 | Vertu | `00500275…` | INPUT2 | INPUT2=£12.35, ZERORATEDINPUT=£0.02 | £0.02 |
| **TOTAL** | | | | | **£1,648.74** ✓ |

Full line-level detail in `multi_tax_4x4_evidence.csv`.

### 2.2 Population B — excluded near-misses (read-only diagnostic, gates reproduced without modifying production code)

A one-off script reproduced the same source population **before** each of the app's exclusion gates
(zero-value-line filter, mileage-contact filter, since-lock-date listing gate) to find every contact
that had ≥2 raw tax codes before filtering but is not in the current 11. **Exactly 3 such contacts
exist in the whole client:**

| Contact | ContactID | Reason excluded | Raw codes | Non-zero codes | Since-LD codes |
|---|---|---|---|---|---|
| TPS Huddersfield | `69bee821…` | £0.00-line filtering reduced it to 1 code | INPUT2, NONE | INPUT2 only | INPUT2 only |
| MANDMORELTD | `328bb18e…` | £0.00-line filtering reduced it to 1 code | INPUT2, NONE | INPUT2 only | INPUT2 only |
| Ray Chapman Motors | `75e21b44…` | No since-lock-date activity at all | INPUT2, ZERORATEDINPUT | both | **none** |

**Ranking these as candidates for Xenon's missing 2 — low confidence, and here's why:**

1. **TPS Huddersfield and MANDMORELTD are NOT viable candidates.** Both are already documented in
   `XENON_PARITY_SPEC.md` from prior-session row-level verification as **confirmed correctly excluded
   by Xenon too** — the spec states verbatim: *"4X4 extras TPS Huddersfield and MANDMORELTD were
   flagged only because of a £0.00 No-VAT line... are NOT flagged [by Xenon]"*. Including them would
   directly contradict already-verified evidence.
2. **Ray Chapman Motors is the only remaining candidate, and it is weak.** Its entire multi-tax
   history is one bill dated 19/08/2025 — over two months before the lock date (31/10/2025), with
   zero since-lock-date activity of any kind. Xenon's own header wording ("including 3 months earlier
   than date range checked") describes exactly this kind of lookback for the tax-code *set*, but this
   app's research (documented in the parity spec) also established that Xenon only *lists* suppliers
   with in-period activity — which Ray Chapman Motors has none of. By the app's own already-verified
   understanding of Xenon's rule, this contact should also **not** be listed.

**Conclusion: no strong candidate for either of Xenon's missing 2 suppliers exists anywhere in our
own data or gate logic.** All 3 traceable near-misses have Xenon-consistent reasons to be excluded.
The two missing suppliers are most likely visible to Xenon through data or logic this project has no
way to observe from the Xero API responses cached here.

### 2.3 Population C — existing Xenon row-level evidence for Multi-Tax

Same search as Section 1.4, repeated for this check: no fixture, snapshot, or JSON file anywhere in
the project contains a 13-name (or any-name) Xenon Multi-Tax list for 4X4.

**NO 13-NAME XENON LIST EXISTS FOR 4X4 MULTI-TAX. Not guessing the two missing names.**

---

## 3. Capital Item Review

### 3.1 Full candidate population

1,012 purchase-side lines (ACCPAY bills + SPEND bank transactions, amount > £0) exist in the selected
period. Full detail in `capital_review_4x4_candidates.csv`. Grouped by Xero `Account.Class`:

| Class | Lines | Total £ |
|---|---|---|
| EXPENSE | 623 | £109,798.11 |
| LIABILITY | 386 | £71,527.79 |
| ASSET | 3 | £3,380.00 |
| (FIXED-type accounts were excluded from this candidate population entirely, per the check's own design — they're already capitalised) |

### 3.2 Hypothesis testing — target: exactly 3 issues, £978.78/£979

| Hypothesis | Result | Matches target? |
|---|---|---|
| Amount ≥ £500, not fixed-type | 86 lines, £106,224.43 | No |
| Amount ≥ £250, not fixed-type | 155 lines, £130,217.12 | No |
| Amount ≥ £500, EXPENSE class only | 48 lines, £68,321.66 | No |
| Amount ≥ £250, EXPENSE class only | 83 lines, £80,754.79 | No |
| Account.Type = OVERHEADS, amount ≥ £500 | 19 lines, £26,015.18 | No |
| Account.Type = OVERHEADS, amount ≥ £250 | 30 lines, £29,970.24 | No |
| Account.Type = DIRECTCOSTS, amount ≥ £500 | 29 lines, £42,306.48 | No |
| Keyword: equipment/computer/furniture/IT/machinery/vehicle in account name | **0 lines** | No — not even close |
| Keyword: printing/stationery/marketing in account name | 26 lines, £1,858.11 | No |
| **Whole account 461 selected as the sole candidate, any amount** | **3 lines, £978.78** | **YES — exact** |
| Per-account manually configured candidate list (our own app's architecture) | 0 accounts currently configured for this client (`is_capital_candidate=1` count = 0, confirmed) | N/A — nothing configured |
| Evidence imported from a prior Xenon fixture identifying account 461 | none found (Section 3.3) | N/A |

**Only one hypothesis reproduces the target, and it is not explainable by any semantic rule** — the
keyword test for genuinely capital-shaped categories (equipment, computer, machinery, vehicles)
returns **zero** matches, meaning Printing & Stationery would never be selected by an intuitive
"looks like a capital item" heuristic. Account 461's match is a numeric coincidence in appearance,
but its uniqueness (confirmed: it is the closest match among every account with ≤5 total lines in the
period, and the only 3-line exact match found by exhaustive subset search across every account code)
makes it worth recording as evidence, not dismissing outright.

### 3.3 Search for prior evidence that account 461 was ever identified for this purpose

Searched: `validation_snapshots`, `validation_snapshot_checks.mismatch_note`, every `.json` evidence
file, `chart_of_accounts_cache` configuration history, `settings` table, this project's markdown
docs (`XENON_PARITY_SPEC.md`, `APP_CONTEXT.md`, `ACCURACY_AUDIT.md`), and test fixtures.

**Result: zero mentions of account 461 or "Printing & Stationery" anywhere in the project outside
this session's own investigation.** `chart_of_accounts_cache` confirms `is_capital_candidate=0` for
every account on this client — it has never been configured, imported, or dismissed for this check.

**ACCOUNT 461 MATCH IS NUMERICALLY UNIQUE BUT NOT PROVEN TO BE XENON'S RULE.**

### 3.4 Corroborating context from a different client

Fast Track Excavations' own fixture (`mismatch_note`, dated 2026-08-10, pre-existing) states: *"unconfigured
capital thresholds reproduce Xenon scoreboard normalized 54/£149,935 exactly; View Issues shows
17/£11,177 after per-account thresholds **in Xenon settings**."* This independently confirms — on a
different client, from evidence gathered before this session — that Xenon's Capital Item Review is
architecturally a **per-client, per-account manually configured list**, not a universal formula. This
matches exactly how account 461 would need to be explained for 4X4: someone configured it in Xenon's
settings for this specific client, and no formula from Xero data alone would ever surface it.

---

## 4. Opening Balance Differences

### 4.1 Complete cross-client evidence table

| Client | Filing Date | Filed Net Assets | Xero Net Assets | Absolute Difference | Xenon Count | Xenon Potential Error | Evidence Source |
|---|---|---|---|---|---|---|---|
| 4X4&MORE LTD | 2025-10-31 | −£21,385 | −£21,385.25 | **£0.25** | 0 | £0 | Live Companies House iXBRL + Reports/BalanceSheet; Xenon summary export |
| ROSE AND CARAMEL LIMITED | 2025-10-31 | £1,000,952 | £1,000,952.99 | **£0.99** | 0 | £0 | Live Companies House iXBRL + Reports/BalanceSheet; Xenon summary export (×2 snapshots, consistent) |
| JULIA KUISMA LTD | 2020-10-31 | £7,106 | £0 | £7,106 | **NO SNAPSHOT** | **NO SNAPSHOT** | Live Companies House iXBRL; Xero side (£0) is suspect for a dissolved company and was never cross-checked against Xenon — no Xenon evidence exists for this org at all |
| HANDYMANZ LTD | — | **MISSING** | **MISSING** | **MISSING** | 0 | £0 | Xenon summary export only — our own filed/Xero comparison has never been computed for this client (no `filed_accounts` row exists) |
| Fast Track Excavations | — | **MISSING** | **MISSING** | **MISSING** | 0 | £0 | Xenon summary export only — same gap |
| MBX GRAFFIX LIMITED | — | **MISSING** | **MISSING** | **MISSING** | **2** | **£114,390** | Xenon summary export only (×2 snapshots, consistent) — this is a real, large, independently-reported discrepancy, but we cannot verify it ourselves without entering MBX's filed accounts and syncing its Balance Sheet |

Machine-readable version: `opening_balance_cross_client_evidence.csv`.

### 4.2 Candidate tolerance rules tested against the only 2 usable samples

Only 4X4 (£0.25 diff, Xenon OK) and Rose (£0.99 diff, Xenon OK) have both sides of the comparison
computed **and** a paired Xenon result. MBX's £114,390 is real Xenon evidence but has no computed
diff on our side to test a rule against — it's cited only as an upper sanity bound (any candidate
tolerance below roughly £10,000 would still correctly flag a discrepancy that large).

| Rule | 4X4 (diff £0.25) | Rose (diff £0.99) | Consistent with both "OK" results? |
|---|---|---|---|
| Exact penny comparison (tolerance £0.00) | Flags an issue | Flags an issue | **RULED OUT** |
| Round both figures to nearest £1, then compare | Equal → OK | **£1,000,952 vs £1,000,953 → NOT equal → flags an issue** | **RULED OUT — specifically by Rose** |
| Tolerance £0.50 | Clears (0.25 ≤ 0.50) | Flags (0.99 > 0.50) | **RULED OUT — specifically by Rose** |
| Tolerance £1 | Clears | Clears (0.99 ≤ 1, using the app's own `difference > tolerance` comparison) | Consistent |
| Tolerance £5 | Clears | Clears | Consistent |
| Tolerance £10 | Clears | Clears | Consistent |
| Tolerance £100 | Clears | Clears | Consistent |

**PROVEN BY SAMPLES:**
- Exact-penny comparison is wrong — both known "OK" clients would incorrectly show as issues.
- Rounding both sides to the nearest whole pound before comparing is **also wrong** — this is a
  genuinely non-obvious finding: it looks like a natural "filed accounts are whole pounds" rule, but
  it fails on Rose specifically, because £952.99 rounds up to £953, creating a new £1 discrepancy
  that isn't there in the raw comparison.
- The true tolerance is somewhere **strictly greater than £0.99**.

**RULES RULED OUT:** exact penny, round-both-to-£1, tolerance £0.50.

**RULES STILL POSSIBLE (indistinguishable with current evidence):** £1, £5, £10, £100 — and
anything else above £0.99 and comfortably below whatever separates "rounding noise" from "a real
discrepancy" (MBX's £114,390 gives no help narrowing this, since every tested value is orders of
magnitude below it). **No single tolerance can be proven from 2 data points; only the lower bound
is proven.**

---

## 5. Xenon Scoreboard vs. View-Issues Totals — full search results

Complete table of every dual-total instance found across all fixtures (all three rows are Fast
Track; no other client or check currently has this evidence recorded):

| Client | Check | Issue Count | Scoreboard Value | View Issues Value | Our Formula Value | Which We Match |
|---|---|---|---|---|---|---|
| Fast Track Excavations | Multi-Account Suppliers | 66 | £324,839 | £347,707 | £324,839 | **Scoreboard** |
| Fast Track Excavations | Multi-Tax Code Suppliers | 45 | £102,659 | £44,186 | £102,659 | **Scoreboard** |
| Fast Track Excavations | Capital Item Review | 54 (scoreboard) / 17 (View Issues) | £149,935 | £11,177 | N/A (not configured for FT either) | — |

**No dual-total evidence exists for Duplicate Invoices, or for any check on 4X4, Rose, Handymanz, or
MBX.** The pattern is currently observed on exactly one client (Fast Track) for exactly three checks.

**On the A/B/C question ("should our goal be to match scoreboard, View Issues, or store both"):**
this evidence cannot answer it in general — it can only report what's proven: on Fast Track,
matching scoreboard is what our existing formula already does, for all three checks measured,
without any deliberate targeting (the formula was fitted against row-level evidence, not against
either Xenon total). Whether that generalises to 4X4's Multi-Account/Multi-Tax gaps is unconfirmed —
flagged in Sections 1 and 2 as a leading hypothesis, not a proven fact, because 4X4 itself has never
had its own scoreboard-vs-View-Issues comparison recorded.

---

## Ranked next actions (most information for least risk)

1. **Get a Xenon scoreboard-vs-View-Issues screenshot for 4X4's Multi-Account Suppliers check
   specifically.** This is the single highest-value, lowest-risk piece of evidence available: if
   4X4's scoreboard figure is close to £12,990, the "problem" resolves to a display/definition
   question, not a formula bug — and the same screenshot request would settle Multi-Tax at the same
   time, since Xenon renders both totals on the same page type.
2. **Ask whether account 461 (Printing & Stationery) is a plausible capital-item candidate for this
   specific client** — a one-sentence question to whoever manages this client's Xenon settings (or
   the client's own knowledge of what GB PRINT & WEBSITE / Miss K Hawley purchases actually were)
   would either confirm or eliminate the only working hypothesis in under a minute, with zero
   engineering effort.
3. **Get Xenon's full Multi-Tax "View Issues" 13-name export for 4X4.** Lower priority than #1
   because Population B's analysis suggests the two missing suppliers aren't visible in our own
   gate logic at all — this would need genuinely new information from Xenon's side, not a
   re-examination of data we already have.

No code, formula, threshold, or database change was made. The live application and its running
process were not touched.
