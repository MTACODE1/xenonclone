# Xenon Parity Matrix

Generated 2026-08-13 by `scripts/generate-xenon-parity-matrix.js`. Read-only — no database or application state was modified to produce this report.

Legend: **EXACT** count and value both match Xenon · **COUNT_MATCH_ONLY** count matches, value does not · **MISMATCH** neither matches · **CONFIG_REQUIRED** needs a one-time setup step in this app · **EXTERNAL_EVIDENCE_REQUIRED** needs data Xero cannot supply · **NON_SCORED_INFORMATIONAL** Xenon shows no comparable number (flag/N/A only) · **NO_XENON_NUMBER** no Xenon figure on file for this check on this client. 🔒 = guarded by a hermetic regression test in `test/xenonParity.test.js`.

## 4X4&MORE LTD

| Check | Status | Our value | Xenon value | Note |
|---|---|---|---|---|
| bank_balance | EXTERNAL_EVIDENCE_REQUIRED | not configured | 1 / £4922 |  |
| unreconciled_bank_items | EXACT | 0 / £0 | 0 / £0 |  |
| unprocessed_bank | EXTERNAL_EVIDENCE_REQUIRED | not configured | null / £null |  |
| duplicate_invoices 🔒 | EXACT | 31 / £3509.9 | 31 / £3510 |  |
| duplicate_bills 🔒 | EXACT | 6 / £492.63 | 6 / £493 |  |
| old_unpaid_invoices | MISMATCH | 219 / £38724.41 | 184 / £34165 | likely date drift, not a formula defect — Xenon's snapshot predates our live period end, so more documents have crossed the 60-day threshold since |
| old_sales_credits | EXACT | 0 / £0 | 0 / £0 |  |
| old_unpaid_bills | MISMATCH | 119 / £8794.06 | 96 / £7829 | likely date drift, not a formula defect — Xenon's snapshot predates our live period end, so more documents have crossed the 60-day threshold since |
| old_purchase_credits | EXACT | 0 / £0 | 0 / £0 |  |
| opening_balance_differences | EXTERNAL_EVIDENCE_REQUIRED | 1 / £0.25 | 0 / £0 |  |
| invoice_or_direct | EXACT | 0 / £0 | 0 / £0 |  |
| bill_or_direct | EXACT | 0 / £0 | 0 / £0 |  |
| low_cost_fixed_assets | EXACT | 0 / £0 | 0 / £0 |  |
| capital_item_review | CONFIG_REQUIRED | not configured | 3 / £979 |  |
| misallocated_items | CONFIG_REQUIRED | 0 / £0 | 0 / £0 |  |
| multi_account_suppliers | COUNT_MATCH_ONLY | 5 / £12990.28 | 5 / £4399 |  |
| multi_tax_suppliers | MISMATCH | 11 / £1648.74 | 13 / £1086 |  |
| unexpected_account_used | EXACT | 0 / £0 | 0 / £0 |  |
| unexpected_tax_code_used | EXACT | 0 / £0 | 0 / £0 |  |
| sales_tax_missing | EXACT | 274 / £18152.1 | 274 / £18152 |  |
| purchase_tax_missing | EXACT | 116 / £14112.35 | 116 / £14112 |  |
| sales_tax_on_bills | EXACT | 0 / £0 | 0 / £0 |  |
| purchase_tax_on_invoices | EXACT | 0 / £0 | 0 / £0 |  |
| undocumented_bills | NON_SCORED_INFORMATIONAL | 0 / £0 | 0 / £0 |  |
| unapproved_invoices | EXACT | 0 / £0 | 0 / £0 |  |
| unapproved_bills | EXACT | 0 / £0 | 0 / £0 |  |
| duplicate_contacts | NON_SCORED_INFORMATIONAL | 150 / £0 | null / £null |  |
| contact_defaults | NON_SCORED_INFORMATIONAL | 910 / £0 | null / £null |  |
| inactive_contacts | NON_SCORED_INFORMATIONAL | 252 / £0 | null / £null |  |

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
| old_unpaid_bills | EXACT | 0 / £0 | 0 / £0 | date-relative — exact today only because our period end and Xenon's snapshot date happen to agree closely; will drift with time even without any code change |
| old_purchase_credits | EXACT | 0 / £0 | 0 / £0 |  |
| opening_balance_differences | EXTERNAL_EVIDENCE_REQUIRED | not configured | 0 / £0 |  |
| invoice_or_direct | EXACT | 0 / £0 | 0 / £0 |  |
| bill_or_direct | EXACT | 0 / £0 | 0 / £0 |  |
| low_cost_fixed_assets | EXACT | 0 / £0 | 0 / £0 |  |
| capital_item_review | CONFIG_REQUIRED | not configured | 0 / £0 |  |
| misallocated_items | CONFIG_REQUIRED | 0 / £0 | 0 / £0 |  |
| multi_account_suppliers | COUNT_MATCH_ONLY | 4 / £67.04 | 4 / £737 |  |
| multi_tax_suppliers | MISMATCH | 5 / £30.93 | 7 / £26 |  |
| unexpected_account_used | EXACT | 12 / £4148.68 | 12 / £4149 |  |
| unexpected_tax_code_used | COUNT_MATCH_ONLY | 30 / £1363.39 | 30 / £1308 |  |
| sales_tax_missing | EXACT | 24 / £26100 | 24 / £26100 |  |
| purchase_tax_missing | EXACT | 10 / £174.35 | 10 / £174 |  |
| sales_tax_on_bills | EXACT | 0 / £0 | 0 / £0 |  |
| purchase_tax_on_invoices | EXACT | 52 / £480.8 | 52 / £481 |  |
| undocumented_bills | NON_SCORED_INFORMATIONAL | 0 / £0 | 0 / £0 |  |
| unapproved_invoices | EXACT | 0 / £0 | 0 / £0 |  |
| unapproved_bills | EXACT | 0 / £0 | 0 / £0 |  |
| duplicate_contacts | NON_SCORED_INFORMATIONAL | 11 / £0 | null / £null |  |
| contact_defaults | NON_SCORED_INFORMATIONAL | 200 / £0 | null / £null |  |
| inactive_contacts | NON_SCORED_INFORMATIONAL | 186 / £0 | null / £null |  |

## Fast Track Excavations

| Check | Status | Our value | Xenon value | Note |
|---|---|---|---|---|
| bank_balance | EXTERNAL_EVIDENCE_REQUIRED | not configured | 1 / £78480 |  |
| unreconciled_bank_items 🔒 | EXACT | 167 / £177956.58 | 167 / £177957 |  |
| unprocessed_bank | EXTERNAL_EVIDENCE_REQUIRED | not configured | null / £null |  |
| duplicate_invoices 🔒 | EXACT | 1 / £8880 | 1 / £8880 |  |
| duplicate_bills 🔒 | EXACT | 0 / £0 | 0 / £0 |  |
| old_unpaid_invoices | EXACT | 44 / £309231.96 | 44 / £309232 | date-relative — exact today only because our period end and Xenon's snapshot date happen to agree closely; will drift with time even without any code change |
| old_sales_credits | EXACT | 0 / £0 | 0 / £0 |  |
| old_unpaid_bills | EXACT | 24 / £148437 | 24 / £148437 | date-relative — exact today only because our period end and Xenon's snapshot date happen to agree closely; will drift with time even without any code change |
| old_purchase_credits | EXACT | 1 / £6480 | 1 / £6480 |  |
| opening_balance_differences | EXTERNAL_EVIDENCE_REQUIRED | not configured | 0 / £0 |  |
| invoice_or_direct | EXACT | 0 / £0 | 0 / £0 |  |
| bill_or_direct | EXACT | 0 / £0 | 0 / £0 |  |
| low_cost_fixed_assets | EXACT | 0 / £0 | 0 / £0 |  |
| capital_item_review | CONFIG_REQUIRED | 54 / £149934.54 | 17 / £11177 |  |
| misallocated_items | CONFIG_REQUIRED | 1 / £378 | 1 / £378 |  |
| multi_account_suppliers | COUNT_MATCH_ONLY | 66 / £324839.29 | 66 / £347707 |  |
| multi_tax_suppliers | COUNT_MATCH_ONLY | 45 / £102659.05 | 45 / £44186 |  |
| unexpected_account_used | EXACT | 0 / £0 | 0 / £0 |  |
| unexpected_tax_code_used | EXACT | 55 / £204665.41 | 55 / £204665 |  |
| sales_tax_missing | EXACT | 76 / £66782 | 76 / £66782 |  |
| purchase_tax_missing | EXACT | 309 / £122632.35 | 309 / £122632 |  |
| sales_tax_on_bills | EXACT | 0 / £0 | 0 / £0 |  |
| purchase_tax_on_invoices | EXACT | 2 / £7863.4 | 2 / £7863 |  |
| undocumented_bills | NON_SCORED_INFORMATIONAL | 1 / £0 | null / £null |  |
| unapproved_invoices | EXACT | 3 / £0 | 3 / £0 |  |
| unapproved_bills | EXACT | 0 / £0 | 0 / £0 |  |
| duplicate_contacts | NON_SCORED_INFORMATIONAL | 5 / £0 | null / £null |  |
| contact_defaults | NON_SCORED_INFORMATIONAL | 158 / £0 | null / £null |  |
| inactive_contacts | NON_SCORED_INFORMATIONAL | 148 / £0 | null / £null |  |

## ROSE AND CARAMEL LIMITED

| Check | Status | Our value | Xenon value | Note |
|---|---|---|---|---|
| bank_balance | EXTERNAL_EVIDENCE_REQUIRED | not configured | 7 / £200298 |  |
| unreconciled_bank_items | MISMATCH | 34 / £53135.36 | 27 / £41785 |  |
| unprocessed_bank | EXTERNAL_EVIDENCE_REQUIRED | not configured | null / £null |  |
| duplicate_invoices 🔒 | EXACT | 0 / £0 | 0 / £0 |  |
| duplicate_bills 🔒 | EXACT | 0 / £0 | 0 / £0 |  |
| old_unpaid_invoices | EXACT | 32 / £100138.77 | 32 / £100139 | date-relative — exact today only because our period end and Xenon's snapshot date happen to agree closely; will drift with time even without any code change |
| old_sales_credits 🔒 | EXACT | 1 / £943.69 | 1 / £944 |  |
| old_unpaid_bills | EXACT | 0 / £0 | 0 / £0 | date-relative — exact today only because our period end and Xenon's snapshot date happen to agree closely; will drift with time even without any code change |
| old_purchase_credits | EXACT | 0 / £0 | 0 / £0 |  |
| opening_balance_differences | EXTERNAL_EVIDENCE_REQUIRED | 1 / £0.99 | 0 / £0 |  |
| invoice_or_direct | EXACT | 0 / £0 | 0 / £0 |  |
| bill_or_direct | EXACT | 0 / £0 | 0 / £0 |  |
| low_cost_fixed_assets | EXACT | 0 / £0 | 0 / £0 |  |
| capital_item_review | CONFIG_REQUIRED | not configured | 14 / £63666 |  |
| misallocated_items | CONFIG_REQUIRED | 0 / £0 | 0 / £0 |  |
| multi_account_suppliers | COUNT_MATCH_ONLY | 37 / £114638.43 | 37 / £109476 |  |
| multi_tax_suppliers | COUNT_MATCH_ONLY | 28 / £28607.25 | 28 / £22459 |  |
| unexpected_account_used | COUNT_MATCH_ONLY | 50 / £5148.1 | 50 / £4581 |  |
| unexpected_tax_code_used | COUNT_MATCH_ONLY | 60 / £12436.23 | 60 / £12004 |  |
| sales_tax_missing | MISMATCH | 254 / £65009.27 | 249 / £61810 |  |
| purchase_tax_missing | MISMATCH | 2758 / £619374.5 | 5 / £0 |  |
| sales_tax_on_bills | EXACT | 0 / £0 | 0 / £0 |  |
| purchase_tax_on_invoices | EXACT | 0 / £0 | 0 / £0 |  |
| undocumented_bills | NON_SCORED_INFORMATIONAL | 0 / £0 | 0 / £0 |  |
| unapproved_invoices | EXACT | 1 / £0 | 1 / £0 |  |
| unapproved_bills | EXACT | 0 / £0 | 0 / £0 |  |
| duplicate_contacts | NON_SCORED_INFORMATIONAL | 20 / £0 | null / £null |  |
| contact_defaults | NON_SCORED_INFORMATIONAL | 370 / £0 | null / £null |  |
| inactive_contacts | NON_SCORED_INFORMATIONAL | 289 / £0 | null / £null |  |

## MBX GRAFFIX LIMITED

| Check | Status | Our value | Xenon value | Note |
|---|---|---|---|---|
| bank_balance | EXTERNAL_EVIDENCE_REQUIRED | not configured | 2 / £18009 |  |
| unreconciled_bank_items | MISMATCH | 121 / £38635.09 | 120 / £38338 |  |
| unprocessed_bank | EXTERNAL_EVIDENCE_REQUIRED | not configured | null / £null |  |
| duplicate_invoices 🔒 | EXACT | 0 / £0 | 0 / £0 |  |
| duplicate_bills 🔒 | EXACT | 10 / £943.57 | 10 / £944 |  |
| old_unpaid_invoices | EXACT | 17 / £4499.29 | 17 / £4499 | date-relative — exact today only because our period end and Xenon's snapshot date happen to agree closely; will drift with time even without any code change |
| old_sales_credits | EXACT | 1 / £12902.76 | 1 / £12903 |  |
| old_unpaid_bills | EXACT | 425 / £105986.07 | 425 / £105986 | date-relative — exact today only because our period end and Xenon's snapshot date happen to agree closely; will drift with time even without any code change |
| old_purchase_credits | EXACT | 4 / £95069.72 | 4 / £95070 |  |
| opening_balance_differences | EXTERNAL_EVIDENCE_REQUIRED | not configured | 2 / £114390 |  |
| invoice_or_direct | EXACT | 0 / £0 | 0 / £0 |  |
| bill_or_direct | MISMATCH | 48 / £7116.08 | 44 / £6257 |  |
| low_cost_fixed_assets | COUNT_MATCH_ONLY | 12 / £555.52 | 12 / £463 |  |
| capital_item_review | CONFIG_REQUIRED | not configured | 11 / £4882 |  |
| misallocated_items | CONFIG_REQUIRED | 239 / £49737.51 | 300 / £62105 |  |
| multi_account_suppliers | COUNT_MATCH_ONLY | 81 / £55535.22 | 81 / £41601 |  |
| multi_tax_suppliers | MISMATCH | 64 / £24249.76 | 65 / £6678 |  |
| unexpected_account_used | COUNT_MATCH_ONLY | 425 / £58775.41 | 425 / £58024 |  |
| unexpected_tax_code_used | MISMATCH | 615 / £4641.1 | 614 / £4539 |  |
| sales_tax_missing | EXACT | 67 / £26850.18 | 67 / £26850 |  |
| purchase_tax_missing | EXACT | 2416 / £55712.49 | 2416 / £55712 |  |
| sales_tax_on_bills | EXACT | 6 / £228.4 | 6 / £228 |  |
| purchase_tax_on_invoices | EXACT | 5 / £4 | 5 / £4 |  |
| undocumented_bills | NON_SCORED_INFORMATIONAL | 0 / £0 | 0 / £0 |  |
| unapproved_invoices | EXACT | 4 / £12956.76 | 4 / £12957 |  |
| unapproved_bills | EXACT | 475 / £101919.83 | 475 / £101920 |  |
| duplicate_contacts | NON_SCORED_INFORMATIONAL | 31 / £0 | null / £null |  |
| contact_defaults | NON_SCORED_INFORMATIONAL | 445 / £0 | null / £null |  |
| inactive_contacts | NON_SCORED_INFORMATIONAL | 276 / £0 | null / £null |  |
