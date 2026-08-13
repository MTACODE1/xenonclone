# Xenon validation evidence guide

**Do not cancel Xenon until the in-app Validation Gate passes.** Existing audit notes cover only
two clients, and only one Xenon headline score is verified. They do not satisfy the gate.

## What to export for each client

Run this app for the same exact period as Xenon, then retain:

1. Xenon's headline health score, issue count, and potential-error value.
2. Count and value for each of all 29 checks (including zeroes and manual/unavailable checks).
3. The Xenon report/export source date.
4. A note for every known timing, configuration, scope, or value-definition difference.
5. At least one accurate profile tag: `high_bank_volume`, `VAT_heavy`,
   `credit_note_heavy`, or `clean`.

The `period_key` must exactly match the active app run (for example
`current_fy:2026-04-01:2027-03-31`). A newer live app run cannot be compared with an older Xenon
period without an explicit matching snapshot.

## JSON import

```json
{
  "periodKey": "current_fy:2026-04-01:2027-03-31",
  "sourceDate": "2026-08-07",
  "profileTags": ["VAT_heavy"],
  "countsTowardGate": true,
  "xenon": { "score": 82, "issues": 120, "value": 4567.89 },
  "notes": "Headline/value timing explanation, if needed",
  "scoreReason": "Accepted score reason only when delta exceeds 3",
  "checks": [
    {
      "type": "bank_balance",
      "count": 0,
      "value": 0,
      "mismatchNote": ""
    }
  ]
}
```

The `checks` array must contain exactly one entry for every check shown on the manual form.
Unknown checks are ignored, but any missing required check rejects the import.

## CSV import

Use one row per check with these headers:

```text
period_key,source_date,profile_tags,counts_toward_gate,xenon_score,xenon_issues,xenon_value_gbp,notes,score_reason,check_type,count,value,mismatch_note
```

Repeat the headline fields on all 29 rows. Separate multiple profile tags with `|`.
Quote any field containing commas or line breaks. Counts must be non-negative whole numbers;
scores and values must be non-negative numbers.

## Evidence handling

Imports are limited to 2 MB, parsed without executing content, SHA-256 hashed, and stored with
private file permissions under `data/validation-evidence/` rather than the public web directory.
The database stores the source filename, hash, date, notes, and immutable snapshot rows.

Historical MBX-derived or anonymized fixtures may be entered only with
`countsTowardGate: false` (or with the manual “Count as verified” box clear). Draft observations
remain visible in the audit trail but never count toward cancellation.

## Passing threshold

The gate requires five distinct real clients covering all four representative profiles; all 29
checks classified as API-supported or manual; at least 98% exact API-supported count parity with
every remainder explained (Xenon `!` / N/A figures and rows with a `mismatchNote` are excluded
from the ratio and do not fail the gate — they are invisible to the Accounting API by design);
all material value deltas explained; score within three points; and dated, documented passes for
review-state survival, no-data-loss sync, and workflow readiness.
