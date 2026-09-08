const levenshtein = require('fast-levenshtein');
const crypto = require('crypto');
const { calculateScoreBreakdown } = require('./scoreProfile');
const {
  NOT_APPLICABLE_PERIODS, NOT_CONFIGURED_PERIODS, UNAVAILABLE_PERIODS, RESERVED_PERIOD_LABELS,
} = require('./periodStatus');

// The period_checked reservation/status model itself now lives in periodStatus.js (dependency-free,
// so scoreProfile.js can import the same sets without a circular require back to this file, which
// already requires scoreProfile.js for calculateHealthScore). See that file for the full category
// documentation (unavailable / not_configured / not_applicable / ok / issues / not_synced) and the
// rationale for keeping this a label on period_checked rather than a dedicated status column.
//
// A check's own period_checked label survives if it is one of the reserved semantic states above;
// otherwise the caller's real period key (or, failing that, whatever label was already there) wins.
// This is the one place both write paths decide what to persist, so the two can never drift apart.
function resolvePeriodChecked(intendedLabel, activePeriodKey) {
  if (RESERVED_PERIOD_LABELS.has(intendedLabel)) return intendedLabel;
  return activePeriodKey || intendedLabel;
}

// The single source of truth for turning a persisted issue into a display/scoring status — the
// dashboard UI and the health score must both go through this instead of re-deriving their own
// period_checked string comparisons, so the two can never drift apart the way period_checked's
// raw handling once did. Order matters: not_applicable's count is deliberately 0 (not null), so it
// must be checked before the null-count "not_synced" fallback, and unavailable/not_configured also
// always carry count: null, so those must be checked before "not_synced" claims the null count for
// itself.
function resolveCheckDisplayStatus(check) {
  const periodChecked = check?.period_checked;
  if (UNAVAILABLE_PERIODS.has(periodChecked)) return 'unavailable';
  if (NOT_CONFIGURED_PERIODS.has(periodChecked)) return 'not_configured';
  if (NOT_APPLICABLE_PERIODS.has(periodChecked)) return 'not_applicable';
  if (check?.count == null) return 'not_synced';
  return Number(check.count) > 0 ? 'issues' : 'ok';
}

// Xenon's own Multi-Account/Multi-Tax Code Suppliers documentation states the pattern-detection
// lookback is "3 months prior to the period selected" by default, and is changeable per client on
// Xenon's settings page — it is not a fixed value shared by every client. 12 months is this app's
// own empirically-tuned fallback (measured against five real clients before this setting existed);
// it stays the default for any client that hasn't been given a specific value, so nothing already
// validated changes, but a new client whose real Xenon lookback differs can now be configured to
// match instead of silently guessing.
const DEFAULT_SUPPLIER_PATTERN_LOOKBACK_MONTHS = 12;
function resolveSupplierPatternLookbackMonths(org) {
  const configured = Number(org?.supplier_pattern_lookback_months);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_SUPPLIER_PATTERN_LOOKBACK_MONTHS;
}

// Multi-account and multi-tax document the identical "3 months prior, changeable per client" rule
// — they were sharing one lookback column, but Xenon lets each check's lookback be configured
// independently, so multi-account needs its own resolver/column rather than inheriting whatever
// multi-tax happens to be set to (Handymanz's multi-tax was widened to 18 months, which must not
// also widen multi-account's separately-validated 12-month default).
function resolveMultiAccountPatternLookbackMonths(org) {
  const configured = Number(org?.multi_account_pattern_lookback_months);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_SUPPLIER_PATTERN_LOOKBACK_MONTHS;
}

// Config-isolation resolvers (2026-09): each takes the organisation row plus the practice-wide
// fallback already in force (an existing `getSetting(...)` read, or a hardcoded practice default),
// and returns the organisation's own override when one is set, otherwise the fallback unchanged.
// A NULL/absent organisation column is indistinguishable from "not yet configured" by design —
// every currently-validated client keeps using exactly the fallback it already matched against.
// The `!= null` guard matters: Number(null) is 0, not NaN, so a genuinely-unset column would
// otherwise resolve to a real (wrong) zero override instead of falling through to practiceDefault.
function resolveMultiAccountSuppliersMinValue(org, practiceDefault) {
  if (org?.multi_account_suppliers_min_value_gbp == null) return practiceDefault;
  const configured = Number(org.multi_account_suppliers_min_value_gbp);
  return Number.isFinite(configured) && configured >= 0 ? configured : practiceDefault;
}

function resolveMultiTaxSuppliersMinValue(org, practiceDefault) {
  if (org?.multi_tax_suppliers_min_value_gbp == null) return practiceDefault;
  const configured = Number(org.multi_tax_suppliers_min_value_gbp);
  return Number.isFinite(configured) && configured >= 0 ? configured : practiceDefault;
}

function resolveCapitalReviewDefaultThreshold(org, practiceDefault) {
  if (org?.capital_review_default_threshold_gbp == null) return practiceDefault;
  const configured = Number(org.capital_review_default_threshold_gbp);
  return Number.isFinite(configured) && configured >= 0 ? configured : practiceDefault;
}

function resolveMisallocatedItemsDefaultThreshold(org, practiceDefault) {
  if (org?.misallocated_items_default_threshold_gbp == null) return practiceDefault;
  const configured = Number(org.misallocated_items_default_threshold_gbp);
  return Number.isFinite(configured) && configured >= 0 ? configured : practiceDefault;
}

// An organisation override of '' (explicitly cleared to "no exclusions") must be distinguishable
// from NULL/absent (fall through to the practice default) — an empty string is a deliberate value,
// not a missing one, so it is checked before falling back rather than failing the truthy test below.
function resolvePurchaseTaxMissingExcludeCodes(org, practiceDefault) {
  return org?.purchase_tax_missing_exclude_codes != null
    ? org.purchase_tax_missing_exclude_codes
    : practiceDefault;
}

// Xenon's own Duplicate Invoices/Bills documentation states a 1-day default window, configurable
// per client — the 3-day value below is this practice's own calibrated default (see CHECK_DEFAULTS),
// not a claim about Xenon's universal behaviour, so it stays the fallback here unchanged.
function resolveDuplicateInvoiceWindowDays(org) {
  if (org?.duplicate_invoice_window_days == null) return CHECK_DEFAULTS.duplicateWindowDays;
  const configured = Number(org.duplicate_invoice_window_days);
  return Number.isInteger(configured) && configured >= 0 ? configured : CHECK_DEFAULTS.duplicateWindowDays;
}

function resolveDuplicateBillWindowDays(org) {
  if (org?.duplicate_bill_window_days == null) return CHECK_DEFAULTS.duplicateBillWindowDays;
  const configured = Number(org.duplicate_bill_window_days);
  return Number.isInteger(configured) && configured >= 0 ? configured : CHECK_DEFAULTS.duplicateBillWindowDays;
}

// Xenon's documented defaults for both remaining Duplicate Invoices/Bills toggles are "off": Exact
// Reference is off (no reference check at all — findDuplicates' default behaviour already matches
// this), and "Also check paid invoices/bills" is off, meaning fully-paid groups ARE excluded by
// default (requireUnpaidPair: true). A stored 0 or 1 is trusted verbatim; only NULL/absent falls
// through to that documented default.
function resolveDuplicateInvoiceRequireExactReference(org) {
  return org?.duplicate_invoice_require_exact_reference == null
    ? false : Boolean(org.duplicate_invoice_require_exact_reference);
}

function resolveDuplicateInvoiceIncludeFullyPaid(org) {
  return org?.duplicate_invoice_include_fully_paid == null
    ? false : Boolean(org.duplicate_invoice_include_fully_paid);
}

function resolveDuplicateBillRequireExactReference(org) {
  return org?.duplicate_bill_require_exact_reference == null
    ? false : Boolean(org.duplicate_bill_require_exact_reference);
}

function resolveDuplicateBillIncludeFullyPaid(org) {
  return org?.duplicate_bill_include_fully_paid == null
    ? false : Boolean(org.duplicate_bill_include_fully_paid);
}

// Exact Total's default here is the OPPOSITE of the other three duplicate toggles: it defaults to
// TRUE (require exact total), not Xenon's own documented "off" — because "off" here changes the
// core grouping key (contact+date only, no amount check at all), and Xenon's own documentation
// does not disclose what off actually looks like. Defaulting to true preserves the contact+exact-
// amount+date-window grouping every currently-validated client is calibrated against; only an
// explicit per-organisation override (set after confirming against that client's real Xenon
// export) should ever flip this to false.
function resolveDuplicateInvoiceRequireExactTotal(org) {
  return org?.duplicate_invoice_require_exact_total == null
    ? true : Boolean(org.duplicate_invoice_require_exact_total);
}

function resolveDuplicateBillRequireExactTotal(org) {
  return org?.duplicate_bill_require_exact_total == null
    ? true : Boolean(org.duplicate_bill_require_exact_total);
}

const CHECK_DEFAULTS = Object.freeze({
  // Three days for both sales invoices and purchase bills, grouped as described on findDuplicates.
  // Row-exact against Xenon's 4X4 View Issues: 31 groups / £3,509.90 for invoices and 6 / £492.63
  // for bills. The former 0-day invoice window matched Xenon's headline count by coincidence while
  // overstating the value by £715.
  duplicateWindowDays: 3,
  duplicateBillWindowDays: 3,
  oldDocumentDays: 60,
  directMatchWindowDays: 30,
  // 90%, not the old unexplained 70% — cross-checked against the practice's own real Xenon general
  // settings (7 Sep 2026): "Contact name similarity score is at least 90%". duplicate_contacts is
  // non-scored/informational, so this only affects the flagged count shown, never the health score.
  contactSimilarityThreshold: 0.9,
});

const CHECK_DEFINITIONS = Object.freeze([
  { type: 'bank_balance', importance: 'critical', label: 'Bank Balance Check' },
  { type: 'unreconciled_bank_items', importance: 'critical', label: 'Unreconciled Bank' },
  { type: 'unprocessed_bank', importance: 'critical', label: 'Unprocessed Bank' },
  { type: 'duplicate_invoices', importance: 'high', label: 'Duplicate Invoices' },
  { type: 'duplicate_bills', importance: 'high', label: 'Duplicate Bills' },
  { type: 'old_unpaid_invoices', importance: 'high', label: 'Old Unpaid Invoices' },
  { type: 'old_sales_credits', importance: 'high', label: 'Old Sales Credits' },
  { type: 'old_unpaid_bills', importance: 'high', label: 'Old Unpaid Bills' },
  { type: 'old_purchase_credits', importance: 'high', label: 'Old Purchase Credits' },
  { type: 'opening_balance_differences', importance: 'high', label: 'Opening Balance Differences' },
  { type: 'invoice_or_direct', importance: 'medium', label: 'Invoice or Direct' },
  { type: 'bill_or_direct', importance: 'medium', label: 'Bill or Direct' },
  { type: 'low_cost_fixed_assets', importance: 'medium', label: 'Low Cost Fixed Assets' },
  { type: 'capital_item_review', importance: 'medium', label: 'Capital Item Review' },
  { type: 'misallocated_items', importance: 'medium', label: 'Misallocated Items' },
  { type: 'multi_account_suppliers', importance: 'medium', label: 'Multi-Account Suppliers' },
  { type: 'multi_tax_suppliers', importance: 'medium', label: 'Multi-Tax Code Suppliers' },
  { type: 'unexpected_account_used', importance: 'medium', label: 'Unexpected Account Used' },
  { type: 'unexpected_tax_code_used', importance: 'medium', label: 'Unexpected Tax Code Used' },
  { type: 'sales_tax_missing', importance: 'medium', label: 'Sales Tax Missing' },
  { type: 'purchase_tax_missing', importance: 'medium', label: 'Purchase Tax Missing' },
  { type: 'sales_tax_on_bills', importance: 'medium', label: 'Sales Tax on Bills' },
  { type: 'purchase_tax_on_invoices', importance: 'medium', label: 'Purchase Tax on Invoices' },
  { type: 'undocumented_bills', importance: 'medium', label: 'Undocumented Bills' },
  { type: 'unapproved_invoices', importance: 'medium', label: 'Unapproved Invoices' },
  { type: 'unapproved_bills', importance: 'medium', label: 'Unapproved Bills' },
  { type: 'duplicate_contacts', importance: 'low', label: 'Duplicate Contacts' },
  { type: 'contact_defaults', importance: 'low', label: 'Contact Defaults' },
  { type: 'inactive_contacts', importance: 'low', label: 'Inactive Contacts' },
]);

const NON_SCORED_CHECKS = Object.freeze([
  'duplicate_contacts',
  'contact_defaults',
  'inactive_contacts',
  'undocumented_bills',
]);

// Processor fees are deliberately not exempt: MBX evidence showed that Xenon includes them.
// Bank fees and charges are likewise not exempt — Xenon counts those lines on all four measured
// clients (they were the single largest source of our undercount: Rose 358 lines, MBX 161,
// Fast Track 122). "Bank interest" / bank revaluations stay exempt. Plain "Interest Paid"
// does NOT: Fast Track's two NONE-tax Interest Paid lines (1049.66+209.73) were XENON_ONLY
// under the old `interest (paid|and)` exclusion; dropping that clause made FT exact on count
// and £ with no change on MBX/Handymanz/4X4/Rose (holdout: zero Interest Paid residuals there).
//
// Row-level residual census (2026-08-10), holdout-checked across five clients:
// - Excluding account names matching charitable/political donations + mileage, plus accounts
//   named exactly Rates / Business Rates / Council Rates (not "Rent & Rates"), made MBX
//   purchase_tax_missing exact on BOTH count and £ (2458→2416 / £55712) and Handymanz exact
//   on count and £ (11→10 / £174). 4X4 stayed exact. Rose/Fast Track were not used to fit
//   those exclusions and did not regress from them.
// dividends added 7 Sep 2026, cross-checked against the practice's own general Xenon settings page
// ("Ignore the following expense codes from this check" for Purchase Tax Missing lists "Dividends
// Paid - Shareholder 1" alongside wages/pensions/corporation tax/etc, all already covered here) —
// a dividend distribution is an equity movement, never a VATable purchase, the company equivalent
// of "drawings" already excluded above for sole traders/partnerships.
const PURCHASE_TAX_EXEMPT_KEYWORDS = /\b(payroll|statutory|wages?|salar(?:y|ies)|paye|national insurance|pensions?|bank (interest|revaluations?)|depreciation|amortisation|drawings|dividends?|corporation tax|deferred tax|penalt(?:y|ies)|directors?'? remuneration|charitable|political donations|mileage)\b/i;

// Business rates sit outside VAT. Match the bare Rates account name only — "Rent & Rates"
// must stay in scope because rent is ordinarily VATable (4X4 has that combined account).
const PURCHASE_TAX_RATES_ACCOUNT = /^(business\s+|council\s+)?rates$/i;

function toDateString(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().split('T')[0];
  if (typeof value === 'string' && value.startsWith('/Date(')) {
    const match = value.match(/\/Date\((\d+)/);
    return match ? new Date(Number(match[1])).toISOString().split('T')[0] : null;
  }
  if (typeof value === 'string') return value.split('T')[0];
  if (typeof value === 'number') return new Date(value).toISOString().split('T')[0];
  return null;
}

function daysBetween(later, earlier) {
  const laterDate = toDateString(later);
  const earlierDate = toDateString(earlier);
  if (!laterDate || !earlierDate) return null;
  return (new Date(`${laterDate}T00:00:00Z`) - new Date(`${earlierDate}T00:00:00Z`)) / 86400000;
}

function sumAbsoluteExposure(items, value = item => item.amount) {
  return items.reduce((sum, item) => sum + Math.abs(Number(value(item)) || 0), 0);
}

// Xero's line.lineAmount is net or gross depending on the parent transaction's own
// lineAmountTypes ('Inclusive' vs 'Exclusive'/'NoTax') — bills and bank spend commonly disagree
// on which convention they use, so any check summing/comparing line.lineAmount across mixed
// sources without normalising first will silently mix net and gross. Every line carries its own
// taxAmount, so either basis can be reconstructed exactly per line. Shared here (rather than
// duplicated per check) so every check that reads line.lineAmount for a total or a threshold
// comparison can opt into a consistent basis instead of re-deriving this independently.
function grossLineAmount(lineAmountTypes, line) {
  const amount = line.lineAmount || 0;
  return lineAmountTypes === 'Inclusive' ? amount : amount + (line.taxAmount || 0);
}

function netLineAmount(lineAmountTypes, line) {
  return grossLineAmount(lineAmountTypes, line) - (line.taxAmount || 0);
}

// Xero reports isReconciled=false on every payment posted to a non-bank ledger account
// (Suspense, Sales Control, Directors' Loan and the like) because there is no bank feed to
// reconcile it against. Those are not bank reconciliation items, and counting them buries the
// real ones: on two reference clients they accounted for every single flagged payment
// (2,467 and 391) against a Xenon headline of zero, while the client whose payments sat on
// genuine bank accounts matched Xenon. Pass the chart of accounts to apply the restriction;
// without it the payment side is left unfiltered.
// bankAccountIds also drives per-account exclusion (Xenon supports excluding individual bank
// accounts from this check): passing the set of INCLUDED bank accounts here filters BOTH sides,
// not just payments — a bank transaction is always tied to a specific bank account in Xero's own
// data model, so filtering it against the full set of genuine bank accounts was already a no-op
// for every currently-validated client (nothing changes unless an account is actually excluded).
function selectAuthorisedUnreconciled(bankTransactions, payments, bankAccountIds = null) {
  const bank = bankTransactions
    .filter(item => item.status === 'AUTHORISED' && item.isReconciled === false)
    .filter(item => !bankAccountIds || bankAccountIds.has(item.bankAccount?.accountID))
    .map(item => ({ ...item, source: 'bank' }));
  const paymentItems = payments
    .filter(item => item.status === 'AUTHORISED' && item.isReconciled === false)
    .filter(item => !bankAccountIds || bankAccountIds.has(item.account?.accountID))
    .map(item => ({ ...item, source: 'payment' }));
  return [...bank, ...paymentItems];
}

// A suspected-duplicate GROUP is one issue worth ONE document amount — not one issue per extra
// document, and not one per pair.
//
// Reconstructed row-for-row from Xenon's 4X4 View Issues export (Aug 2026), which lists 31 numbered
// groups totalling £3,509.90 (displayed £3,510). Grouping is greedy from the newest document:
// anchor on the latest document not yet grouped, absorb every same-contact / same-amount document
// dated within `windowDays` BEFORE it, emit that group, repeat. Chaining forward instead (a rolling
// gap between consecutive dates) cannot reproduce Xenon's boundaries — its groups 5 and 7 sit two
// days apart yet stay separate, while group 4 spans three days internally.
//
// The previous rule — same calendar day, counting each extra document — matched 4X4's headline of
// 31 by coincidence: 31 extras at a 0-day window happened to equal 31 groups at a 3-day window,
// while the value was £4,225 against Xenon's £3,510. Same class of false confirmation as the
// Handymanz multi-tax "fake exact" recorded in XENON_PARITY_SPEC.md.
//
// requireUnpaidPair drops groups whose every member is fully paid (Duplicate Bills; confirmed on
// MBX and 4X4) — this is Xenon's own documented default ("at least 1 of the invoices/bills in a
// potential match must be unpaid"), togglable via their "Also check paid invoices/bills" setting;
// passing requireUnpaidPair: false reproduces that toggle being turned on.
//
// requireExactReference additionally requires a candidate to share the anchor's own reference
// (invoiceNumber/reference) before it can join the group — Xenon's documented "Exact Reference"
// setting, off by default (this function's default options already behave as if it were off, since
// grouping is by contact+amount+date alone with no reference check at all).
//
// Xenon also documents an "Exact Total" setting, off by default — but their own documentation
// explicitly does not disclose what the baseline matching criteria are when it (and Exact
// Reference) are both left off, only that both are optional "further narrowing" on top of some
// undocumented base match. This function's contact+exact-amount+date-window grouping is this
// PRACTICE's own calibrated behaviour (see the 4X4 evidence above), not a reproduction of Xenon's
// real "Exact Total: disabled" behaviour — so requireExactTotal defaults to true here (opposite of
// Xenon's own documented default), explicitly preserving every currently-validated client's
// grouping unless a specific client's real Xenon settings are confirmed to have it off, at which
// point requireExactTotal: false groups by contact + date window alone (the only interpretation
// consistent with Xenon's phrasing that reference/total are "further narrowing" on a base match).
// Never flip the fallback to false without that per-client evidence — see the master completion
// prompt's rule against tuning a universal default from a single observation.
function findDuplicates(items, windowDays = CHECK_DEFAULTS.duplicateWindowDays, options = {}) {
  const requireUnpaidPair = Boolean(options.requireUnpaidPair);
  const requireExactReference = Boolean(options.requireExactReference);
  const requireExactTotal = options.requireExactTotal !== false;
  const referenceOf = item => item.invoiceNumber || item.reference || null;
  const byGroupKey = new Map();
  for (const item of items) {
    const contactId = item.contact?.contactID;
    const amount = Math.round((item.total || 0) * 100);
    // A zero-value document was never a candidate duplicate under either mode — nothing to match.
    if (!contactId || !amount) continue;
    const key = requireExactTotal ? `${contactId}|${amount}` : contactId;
    if (!byGroupKey.has(key)) byGroupKey.set(key, []);
    byGroupKey.get(key).push(item);
  }

  const groups = [];
  for (const candidates of byGroupKey.values()) {
    // Newest first, with a stable id tie-break so re-runs group identically.
    const remaining = [...candidates].sort((a, b) => {
      const dateA = toDateString(a.date) || '';
      const dateB = toDateString(b.date) || '';
      if (dateA !== dateB) return dateB.localeCompare(dateA);
      return String(a.invoiceID || '').localeCompare(String(b.invoiceID || ''));
    });
    while (remaining.length) {
      const anchor = remaining.shift();
      const group = [anchor];
      const anchorReference = requireExactReference ? referenceOf(anchor) : null;
      for (let index = remaining.length - 1; index >= 0; index--) {
        const age = daysBetween(anchor.date, remaining[index].date);
        if (age == null || age < 0 || age > windowDays) continue;
        // A blank reference on both sides is not a "match" — it would let every reference-less
        // document at the same contact/amount/date silently satisfy this filter regardless of the
        // setting's intent, which is to REQUIRE a genuinely shared reference, not the absence of one.
        if (requireExactReference && (!anchorReference || referenceOf(remaining[index]) !== anchorReference)) continue;
        group.push(remaining[index]);
        remaining.splice(index, 1);
      }
      if (group.length < 2) continue;
      if (requireUnpaidPair && group.every(item => (item.amountDue || 0) <= 0.005)) continue;
      groups.push(group);
    }
  }

  // Oldest member first inside each group, and groups newest-first, mirroring Xenon's ordering.
  return groups
    .map(group => {
      const ordered = [...group].sort((a, b) =>
        String(toDateString(a.date) || '').localeCompare(String(toDateString(b.date) || '')));
      const earliest = ordered[0];
      const latest = ordered[ordered.length - 1];
      return {
        // id1/id2 keep the earliest and latest member so existing pair-shaped detail rendering and
        // finding identity continue to work; documentIds carries the full group.
        id1: earliest.invoiceID,
        id2: latest.invoiceID,
        contact: latest.contact?.name,
        // Counted once for the whole group — this is the exposure of the suspected duplicate.
        amount: latest.total,
        date1: toDateString(earliest.date),
        date2: toDateString(latest.date),
        ref1: earliest.invoiceNumber || earliest.reference,
        ref2: latest.invoiceNumber || latest.reference,
        documentCount: ordered.length,
        documentIds: ordered.map(item => item.invoiceID),
        documents: ordered.map(item => ({
          id: item.invoiceID,
          date: toDateString(item.date),
          reference: item.invoiceNumber || item.reference,
          amount: item.total,
          amountDue: item.amountDue,
          status: item.status,
        })),
      };
    })
    .sort((a, b) => String(b.date2 || '').localeCompare(String(a.date2 || '')));
}

// Unapproved Invoices/Bills should report distinct amounts genuinely awaiting a decision, not
// inflate that exposure with repeat drafts of the same document (someone re-saving/copying while
// working on it, never deleting the earlier attempts). Confirmed against RBC Sutherland Ltd real
// Xenon evidence: our raw draft pool was 8/£185,893.04, including 6 identical £24,164.34 drafts
// for one contact all saved within a 10-minute window — excluding that whole cluster (not
// collapsing it to one representative) landed on Xenon's exact 2/£40,907, matching on both count
// and value simultaneously.
function excludeDuplicateDrafts(items, windowDays = CHECK_DEFAULTS.duplicateWindowDays, precomputedGroups = null) {
  const groups = precomputedGroups || findDuplicates(items, windowDays);
  const duplicateIds = new Set(groups.flatMap(group => group.documentIds));
  return items.filter(item => !duplicateIds.has(item.invoiceID));
}

function isOldDocument(document, asOf, days = CHECK_DEFAULTS.oldDocumentDays) {
  const age = daysBetween(asOf, document.date);
  return age != null && age > days;
}

function findDirectMatches(transactions, documents, eligibleAccountCodes, windowDays = CHECK_DEFAULTS.directMatchWindowDays) {
  // One-to-one pairing (validated row-by-row against Xenon's MBX bill_or_direct list):
  // each document can explain at most one bank transaction, and the nearest-dated
  // document wins. Approved documents match on the amount still due; drafts on total.
  const matches = [];
  const usedDocuments = new Set();
  const ordered = [...transactions].sort((a, b) =>
    String(toDateString(a.date)).localeCompare(String(toDateString(b.date))));
  for (const transaction of ordered) {
    const contactId = transaction.contact?.contactID;
    if (!contactId || !(transaction.lineItems || []).some(line => eligibleAccountCodes.has(line.accountCode))) continue;
    const amount = Math.round((transaction.total || 0) * 100);
    if (!amount) continue;
    let candidate = null; let candidateGap = null;
    for (const document of documents) {
      if (usedDocuments.has(document.invoiceID)) continue;
      if (document.contact?.contactID !== contactId) continue;
      const documentAmount = document.status === 'AUTHORISED' ? document.amountDue : document.total;
      if (Math.round((documentAmount || 0) * 100) !== amount) continue;
      const daysAfterDocument = daysBetween(transaction.date, document.date);
      if (daysAfterDocument == null || daysAfterDocument < 0 || daysAfterDocument > windowDays) continue;
      if (!candidate || daysAfterDocument < candidateGap) { candidate = document; candidateGap = daysAfterDocument; }
    }
    if (candidate) {
      usedDocuments.add(candidate.invoiceID);
      matches.push({ transaction, document: candidate });
    }
  }
  return matches;
}

// Normalizes a contact name for exact-match exclusion lookups ("Ignore this contact") — lowercase
// and whitespace-collapsed only, deliberately lighter than contactNameSimilarity's alphanumeric-only
// strip below (which is for FUZZY duplicate detection); an exclusion must match the same real
// contact exactly, not just something similarly spelled.
function normalizeContactKey(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function contactNameSimilarity(nameA, nameB) {
  const a = String(nameA || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const b = String(nameB || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!a || !b) return 0;
  return 1 - levenshtein.get(a, b) / Math.max(a.length, b.length);
}

function findDuplicateContacts(contacts, threshold = CHECK_DEFAULTS.contactSimilarityThreshold) {
  const duplicates = [];
  for (let i = 0; i < contacts.length; i++) {
    for (let j = i + 1; j < contacts.length; j++) {
      if (contactNameSimilarity(contacts[i].name, contacts[j].name) < threshold) continue;
      duplicates.push({
        id1: contacts[i].contactID,
        name1: contacts[i].name,
        id2: contacts[j].contactID,
        name2: contacts[j].name,
      });
    }
  }
  return duplicates;
}

function findUnexpectedDefaultLines(documents, contactsById, defaultField, lineField) {
  const findings = [];
  for (const document of documents) {
    const contact = contactsById[document.contact?.contactID];
    const expected = contact?.[defaultField];
    if (!expected) continue;
    for (const line of (document.lineItems || [])) {
      if (line[lineField] && line[lineField] !== expected) {
        findings.push({ document, line, expected });
      }
    }
  }
  return findings;
}

// Capital Item Review defaults + opt-out (2026-09): Xenon monitors account codes 461/473 by
// default "if they exist" — but is_capital_candidate on its own can't tell "never configured"
// (apply the default) apart from "explicitly unchecked" (a deliberate opt-out), since both store 0.
// accountSettingsInitialised is the tri-state that resolves this: false/0 means the accountant has
// never saved the Per-account Check Settings page for this org, so the documented default still
// applies; true/1 means it has been saved at least once, so is_capital_candidate is trusted
// verbatim — including an explicit 0 on 461 or 473, which now genuinely excludes it.
function resolveCapitalReviewCandidateCodes(accountCheckConfigurations, accountNameByCode, accountSettingsInitialised) {
  const codes = new Set(
    accountCheckConfigurations.filter(account => account.is_capital_candidate).map(account => account.account_code)
  );
  if (!accountSettingsInitialised) {
    for (const code of ['461', '473']) if (accountNameByCode[code]) codes.add(code);
  }
  return codes;
}

// Misallocated Items — one source at a time (bill / customer invoice / Money Out / Money In), so
// xeroSync.js calls this once per source with that source's own monitored-codes set (expense-side
// codes for bills/Money Out, revenue-side codes for invoices/Money In) rather than mixing the two.
// Net (ex-VAT) amount, consistent with the other threshold-based checks (capital_item_review,
// low_cost_fixed_assets) — raw lineAmount mixes gross (bank spend, usually Inclusive) and net
// (bills/invoices, usually Exclusive), so a fixed £ threshold would compare like against unlike.
function findMisallocatedLines(documents, monitoredCodes, getThresholdForAccount, source) {
  const findings = [];
  for (const document of documents) {
    for (const line of (document.lineItems || [])) {
      if (!line.accountCode || !monitoredCodes.has(line.accountCode)) continue;
      const amount = Math.abs(netLineAmount(document.lineAmountTypes, line));
      if (amount < getThresholdForAccount(line.accountCode)) continue;
      findings.push({
        invoiceId: document.invoiceID || document.bankTransactionID, contact: document.contact?.name,
        date: toDateString(document.date), accountCode: line.accountCode,
        description: line.description, amount, source,
      });
    }
  }
  return findings;
}

function isPurchaseTaxExemptAccount(accountName, extraExemptCodes, accountCode) {
  if (extraExemptCodes.has(accountCode)) return true;
  const name = accountName || '';
  if (PURCHASE_TAX_RATES_ACCOUNT.test(name.trim())) return true;
  return PURCHASE_TAX_EXEMPT_KEYWORDS.test(name);
}

function withDisplayOnlyBankFindings(documentFindings, bankFindings) {
  return {
    count: documentFindings.length,
    potentialValue: sumAbsoluteExposure(documentFindings),
    details: [
      ...documentFindings,
      ...bankFindings.map(item => ({ ...item, displayOnly: true })),
    ],
  };
}

function selectOldCredits(credits, asOf, days = CHECK_DEFAULTS.oldDocumentDays) {
  return credits.filter(credit =>
    ['AUTHORISED', 'SUBMITTED'].includes(credit.status) &&
    isOldDocument(credit, asOf, days) &&
    Number.isFinite(Number(credit.remainingCredit)) &&
    Number(credit.remainingCredit) > 0
  );
}

const CONTACT_FINDING_CHECKS = new Set([
  'multi_account_suppliers', 'multi_tax_suppliers', 'contact_defaults', 'inactive_contacts',
]);
const ACCOUNT_FINDING_CHECKS = new Set(['bank_balance']);
const PAIR_FINDING_CHECKS = new Set([
  'duplicate_invoices', 'duplicate_bills', 'duplicate_contacts', 'invoice_or_direct', 'bill_or_direct',
]);

function findingIdentity(checkType, item) {
  const pairIds = [item.id1, item.id2].filter(Boolean).sort();
  if (pairIds.length === 2) return { kind: 'pair', ids: pairIds };
  if (PAIR_FINDING_CHECKS.has(checkType)) {
    const ids = [item.bankTransactionId, item.invoiceId].filter(Boolean).sort();
    return { kind: 'pair', ids };
  }
  if (CONTACT_FINDING_CHECKS.has(checkType)) {
    return { kind: 'contact', contactId: item.contactId || item.contactID || item.id };
  }
  if (ACCOUNT_FINDING_CHECKS.has(checkType)) {
    return { kind: 'account', accountId: item.accountId || item.bank_account_id || item.accountCode };
  }
  const documentId = item.documentId || item.invoiceId || item.invoiceID ||
    item.creditNoteId || item.creditNoteID || item.bankTransactionId ||
    item.bankTransactionID || item.paymentId || item.paymentID || item.id;
  const lineId = item.lineItemId || item.lineItemID;
  if (lineId || (documentId && (item.accountCode || item.description))) {
    return {
      kind: 'line',
      documentId,
      lineId: lineId || null,
      accountCode: item.accountCode || null,
      description: item.description || null,
      amount: Number(item.amount ?? item.lineAmount ?? 0),
      date: item.date || null,
      source: item.source || null,
    };
  }
  const contactId = item.contactId || item.contactID;
  if (contactId) return { kind: 'contact', contactId };
  const accountId = item.accountId || item.bank_account_id || item.accountCode;
  if (accountId) return { kind: 'account', accountId };
  return {
    kind: 'document',
    documentId: documentId || null,
    number: item.number || item.invoiceNumber || item.creditNoteNumber || null,
    date: item.date || null,
    amount: Number(item.amount ?? item.total ?? item.remaining ?? item.amountDue ?? 0),
    source: item.source || null,
  };
}

function addFindingKeys(checkType, items) {
  const occurrences = new Map();
  return items.map(item => {
    const identity = findingIdentity(checkType, item);
    const identityJson = JSON.stringify([checkType, identity]);
    const occurrence = occurrences.get(identityJson) || 0;
    occurrences.set(identityJson, occurrence + 1);
    const digest = crypto.createHash('sha256')
      .update(JSON.stringify([identityJson, occurrence]))
      .digest('hex')
      .slice(0, 24);
    return { finding_key: `${identity.kind}:${digest}`, ...item };
  });
}

function isReviewStateActive(review, periodKey, now = new Date()) {
  if (!review) return false;
  if (review.state === 'dismissed') return true;
  if (review.state === 'ok') return !!review.period_key && review.period_key === periodKey;
  if (review.state === 'ignored') {
    return !!review.ignored_until && new Date(review.ignored_until).getTime() > now.getTime();
  }
  return false;
}

function allocateFindingValues(items, totalValue) {
  if (!items.length) return [];
  const requestedTotal = Math.abs(Number(totalValue) || 0);
  const candidates = items.map(item => {
    if (item.displayOnly) return 0;
    const value = item.potentialValue ?? item.nonDominantValue ?? item.discrepancy ??
      item.amountDue ?? item.remaining ?? item.amount ?? item.lineAmount ?? item.total ?? 0;
    return Math.abs(Number(value) || 0);
  });
  const candidateTotal = candidates.reduce((sum, value) => sum + value, 0);
  if (!requestedTotal) return candidates.map(() => 0);
  if (!candidateTotal) {
    const count = items.filter(item => !item.displayOnly).length || 1;
    return items.map(item => item.displayOnly ? 0 : requestedTotal / count);
  }
  const scale = requestedTotal / candidateTotal;
  return candidates.map(value => value * scale);
}

function calculateHealthScore(issues, options = {}) {
  return calculateScoreBreakdown(issues, {
    ...options,
    nonScoredChecks: NON_SCORED_CHECKS,
  }).score;
}

module.exports = {
  CHECK_DEFAULTS,
  CHECK_DEFINITIONS,
  NON_SCORED_CHECKS,
  RESERVED_PERIOD_LABELS,
  NOT_APPLICABLE_PERIODS,
  NOT_CONFIGURED_PERIODS,
  UNAVAILABLE_PERIODS,
  resolvePeriodChecked,
  resolveCheckDisplayStatus,
  resolveSupplierPatternLookbackMonths,
  resolveMultiAccountPatternLookbackMonths,
  resolveMultiAccountSuppliersMinValue,
  resolveMultiTaxSuppliersMinValue,
  resolveCapitalReviewDefaultThreshold,
  resolveMisallocatedItemsDefaultThreshold,
  resolvePurchaseTaxMissingExcludeCodes,
  resolveDuplicateInvoiceWindowDays,
  resolveDuplicateBillWindowDays,
  resolveDuplicateInvoiceRequireExactReference,
  resolveDuplicateInvoiceIncludeFullyPaid,
  resolveDuplicateBillRequireExactReference,
  resolveDuplicateBillIncludeFullyPaid,
  resolveDuplicateInvoiceRequireExactTotal,
  resolveDuplicateBillRequireExactTotal,
  calculateHealthScore,
  contactNameSimilarity,
  normalizeContactKey,
  findDirectMatches,
  findDuplicateContacts,
  findDuplicates,
  excludeDuplicateDrafts,
  findUnexpectedDefaultLines,
  findMisallocatedLines,
  resolveCapitalReviewCandidateCodes,
  isOldDocument,
  isPurchaseTaxExemptAccount,
  addFindingKeys,
  allocateFindingValues,
  isReviewStateActive,
  selectOldCredits,
  selectAuthorisedUnreconciled,
  sumAbsoluteExposure,
  grossLineAmount,
  netLineAmount,
  toDateString,
  withDisplayOnlyBankFindings,
};
