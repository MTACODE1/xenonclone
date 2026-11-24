// UAE rules for Zoho Books clients whose books are kept for a UAE company. Only the Zoho checks
// (zohoChecks.js) use this file; the Xero checks, VAT_LIMITS (journalChecks.js) and PRACTICE_POLICY
// (checkRules.js) are untouched, so a UK client is never judged by a UAE rule or the other way round.
//
// Sources (researched 24 Nov 2026; see the UAE rules spec):
//  - VAT registration: mandatory over AED 375,000 of taxable supplies and imports in 12 months, voluntary from
//    AED 187,500 (tax.gov.ae, VAT registration). Deregistration below AED 187,500, application due within 30
//    business days (tax.gov.ae, VAT deregistration).
//  - Corporate Tax Small Business Relief: revenue up to AED 3,000,000, extended to tax periods ending on or
//    before 31 Dec 2029 (Ministry of Finance notice, 7 Aug 2026). Lost for good once one tax period goes over
//    (Ministerial Decision 73 of 2023, Art. 2). Not for Qualifying Free Zone Persons.
//  - Blocked input VAT: entertainment for non-employees and cars available for personal use (VAT Executive
//    Regulation Art. 53, secondary source). Treated as "review", never as an error.
//  - No legal capitalisation threshold: AED 10,000 is a practice default (about GBP 2,000), to be confirmed.

const UAE_VAT = Object.freeze({ mandatory: 375000, voluntary: 187500, amberBand: 0.9 });
const SBR_REVENUE = 3000000;
const SBR_LAST_PERIOD_END = '2029-12-31';
const SBR_FIRST_PERIOD_START = '2023-06-01'; // the relief covers tax periods starting on or after 1 June 2023
const UAE_POLICY = Object.freeze({
  capitalisationThresholdAed: 10000,
  inactiveContactMonths: 24,   // activity comes from documents only until bank access is granted, so wait longer
});

// VAT accounts in a UAE (or any) Zoho chart: "Input VAT" (an asset in Zoho), "Output VAT", "VAT Payable",
// "GCC VAT Payable", reverse charge and excise accounts. Zoho does not mark them as system VAT accounts.
const VAT_ACCOUNT_NAME = /\b(input|output)\s+(vat|tax)\b|\bvat\s+(payable|control|receivable|refund|liabilit\w*|account)\b|\bgcc\s+vat\b|\breverse\s+charge\b|\bexcise\s+tax\b/i;

// Purchase Tax Missing ignores these UAE accounts by name: payroll and end-of-service costs, government and
// visa fees, fines, depreciation, Corporate Tax, owner and loan movements, zakat and donations (none carry VAT).
// Rent and bank fees are deliberately NOT here: commercial rent is standard-rated and UAE bank fees usually carry 5%.
const UAE_PURCHASE_TAX_EXCLUDED_NAME = /salar|wages|payroll|end of service|gratuity|gpsss?a|pension|visa|immigration|labour card|government fee|\bfines?\b|penalt|depreciation|amorti[sz]ation|corporate tax|dividend|drawings|interest|\bloan|zakat|donation/i;

// Blocked input VAT (Executive Regulation Art. 53): entertainment, and motor vehicles bought, hired or leased.
const UAE_ENTERTAINMENT_NAME = /entertain|hospitality|\bmeals?\b/i;
const UAE_VEHICLE_NAME = /vehicle|\bcar\s+(hire|lease|leasing|rent|rental)|\bmotor\b/i;

// Owner and related-party accounts (a Zoho UAE chart names them "Shareholder Loan Account - <name>" or
// "<name> Current Account"). Used only to describe the Shareholder check, which needs balances Zoho cannot give.
const UAE_RELATED_PARTY_NAME = /shareholder|partner|owner|director|related party|due (to|from)|current account/i;

// Is this Zoho client a UAE company? Zoho leaves the organisation's country empty, so it is told from the
// currency (AED), the tax rates (country AE or authority FTA) or the "TRN" registration label.
function regionOf({ baseCurrency = null, taxRates = [], taxProfile = null } = {}) {
  const currency = String(baseCurrency || taxProfile?.currencyCode || '').trim().toUpperCase();
  if (currency === 'AED') return 'AE';
  if (String(taxProfile?.countryCode || '').toUpperCase() === 'AE') return 'AE';
  if (/^TRN$/i.test(String(taxProfile?.taxRegNoLabel || '').trim())) return 'AE';
  if ((taxRates || []).some(rate => String(rate?.countryCode || '').toUpperCase() === 'AE'
    || /^FTA$/i.test(String(rate?.taxAuthorityName || '').trim()))) return 'AE';
  return null;
}

// VAT registered? Zoho's own flag when it gave one; otherwise "registered" only if the organisation has an active
// tax rate above 0% (an unregistered Zoho organisation has none). Never guesses "registered" from nothing.
function isVatRegistered(taxProfile, taxRates) {
  if (taxProfile && taxProfile.isTaxRegistered === true) return true;
  if (taxProfile && taxProfile.isTaxRegistered === false) return false;
  return (taxRates || []).some(rate => rate && rate.status !== 'ARCHIVED' && Number(rate.effectiveRate) > 0);
}

// A line with no VAT rate that is exempt or out of scope on purpose (Zoho's exemption id/code or a treatment code
// saying so). Such a line is not "missing" its VAT.
function isExemptLine(line) {
  if (!line) return false;
  if (line.taxExemptionID || line.taxExemptionCode) return true;
  return /exempt|out_?of_?scope|non_?taxable|not_?applicable/i.test(String(line.taxTreatmentCode || ''));
}

// Reverse charge: the customer (our client) accounts for the VAT, so a bill line may have no rate of its own.
function isReverseChargeLine(document, line) {
  return Boolean((document && document.isReverseChargeApplied) || (line && line.isReverseCharge));
}

// An import for the VAT registration test: a bill from outside the UAE (non_gcc, gcc_*) or under reverse charge.
function isImportDocument(document) {
  const treatment = String(document?.taxTreatment || '').toLowerCase();
  return Boolean(document?.isReverseChargeApplied) || treatment === 'non_gcc' || treatment.startsWith('gcc_');
}

// A bill from a supplier that is not VAT-registered (Zoho's tax treatment vat_not_registered, gcc_vat_not_registered
// or dz_vat_not_registered): no VAT is due on it, so a blank rate is right.
function isUnregisteredSupplier(document) {
  return /(^|_)vat_not_registered$/.test(String(document?.taxTreatment || '').toLowerCase());
}

// An import from outside the GCC (treatment non_gcc) that is not under reverse charge.
function isNonGccImport(document) {
  return String(document?.taxTreatment || '').toLowerCase() === 'non_gcc' && !document?.isReverseChargeApplied;
}

const aed = value => `AED ${Math.round(Number(value) || 0).toLocaleString('en-GB')}`;

// The UAE VAT registration and Corporate Tax Small Business Relief tests. Pure: the caller works out the figures.
//  taxableSupplies: rolling 12 months of taxable sales plus imports, net, in AED
//  revenue: this financial year's income-account sales, net, in AED (null when not known)
//  priorRevenue: earlier financial years' revenue, [{ fyEnd, revenue }], from the invoices Zoho Books holds
//  registered: Zoho's registration flag (or the rates); isFreeZone: Zoho's free zone flag (null = not known)
//  fyEnd: the end of the financial year (the Corporate Tax period) the revenue is for
function evaluateUaeThresholds({
  taxableSupplies, registered, revenue = null, priorRevenue = [], periodEnd = null, isFreeZone = null, to = null, fyEnd = null,
}) {
  const items = [];
  const item = (rule, level, value, limit, message) => ({
    documentId: `uae-${rule}`, number: null, date: to, source: 'vat_scheme', accountCode: registered ? 'vat_registered' : 'not_vat_registered',
    description: message, amount: value, level, rule, limit,
  });
  const supplies = Number(taxableSupplies) || 0;
  if (!registered) {
    if (supplies > UAE_VAT.mandatory) {
      items.push(item('uae_vat_mandatory', 'red', supplies, UAE_VAT.mandatory,
        `Rolling 12-month taxable supplies ${aed(supplies)} are over the AED 375,000 mandatory registration limit. The client must apply to register for VAT within 30 days.`));
    } else if (supplies >= UAE_VAT.mandatory * UAE_VAT.amberBand) {
      items.push(item('uae_vat_mandatory', 'amber', supplies, UAE_VAT.mandatory,
        `Rolling 12-month taxable supplies ${aed(supplies)} against the AED 375,000 mandatory registration limit.`));
    } else if (supplies >= UAE_VAT.voluntary) {
      items.push(item('uae_vat_voluntary', 'info', supplies, UAE_VAT.voluntary,
        `Rolling 12-month taxable supplies ${aed(supplies)} are over the AED 187,500 voluntary registration limit, so the client may register voluntarily.`));
    }
  } else if (supplies < UAE_VAT.voluntary) {
    items.push(item('uae_vat_deregistration', 'info', supplies, UAE_VAT.voluntary,
      `Rolling 12-month taxable supplies ${aed(supplies)} are below the AED 187,500 limit. The client may have to deregister; the FTA expects the application within 30 business days of the obligation arising.`));
  }
  // Small Business Relief (Ministerial Decision 73 of 2023): revenue of AED 3m or less in the tax period AND in
  // every earlier one, so a year over the limit ends the relief for that year and all later years. Only tax periods
  // (financial years) ending on or before 31 Dec 2029 are covered, so the year end is compared, not the review
  // period's end. A Qualifying Free Zone Person cannot claim it, but not every free zone company is one, so a free
  // zone client's result is shown as "review" rather than hidden.
  const taxPeriodEnd = fyEnd || periodEnd;
  const sbrApplies = revenue != null && !(taxPeriodEnd && taxPeriodEnd > SBR_LAST_PERIOD_END);
  if (sbrApplies) {
    const value = Number(revenue) || 0;
    const ddmmyyyy = date => date.split('-').reverse().join('/');
    const year = fyEnd ? ` for the financial year to ${ddmmyyyy(fyEnd)}` : '';
    const freeZone = isFreeZone === true;
    const qfzpNote = freeZone ? ' The client is in a free zone: this applies only if it is not a Qualifying Free Zone Person, which cannot claim the relief at all.' : '';
    const level = colour => (freeZone ? 'review' : colour);
    const earlierOver = (priorRevenue || []).filter(prior => prior && Number(prior.revenue) > SBR_REVENUE)
      .sort((a, b) => String(a.fyEnd).localeCompare(String(b.fyEnd)))[0];
    if (value > SBR_REVENUE) {
      items.push(item('uae_sbr_revenue', level('red'), value, SBR_REVENUE,
        `Revenue${year} is ${aed(value)}, over the AED 3,000,000 limit: Small Business Relief is not available for that tax period or any later one.${qfzpNote}`));
    } else if (earlierOver) {
      items.push(item('uae_sbr_revenue', level('red'), Number(earlierOver.revenue), SBR_REVENUE,
        `Revenue for the earlier financial year to ${ddmmyyyy(earlierOver.fyEnd)} was ${aed(earlierOver.revenue)}, over the AED 3,000,000 limit: Small Business Relief is not available for this or any later tax period, even though this year's revenue is ${aed(value)}.${qfzpNote}`));
    } else if (value >= SBR_REVENUE * UAE_VAT.amberBand) {
      items.push(item('uae_sbr_revenue', level('amber'), value, SBR_REVENUE,
        `Revenue${year} is ${aed(value)}, close to the AED 3,000,000 Corporate Tax Small Business Relief limit. Going over it ends the relief for that year and every later one.${qfzpNote}`));
    }
  }
  return items;
}

module.exports = {
  UAE_VAT, SBR_REVENUE, SBR_LAST_PERIOD_END, SBR_FIRST_PERIOD_START, UAE_POLICY,
  VAT_ACCOUNT_NAME, UAE_PURCHASE_TAX_EXCLUDED_NAME, UAE_ENTERTAINMENT_NAME, UAE_VEHICLE_NAME, UAE_RELATED_PARTY_NAME,
  regionOf, isVatRegistered, isExemptLine, isReverseChargeLine, isImportDocument, isUnregisteredSupplier, isNonGccImport,
  evaluateUaeThresholds, aed,
};
