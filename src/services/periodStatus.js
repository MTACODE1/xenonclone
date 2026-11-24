// Single source of truth for the period_checked "applicability/status" labels, shared between
// checkRules.js (persistence: which labels survive resolvePeriodChecked so they aren't silently
// overwritten by the sync's real period key) and scoreProfile.js (scoring: which labels are
// excluded from the score's deduction total, same as a check with no active findings).
//
// Kept dependency-free (no requires of its own) specifically so both of those modules can import
// from here without creating a circular require between them — checkRules.js already requires
// scoreProfile.js for calculateHealthScore, so scoreProfile.js requiring checkRules.js back would
// close a cycle; requiring this instead avoids that entirely.
//
// period_checked is overloaded to carry BOTH "which period was this run over" (a real period key)
// AND "why is there nothing to show" (one of the reserved labels below) — a deliberate scope
// decision, not an oversight: a dedicated status column would touch every issue read/write path in
// the app for a distinction these labels already express unambiguously. If a future status needs
// richer structure than a single label can carry, that is the point to revisit this design.
//
// Categories:
//   - unavailable    : the required data is permanently outside what the connected Xero APIs can
//                       supply.
//   - not_configured : the accountant hasn't supplied evidence this check needs yet.
//   - not_applicable : the check ran successfully but this client's own circumstances mean it has
//                       nothing to check (e.g. VAT checks on a non-VAT-registered client) — distinct
//                       from "ran and found nothing". Extensible: a future check with its own
//                       applicability gate should add its own label here rather than a new
//                       mechanism.
//   - ok / issues    : none of the above, a real period key — count === 0 is "ok", count > 0 is
//                       "issues".
//   - not_synced     : none of the above, but count is null — this sync attempt failed or never ran.
// not_applicable_uae: a UK-only rule (UK VAT schemes, dividends, sales/purchase tax codes) on a Zoho Books client
// that is a UAE company; the UAE version of the check runs in its slot where there is one (zohoChecks.js).
const NOT_APPLICABLE_PERIODS = Object.freeze(new Set(['not_vat_registered', 'not_applicable_freeagent', 'not_applicable_quickbooks', 'not_applicable_zoho', 'not_applicable_uae', 'not_a_company', 'no_filed_accounts_yet', 'flat_rate_scheme']));
// needs_bank_update: the only evidence is a reading of Xero's Bank accounts page that is too old to use;
// someone has to click "Update from Xero" (browser extension) before the check can say anything.
// needs_zoho_bank_access / needs_zoho_expense_access: the Zoho Books connection was made without bank or expense
// access (and, for the bank checks, there is no recent reading of Zoho's Banking page either); reconnecting Zoho
// Books fixes it. Not an error and not a clean result, so it is kept out of the score like the others here.
const NOT_CONFIGURED_PERIODS = Object.freeze(new Set(['not_configured', 'needs_sync', 'needs_bank_update', 'needs_zoho_bank_access', 'needs_zoho_expense_access']));
// unavailable_zoho: Zoho Books' API cannot give what the check needs (no balance sheet, trial balance or P&L, no
// coded bank deposits, no filing dates), so no figure is made up.
const UNAVAILABLE_PERIODS = Object.freeze(new Set(['out_of_scope', 'unavailable', 'unavailable_zoho']));
const RESERVED_PERIOD_LABELS = Object.freeze(new Set([
  ...NOT_CONFIGURED_PERIODS, ...UNAVAILABLE_PERIODS, ...NOT_APPLICABLE_PERIODS,
]));

module.exports = {
  NOT_APPLICABLE_PERIODS,
  NOT_CONFIGURED_PERIODS,
  UNAVAILABLE_PERIODS,
  RESERVED_PERIOD_LABELS,
};
