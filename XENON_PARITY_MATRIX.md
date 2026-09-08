# Xenon Parity Matrix

Generated 2026-09-07 by `scripts/generate-xenon-parity-matrix.js`. Read-only — no database or application state was modified to produce this report.

Legend: **EXACT** count and value both match Xenon · **COUNT_MATCH_ONLY** count matches, value does not · **MISMATCH** neither matches · **CONFIG_REQUIRED** needs a one-time setup step in this app · **EXTERNAL_EVIDENCE_REQUIRED** needs data Xero cannot supply · **NON_SCORED_INFORMATIONAL** Xenon shows no comparable number (flag/N/A only) · **NO_XENON_NUMBER** no Xenon figure on file for this check on this client. 🔒 = guarded by a hermetic regression test in `test/xenonParity.test.js`.

## 4X4&MORE LTD

| Check | Status | Our value | Xenon value | Note |
|---|---|---|---|---|
| bank_balance | EXTERNAL_EVIDENCE_REQUIRED | not configured | 1 / £4922 |  |
| unreconciled_bank_items | EXACT | 0 / £0 | 0 / £0 |  |
| unprocessed_bank | EXTERNAL_EVIDENCE_REQUIRED | not configured | null / £null |  |
| duplicate_invoices 🔒 | MISMATCH | 0 / £0 | 31 / £3510 |  |
| duplicate_bills 🔒 | MISMATCH | 0 / £0 | 6 / £493 |  |
| old_unpaid_invoices | MISMATCH | 0 / £0 | 184 / £34165 | likely date drift, not a formula defect — Xenon's snapshot predates our live period end, so more documents have crossed the 60-day threshold since |
| old_sales_credits | EXACT | 0 / £0 | 0 / £0 |  |
| old_unpaid_bills | MISMATCH | 59 / £7551.22 | 96 / £7829 | likely date drift, not a formula defect — Xenon's snapshot predates our live period end, so more documents have crossed the 60-day threshold since |
| old_purchase_credits | EXACT | 0 / £0 | 0 / £0 |  |
| opening_balance_differences | EXTERNAL_EVIDENCE_REQUIRED | 0 / £0 | 0 / £0 |  |
| invoice_or_direct | EXACT | 0 / £0 | 0 / £0 |  |
| bill_or_direct | MISMATCH | 1 / £348.68 | 0 / £0 |  |
| low_cost_fixed_assets | EXACT | 0 / £0 | 0 / £0 |  |
| capital_item_review | CONFIG_REQUIRED | 3 / £978.78 | 3 / £979 |  |
| misallocated_items | CONFIG_REQUIRED | 0 / £0 | 0 / £0 |  |
| multi_account_suppliers | MISMATCH | 7 / £13922.51 | 5 / £4399 |  |
| multi_tax_suppliers | MISMATCH | 9 / £1684.81 | 13 / £1086 |  |
| unexpected_account_used | EXACT | 0 / £0 | 0 / £0 |  |
| unexpected_tax_code_used | EXACT | 0 / £0 | 0 / £0 |  |
| sales_tax_missing | MISMATCH | 475 / £30018.95 | 274 / £18152 |  |
| purchase_tax_missing | MISMATCH | 169 / £18686.64 | 116 / £14112 |  |
| sales_tax_on_bills | EXACT | 0 / £0 | 0 / £0 |  |
| purchase_tax_on_invoices | EXACT | 0 / £0 | 0 / £0 |  |
| undocumented_bills | NON_SCORED_INFORMATIONAL | 0 / £0 | 0 / £0 |  |
| unapproved_invoices | MISMATCH | 1 / £430 | 0 / £0 |  |
| unapproved_bills | EXACT | 0 / £0 | 0 / £0 |  |
| duplicate_contacts | NON_SCORED_INFORMATIONAL | 154 / £0 | null / £null |  |
| contact_defaults | NON_SCORED_INFORMATIONAL | 919 / £0 | null / £null |  |
| inactive_contacts | NON_SCORED_INFORMATIONAL | 114 / £0 | null / £null |  |

## HANDYMANZ LTD

| Check | Status | Our value | Xenon value | Note |
|---|---|---|---|---|
| bank_balance | EXTERNAL_EVIDENCE_REQUIRED | not configured | 2 / £3096 |  |
| unreconciled_bank_items | EXACT | 0 / £0 | 0 / £0 |  |
| unprocessed_bank | EXTERNAL_EVIDENCE_REQUIRED | not configured | null / £null |  |
| duplicate_invoices 🔒 | EXACT | 0 / £0 | 0 / £0 |  |
| duplicate_bills 🔒 | EXACT | 0 / £0 | 0 / £0 |  |
| old_unpaid_invoices | EXACT | 0 / £0 | 0 / £0 | date-relative — exact today only because our period end and Xenon's snapshot date happen to agree closely; will drift with time even without any code change |
| old_sales_credits | EXACT | 0 / £0 | 0 / £0 |  |
| old_unpaid_bills | MISMATCH | 2 / £47.26 | 0 / £0 | likely date drift, not a formula defect — Xenon's snapshot predates our live period end, so more documents have crossed the 60-day threshold since |
| old_purchase_credits | EXACT | 0 / £0 | 0 / £0 |  |
| opening_balance_differences | EXTERNAL_EVIDENCE_REQUIRED | 0 / £0 | 0 / £0 |  |
| invoice_or_direct | EXACT | 0 / £0 | 0 / £0 |  |
| bill_or_direct | EXACT | 0 / £0 | 0 / £0 |  |
| low_cost_fixed_assets | EXACT | 0 / £0 | 0 / £0 |  |
| capital_item_review | CONFIG_REQUIRED | 0 / £0 | 0 / £0 |  |
| misallocated_items | CONFIG_REQUIRED | 0 / £0 | 0 / £0 |  |
| multi_account_suppliers | COUNT_MATCH_ONLY | 4 / £84.85 | 4 / £737 |  |
| multi_tax_suppliers | COUNT_MATCH_ONLY | 7 / £30.93 | 7 / £26 |  |
| unexpected_account_used | EXACT | 12 / £4148.68 | 12 / £4149 |  |
| unexpected_tax_code_used | EXACT | 30 / £1308.21 | 30 / £1308 |  |
| sales_tax_missing | EXACT | 24 / £26100 | 24 / £26100 |  |
| purchase_tax_missing | EXACT | 10 / £174.35 | 10 / £174 |  |
| sales_tax_on_bills | EXACT | 0 / £0 | 0 / £0 |  |
| purchase_tax_on_invoices | EXACT | 52 / £480.8 | 52 / £481 |  |
| undocumented_bills | NON_SCORED_INFORMATIONAL | 0 / £0 | 0 / £0 |  |
| unapproved_invoices | EXACT | 0 / £0 | 0 / £0 |  |
| unapproved_bills | EXACT | 0 / £0 | 0 / £0 |  |
| duplicate_contacts | NON_SCORED_INFORMATIONAL | 11 / £0 | null / £null |  |
| contact_defaults | NON_SCORED_INFORMATIONAL | 200 / £0 | null / £null |  |
| inactive_contacts | NON_SCORED_INFORMATIONAL | 159 / £0 | null / £null |  |

## Fast Track Excavations

| Check | Status | Our value | Xenon value | Note |
|---|---|---|---|---|
| bank_balance | EXTERNAL_EVIDENCE_REQUIRED | not configured | 1 / £78480 |  |
| unreconciled_bank_items 🔒 | EXACT | 167 / £177956.58 | 167 / £177957 |  |
| unprocessed_bank | EXTERNAL_EVIDENCE_REQUIRED | not configured | null / £null |  |
| duplicate_invoices 🔒 | EXACT | 1 / £8880 | 1 / £8880 |  |
| duplicate_bills 🔒 | MISMATCH | 4 / £833.14 | 0 / £0 |  |
| old_unpaid_invoices | MISMATCH | 48 / £320433.96 | 44 / £309232 | likely date drift, not a formula defect — Xenon's snapshot predates our live period end, so more documents have crossed the 60-day threshold since |
| old_sales_credits | EXACT | 0 / £0 | 0 / £0 |  |
| old_unpaid_bills | MISMATCH | 103 / £181931.29 | 24 / £148437 | likely date drift, not a formula defect — Xenon's snapshot predates our live period end, so more documents have crossed the 60-day threshold since |
| old_purchase_credits | EXACT | 1 / £6480 | 1 / £6480 |  |
| opening_balance_differences | EXTERNAL_EVIDENCE_REQUIRED | not configured | 0 / £0 |  |
| invoice_or_direct | EXACT | 0 / £0 | 0 / £0 |  |
| bill_or_direct | EXACT | 0 / £0 | 0 / £0 |  |
| low_cost_fixed_assets | EXACT | 0 / £0 | 0 / £0 |  |
| capital_item_review | CONFIG_REQUIRED | 20 / £12316.53 | 17 / £11177 |  |
| misallocated_items | CONFIG_REQUIRED | 3 / £2774.83 | 1 / £378 |  |
| multi_account_suppliers | COUNT_MATCH_ONLY | 66 / £324100.57 | 66 / £347707 |  |
| multi_tax_suppliers | MISMATCH | 49 / £52291.37 | 45 / £44186 |  |
| unexpected_account_used | EXACT | 0 / £0 | 0 / £0 |  |
| unexpected_tax_code_used | EXACT | 55 / £204665.41 | 55 / £204665 |  |
| sales_tax_missing | EXACT | 76 / £66782 | 76 / £66782 |  |
| purchase_tax_missing | MISMATCH | 314 / £122967.42 | 309 / £122632 |  |
| sales_tax_on_bills | EXACT | 0 / £0 | 0 / £0 |  |
| purchase_tax_on_invoices | EXACT | 2 / £7863.4 | 2 / £7863 |  |
| undocumented_bills | NON_SCORED_INFORMATIONAL | 12 / £0 | null / £null |  |
| unapproved_invoices | EXACT | 3 / £0 | 3 / £0 |  |
| unapproved_bills | EXACT | 0 / £0 | 0 / £0 |  |
| duplicate_contacts | NON_SCORED_INFORMATIONAL | 11 / £0 | null / £null |  |
| contact_defaults | NON_SCORED_INFORMATIONAL | 170 / £0 | null / £null |  |
| inactive_contacts | NON_SCORED_INFORMATIONAL | 141 / £0 | null / £null |  |

## ROSE AND CARAMEL LIMITED

| Check | Status | Our value | Xenon value | Note |
|---|---|---|---|---|
| bank_balance | EXTERNAL_EVIDENCE_REQUIRED | not configured | 7 / £200298 |  |
| unreconciled_bank_items | MISMATCH | 49 / £110626.93 | 27 / £41785 |  |
| unprocessed_bank | EXTERNAL_EVIDENCE_REQUIRED | not configured | null / £null |  |
| duplicate_invoices 🔒 | EXACT | 0 / £0 | 0 / £0 |  |
| duplicate_bills 🔒 | EXACT | 0 / £0 | 0 / £0 |  |
| old_unpaid_invoices | MISMATCH | 40 / £84177.16 | 32 / £100139 | likely date drift, not a formula defect — Xenon's snapshot predates our live period end, so more documents have crossed the 60-day threshold since |
| old_sales_credits 🔒 | EXACT | 1 / £943.69 | 1 / £944 |  |
| old_unpaid_bills | EXACT | 0 / £0 | 0 / £0 | date-relative — exact today only because our period end and Xenon's snapshot date happen to agree closely; will drift with time even without any code change |
| old_purchase_credits | EXACT | 0 / £0 | 0 / £0 |  |
| opening_balance_differences | EXTERNAL_EVIDENCE_REQUIRED | 0 / £0 | 0 / £0 |  |
| invoice_or_direct | EXACT | 0 / £0 | 0 / £0 |  |
| bill_or_direct | EXACT | 0 / £0 | 0 / £0 |  |
| low_cost_fixed_assets | EXACT | 0 / £0 | 0 / £0 |  |
| capital_item_review | CONFIG_REQUIRED | 22 / £71699.5 | 14 / £63666 |  |
| misallocated_items | CONFIG_REQUIRED | 0 / £0 | 0 / £0 |  |
| multi_account_suppliers | COUNT_MATCH_ONLY | 37 / £211309.86 | 37 / £109476 |  |
| multi_tax_suppliers | MISMATCH | 27 / £19953.09 | 28 / £22459 |  |
| unexpected_account_used | MISMATCH | 52 / £4714.74 | 50 / £4581 |  |
| unexpected_tax_code_used | MISMATCH | 70 / £13224.06 | 60 / £12004 |  |
| sales_tax_missing | MISMATCH | 261 / £68306.03 | 249 / £61810 |  |
| purchase_tax_missing | MISMATCH | 2952 / £646540.7 | 5 / £0 |  |
| sales_tax_on_bills | EXACT | 0 / £0 | 0 / £0 |  |
| purchase_tax_on_invoices | EXACT | 0 / £0 | 0 / £0 |  |
| undocumented_bills | NON_SCORED_INFORMATIONAL | 0 / £0 | 0 / £0 |  |
| unapproved_invoices | MISMATCH | 2 / £968.07 | 1 / £0 |  |
| unapproved_bills | EXACT | 0 / £0 | 0 / £0 |  |
| duplicate_contacts | NON_SCORED_INFORMATIONAL | 20 / £0 | null / £null |  |
| contact_defaults | NON_SCORED_INFORMATIONAL | 371 / £0 | null / £null |  |
| inactive_contacts | NON_SCORED_INFORMATIONAL | 200 / £0 | null / £null |  |

## MBX GRAFFIX LIMITED

| Check | Status | Our value | Xenon value | Note |
|---|---|---|---|---|
| bank_balance | EXTERNAL_EVIDENCE_REQUIRED | not configured | 2 / £18009 |  |
| unreconciled_bank_items | MISMATCH | 97 / £33272.59 | 120 / £38338 |  |
| unprocessed_bank | EXTERNAL_EVIDENCE_REQUIRED | not configured | null / £null |  |
| duplicate_invoices 🔒 | EXACT | 0 / £0 | 0 / £0 |  |
| duplicate_bills 🔒 | EXACT | 10 / £943.57 | 10 / £944 |  |
| old_unpaid_invoices | MISMATCH | 24 / £5627.29 | 17 / £4499 | likely date drift, not a formula defect — Xenon's snapshot predates our live period end, so more documents have crossed the 60-day threshold since |
| old_sales_credits | EXACT | 1 / £12902.76 | 1 / £12903 |  |
| old_unpaid_bills | EXACT | 425 / £105986.07 | 425 / £105986 | date-relative — exact today only because our period end and Xenon's snapshot date happen to agree closely; will drift with time even without any code change |
| old_purchase_credits | EXACT | 4 / £95069.72 | 4 / £95070 |  |
| opening_balance_differences | EXTERNAL_EVIDENCE_REQUIRED | 1 / £3.01 | 2 / £114390 |  |
| invoice_or_direct | EXACT | 0 / £0 | 0 / £0 |  |
| bill_or_direct | MISMATCH | 47 / £6401.15 | 44 / £6257 |  |
| low_cost_fixed_assets | EXACT | 12 / £462.94 | 12 / £463 |  |
| capital_item_review | CONFIG_REQUIRED | 11 / £4881.71 | 11 / £4882 |  |
| misallocated_items | CONFIG_REQUIRED | 247 / £65022 | 300 / £62105 |  |
| multi_account_suppliers | MISMATCH | 83 / £60739.7 | 81 / £41601 |  |
| multi_tax_suppliers | MISMATCH | 67 / £20227.18 | 65 / £6678 |  |
| unexpected_account_used | MISMATCH | 411 / £55167.18 | 425 / £58024 |  |
| unexpected_tax_code_used | MISMATCH | 620 / £4570.91 | 614 / £4539 |  |
| sales_tax_missing | EXACT | 67 / £26850.18 | 67 / £26850 |  |
| purchase_tax_missing | MISMATCH | 2428 / £56004.7 | 2416 / £55712 |  |
| sales_tax_on_bills | EXACT | 6 / £228.4 | 6 / £228 |  |
| purchase_tax_on_invoices | EXACT | 5 / £4 | 5 / £4 |  |
| undocumented_bills | NON_SCORED_INFORMATIONAL | 0 / £0 | 0 / £0 |  |
| unapproved_invoices | EXACT | 4 / £12956.76 | 4 / £12957 |  |
| unapproved_bills | MISMATCH | 412 / £91253.21 | 475 / £101920 |  |
| duplicate_contacts | NON_SCORED_INFORMATIONAL | 31 / £0 | null / £null |  |
| contact_defaults | NON_SCORED_INFORMATIONAL | 453 / £0 | null / £null |  |
| inactive_contacts | NON_SCORED_INFORMATIONAL | 251 / £0 | null / £null |  |
