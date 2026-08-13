# Xenon Count-Match Forensics — Handymanz & MBX

Prepared 13 Aug 2026. **Forensic investigation only — no production code, health-check algorithm,
fixture, parity expectation, database record, scoring, or threshold was changed to produce this
report.** All extraction used `{readonly: true}` SQLite connections (physically write-blocked) and
faithful, verified replication of the actual production logic from `xeroSync.js` — every
reconstructed count/value was cross-checked against the real value the last successful sync wrote
before any hypothesis testing began.

Companion files: `handymanz_unexpected_tax_code_evidence.csv` (30 rows),
`mbx_low_cost_fixed_assets_evidence.csv` (12 rows).

---

## Headline verdicts

### HANDYMANZ — Unexpected Tax Code Used

**Current:** 30 / £1,363.39 · **Xenon:** 30 / £1,308

**Classification: `INSUFFICIENT_EVIDENCE`**

**Best-supported explanation:** A net-of-VAT valuation formula lands within 21p of Xenon's figure
(£1,308.21) while preserving all 30 findings — by far the tightest fit of every hypothesis tested.
**However, this hypothesis is directly contradicted by Fast Track Excavations**, which is *already*
near-exact against Xenon on this identical check using the **current gross formula**
(£204,665.41 vs Xenon's £204,665, 41p off) and has substantial real VAT on its lines (£38,512) — so
switching to net would move Fast Track from near-perfect to wrong by £38,512. No other tested
hypothesis explains the £55.39 gap without either breaking the count or resorting to an implausible,
economically meaningless multi-contact coincidence (detailed below). The true cause of Handymanz's
gap is not established.

**Confidence: Low.** The net hypothesis is numerically excellent in isolation but is falsified as a
*universal* rule by cross-client evidence gathered in this same investigation.

### MBX — Low Cost Fixed Assets

**Current:** 12 / £555.52 · **Xenon:** 12 / £463

**Classification: `LIKELY_VALUATION_RULE`**

**Best-supported explanation:** All 12 findings are `SPEND` bank transactions where Xero's own
`lineAmount` field is VAT-**inclusive** (gross) for this client's bank feed. Computing the net value
(`lineAmount − taxAmount`) reproduces exactly `subTotal` on every single row and totals £462.94 —
6 pence from Xenon's £463, a 0.013% residual, with the £200 threshold comparison unaffected (the
largest net value is £100.43, nowhere near the boundary) and the count staying at 12.

**Confidence: Medium.** This is a clean, mechanically-explained fit with no contradicting evidence
from any other client — but MBX is the *only* client with any Low Cost Fixed Assets activity at all,
so the finding cannot be cross-validated the way Handymanz's was, and no row-level Xenon evidence
exists to confirm it directly.

---

# PART 1 — HANDYMANZ: Unexpected Tax Code Used

## 1. All 30 findings, reconciling exactly to £1,363.39

Full detail (every field requested) is in `handymanz_unexpected_tax_code_evidence.csv`. Summary of
the population:

- **28 findings from ACCPAY bills**, **2 from SPEND bank transactions** — zero from invoices or
  RECEIVE transactions (this client has no ACCREC/RECEIVE lines with a tax-code mismatch).
- **Every line's actual tax type is `INPUT2`.** The expected default varies by contact:
  `ZERORATEDINPUT` (27 findings), `RRINPUT` (2, both Edf Energy), `NONE` (1, Screwfix).
- **Zero negative lines, zero zero-value lines.** All GBP, currency rate 1 or unset (never foreign).
- **Zero documents contribute more than one finding line** — every finding is the sole qualifying
  line on its own document.
- **Mixed `lineAmountTypes` within the same 30-row set**: 19 documents are `Exclusive` (Xero's
  `lineAmount` is already net), 11 are `Inclusive` (Xero's `lineAmount` is VAT-inclusive/gross). This
  mix exists in the client's own bookkeeping — some bills/transactions were entered net, others
  gross — and is why summing raw `lineAmount` blends two different bases.

Sum of raw `lineAmount` (current production formula) = **£1,363.39**, reconciling exactly.

## 2. Current valuation formula

**File/function:** `src/services/xeroSync.js`, the `unexpected_tax_code_used` block (lines
1459–1526), and `findUnexpectedDefaultLines` in `checkRules.js` (used only for the bill-side source;
the other three sources are inlined with equivalent logic).

**Pseudocode, exactly reproducing production:**

```
findings = []
for bill in billsSinceLockDate(ACCPAY, status AUTHORISED or PAID):
    expected = contact.accountsPayableTaxType
    if not expected: continue
    for line in bill.lineItems:
        if line.taxType and line.taxType != expected:
            findings.push({ amount: line.lineAmount, source: 'bill', ... })

for invoice in sinceLockDate(ACCREC, status AUTHORISED or PAID):
    expected = contact.accountsReceivableTaxType
    if not expected: continue
    for line in invoice.lineItems:
        if line.taxType and line.taxType != expected:
            findings.push({ amount: line.lineAmount, source: 'invoice', ... })

for txn in periodFiltered(bankSpendTxns):          # status AUTHORISED, type SPEND
    expected = contact.accountsPayableTaxType
    if not expected: continue
    for line in txn.lineItems:
        if line.taxType and line.taxType != expected:
            findings.push({ amount: line.lineAmount, source: 'bank_spend', ... })

for txn in periodFiltered(bankReceiveTxns):        # status AUTHORISED, type RECEIVE
    expected = contact.accountsReceivableTaxType
    if not expected: continue
    for line in txn.lineItems:
        if line.taxType and line.taxType != expected:
            findings.push({ amount: line.lineAmount, source: 'bank_receive', ... })

count = len(findings)
potential_value_gbp = sum(abs(f.amount) for f in findings)   # <-- the valuation
```

**Which value is used:** `line.lineAmount` — **the raw net-or-gross value as Xero stores it on that
specific line**, whatever `LineAmountTypes` the document happened to use. It is **not** `taxAmount`,
**not** a normalised net or gross figure, **not** `SubTotal`/`Total`/`AmountDue`, and **not**
deduplicated per document (though in this dataset that distinction never arises, since no document
has more than one finding).

## 3. The £55.39 difference — all 16 hypotheses tested

| # | Hypothesis | Calculated value | Diff from £1,308 | Count stays 30? |
|---|---|---|---|---|
| A | Net line values (`Inclusive` docs: `lineAmount − taxAmount`; `Exclusive` docs: as-is) | **£1,308.21** | **£0.21** | Yes |
| B | Gross line values (`Exclusive` docs: `lineAmount + taxAmount`; `Inclusive`: as-is) | £1,569.88 | £261.88 | Yes |
| C | TaxAmount only | £261.67 | −£1,046.33 | Yes |
| D | Rounded line values (whole £, per line) | £1,364.00 | £56.00 | Yes |
| E | Rounded document totals (whole £, per line) | £1,581.00 | £273.00 | Yes |
| F | One value per document rather than per line | £1,363.39 (no change — 0 documents have >1 finding line) | £55.39 | Yes |
| G | Excluding negative/credit lines | £1,363.39 (no change — none exist) | £55.39 | Yes |
| H | Excluding zero-value lines | £1,363.39 (no change — none exist) | £55.39 | Yes |
| I | Excluding specific expected-TaxType groups (e.g. drop all `RRINPUT`- or `NONE`-expected findings) | £1,332.54 (drop RRINPUT) / £1,338.00 (drop NONE) | −£24.54 / −£30.00 | **No — drops to 28/29** |
| J | Only minority/unexpected TaxType exposure | Same as base — every finding *is* the minority line by the check's own definition | £55.39 | Yes |
| K | Contact-default-tax comparison | Same as base — this is already how the check is defined | £55.39 | Yes |
| L | Account-default-tax comparison | Not testable as a *valuation* hypothesis without changing *detection* (would need Xero account-level default tax data, which isn't what this check compares against) | n/a | n/a |
| M | Date/window differences | Not applicable — count already matches Xenon's 30 exactly, so no window adjustment is indicated | n/a | Yes |
| N | VAT-inclusive vs VAT-exclusive treatment | Same as A/B above | see A/B | Yes |
| O | Duplicate document/line contribution | Confirmed zero duplicate documents (see §1) — not the cause | n/a | Yes |
| P | Currency conversion differences | Ruled out — every finding is GBP at rate 1 or unset; no foreign currency present | n/a | Yes |

**Hypothesis A is the only one within a pound of Xenon's figure, at 21 pence — 260× closer than the
next-best full-population hypothesis (B).** Verified this is not a rounding artefact: summing the
11 `Inclusive` documents' net values rounded to 2dp individually, versus summing raw and rounding once
at the end, produce the identical £1,308.21 either way. The residual is a genuine 21p gap, not a
display-rounding coincidence.

**Per the task's explicit instruction not to select a rule merely because rounding produces the
target:** Hypothesis A was *not* selected on that basis — it is the only hypothesis with a coherent
economic rationale (VAT is normally recoverable, so a misclassification's real exposure is the net
amount) that also happens to fit tightly. That is precisely why Part 3's cross-client check matters:
**it falsifies A anyway**, on genuinely independent evidence (see below).

### The cross-client contradiction (this is the decisive finding)

Fast Track Excavations has the *same check type*, a large population (55 findings), substantial real
VAT (£38,512 across 29 of 55 lines), and is **already exact against Xenon using the current gross
formula**: £204,665.41 vs Xenon's £204,665 (41p off — tighter, proportionally, than Handymanz's net
fit). Recomputing Fast Track's total using Hypothesis A's net formula gives **£166,153.41** — a
£38,512 divergence from Xenon, not a 21p one. **A formula cannot be "net" for Handymanz and "gross"
for Fast Track on the identical check** unless something else distinguishes the two clients that this
investigation has not identified. This means Hypothesis A, despite its excellent isolated fit, cannot
be recommended as Xenon's actual rule.

### Ruling out a spurious "explained exclusion" (hypothesis O / dismissed-state check)

A brute-force search for any subset of Handymanz's 30 gross line amounts summing to exactly £55.39
(which would support a "one dismissed/excluded line, otherwise gross" theory, consistent with Fast
Track) **did find a match — but it is not a plausible real-world exclusion**: a 6-line combination
spanning three unrelated contacts (Amazon, Plumbfix, Wickes) with no shared account, date, or tax
property. This is exactly the class of coincidence the task instructions warned against selecting.
With 30 line values mostly in the £5–£30 range, *some* subset summing to nearly any plausible target
is close to guaranteed by combinatorics alone — this is noise, not evidence, and is explicitly not
being recommended as an explanation.

**Net result: no hypothesis tested explains the £55.39 gap in a way that is both numerically precise
and free of contradiction or implausibility.**

## 4. Search for existing Xenon row-level evidence

Searched: `validation_snapshots`, `validation_snapshot_checks.mismatch_note` (all rows), every
`.json` file under `data/validation-evidence/`, and this project's markdown documentation.

The only record found is the plain summary pair already known: `xenon_count=30, xenon_value_gbp=1308,
support_type='api', mismatch_note=null` (from `HANDYMANZ_LTD-xenon-2026-08-06.json`). No per-line,
per-document, or per-contact breakdown exists anywhere in the project for this check on this client.

**NO ROW-LEVEL XENON EVIDENCE AVAILABLE FOR HANDYMANZ UNEXPECTED TAX CODE USED.**

---

# PART 2 — MBX: Low Cost Fixed Assets

## 5. All 12 findings, reconciling exactly to £555.52

Full detail in `mbx_low_cost_fixed_assets_evidence.csv`. Every one of the 12 findings:
- Is a **`SPEND` bank transaction** (zero from ACCPAY bills).
- Is coded to **account `760` "Motor Vehicles"** (Xero `Account.Type = FIXED`, `Account.Class = ASSET`)
  — the *only* fixed-asset account with any qualifying activity; the other 13 fixed-asset accounts on
  this client's chart of accounts (750, 751, 761, 721, 710, 741, 711, 765, 771, 720, 764, 770, 740)
  have none.
- Has **currency GBP** throughout, no foreign-currency lines.
- Has **`lineAmount` exactly equal to `total`** (i.e. VAT-inclusive/gross) on every row — this bank
  feed enters SPEND lines gross for this client.

| Contact | Date | Xero ID | LineAmount (gross) | TaxAmount | SubTotal (net) |
|---|---|---|---|---|---|
| TESCO | 2020-07-13 | `…` | £83.45 | £13.91 | £69.54 |
| TAG LANE | 2023-08-15 | `…` | £16.99 | £2.83 | £14.16 |
| EK MOTOR FACTORS | 2024-07-19 | `…` | £20.21 | £3.37 | £16.84 |
| TESCO | 2024-07-29 | `…` | £14.87 | £2.48 | £12.39 |
| CO-OP | 2024-01-02 | `…` | £43.14 | £7.19 | £35.95 |
| FUEL CARD | 2020-06-19 | `…` | £12.32 | £2.05 | £10.27 |
| VMS ROADCHEF | 2023-12-27 | `…` | £8.98 | £1.50 | £7.48 |
| truckhaven | 2024-11-11 | `…` | £53.16 | £8.86 | £44.30 |
| truckhaven | 2023-12-27 | `…` | £61.82 | £10.30 | £51.52 |
| TESCO | 2024-09-23 | `…` | £20.00 | £3.33 | £16.67 |
| truckhaven | 2024-08-05 | `…` | £100.07 | £16.68 | £83.39 |
| national tyre | 2023-04-25 | `…` | £120.51 | £20.08 | £100.43 |
| **Sum** | | | **£555.52** ✓ | £92.58 | **£462.94** |

## 6. Detection logic

**File/function:** `xeroSync.js`, `low_cost_fixed_assets` block (lines 1293–1332).

```
FIXED_ASSET_ACCOUNTS = { account.code for account in chartOfAccounts
                          if account.Type == 'FIXED' and (account.Class is unset or account.Class == 'ASSET') }
THRESHOLD = 200

items = []
for bill in billsSinceLockDate(ACCPAY, status AUTHORISED or PAID):
    for line in bill.lineItems:
        amount = line.lineAmount              # <-- net-or-gross, whatever Xero stored
        if amount > 0 and amount <= THRESHOLD and line.accountCode in FIXED_ASSET_ACCOUNTS:
            items.push({ amount, source: 'bill' })

for txn in periodFiltered(bankSpendTxns):      # status AUTHORISED, type SPEND
    for line in txn.lineItems:
        amount = line.lineAmount
        if amount > 0 and amount <= THRESHOLD and line.accountCode in FIXED_ASSET_ACCOUNTS:
            items.push({ amount, source: 'bank_spend' })

count = len(items)
potential_value_gbp = sum(abs(item.amount) for item in items)
```

Direct answers:
- **Qualifying account:** Xero's own `Account.Type = 'FIXED'` (with `Class` unset or `'ASSET'`) —
  no accountant configuration, unlike `capital_item_review`.
- **Threshold:** fixed at £200, not configurable, compared against `line.lineAmount` **as Xero
  stored it** — i.e. gross where the document is VAT-inclusive, net where it's VAT-exclusive. The
  comparison is **not** normalised to one basis before thresholding.
- **ACCPAY bills:** included. **SPEND bank transactions:** included. **Journals:** not included —
  no journal endpoint is called anywhere in the codebase (confirmed in earlier session forensics).
- **Negative lines:** excluded by `amount > 0`.
- **Granularity:** one issue per **line**, not per document (though for this dataset it makes no
  difference — no document contributes more than one finding line).

## 7. Valuation and the £92.52 difference — all 17 hypotheses tested

| # | Hypothesis | Issue count | Calculated value | Diff from £463 |
|---|---|---|---|---|
| A | Net amount (`lineAmount − taxAmount`) | 12 | **£462.94** | **−£0.06** |
| B | Gross amount (current formula) | 12 | £555.52 | £92.52 |
| C | Tax-exclusive amount = `subTotal` field directly | 12 | £462.94 | −£0.06 |
| D | Tax-inclusive amount = `total` field directly | 12 | £555.52 | £92.52 |
| E | TaxAmount removed (same computation as A) | 12 | £462.94 | −£0.06 |
| F | Absolute vs signed amounts | 12 | £555.52 (no negatives exist, so identical to B) | £92.52 |
| G | Excluding credits/negative lines | 12 | £555.52 (none exist, no change) | £92.52 |
| H | One amount per document | 12 | £555.52 (no document has >1 finding line, no change) | £92.52 |
| I | Threshold applied to net rather than gross | 12 (unchanged — max net value £100.43, nowhere near £200) | £462.94 | −£0.06 |
| J | Threshold applied to whole document rather than line | Not testable without a different document-total field being compared — no document here has other lines that would change this | n/a | n/a |
| K | Different fixed-asset account population | 12 (only account 760 has any activity — no other FIXED account contributes) | £555.52 | £92.52 |
| L | Excluding certain Account.Type/Class combinations | n/a — all 12 already share the identical Type=FIXED/Class=ASSET; nothing to exclude | n/a | n/a |
| M | Rounding each issue to whole pounds | 12 | £562.00 (gross) / £462.00 (net) | £99.00 / −£1.00 |
| N | Rounding only the final total | 12 | £555.52 / £462.94 (rounding a number already at 2dp changes nothing) | same as B/A |
| O | Currency conversion | n/a — all GBP, no conversion applies | n/a | n/a |
| P | Duplicate/linked transactions | 0 duplicates found (12 distinct `bankTransactionID`s) | n/a | n/a |
| Q | Journal-vs-purchase distinction | n/a — no journals are fetched by this codebase at all | n/a | n/a |

**Hypothesis A/C/E (all three are the same net calculation, verified identical) is the only match,
landing 6 pence from Xenon's figure — the tightest residual found in this entire investigation** —
while preserving the count at 12 and not touching the £200 threshold's outcome for any line.

Confirmed mechanically clean: `lineAmount − taxAmount` equals the document's own `subTotal` field
**exactly**, to the penny, on all 12 rows (verified row-by-row) — this is not an approximation, it is
recovering the actual net value Xero itself already computed and stored for each transaction.

## 8. Does count=12 mean row-membership=12 identical rows? — Unproven

Searched every fixture, snapshot, and JSON file for row-level Low Cost Fixed Assets evidence for MBX.
The only record found: `xenon_count=12, xenon_value_gbp=463, support_type='api'` from
`MBX_GRAFFIX_LIMITED-xenon-2026-08-07.json`, carried forward unchanged into the later checklist
re-ingest (`mbx-xenon-checklist-2026-08-07.json`), whose own `mismatch_note` states explicitly:
*"Count exact (12). £ delta vs prior export is timing/line-mix drift; checklist paste has no
per-check £."* — i.e. even the later re-ingest could not independently re-derive the £463 figure; it
inherited it from the earlier export.

No per-transaction list exists to compare against our 12 specific bank transaction IDs.

**COUNT MATCHES — ROW MEMBERSHIP UNPROVEN.** The 12-vs-12 agreement, combined with the clean 6p
value fit, is suggestive that the underlying population is the same set — but this is inference, not
proof, and is explicitly not being claimed as proof.

---

# PART 3 — Cross-check the valuation engine

Compared the two new cases against every check with a currently-solved (exact or near-exact) Xenon
value, using data already gathered this session and in `XENON_PARITY_MATRIX.md`:

| Check | Value field used in production | Basis (confirmed) | Evidence |
|---|---|---|---|
| Duplicate Invoices | one document's `total` per group | **Gross** (VAT-inclusive) | Row-exact vs Xenon on 4X4 (£3,509.90/£3,510) and clean on 4 other clients |
| Duplicate Bills | one document's `total` per group | **Gross** | Row-exact vs Xenon on 4X4 (£492.63/£493) and MBX (£943.57/£944) |
| Old Unpaid Invoices/Bills | `amountDue` (VAT-inclusive on a Xero invoice) | **Gross** | Exact on Fast Track and MBX (both date-relative, but currently exact) |
| Unexpected Tax Code Used | `lineAmount` as stored | **Gross fits Fast Track almost exactly** (£204,665.41 vs £204,665); **net fits Handymanz far better** (£1,308.21 vs £1,308) — **contradictory across clients** | This investigation |
| Low Cost Fixed Assets | `lineAmount` as stored | **Net fits MBX** (£462.94 vs £463) — the only client with data | This investigation |
| Sales/Purchase Tax Missing | `lineAmount` on lines with **no tax code** | Not informative — net and gross are identical when no VAT is present | N/A |
| Multi-Account/Multi-Tax Suppliers | `lineAmount` as stored, non-dominant amounts | Not informative for this question — the existing 4X4/Fast Track/Rose gaps are orders of magnitude larger than a VAT-scale difference and already have a separate, better-evidenced explanation (Xenon's own scoreboard-vs-View-Issues dual total, documented in `XENON_ROW_LEVEL_EVIDENCE.md`) | Prior session |

**Conclusion: the evidence does NOT support one universal Potential Error convention.** Every
check with a *proven, row-exact* match (Duplicate Invoices, Duplicate Bills, Old Unpaid items) uses
**gross**. Fast Track's own near-perfect fit on Unexpected Tax Code Used reinforces gross as that
check's real convention too. Low Cost Fixed Assets is the one place net fits better — but on a
single-client, unconfirmed data point, this could equally be a coincidence of MBX's specific data
shape rather than a genuine check-specific rule. **Per the task's explicit instruction not to force
one universal formula where the evidence shows check-specific behaviour: it does not, in fact,
cleanly show check-specific behaviour either — it shows one contradiction (Unexpected Tax Code Used)
and one single-client fit (Low Cost Fixed Assets), which is a materially weaker evidentiary position
than "gross for documents, net for lines" would have been.**

---

# PART 4 — Classification

| Case | Classification | Rationale |
|---|---|---|
| Handymanz — Unexpected Tax Code Used | **`INSUFFICIENT_EVIDENCE`** | The only numerically tight hypothesis (net, 21p residual) is directly falsified by Fast Track's near-exact gross fit on the identical check. No alternative hypothesis fits without breaking the count or resorting to an implausible cross-contact coincidence. |
| MBX — Low Cost Fixed Assets | **`LIKELY_VALUATION_RULE`** | Net (`lineAmount − taxAmount`, mechanically equal to Xero's own `subTotal`) fits within 6 pence, preserves the count, and is uncontradicted by any other client — but MBX is the only client with data for this check, and no row-level Xenon evidence exists to prove either the formula or row membership, so it stops short of `VALUATION_RULE_IDENTIFIED`. |

**No change is recommended to `XENON_PARITY_MATRIX.md` in this task**, per instruction. If it is
updated in a future task, MBX's row would move from `COUNT_MATCH_ONLY` toward a `LIKELY_VALUATION_RULE`
annotation once evidence review confirms it; Handymanz's row should **not** be reclassified as a
value discrepancy explained by net-vs-gross, since that explanation is now disproven.

---

# Final Answers

**1. Can either discrepancy be fixed safely now?**
**No, for both — but for different reasons.** Handymanz: the best-fitting formula is actively
disproven by Fast Track's data; applying it would fix Handymanz and break Fast Track. MBX: the net
formula is uncontradicted and precise, but it rests on exactly one client's evidence with no
row-level Xenon confirmation — not a safe basis for a global algorithm change on its own.

**2. If yes, what exact formula would change?**
N/A for Handymanz (no safe fix identified). For MBX, *if* further evidence confirmed it: change
`low_cost_fixed_assets`' valuation from `sumAbsoluteExposure(lowCostItems)` (summing raw
`line.lineAmount`) to summing `line.lineAmount - line.taxAmount` per item — i.e. exactly the same
value the ACCPAY-side `purchase_tax_missing` check already treats as "the line" conceptually, just
applied to fixed-asset lines here.

**3. What other clients/checks would that change affect?**
For `low_cost_fixed_assets` specifically: only MBX currently has any activity at all (4X4, Handymanz,
Rose, Fast Track all show 0/£0, so a net-vs-gross change would not move their numbers). For
`unexpected_tax_code_used`, changing the formula to net would move **every** client with activity —
Fast Track (would break, £204,665.41 → £166,153.41, a £38,512 regression), Rose (£12,436.23 →
£11,119.39, currently `COUNT_MATCH_ONLY` at 60/£12,436 vs Xenon 60/£12,004 — net would land at
£11,119, actually *worse*, moving further from Xenon's £12,004), and MBX (£4,641.10 → £4,533.59,
count already mismatched at 615 vs 614 so this check has its own separate, unresolved count problem
too). **This confirms a net-value change to this check would harm more clients than it helps.**

**4. Which existing regression tests would protect us?**
None directly guard either of these two checks — `test/xenonParity.test.js` currently locks only
Duplicate Invoices, Duplicate Bills, Old Sales Credits (Rose), and Unreconciled Bank Items (Fast
Track). A change to `unexpected_tax_code_used` or `low_cost_fixed_assets` valuation would not be
caught by any existing hard-locked test today — this is a genuine coverage gap.

**5. What new regression test would be required?**
Before any formula change: a hermetic fixture-based test locking **Fast Track's current gross-based
£204,665.41** for `unexpected_tax_code_used` (to catch exactly the regression identified in Q3), plus
one for MBX's current state pending resolution. Since low_cost_fixed_assets currently has no
regression coverage at all and only MBX has any data, a frozen-fixture lock of MBX's current 12/£555.52
(the CURRENT, not the hypothesised, value) would at least protect against accidental regression while
the valuation question remains open.

**6. If evidence is insufficient, what exact Xenon screenshot/export/row-level information would
prove the rule?**
For Handymanz: Xenon's "View Issues" row-level export for `unexpected_tax_code_used`, showing the
£ value displayed against each of the 30 (or however many Xenon actually lists) individual
transactions — this would immediately reveal whether Xenon uses net or gross per line, and would
also resolve whether Handymanz's Xenon list is genuinely the same 30 transactions as ours. The same
export type for Fast Track would let this be cross-checked in the same pass, closing the
contradiction definitively either way.
For MBX: the equivalent row-level "View Issues" export for `low_cost_fixed_assets`, showing the 12
transactions Xenon itself lists with their individual values — this would prove or disprove both the
net-value hypothesis and row membership in one document, since MBX is the only client where this
check currently has any data to compare.
