// The checks a Zoho Books client gets on top of the shared document checks (ledgerChecks.js), worked out from
// the accounting data the Zoho sync reads (docs/zoho-data-contract.md): the chart of accounts, tax rates, manual
// journals, invoice and bill line items, expenses and bank details. Xero clients never come here, so their checks
// and pages stay exactly as they were.
//
// The Xero check logic is reused wherever it is a function (journalChecks, checkRules). Zoho lines name their
// account by accountID (Zoho account codes are usually blank), while those functions key accounts by `code`, so
// they are given a copy of the chart and the lines keyed by accountID ("rekeyed"), and the rows they return are
// given back the account's real code and name for the page.
//
// region 'AE' (a UAE company, see uaeRules.regionOf) swaps every UK-specific rule for its UAE version: AED
// thresholds, the FTA instead of HMRC, UAE VAT exemptions and reverse charge, no UK VAT schemes. Checks the UAE
// rules say do not apply are marked 'not_applicable_uae'.
//
// Nothing here reads a database or calls Zoho: ledgerChecks passes everything in, and persists what comes back.
const {
  isUnderMinimumItem, isExpenseAccountLine, grossLineAmount, netLineAmount, toDateString, sumAbsoluteExposure,
  findDirectMatches, findMisallocatedLines, isVagueAccountName, monitoredMisallocatedExpenseCodes,
  monitoredMisallocatedRevenueCodes, effectiveMisallocatedThreshold, resolveMisallocatedItemsDefaultThreshold,
  isCapitalDefaultAccount, effectiveCapitalThreshold, resolveCapitalReviewDefaultThreshold, isLowCostFixedAssetLine,
  isPurchaseTaxExemptAccount, dropTaxMissingNoise, PURCHASE_TAX_NOISE_ACCOUNT_NAME, INTEREST_INCOME_ACCOUNT_NAME,
  previousMonthsStart, isWithinPreviousMonths, withPreviousMonths, resolveSupplierPatternLookbackMonths,
  resolveMultiAccountSuppliersMinValue, resolveMultiTaxSuppliersMinValue, PRACTICE_POLICY,
} = require('./checkRules');
const journalChecks = require('./journalChecks');
const { isWithinPeriod, isWithinPatternWindow, resolvePeriod } = require('./periodResolver');
const uae = require('./uaeRules');
const mapping = require('./ledgers/zoho/mapping');
const { bankFeedOf, STALE_AFTER_DAYS } = require('./zohoBankScreenReading');
const { NOT_APPLICABLE_PERIODS } = require('./periodStatus');

// Reserved period_checked labels these checks use (periodStatus.js).
const LABELS = Object.freeze({
  unavailable: 'unavailable_zoho',            // Zoho's API cannot give the data (no reports, no balances)
  bankAccess: 'needs_zoho_bank_access',       // the connection does not allow Zoho's banking data
  expenseAccess: 'needs_zoho_expense_access', // the connection does not allow Zoho's expenses
  notApplicableUae: 'not_applicable_uae',     // a UK-only rule, for a UAE company
  notApplicableZoho: 'not_applicable_zoho',   // Zoho has no such data (e.g. contact defaults)
});

const ISSUE_DEFAULTS = Object.freeze({
  bank_balance: 'critical', unreconciled_bank_items: 'critical', unprocessed_bank: 'critical',
  opening_balance_differences: 'high', invoice_or_direct: 'medium', bill_or_direct: 'medium',
  low_cost_fixed_assets: 'medium', capital_item_review: 'medium', misallocated_items: 'medium',
  multi_account_suppliers: 'medium', multi_tax_suppliers: 'medium', unexpected_account_used: 'medium',
  unexpected_tax_code_used: 'medium', sales_tax_missing: 'medium', purchase_tax_missing: 'medium',
  sales_tax_on_bills: 'medium', purchase_tax_on_invoices: 'medium', inactive_contacts: 'low',
  journal_revenue_vs_expense: 'medium', journal_vat_control: 'critical', journal_to_bank: 'critical',
  journal_fixed_asset_to_expense: 'medium', suspense_open_balance: 'critical', tax_review_by_code: 'medium',
  vat_scheme_threshold: 'critical', directors_loan_overdrawn: 'critical', dividend_status: 'medium',
  historical_changes: 'medium', motor_vehicle_expenses: 'medium', bank_statements_review: 'high',
});

// Capital Item Review (Zoho): expense accounts that never hold a purchase to capitalise, on top of the Xero default
// exclusions (checkRules.isCapitalDefaultAccount: wages, rent, rates, insurance, interest, depreciation, tax,
// dividends, drawings), which stay exactly as they are for Xero. Commission, fees and charges (bank charges and
// licence fees included), staff costs (UAE gratuity / end of service, visas, air tickets, allowances), rent and
// lease costs, utilities (DEWA, SEWA, ADDC, FEWA) and telecoms bills (Etisalat, du), subscriptions, a trade licence,
// fines and penalties, postage and courier are running costs. Accounts where a capital purchase is often miscoded
// stay watched: IT and internet, phones and mobiles, software licences, and bank- or loan-named expense accounts.
const ZOHO_CAPITAL_EXCLUDED_NAME = new RegExp([
  String.raw`commissions?`, String.raw`fees?`, String.raw`charges?`, String.raw`salar(?:y|ies)`, String.raw`wages?`,
  String.raw`payroll`, String.raw`gratuity`, String.raw`end\s+of\s+service`, String.raw`staff\s+welfare`, String.raw`visas?`,
  String.raw`air\s*tickets?`, String.raw`allowances?`, String.raw`bonus(?:es)?`, String.raw`incentives?`,
  String.raw`rents?`, String.raw`rental`, String.raw`leases?`, String.raw`leasing`, String.raw`utilit(?:y|ies)`,
  String.raw`electricity`, String.raw`water`, String.raw`dewa`, String.raw`sewa`, String.raw`addc`, String.raw`fewa`,
  String.raw`telecoms?`, String.raw`etisalat`, String.raw`du`, String.raw`subscriptions?`, String.raw`trade\s+licen[cs]es?`,
  String.raw`memberships?`, String.raw`fines?`, String.raw`penalt(?:y|ies)`, String.raw`postage`, String.raw`courier`,
].map(word => String.raw`\b${word}\b`).join('|'), 'i');
const isZohoCapitalCandidate = account => isCapitalDefaultAccount(account) && !ZOHO_CAPITAL_EXCLUDED_NAME.test(String(account?.name || ''));

const round2 = value => Math.round((Number(value) || 0) * 100) / 100;
const lower = value => String(value || '').trim().toLowerCase();

function runZohoChecks({
  org = {}, period, region = null, taxProfile = null, accounting, invoices = [], credits = [], contacts = [],
  bankReading = null, money, now = new Date(),
}) {
  const issues = [];
  const notes = [];
  const isUae = region === 'AE';
  const importanceOf = checkType => (isUae && checkType === 'directors_loan_overdrawn' ? 'medium' : ISSUE_DEFAULTS[checkType]);
  const push = (checkType, { count, value = 0, items = [], periodChecked }) => issues.push({
    check_type: checkType, importance: importanceOf(checkType),
    count, potential_value_gbp: value, detail_json: JSON.stringify(items), period_checked: periodChecked,
  });
  // Not applicable carries 0 (it ran, nothing applies); unavailable and "needs set-up" carry null, as in Xero.
  const mark = (checkType, label) => push(checkType, { count: NOT_APPLICABLE_PERIODS.has(label) ? 0 : null, periodChecked: label });
  // A check that throws leaves no result, so the page shows "Not synced" rather than a false OK (as in xeroSync.js).
  const attempt = (name, fn) => {
    try { fn(); } catch (error) { console.error(`[zohoChecks] ${name} failed — skipping (will show as "Not synced"):`, error.message); }
  };

  const accounts = Array.isArray(accounting?.accounts) ? accounting.accounts : [];
  const taxRates = Array.isArray(accounting?.taxRates) ? accounting.taxRates : [];
  const allJournals = Array.isArray(accounting?.manualJournals) ? accounting.manualJournals : [];
  const bankRows = Array.isArray(accounting?.bankTransactions) ? accounting.bankTransactions : [];
  const readStatus = accounting?.readStatus || null;
  const permissions = readStatus?.permissions || {};

  // ---- Accounts, keyed by Zoho's accountID ----
  const accountById = new Map();
  const idByCode = new Map();
  for (const account of accounts) {
    if (!account || account.accountID == null) continue;
    accountById.set(String(account.accountID), account);
    if (account.code) idByCode.set(String(account.code).toUpperCase(), String(account.accountID));
  }
  // A line's account id: its accountID, else the account its code names (bills can carry only a code).
  const idOfLine = line => {
    if (!line) return null;
    if (line.accountID != null && line.accountID !== '') return String(line.accountID);
    return line.accountCode ? idByCode.get(String(line.accountCode).toUpperCase()) || null : null;
  };
  // What a row shows: the account's code when it has one, else its name (Zoho codes are usually blank).
  const shown = id => {
    const account = id ? accountById.get(String(id)) : null;
    if (!account) return { accountCode: null, accountName: null, accountID: id || null };
    return account.code
      ? { accountCode: account.code, accountName: account.name || null, accountID: account.accountID }
      : { accountCode: account.name || null, accountName: null, accountID: account.accountID };
  };
  const nameOf = id => accountById.get(String(id))?.name || '';
  const idsWhere = test => new Set([...accountById.values()].filter(test).map(account => String(account.accountID)));
  const revenueIds = idsWhere(a => a._class === 'REVENUE');
  const expenseIds = idsWhere(a => a._class === 'EXPENSE');
  const fixedIds = idsWhere(a => a.type === 'FIXED');
  const classById = new Map([...accountById].map(([id, a]) => [id.toUpperCase(), a._class]));
  const nameById = Object.fromEntries([...accountById].map(([id, a]) => [id, a.name || '']));
  // The chart as the Xero helpers expect it: code = accountID. VAT accounts are marked as Xero marks its own
  // ("GST") so the VAT journal check finds them; Zoho does not mark them, and "Input VAT" is an asset there.
  const rekeyedAccounts = [...accountById.values()].map(account => ({
    ...account, code: String(account.accountID),
    systemAccount: uae.VAT_ACCOUNT_NAME.test(account.name || '') ? 'GST' : (account.systemAccount || ''),
  }));
  const rekeyLines = lines => (lines || []).map(line => ({ ...line, accountCode: idOfLine(line) }));
  const rekeyDoc = doc => ({ ...doc, lineItems: rekeyLines(doc.lineItems) });

  // ---- Documents ----
  const isOpening = doc => Boolean(doc && doc.isOpeningBalance);
  const posted = doc => ['AUTHORISED', 'PAID'].includes(doc.status);
  const accrec = invoices.filter(doc => doc.type === 'ACCREC' && posted(doc) && !isOpening(doc));
  const accpay = invoices.filter(doc => doc.type === 'ACCPAY' && posted(doc) && !isOpening(doc));
  const expenses = bankRows.filter(row => row && row.source === 'zoho_expense' && row.status === 'AUTHORISED');
  const statementLines = bankRows.filter(row => row && row.source === 'zoho_uncategorized');
  const journals = allJournals.filter(journal => journal && journal.status === 'POSTED');
  const dateOf = item => toDateString(item.date);
  const inPeriod = items => items.filter(item => isWithinPeriod(dateOf(item), period));
  const previousStart = previousMonthsStart(period);
  const inPrevious = items => items.filter(item => isWithinPreviousMonths(dateOf(item), period, previousStart));
  const scopes = {
    period: { docs: inPeriod, label: 'period' },
    previous: { docs: inPrevious, label: 'previous' },
  };
  // Expenses are only there when the connection allows them; refused, the checks that need them say so.
  const expensesRefused = permissions.expenses === false;
  const bankingRefused = permissions.banking === false;

  // Documents in the period whose lines have not been read yet (the per-sync read cap): the line checks cannot
  // see them this time. Said once, so a low count is never taken for a clean result without explanation.
  const unreadInPeriod = inPeriod([...accrec, ...accpay]).filter(doc => doc.lineItemsRead === false).length
    + inPeriod(expenses).filter(doc => doc.lineItemsRead === false).length
    + inPeriod(journals).filter(journal => journal.linesRead === false).length;
  // Changed in Zoho since their lines were read, and not read again yet: checked on their earlier lines.
  const staleInPeriod = inPeriod([...accrec, ...accpay, ...expenses]).filter(doc => doc.lineItemsStale === true).length
    + inPeriod(journals).filter(journal => journal.linesStale === true).length;
  if (unreadInPeriod) notes.push(`${unreadInPeriod} Zoho Books document(s) in the period have no line items read yet (read cap); the line checks will include them after the next sync.`);
  // Kept with the client (ledgerChecks) so the line-item checks' pages can say it too (LINE_ITEM_CHECKS).
  const coverage = { unreadInPeriod, staleInPeriod, periodKey: period.key || null };

  // ---- Money ----
  // A line's net amount in the document's own currency (Xero's convention: Inclusive lines hold the gross).
  const docNet = (doc, line) => (doc.lineAmountTypes === 'Inclusive'
    ? (Number(line.lineAmount) || 0) - (Number(line.taxAmount) || 0)
    : Number(line.lineAmount) || 0);
  const hasRate = doc => Number(doc && doc.currencyRate) > 0;
  const cannotConvert = doc => Boolean(money.foreignCode(doc)) && !hasRate(doc);
  // The same net in the client's currency (null when it cannot be converted): compared against thresholds.
  const baseNet = (doc, line) => (cannotConvert(doc) ? null : netLineAmount(doc, line));
  const baseGross = (doc, line) => (cannotConvert(doc) ? null : grossLineAmount(doc, line));
  // A row's figure: its own currency, with the converted figure beside it (as the document checks show it).
  const lineRow = (doc, line, extra = {}) => {
    const amount = round2(docNet(doc, line));
    return { amount, ...money.currencyFields(doc, amount), ...extra };
  };
  const rowValue = row => (row.noExchangeRate ? 0 : typeof row.baseAmount === 'number' ? row.baseAmount : Number(row.amount) || 0);
  const exposure = rows => sumAbsoluteExposure(rows.filter(row => !row.displayOnly), rowValue);
  const docRef = doc => doc.invoiceID
    ? { invoiceId: doc.invoiceID, number: doc.invoiceNumber || null, type: doc.type, source: doc.type === 'ACCREC' ? 'invoice' : 'bill' }
    : { bankTransactionId: doc.bankTransactionID, number: doc.reference || null, source: 'expense' };
  const taxNameById = new Map(taxRates.map(rate => [String(rate.taxType), rate.name || rate.taxType]));
  const taxLabel = line => {
    if (!line.taxType || line.taxType === 'NONE') return uae.isExemptLine(line) ? 'Exempt / out of scope' : 'No VAT';
    return line.taxName || taxNameById.get(String(line.taxType)) || String(line.taxType);
  };
  const ratePercent = line => {
    if (line.taxPercentage != null && Number.isFinite(Number(line.taxPercentage))) return Number(line.taxPercentage);
    const rate = taxRates.find(r => String(r.taxType) === String(line.taxType));
    return rate && rate.effectiveRate != null ? Number(rate.effectiveRate) : null;
  };
  const vatRegistered = uae.isVatRegistered(taxProfile, taxRates);
  // The date VAT registration took effect (Zoho's tax settings). Before it the client could not charge or reclaim VAT,
  // so documents dated earlier are left out of the tax-code checks.
  const vatFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(taxProfile?.taxRegisteredDate || '')) ? taxProfile.taxRegisteredDate : null;
  const beforeVat = doc => Boolean(vatFrom) && Boolean(dateOf(doc)) && dateOf(doc) < vatFrom;
  const accountsKnown = accountById.size > 0;
  const todayIso = now.toISOString().slice(0, 10);

  // =============================== Coding checks (line items) ===============================

  // Multi-Account Suppliers: the same rule as xeroSync.js (expense accounts only, items under 1 ignored, gross,
  // the review period only, value = the in-period amount outside the supplier's main account), on bills and
  // expenses. Vendor credits are not included: Zoho's vendor credit list has no lines.
  attempt('multi_account_suppliers', () => {
    if (!accountsKnown) throw new Error('chart of accounts not read');
    const lookback = PRACTICE_POLICY.multiAccountLookbackMonths;
    const floor = new Date(`${period.start}T00:00:00Z`);
    floor.setUTCMonth(floor.getUTCMonth() - lookback);
    const patternStart = [period.start, floor.toISOString().slice(0, 10)].filter(Boolean).sort()[0];
    const inWindow = items => items.filter(item => isWithinPatternWindow(dateOf(item), period, patternStart));
    const suppliers = new Map();
    const record = (doc, line, inScope) => {
      const contactId = doc.contact?.contactID;
      const id = idOfLine(line);
      if (!contactId || !id || !isExpenseAccountLine(id, classById)) return;
      const gross = baseGross(doc, line);
      if (gross == null || isUnderMinimumItem(gross)) return;
      const amount = Math.abs(gross);
      const entry = suppliers.get(contactId) || { name: doc.contact?.name || null, amounts: {}, inPeriod: {}, transactions: [] };
      if (inScope) {
        entry.amounts[id] = (entry.amounts[id] || 0) + amount;
        if (isWithinPeriod(dateOf(doc), period)) entry.inPeriod[id] = (entry.inPeriod[id] || 0) + amount;
      }
      entry.transactions.push({
        date: dateOf(doc), reference: doc.reference || doc.invoiceNumber || null, description: line.description || null,
        ...docRef(doc), inPeriod: inScope && isWithinPeriod(dateOf(doc), period), ...shown(id), amount,
      });
      suppliers.set(contactId, entry);
    };
    for (const doc of inWindow([...accpay, ...expenses])) for (const line of doc.lineItems || []) record(doc, line, true);
    const minValue = resolveMultiAccountSuppliersMinValue(org, 0);
    const flagged = [];
    for (const [contactId, entry] of suppliers) {
      const ids = Object.keys(entry.amounts);
      if (ids.length <= 1 || !Object.keys(entry.inPeriod).length) continue;
      const dominant = ids.reduce((a, b) => (entry.amounts[a] >= entry.amounts[b] ? a : b));
      const value = Object.entries(entry.inPeriod).reduce((sum, [id, amount]) => (id !== dominant ? sum + amount : sum), 0);
      if (value < minValue) continue;
      flagged.push({ contactId, entry, ids, value });
    }
    // The 3 months before the period, listed for context for the flagged suppliers only.
    const flaggedIds = new Set(flagged.map(f => f.contactId));
    for (const doc of inPrevious([...accpay, ...expenses]).filter(d => !isWithinPatternWindow(dateOf(d), period, patternStart))) {
      if (flaggedIds.has(doc.contact?.contactID)) for (const line of doc.lineItems || []) record(doc, line, false);
    }
    const items = flagged.map(({ contactId, entry, ids, value }) => ({
      contactId, name: entry.name, accountCodes: ids.map(id => shown(id).accountCode), potentialValue: round2(value),
      transactions: [...entry.transactions].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))),
    }));
    push('multi_account_suppliers', {
      count: items.length, value: items.reduce((sum, item) => sum + item.potentialValue, 0), items,
      periodChecked: `supplier_pattern_from_${patternStart}_value_since_lock_date`,
    });
  });

  // Multi-Tax Code Suppliers: as xeroSync.js (net, items under 1 ignored, a "No VAT" line counts as a code but adds
  // no value, the client's supplier lookback), on bills and expenses. "Exempt / out of scope" is a code of its own.
  // Zoho organisations often hold two rates that are the same VAT treatment under different names (an old
  // "Standard Rate" 5% and a newer "VAT" 5%): a supplier billed under both has not been given two tax codes. So
  // rates are grouped by their percentage (zero-rated 0% stays apart from "No VAT" and from exempt / out of scope,
  // which carry no rate), not by Zoho's tax_id; a rate whose percentage is unknown keeps its own group.
  const taxGroupOf = line => {
    if (!line.taxType || line.taxType === 'NONE') return taxLabel(line);
    const pct = ratePercent(line);
    return pct == null || !Number.isFinite(pct) ? `id:${line.taxType}` : `rate:${pct}`;
  };
  attempt('multi_tax_suppliers', () => {
    const lookbackMonths = resolveSupplierPatternLookbackMonths(org);
    const floor = new Date(`${period.start}T00:00:00Z`);
    floor.setUTCMonth(floor.getUTCMonth() - lookbackMonths);
    const patternStart = [period.start, floor.toISOString().slice(0, 10)].filter(Boolean).sort()[0];
    const inWindow = items => items.filter(item => { const d = dateOf(item); return d && d >= patternStart && d <= period.end; });
    const isMileage = name => /^mileage(\s+expense)?$/i.test(String(name || '').trim());
    const suppliers = new Map();
    for (const doc of inWindow([...accpay, ...expenses])) {
      if (beforeVat(doc)) continue;
      const contactId = doc.contact?.contactID;
      if (!contactId || isMileage(doc.contact?.name)) continue;
      const entryInPeriod = isWithinPeriod(dateOf(doc), period);
      for (const line of doc.lineItems || []) {
        if (isUnderMinimumItem(line.lineAmount)) continue;
        const net = baseNet(doc, line);
        if (net == null) continue;
        const code = taxGroupOf(line);
        const amount = Math.abs(net);
        const entry = suppliers.get(contactId) || { name: doc.contact?.name || null, amounts: {}, inPeriod: {}, names: {}, transactions: [] };
        entry.amounts[code] = (entry.amounts[code] || 0) + amount;
        if (entryInPeriod) entry.inPeriod[code] = (entry.inPeriod[code] || 0) + amount;
        (entry.names[code] = entry.names[code] || new Set()).add(taxLabel(line));
        entry.transactions.push({
          date: dateOf(doc), reference: doc.reference || doc.invoiceNumber || null, ...docRef(doc),
          inPeriod: entryInPeriod, taxCode: taxLabel(line), ...shown(idOfLine(line)), description: line.description || null, amount,
        });
        suppliers.set(contactId, entry);
      }
    }
    const minValue = resolveMultiTaxSuppliersMinValue(org, 0);
    const noValue = new Set(['No VAT', 'Exempt / out of scope']);
    // A group's name on the page: the rate's name, or every name it was used under ("Standard Rate / VAT").
    const groupName = (entry, code) => [...(entry.names[code] || [code])].sort().join(' / ');
    const items = [];
    for (const [contactId, entry] of suppliers) {
      const codes = Object.keys(entry.amounts);
      if (codes.length <= 1 || !Object.keys(entry.inPeriod).length) continue;
      const dominant = codes.reduce((a, b) => (entry.amounts[a] >= entry.amounts[b] ? a : b));
      const value = Object.entries(entry.inPeriod).reduce((sum, [code, amount]) => (code !== dominant && !noValue.has(code) ? sum + amount : sum), 0);
      if (value < minValue) continue;
      items.push({
        contactId, name: entry.name, taxCodes: codes.map(code => groupName(entry, code)), dominantTax: groupName(entry, dominant), nonDominantValue: round2(value),
        transactions: [...entry.transactions].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))),
      });
    }
    push('multi_tax_suppliers', {
      count: items.length, value: items.reduce((sum, item) => sum + item.nonDominantValue, 0), items,
      periodChecked: `supplier_pattern_from_${patternStart}_value_since_lock_date`,
    });
  });

  // Purchase Tax Missing / Sales Tax Missing: a line with no VAT rate, a positive amount and an expense (or fixed
  // asset) / income account, counted per line, items under 1 dropped (as xeroSync.js). A line exempt or out of
  // scope on purpose, or under reverse charge, is not missing anything. UK names (payroll, bank fees, rent,
  // mileage, interest) are skipped as in Xero; a UAE client uses the UAE list instead, which keeps rent and bank
  // fees (both normally carry 5% in the UAE).
  const missingTax = (doc, line) => (!line.taxType || line.taxType === 'NONE') && (Number(line.lineAmount) || 0) > 0
    && !uae.isExemptLine(line) && !uae.isReverseChargeLine(doc, line);
  attempt('purchase_tax_missing', () => {
    if (!accountsKnown) throw new Error('chart of accounts not read');
    if (!vatRegistered) return mark('purchase_tax_missing', 'not_vat_registered');
    const inScope = id => id && (expenseIds.has(id) || fixedIds.has(id))
      && (isUae ? !uae.UAE_PURCHASE_TAX_EXCLUDED_NAME.test(nameOf(id)) : !isPurchaseTaxExemptAccount(nameOf(id), new Set(), id));
    const linesFor = scope => {
      const rows = [];
      for (const doc of scope.docs([...accpay, ...expenses])) {
        // UAE: a supplier that is not VAT-registered charges no VAT, so its bills rightly carry none.
        if (isUae && uae.isUnregisteredSupplier(doc)) continue;
        if (beforeVat(doc)) continue;
        // An import from outside the GCC with no VAT and no reverse charge is right for goods whose VAT was paid at
        // customs, but not for services (they should be under reverse charge). Zoho does not say which, so these
        // lines are listed for review and add no value.
        const importReview = isUae && uae.isNonGccImport(doc);
        for (const line of doc.lineItems || []) {
          const id = idOfLine(line);
          if (!missingTax(doc, line) || !inScope(id)) continue;
          // Keyed by account id while the noise filter runs (it looks names up by accountCode), then shown.
          rows.push(lineRow(doc, line, {
            ...docRef(doc), contact: doc.contact?.name || null, date: dateOf(doc), accountCode: id, description: line.description || null,
            ...(importReview ? {
              level: 'review', rule: 'uae_import_no_vat', potentialValue: 0,
              note: 'Import from outside the GCC with no VAT and no reverse charge: correct for goods if VAT was paid at customs; services should be under reverse charge.',
            } : {}),
          }));
        }
      }
      return dropTaxMissingNoise(rows, {
        minAmount: 1, nameByCode: new Map(Object.entries(nameById)),
        skipName: isUae ? null : PURCHASE_TAX_NOISE_ACCOUNT_NAME, keepCodes: fixedIds,
      }).map(row => ({ ...row, ...shown(row.accountCode) }));
    };
    const rows = linesFor(scopes.period);
    push('purchase_tax_missing', {
      count: rows.length, value: exposure(rows.filter(row => row.rule !== 'uae_import_no_vat')), items: withPreviousMonths(rows, linesFor(scopes.previous)), periodChecked: period.key,
    });
  });
  attempt('sales_tax_missing', () => {
    if (!accountsKnown) throw new Error('chart of accounts not read');
    if (!vatRegistered) return mark('sales_tax_missing', 'not_vat_registered');
    const linesFor = scope => {
      const rows = [];
      for (const doc of scope.docs(accrec)) {
        if (beforeVat(doc)) continue;
        for (const line of doc.lineItems || []) {
          const id = idOfLine(line);
          if (!missingTax(doc, line) || !id || !revenueIds.has(id)) continue;
          rows.push(lineRow(doc, line, { ...docRef(doc), contact: doc.contact?.name || null, date: dateOf(doc), accountCode: id, description: line.description || null }));
        }
      }
      return dropTaxMissingNoise(rows, {
        minAmount: 1, nameByCode: new Map(Object.entries(nameById)),
        skipName: isUae ? null : INTEREST_INCOME_ACCOUNT_NAME,
      }).map(row => ({ ...row, ...shown(row.accountCode) }));
    };
    const rows = linesFor(scopes.period);
    push('sales_tax_missing', {
      count: rows.length, value: exposure(rows), items: withPreviousMonths(rows, linesFor(scopes.previous)), periodChecked: period.key,
    });
  });

  // Sales Tax on Bills / Purchase Tax on Invoices compare Xero's sales-only and purchase-only tax codes. Zoho's
  // tax rates are not split into sales and purchase rates (a UAE organisation uses the same 5% and 0% on both),
  // so there is nothing to compare.
  for (const checkType of ['sales_tax_on_bills', 'purchase_tax_on_invoices']) {
    mark(checkType, isUae ? LABELS.notApplicableUae : LABELS.notApplicableZoho);
  }
  // Unexpected Account / Tax Code Used compare a line with the contact's default account or tax rate. Zoho Books
  // contacts have none (the same reason Contact Defaults is not applicable).
  for (const checkType of ['unexpected_account_used', 'unexpected_tax_code_used']) mark(checkType, LABELS.notApplicableZoho);

  // Low Cost Fixed Assets and Capital Item Review: the practice's capitalisation threshold, GBP 2,000 for a UK
  // client and AED 10,000 for a UAE one (no UAE law sets one; practice default, to be confirmed).
  const capitalPolicy = isUae ? uae.UAE_POLICY.capitalisationThresholdAed : PRACTICE_POLICY.capitalisationThresholdGbp;
  attempt('low_cost_fixed_assets', () => {
    if (!accountsKnown) throw new Error('chart of accounts not read');
    const itemsFor = scope => {
      const rows = [];
      for (const doc of scope.docs([...accpay, ...expenses])) {
        for (const line of doc.lineItems || []) {
          const id = idOfLine(line);
          const net = baseNet(doc, line);
          if (!id || !fixedIds.has(id) || net == null) continue;
          const amount = Math.abs(net);
          if (amount > 0 && amount <= capitalPolicy) {
            rows.push(lineRow(doc, line, { ...docRef(doc), contact: doc.contact?.name || null, date: dateOf(doc), ...shown(id), description: line.description || null }));
          }
        }
      }
      return rows;
    };
    const rows = itemsFor(scopes.period);
    push('low_cost_fixed_assets', {
      count: rows.length, value: exposure(rows), items: withPreviousMonths(rows, itemsFor(scopes.previous)),
      periodChecked: `fixed_asset_accounts_lte_${capitalPolicy}_since_lock_date`,
    });
  });
  attempt('capital_item_review', () => {
    if (!accountsKnown) throw new Error('chart of accounts not read');
    // The practice default watch list (expense accounts that are not wages, rent, tax and so on), as for an
    // unconfigured Xero client: Zoho accounts have no codes for the per-account settings page to key on yet.
    const candidates = new Set([...accountById.values()].filter(isZohoCapitalCandidate).map(a => String(a.accountID)));
    if (!candidates.size) return mark('capital_item_review', 'not_configured');
    const threshold = effectiveCapitalThreshold(null, resolveCapitalReviewDefaultThreshold(org, null), capitalPolicy);
    const itemsFor = scope => {
      const rows = [];
      for (const doc of scope.docs([...accpay, ...expenses])) {
        for (const line of doc.lineItems || []) {
          const id = idOfLine(line);
          const net = baseNet(doc, line);
          if (!id || !candidates.has(id) || net == null) continue;
          const amount = Math.abs(net);
          if (amount >= threshold && !isLowCostFixedAssetLine(id, amount, fixedIds, capitalPolicy)) {
            rows.push(lineRow(doc, line, { ...docRef(doc), contact: doc.contact?.name || null, date: dateOf(doc), ...shown(id), description: line.description || null }));
          }
        }
      }
      return rows;
    };
    const rows = itemsFor(scopes.period);
    push('capital_item_review', { count: rows.length, value: exposure(rows), items: withPreviousMonths(rows, itemsFor(scopes.previous)), periodChecked: period.key });
  });

  // Misallocated Items: lines on catch-all accounts ("General Expenses", "Sundry"), with the same vague-name rule
  // and the same 1 threshold as an unconfigured Xero client, on bills, expenses and invoices.
  attempt('misallocated_items', () => {
    if (!accountsKnown) throw new Error('chart of accounts not read');
    const threshold = effectiveMisallocatedThreshold(null, resolveMisallocatedItemsDefaultThreshold(org, 1));
    const expenseWatch = monitoredMisallocatedExpenseCodes([], expenseIds, nameById);
    const revenueWatch = monitoredMisallocatedRevenueCodes([], revenueIds, nameById, true);
    const byId = new Map([...accpay, ...accrec, ...expenses].map(doc => [doc.invoiceID || doc.bankTransactionID, doc]));
    const itemsFor = scope => {
      const usable = docs => scope.docs(docs).filter(doc => !cannotConvert(doc)).map(rekeyDoc);
      return [
        ...findMisallocatedLines(usable(accpay), expenseWatch, () => threshold, 'bill'),
        ...findMisallocatedLines(usable(accrec), revenueWatch, () => threshold, 'invoice'),
        ...findMisallocatedLines(usable(expenses), expenseWatch, () => threshold, 'expense'),
      ].map(row => {
        const doc = byId.get(row.invoiceId);
        return { ...row, ...shown(row.accountCode), ...(doc && doc.bankTransactionID ? { bankTransactionId: doc.bankTransactionID } : {}) };
      });
    };
    const rows = itemsFor(scopes.period);
    push('misallocated_items', {
      count: rows.length, value: exposure(rows), items: withPreviousMonths(rows, itemsFor(scopes.previous)),
      periodChecked: `vague_account_fallback_gte_${threshold}_since_lock_date`,
    });
  });

  // Invoice or Direct: a bank deposit categorised straight to income (Zoho's sales_without_invoices, other_income or
  // deposit) while an unpaid invoice for the same customer and amount exists up to 30 days earlier: findDirectMatches,
  // as xeroSync.js does for Xero's bank receipts (unpaid approved invoices and drafts). The deposits are read with
  // banking access (accounting.fetchBankActivity); without it the check asks for Zoho to be reconnected.
  attempt('invoice_or_direct', () => {
    if (bankingRefused) return mark('invoice_or_direct', LABELS.bankAccess);
    const section = readStatus?.sections?.categorisedReceipts || null;
    const receipts = bankRows.filter(row => row && row.source === 'zoho_categorized_receipt');
    // Not read yet (an older sync, or the read budget or daily limit stopped it): "Needs sync", never a false OK.
    if (!receipts.length && !(section && section.read)) return mark('invoice_or_direct', 'needs_sync');
    if (!accountsKnown) throw new Error('chart of accounts not read');
    // The income account a deposit went to, when Zoho names it; otherwise its type says it is income. A deposit
    // Zoho says went to an account that is not income (an owner's capital, a loan) is not a sale.
    const INCOME = '__zoho_income__';
    const offsetIdOf = row => {
      if (row.offsetAccountID && accountById.has(String(row.offsetAccountID))) return String(row.offsetAccountID);
      const named = row.offsetAccountName ? [...accountById.values()].find(a => lower(a.name) === lower(row.offsetAccountName)) : null;
      return named ? String(named.accountID) : null;
    };
    const asReceipt = row => {
      const offset = offsetIdOf(row);
      if (offset && !revenueIds.has(offset)) return null;
      return { ...row, lineItems: [{ accountCode: offset || INCOME }] };
    };
    const eligible = new Set([...revenueIds, INCOME]);
    const unpaidInvoices = invoices.filter(doc => doc.type === 'ACCREC' && !isOpening(doc)
      && ((doc.status === 'AUTHORISED' && (doc.amountDue || 0) > 0) || ['DRAFT', 'SUBMITTED'].includes(doc.status)));
    const matchesFor = scope => findDirectMatches(scope.docs(receipts).map(asReceipt).filter(Boolean), unpaidInvoices, eligible)
      .map(({ transaction, document }) => ({
        bankTransactionId: transaction.bankTransactionID, contact: transaction.contact?.name || null, date: dateOf(transaction),
        amount: transaction.total, ...money.currencyFields(transaction, transaction.total),
        invoiceId: document.invoiceID, invoiceNumber: document.invoiceNumber,
        accountName: transaction.bankAccount?.name || null, type: transaction.zohoTransactionType || null,
      }));
    const rows = matchesFor(scopes.period);
    push('invoice_or_direct', { count: rows.length, value: exposure(rows), items: withPreviousMonths(rows, matchesFor(scopes.previous)), periodChecked: 'since_lock_date' });
  });
  // Bill or Direct: an expense (Zoho's "spend money") coded to an expense account while an unpaid bill from the same
  // supplier for the same amount exists up to 30 days earlier: findDirectMatches, as for Xero's bank payments.
  attempt('bill_or_direct', () => {
    if (expensesRefused && !expenses.length) return mark('bill_or_direct', LABELS.expenseAccess);
    if (!accountsKnown) throw new Error('chart of accounts not read');
    const unpaidBills = invoices.filter(doc => doc.type === 'ACCPAY' && ((doc.status === 'AUTHORISED' && (doc.amountDue || 0) > 0) || doc.status === 'DRAFT'));
    const matchesFor = scope => findDirectMatches(scope.docs(expenses).map(rekeyDoc), unpaidBills, expenseIds)
      .map(({ transaction, document }) => ({
        bankTransactionId: transaction.bankTransactionID, contact: transaction.contact?.name || null, date: dateOf(transaction),
        amount: transaction.total, ...money.currencyFields(transaction, transaction.total),
        invoiceId: document.invoiceID, invoiceNumber: document.invoiceNumber,
      }));
    const rows = matchesFor(scopes.period);
    push('bill_or_direct', { count: rows.length, value: exposure(rows), items: withPreviousMonths(rows, matchesFor(scopes.previous)), periodChecked: 'since_lock_date' });
  });

  // =============================== Journal checks ===============================
  // Journals to Bank and VAT Control Journals, one row per journal (journalChecks lists one row per line, which
  // for Zoho counted a bank-to-cash transfer twice and a VAT return journal three times):
  //  - Journals to Bank: valued once, at the larger of the money into and out of bank, card and cash accounts, so a
  //    transfer between two of them (every line on a bank or cash account) is one movement, not two. A journal on
  //    Cash / Petty Cash accounts only is kept but said to be lower risk (cash has no bank feed to post from).
  //  - VAT Control Journals: valued once, at the larger of the debits or the credits on VAT accounts, counting the
  //    VAT a tax rate on a journal line posts. A journal moving money only between VAT accounts (Output VAT against
  //    Input VAT and VAT Payable: the period-end VAT offset) is labelled for review.
  //  - A journal and its reversal (Zoho numbers it "REV - <original>" and its notes say "Reverse entry of <number>")
  //    that cancel out account by account are listed as reversed, with no value, and are not counted.
  const isBankId = id => accountById.get(String(id))?.type === 'BANK';
  const isCashId = id => {
    const account = accountById.get(String(id));
    return Boolean(account) && account.type === 'BANK' && (account.zohoAccountType === 'cash' || /\bcash\b/i.test(account.name || ''));
  };
  const isVatId = id => {
    const account = accountById.get(String(id));
    if (!account) return false;
    return uae.VAT_ACCOUNT_NAME.test(account.name || '') || account.systemAccount === 'GST'
      || (account._class === 'LIABILITY' && /\b(vat|gst)\b/i.test(account.name || '') && /control|liabilit|payable|account/i.test(account.name || ''));
  };
  const vatIds = [...accountById.keys()].filter(isVatId);
  const firstVat = pattern => vatIds.find(id => pattern.test(nameOf(id))) || vatIds[0] || null;
  const journalNumber = j => j.entryNumber || j.reference || String(j.manualJournalID || '').slice(0, 8);
  const sameNumber = text => String(text || '').toUpperCase().replace(/\s+/g, '').replace(/\d+/g, digits => String(Number(digits)));
  // The original a journal reverses, by number: "REV - MJ-2026-20" or notes naming "MJ-2026-020".
  const reversedNumberOf = j => {
    const byPrefix = /^\s*REV\b\s*[-:]?\s*(.+)$/i.exec(String(j.entryNumber || ''));
    if (byPrefix) return byPrefix[1];
    const byNote = /\brevers\w*\b[^A-Z0-9]*(?:entry\s+|journal\s+)?(?:of\s+|for\s+)?([A-Z]{1,6}-[A-Z0-9-]*\d)/i.exec(String(j.narration || ''));
    return byNote ? byNote[1] : null;
  };
  const cancelOut = (a, b) => {
    const net = new Map();
    for (const l of [...(a.journalLines || []), ...(b.journalLines || [])]) {
      const id = idOfLine(l);
      net.set(id, (net.get(id) || 0) + (Number(l.lineAmount) || 0));
    }
    return (a.journalLines || []).length > 0 && [...net.values()].every(v => Math.abs(v) < 0.005);
  };
  const reversals = new Map(); // journal id -> { partner, role }
  {
    const byNumber = new Map(journals.map(j => [sameNumber(journalNumber(j)), j]));
    for (const j of journals) {
      const target = reversedNumberOf(j);
      const original = target ? byNumber.get(sameNumber(target)) : null;
      if (!original || original === j || reversals.has(original.manualJournalID) || reversals.has(j.manualJournalID)) continue;
      if (!cancelOut(original, j)) continue;
      reversals.set(original.manualJournalID, { partner: j, role: 'original' });
      reversals.set(j.manualJournalID, { partner: original, role: 'reversal' });
    }
  }
  const signedTax = l => (l.taxType && l.taxType !== 'NONE' ? Number(l.taxAmount) || 0 : 0);
  // partnerInScope: whether a reversal partner's date falls on or before the end of the rows' scope. A journal whose
  // reversal is dated after the period end still stood, unreversed, at the period end, so it is counted.
  function zohoJournalRow(kind, j, partnerInScope = () => true) {
    const lines = (j.journalLines || []).filter(l => Number(l.lineAmount) || signedTax(l));
    let debits = 0;
    let credits = 0;
    let firstId = null;
    let taxLine = null;
    if (kind === 'bank') {
      for (const l of lines) {
        const id = idOfLine(l);
        if (!isBankId(id)) continue;
        const amount = Number(l.lineAmount) || 0;
        if (amount > 0) debits += amount; else credits -= amount;
        firstId = firstId || id;
      }
    } else {
      for (const l of lines) {
        const id = idOfLine(l);
        const amount = Number(l.lineAmount) || 0;
        if (isVatId(id) && amount) {
          if (amount > 0) debits += amount; else credits -= amount;
          firstId = firstId || id;
          continue;
        }
        const tax = signedTax(l);
        if (tax) {
          if (tax > 0) debits += tax; else credits -= tax;
          taxLine = taxLine || l;
          firstId = firstId || firstVat(tax > 0 ? /input/i : /output/i);
        }
      }
    }
    if (!(debits > 0.004 || credits > 0.004)) return null;
    const value = round2(Math.max(debits, credits));
    const ids = lines.map(idOfLine).filter(Boolean);
    const notes = [];
    let level = null;
    let rule = null;
    if (kind === 'bank') {
      const allBank = ids.length > 0 && ids.every(isBankId);
      const cashOnly = ids.filter(isBankId).every(isCashId);
      if (allBank) notes.push('Transfer between bank / cash accounts: counted once');
      if (cashOnly) { notes.push('Petty cash (Cash account) journal: lower risk, as cash has no bank feed'); level = 'review'; rule = 'petty_cash_journal'; }
    } else if (ids.length > 1 && ids.every(isVatId) && !lines.some(signedTax)) {
      notes.push('Review: period-end VAT offset journal (VAT accounts only), normally the VAT return settlement');
      level = 'review'; rule = 'vat_offset_journal';
    }
    const pairFound = reversals.get(j.manualJournalID);
    const pair = pairFound && partnerInScope(dateOf(pairFound.partner)) ? pairFound : null;
    const shownId = firstId ? shown(firstId) : { accountCode: null, accountName: null };
    const base = {
      documentId: j.manualJournalID, number: journalNumber(j), date: dateOf(j), source: 'manual_journal',
      accountCode: shownId.accountCode, accountName: shownId.accountName,
      narration: j.narration || null, debits: round2(debits), credits: round2(credits),
      ...(taxLine ? {
        taxType: taxNameById.get(String(taxLine.taxType)) || taxLine.taxType, taxOnAccountCode: shown(idOfLine(taxLine)).accountCode,
        taxOnAccountName: nameOf(idOfLine(taxLine)) || null, postedVia: 'Tax rate on the journal line',
      } : {}),
    };
    if (pair) {
      const other = pair.partner;
      const text = pair.role === 'original'
        ? `Reversed by ${journalNumber(other)} on ${dateOf(other)}: the two journals cancel out, so there is nothing to correct`
        : `Reversal of ${journalNumber(other)} (${dateOf(other)}): the two journals cancel out, so there is nothing to correct`;
      return {
        ...base, amount: 0, potentialValue: 0, displayOnly: true, level: 'reversed', rule: 'reversed_journal',
        description: `${text}. ${j.narration || ''}`.trim(),
      };
    }
    return {
      ...base, amount: value, potentialValue: value, ...(level ? { level, rule } : {}),
      description: `${notes.length ? `${notes.join('. ')}. ` : ''}${j.narration || ''}`.trim() || null,
    };
  }
  const zohoJournalRows = kind => {
    const build = (list, partnerInScope) => list.map(j => zohoJournalRow(kind, j, partnerInScope)).filter(Boolean);
    return {
      rows: build(inPeriod(journals), date => Boolean(date) && date <= period.end),
      previousRows: build(inPrevious(journals), date => Boolean(date) && date < period.start),
    };
  };

  // journalChecks.detectUnusualJournals on the posted manual journals, the chart keyed by accountID.
  attempt('unusual journals', () => {
    if (!accountsKnown) throw new Error('chart of accounts not read');
    const rekeyJournals = list => list.map(journal => ({ ...journal, journalLines: rekeyLines(journal.journalLines) }));
    const detect = list => journalChecks.detectUnusualJournals({ journals: rekeyJournals(list), accounts: rekeyedAccounts });
    const back = item => ({
      ...item, ...shown(item.accountCode),
      ...(item.counterAccountCode ? { counterAccountCode: shown(item.counterAccountCode).accountCode } : {}),
      ...(item.taxOnAccountCode ? { taxOnAccountCode: shown(item.taxOnAccountCode).accountCode, taxOnAccountName: nameOf(item.taxOnAccountCode) || null } : {}),
      ...(item.taxType ? { taxType: taxNameById.get(String(item.taxType)) || item.taxType } : {}),
      // Zoho's journal number, which is what the client sees in Zoho Books (Xero's has none).
      number: allJournals.find(j => j.manualJournalID === item.documentId)?.entryNumber || item.number,
    });
    const current = detect(inPeriod(journals));
    const previous = detect(inPrevious(journals));
    // Journals to Bank and VAT Control Journals are built per journal for Zoho (zohoJournalRows below).
    const perJournal = {
      journal_to_bank: zohoJournalRows('bank'),
      journal_vat_control: zohoJournalRows('vat'),
    };
    for (const [checkType, items] of Object.entries(current)) {
      if (perJournal[checkType]) {
        const { rows, previousRows } = perJournal[checkType];
        push(checkType, {
          count: rows.filter(row => !row.displayOnly).length, value: exposure(rows),
          items: withPreviousMonths(rows, previousRows), periodChecked: 'since_lock_date',
        });
        continue;
      }
      const rows = items.map(back);
      push(checkType, {
        count: rows.length, value: sumAbsoluteExposure(rows),
        items: withPreviousMonths(rows, (previous[checkType] || []).map(back)), periodChecked: 'since_lock_date',
      });
    }
  });

  // Suspense & Clearing Balances and the Director's Loan (UAE: Shareholder & Related Party Balances), from each
  // account's CURRENT balance as Zoho gives it (accounting.readCandidateBalances: the chart list read with
  // showbalance, else GET /chartofaccounts/{id} for the candidate accounts). Zoho has no balance at a past date, so,
  // like Xero's live-only checks (LIVE_ONLY_CHECK_TYPES), they describe the position when the balances were read,
  // whatever the review period, and each row says when that was. Rules as Xero's (journalChecks): suspense or
  // clearing with a balance of 1 or more either way; a loan / current account overdrawn (the owner owes the
  // company), and not a plain Drawings account in equity. ASSUMED sign (mapping.balanceOf): the figure is on the
  // account's normal side, so an asset account owed to the company is positive and a liability or equity account
  // overdrawn is negative; when Zoho says the side (debit / credit) that is used instead.
  // Opening Balance Differences needs net assets at a past year end, which Zoho cannot give: unavailable.
  mark('opening_balance_differences', LABELS.unavailable);
  const balanceSection = readStatus?.sections?.balances || null;
  const debitBalanceOf = account => {
    const b = account.ledgerBalance;
    const amount = Number(b.amount) || 0;
    if (b.side === 'debit') return Math.abs(amount);
    if (b.side === 'credit') return -Math.abs(amount);
    return account._class === 'ASSET' || account._class === 'EXPENSE' ? amount : -amount;
  };
  const asOfOf = account => String(account.ledgerBalance.readAt || '').slice(0, 10) || null;
  const balanceRows = (test, build) => {
    const candidates = [...accountById.values()].filter(a => a.status !== 'ARCHIVED' && a.type !== 'BANK' && test(a));
    const known = candidates.filter(a => a.ledgerBalance && Number.isFinite(Number(a.ledgerBalance.amount)));
    if (candidates.length && !known.length) return null; // candidates, but no balance read for any of them
    if (!candidates.length && !balanceSection && ![...accountById.values()].some(a => a.ledgerBalance)) return null; // balances never read
    return { rows: known.map(build).filter(Boolean), missing: candidates.length - known.length };
  };
  // A balance row names its account (shown in the account column) and is identified by "id", which the page does not
  // show: the Zoho account id is never a column (it was shown where the account name should be). "id" gives the
  // finding the same identity, and so the same review state, that "documentId" gave it.
  const balanceAccount = id => { const { accountID, ...rest } = shown(id); return rest; };
  const unreadNote = missing => (missing ? ` ${missing} other candidate account(s) had no balance from Zoho Books and were not checked.` : '');
  attempt('suspense_open_balance', () => {
    if (!accountsKnown) throw new Error('chart of accounts not read');
    // Balance sheet accounts only (as Xero, read from the balance sheet): "Customs Clearing Charges" is a cost.
    const result = balanceRows(a => uae.SUSPENSE_ACCOUNT_NAME.test(a.name || '') && !uae.isIncomeStatementAccount(a), account => {
      const balance = debitBalanceOf(account);
      if (Math.abs(balance) < 1) return null;
      const asOf = asOfOf(account);
      return {
        id: `zoho-balance:${account.accountID}`, date: asOf, source: 'account_balance', ...balanceAccount(account.accountID),
        description: `Balance of ${Math.abs(balance).toFixed(2)} ${balance >= 0 ? 'debit' : 'credit'} left on ${account.name} in Zoho Books${asOf ? ` on ${asOf}` : ''} (the current balance: Zoho gives no balance at the period end).${account.ledgerBalance.stale ? ' Balance from an earlier sync.' : ''}`,
        amount: round2(Math.abs(balance)),
      };
    });
    if (!result) return mark('suspense_open_balance', LABELS.unavailable);
    const rows = result.rows.map(row => (result.missing ? { ...row, description: row.description + unreadNote(result.missing) } : row));
    push('suspense_open_balance', { count: rows.length, value: sumAbsoluteExposure(rows), items: rows, periodChecked: 'since_lock_date' });
  });
  attempt('directors_loan_overdrawn', () => {
    if (!accountsKnown) throw new Error('chart of accounts not read');
    const nameTest = isUae
      ? a => uae.UAE_RELATED_PARTY_NAME.test(a.name || '') || uae.DLA_ACCOUNT_NAME.test(a.name || '')
      : a => uae.DLA_ACCOUNT_NAME.test(a.name || '');
    // A plain "Drawings" (or owner's capital) account in equity is the owner's capital, not a loan to them (Xero rule).
    // An income or expense account ("Directors Remuneration", "Partner Commission") is never a loan or current account.
    const isLoanAccount = a => nameTest(a) && !uae.isIncomeStatementAccount(a)
      && !(a._class === 'EQUITY' && !/loan|current|\bdla\b|due (to|from)/i.test(a.name || ''));
    const result = balanceRows(isLoanAccount, account => {
      const overdrawn = debitBalanceOf(account);
      if (overdrawn < 0.01) return null;
      const asOf = asOfOf(account);
      const unit = isUae ? 'AED ' : money.base === 'GBP' ? '£' : `${money.base} `;
      return {
        id: `dla:${account.accountID}`, date: asOf, source: 'account_balance', ...balanceAccount(account.accountID),
        level: isUae ? 'review' : 'critical', rule: isUae ? 'uae_related_party_owes_company' : 'dla_overdrawn',
        description: isUae
          ? `${account.name} shows ${unit}${overdrawn.toFixed(2)} owed to the company${asOf ? ` on ${asOf}` : ''} (current balance in Zoho Books). Check it is on arm's-length terms and documented for Corporate Tax.${account.ledgerBalance.stale ? ' Balance from an earlier sync.' : ''}`
          : `${account.name} is overdrawn by ${unit}${Math.round(overdrawn).toLocaleString('en-GB')}${asOf ? ` on ${asOf}` : ''} (current balance in Zoho Books). Possible section 455 tax liability if not cleared in time.${account.ledgerBalance.stale ? ' Balance from an earlier sync.' : ''}`,
        amount: round2(overdrawn),
      };
    });
    if (!result) return mark('directors_loan_overdrawn', LABELS.unavailable);
    const rows = result.rows.map(row => (result.missing ? { ...row, description: row.description + unreadNote(result.missing) } : row));
    push('directors_loan_overdrawn', { count: rows.length, value: sumAbsoluteExposure(rows), items: rows, periodChecked: 'since_lock_date' });
  });

  // Unreconciled Bank (Xero: posted bank transactions in the review period not yet reconciled, valued at their
  // amounts, selectAuthorisedUnreconciled). Zoho: each bank or card account's recorded transactions that Zoho's
  // Reconciliation Status report lists as Unreconciled Transactions: every row with reconcile_status "unreconciled".
  // Checked live (25 Nov 2026) quarter by quarter on one client's main bank account against Zoho's report: Apr-Jun,
  // Jul-Sep and Oct-Dec all list exactly the same transactions, apart from the account's opening-balance entry, which
  // is deliberately left out here (it is not a transaction). Zoho's summary figure "Unmatched Books Transactions" is a
  // different, smaller headline that does not add up to its own lists, so it is not what this check matches.
  // statementLinked (mapping.isStatementLinked) is kept on each row for information only and does NOT remove a row:
  // an earlier guess that matched-but-unreconciled rows explain that headline was disproved by the quarterly lists.
  // accounting.fetchBankActivity reads the review period only; opening balances are left
  // out there. Cash accounts have no statement and are left out. A row whose status Zoho did not give is never
  // counted; if no row had one the check is unavailable rather than a false OK. Its bank lines still waiting to be
  // categorised are under Unprocessed Bank.
  // Each row says which bank account it is on, the customer or vendor (Zoho's payee, else the contact its id names),
  // Zoho's own description, the type, and whether the money came in or went out. The amount stays unsigned, as on
  // the Xero rows (the value and finding values are shared out by it), and "direction" gives the sign: Zoho's report
  // total is deposits minus withdrawals (unreconciledTotals, shown as the check's headline on the page).
  attempt('unreconciled_bank_items', () => {
    const reconciled = [...accountById.values()].filter(a => a.type === 'BANK' && a.status !== 'ARCHIVED' && a.zohoAccountType !== 'cash');
    const withData = reconciled.filter(a => a.reconciliation && Array.isArray(a.reconciliation.unreconciled));
    if (!reconciled.length) return mark('unreconciled_bank_items', 'not_configured');
    if (!withData.length) return mark('unreconciled_bank_items', 'needs_sync');
    const totalRows = withData.reduce((sum, a) => sum + (Number(a.reconciliation.rows) || 0), 0);
    const unknownRows = withData.reduce((sum, a) => sum + (Number(a.reconciliation.unknown) || 0), 0);
    if (totalRows && unknownRows === totalRows) return mark('unreconciled_bank_items', LABELS.unavailable);
    const sameAsBaseCurrency = code => !code || String(code).toUpperCase() === money.base;
    const contactNameById = new Map((contacts || []).filter(c => c && c.contactID != null && c.name).map(c => [String(c.contactID), c.name]));
    // A row read before the direction was kept: the sign of its amount (a debit, money in, is positive).
    const directionOf = t => (t.direction === 'in' || t.direction === 'out' ? t.direction : Number(t.amount) < 0 ? 'out' : 'in');
    // id (not shown as a column) is the finding's identity, exactly as documentId was; the bank account's id is kept as
    // bankAccountId (not shown), so a row without a description is still told apart by its own id.
    const toRow = (account, t) => ({
      id: `zoho-unreconciled:${account.accountID}:${t.transactionID || `${t.date}:${t.amount}`}`,
      date: t.date, number: t.entryNumber || null, reference: t.reference || null,
      account: account.name || null,
      contact: t.payee || (t.contactID != null ? contactNameById.get(String(t.contactID)) : null) || null,
      description: t.description || null,
      type: mapping.transactionTypeLabel(t.transactionType),
      direction: directionOf(t) === 'in' ? 'Money in' : 'Money out',
      amount: Math.abs(Number(t.amount) || 0),
      bankAccountId: account.accountID,
      // A row read from Zoho's bcy_ fields is already in the client's currency, whatever the account's currency.
      ...(account.currencyCode && !sameAsBaseCurrency(account.currencyCode) && t.amountInBaseCurrency !== true ? { currency: account.currencyCode, potentialValue: 0 } : {}),
      // A foreign-currency account whose row has both amounts: shown in the account's currency, as in Zoho, with the
      // client's-currency amount beside it (the value counted).
      ...(account.currencyCode && !sameAsBaseCurrency(account.currencyCode) && t.amountInBaseCurrency === true && t.accountAmount != null
        ? { amount: Math.abs(Number(t.accountAmount) || 0), currency: account.currencyCode, baseAmount: Math.abs(Number(t.amount) || 0), potentialValue: Math.abs(Number(t.amount) || 0) } : {}),
      ...(account.reconciliation.stale ? { stale: true } : {}),
    });
    const unmatched = account => account.reconciliation.unreconciled;
    const all = withData.flatMap(account => unmatched(account).map(t => toRow(account, t)));
    const rows = all.filter(row => isWithinPeriod(row.date, period)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const notes = withData.filter(a => a.reconciliation.complete === false || a.reconciliation.stale).map(a => a.name);
    const coverage = withData[0].reconciliation;
    const items = rows.map(row => ({
      ...row,
      ...(notes.length ? { note: `Read from Zoho Books for ${coverage.from} to ${coverage.to}; not complete for ${notes.join(', ')} (read limit or an earlier sync).` } : {}),
    }));
    // The value (score, sorting, finding values) stays the gross amount at stake, as in Xero; the page's headline is
    // the net figure Zoho shows. An account in another currency is listed but not added to the total in the client's
    // currency (as Bank Balance).
    // A foreign row Zoho also gave in the client's currency counts at that amount (baseAmount).
    const value = items.reduce((sum, row) => sum + (!row.currency ? Math.abs(Number(row.amount) || 0)
      : typeof row.baseAmount === 'number' ? Math.abs(row.baseAmount) : 0), 0);
    push('unreconciled_bank_items', { count: items.length, value: round2(value), items, periodChecked: period.key });
  });

  // Dividends Status needs the year's profit (a P&L, which Zoho's API cannot give). For a UAE company it is not
  // applicable anyway: no withholding tax and no filing on dividends.
  mark('dividend_status', isUae ? LABELS.notApplicableUae : LABELS.unavailable);
  // Historical Changes needs the date the accounts were filed (Companies House) or, in the UAE, the date a VAT
  // return was filed or the accounts approved. Zoho's API does not give either date.
  mark('historical_changes', LABELS.unavailable);

  // Tax Review by Code: every line in the period grouped by VAT rate. A UAE client is also split by sales and
  // purchases, exempt / out of scope and reverse charge, as the VAT return needs, with three review flags.
  attempt('tax_review_by_code', () => {
    const itemsFor = scope => {
      const groups = new Map();
      const add = (side, doc, line, net, tax) => {
        const reverse = uae.isReverseChargeLine(doc, line);
        const key = isUae ? `${side}|${taxLabel(line)}|${reverse ? 'rc' : ''}` : taxLabel(line);
        const group = groups.get(key) || {
          key, side, label: taxLabel(line), reverse, count: 0, net: 0, tax: 0,
          taxType: line.taxType || 'NONE', flags: new Set(), emirates: new Map(),
        };
        group.count += 1;
        group.net += Math.abs(net);
        group.tax += Math.abs(tax);
        if (isUae && side === 'sales') {
          const pct = ratePercent(line);
          if (pct === 5 && line.taxType && line.taxType !== 'NONE') {
            if (!doc.placeOfSupply) group.flags.add('Standard-rated sales with no place of supply (emirate) on the invoice');
            const emirate = doc.placeOfSupply || 'not set';
            group.emirates.set(emirate, (group.emirates.get(emirate) || 0) + Math.abs(net));
          }
          if (pct === 0 && line.taxType && line.taxType !== 'NONE' && lower(doc.taxTreatment) === 'vat_registered') {
            group.flags.add('Zero-rated sales to a UAE VAT-registered customer (domestic: zero rate is unusual)');
          }
        }
        if (isUae && side === 'purchases' && reverse && lower(doc.taxTreatment) === 'vat_registered') {
          group.flags.add('Reverse charge on a bill from a UAE VAT-registered supplier');
        }
        groups.set(key, group);
      };
      for (const [side, docs] of [['sales', accrec], ['purchases', [...accpay, ...expenses]]]) {
        for (const doc of scope.docs(docs)) {
          if (cannotConvert(doc)) continue;
          const rate = hasRate(doc) ? Number(doc.currencyRate) : 1;
          for (const line of doc.lineItems || []) add(side, doc, line, netLineAmount(doc, line), (Number(line.taxAmount) || 0) / rate);
        }
      }
      for (const journal of scope.docs(journals)) {
        for (const line of journal.journalLines || []) {
          if (!line.taxType || line.taxType === 'NONE') continue;
          add('journals', journal, line, Number(line.lineAmount) || 0, Number(line.taxAmount) || 0);
        }
      }
      const unit = isUae ? 'AED ' : money.base === 'GBP' ? '£' : `${money.base} `;
      return [...groups.values()].sort((a, b) => b.net - a.net).map(group => {
        const flags = [...group.flags];
        const bySide = isUae ? `${group.side === 'sales' ? 'Sales' : group.side === 'purchases' ? 'Purchases' : 'Journals'}: ` : '';
        const emirates = group.emirates.size > 1 || (group.emirates.size === 1 && !group.emirates.has('not set'))
          ? ` By emirate: ${[...group.emirates].map(([e, v]) => `${e} ${unit}${v.toFixed(2)}`).join(', ')}.` : '';
        return {
          documentId: `tax-code:${group.key}`, number: null, date: null, source: 'tax_review',
          accountCode: group.label + (group.reverse ? ' (reverse charge)' : ''), accountName: bySide ? bySide.slice(0, -2) : group.label,
          description: `${bySide}${group.count} line(s), net ${unit}${group.net.toFixed(2)}, VAT ${unit}${group.tax.toFixed(2)}.${emirates}${flags.length ? ` Review: ${flags.join('; ')}.` : ''}`,
          amount: round2(group.net), lineCount: group.count, taxAmount: round2(group.tax),
          ...(flags.length ? { level: 'review', rule: 'uae_tax_treatment_review' } : {}),
        };
      });
    };
    const rows = itemsFor(scopes.period);
    push('tax_review_by_code', { count: rows.length, value: 0, items: withPreviousMonths(rows, itemsFor(scopes.previous)), periodChecked: 'since_lock_date' });
  });

  // VAT thresholds. UAE: the AED 375,000 / 187,500 VAT registration tests and Corporate Tax Small Business Relief.
  // A UK Zoho client: Zoho does not say which VAT scheme (flat rate, cash, annual) the client uses, which is what
  // the UK check is about, so it is not applicable.
  attempt('vat_scheme_threshold', () => {
    if (!isUae) return mark('vat_scheme_threshold', LABELS.notApplicableZoho);
    if (!accountsKnown) throw new Error('chart of accounts not read');
    const to = period.end < todayIso ? period.end : todayIso;
    const fromDate = new Date(`${to}T00:00:00Z`);
    fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 1);
    fromDate.setUTCDate(fromDate.getUTCDate() + 1);
    const from = fromDate.toISOString().slice(0, 10);
    const within = (doc, a, b) => { const d = dateOf(doc); return d && d >= a && d <= b; };
    let unconverted = 0;
    const lineNet = (doc, line) => { const v = baseNet(doc, line); if (v == null) unconverted += 1; return v || 0; };
    // A document whose lines have not been read yet (the per-sync read cap) is counted at its net total from
    // Zoho's list (the gross total when the list gives no net), so a backlog never hides turnover. Counted and said
    // on the finding, because that figure cannot tell taxable from exempt lines.
    const estimated = new Set();
    const unreadNet = doc => {
      if (cannotConvert(doc)) { unconverted += 1; return 0; }
      estimated.add(doc.invoiceID);
      const amount = doc.subTotal != null ? Number(doc.subTotal) : Number(doc.total) || 0;
      return amount / (hasRate(doc) ? Number(doc.currencyRate) : 1);
    };
    const unread = doc => doc.lineItemsRead === false && !(doc.lineItems || []).length;
    // Taxable supplies. A registered client: standard- (5%) and zero-rated (0%) sales lines, never exempt or
    // out-of-scope ones. A client that is not registered has no VAT rates in Zoho at all, so every sales line on an
    // income account that is not marked exempt or out of scope counts (its rate would be 5% or 0% once registered).
    const taxableLine = (line, doc) => {
      if (uae.isExemptLine(line)) return false;
      // Before registration (or not registered) every sale on an income account counts towards turnover; after it, a
      // sales line left without a VAT code is still a supply (Sales Tax Missing lists it), so it counts too.
      if (!vatRegistered || beforeVat(doc)) return revenueIds.has(idOfLine(line));
      if (!line.taxType || line.taxType === 'NONE') return revenueIds.has(idOfLine(line));
      const pct = ratePercent(line);
      return pct === 5 || pct === 0;
    };
    let supplies = 0;
    for (const doc of accrec.filter(d => within(d, from, to))) {
      if (unread(doc)) { supplies += unreadNet(doc); continue; }
      for (const line of doc.lineItems || []) if (taxableLine(line, doc)) supplies += lineNet(doc, line);
    }
    // Sales credit notes, less: Zoho's credit note list has no lines, so its net total (or the gross total when
    // Zoho gives no net figure) is taken off in full. A credit against an exempt sale should not be, so the amount
    // taken off is shown on the finding for staff to check.
    const creditNet = list => list.filter(c => c.type === 'ACCRECCREDIT' && posted(c)).reduce((sum, c) => {
      const amount = c.subTotal != null ? Number(c.subTotal) : Number(c.total) || 0;
      if (cannotConvert(c)) { unconverted += 1; return sum; }
      return sum + amount / (hasRate(c) ? Number(c.currencyRate) : 1);
    }, 0);
    const rollingCredits = creditNet(credits.filter(c => within(c, from, to)));
    supplies -= rollingCredits;
    // Imports: bills from outside the UAE or under reverse charge.
    for (const doc of accpay.filter(d => within(d, from, to) && uae.isImportDocument(d))) {
      if (unread(doc)) { supplies += unreadNet(doc); continue; }
      for (const line of doc.lineItems || []) supplies += lineNet(doc, line);
    }
    // Revenue for a financial year: income-account sales lines less credit notes.
    const revenueBetween = (start, end) => {
      let total = 0;
      for (const doc of accrec.filter(d => within(d, start, end))) {
        if (unread(doc)) { total += unreadNet(doc); continue; }
        for (const line of doc.lineItems || []) if (revenueIds.has(idOfLine(line))) total += lineNet(doc, line);
      }
      return total - creditNet(credits.filter(c => within(c, start, end)));
    };
    let revenue = null;
    let fy = null;
    const priorRevenue = [];
    try {
      // The year end saved by the sync, else the one Zoho's fiscal_year_start_month gives (0 = January, so a year
      // starting in month n ends in month n; 0 ends in December, as zoho/index.js financialYearEnd reads it).
      const startMonth = taxProfile?.fiscalYearStartMonth == null ? null : Number(taxProfile.fiscalYearStartMonth);
      const endMonth = Number(org.financial_year_end_month) || (Number.isInteger(startMonth) && startMonth >= 1 && startMonth <= 11 ? startMonth : 12);
      const endDay = Number(org.financial_year_end_day) || new Date(Date.UTC(2001, endMonth, 0)).getUTCDate();
      fy = resolvePeriod({ type: 'current_fy' }, { asOf: todayIso, financialYearEndMonth: endMonth, financialYearEndDay: endDay });
      revenue = revenueBetween(fy.start, fy.end);
      // Earlier years, as far back as the relief goes (tax periods starting on or after 1 June 2023), from the
      // invoices Zoho Books holds: one year over AED 3m ends the relief for every later year.
      let yearEnd = new Date(`${fy.start}T00:00:00Z`);
      for (let guard = 0; guard < 10; guard += 1) {
        yearEnd.setUTCDate(yearEnd.getUTCDate() - 1);
        const end = yearEnd.toISOString().slice(0, 10);
        const startDate = new Date(yearEnd);
        startDate.setUTCFullYear(startDate.getUTCFullYear() - 1);
        startDate.setUTCDate(startDate.getUTCDate() + 1);
        const start = startDate.toISOString().slice(0, 10);
        if (start < uae.SBR_FIRST_PERIOD_START) break;
        priorRevenue.push({ fyEnd: end, revenue: revenueBetween(start, end) });
        yearEnd = new Date(`${start}T00:00:00Z`);
      }
    } catch (error) {
      revenue = null;
    }
    const items = uae.evaluateUaeThresholds({
      taxableSupplies: supplies, registered: vatRegistered, revenue, priorRevenue, periodEnd: period.end,
      isFreeZone: taxProfile?.isFreeZone ?? null, to, fyEnd: fy ? fy.end : null,
    });
    // Coverage notes on each finding: sales recorded only as bank deposits cannot be seen without bank access,
    // documents not read yet are estimates, credit notes are taken off in full, and documents with no exchange
    // rate are left out.
    const caveats = [];
    if (bankingRefused || !statementLines.length) caveats.push('Sales recorded only as bank deposits are not visible to Akrio, so turnover may be understated.');
    if (estimated.size) caveats.push(`${estimated.size} invoice(s) or bill(s) whose lines Akrio has not read yet were counted at their total from Zoho Books (an estimate: exempt lines cannot be told apart until they are read at the next sync).`);
    if (rollingCredits) caveats.push(`Sales credit notes of ${uae.aed(rollingCredits)} were taken off in full; check none of them were for exempt or out-of-scope sales.`);
    if (unconverted) caveats.push(`${unconverted} line(s) in another currency with no exchange rate were left out.`);
    caveats.push('The "next 30 days" test cannot be checked automatically.');
    const rows = items.map(item => ({ ...item, description: `${item.description} ${caveats.join(' ')}` }));
    push('vat_scheme_threshold', { count: rows.length, value: 0, items: rows, periodChecked: 'rolling_12_months' });
  });

  // Motor Vehicle Expenses: journalChecks.motorVehicleExpenses on bills, expenses and journals (no balance sheet,
  // so a vehicle asset counts if it was ever posted to). UAE: also input VAT claimed on entertainment or on hiring,
  // leasing or buying a car (blocked under the VAT Executive Regulation), as review items.
  attempt('motor_vehicle_expenses', () => {
    if (!accountsKnown) throw new Error('chart of accounts not read');
    const docs = [...accpay, ...expenses].filter(doc => !cannotConvert(doc)).map(rekeyDoc);
    const rekeyedJournals = journals.map(journal => ({ ...journal, journalLines: rekeyLines(journal.journalLines) }));
    const vehicle = journalChecks.motorVehicleExpenses({
      accounts: rekeyedAccounts, documents: docs, journals: rekeyedJournals, from: period.start, to: period.end, balanceSheet: null,
    }).map(item => {
      const doc = docs.find(d => (d.invoiceID || d.bankTransactionID) === item.id);
      return {
        ...item, ...shown(item.accountCode), source: doc && doc.bankTransactionID ? 'expense' : 'bill',
        ...(doc && doc.bankTransactionID ? { bankTransactionId: doc.bankTransactionID } : { invoiceId: item.id }),
      };
    });
    const blocked = [];
    if (isUae) {
      const blockedName = id => uae.UAE_ENTERTAINMENT_NAME.test(nameOf(id)) || uae.UAE_VEHICLE_NAME.test(nameOf(id));
      const recoverable = line => !line.itcEligibility || lower(line.itcEligibility) === 'eligible';
      for (const doc of inPeriod([...accpay, ...expenses])) {
        if (cannotConvert(doc)) continue;
        const rate = hasRate(doc) ? Number(doc.currencyRate) : 1;
        (doc.lineItems || []).forEach((line, index) => {
          const id = idOfLine(line);
          const tax = Math.abs(Number(line.taxAmount) || 0) / rate;
          if (!id || !blockedName(id) || !(tax > 0) || ratePercent(line) !== 5 || !recoverable(line)) return;
          blocked.push({
            documentId: `${doc.invoiceID || doc.bankTransactionID}:vat:${index}`, ...docRef(doc), date: dateOf(doc),
            contactName: doc.contact?.name || null, ...shown(id), description: line.description || null,
            amount: round2(tax), level: 'review', rule: 'uae_blocked_input_vat',
            note: `Input VAT of AED ${tax.toFixed(2)} claimed on ${nameOf(id)}. It cannot be recovered on entertainment for non-employees or on a car available for personal use.`,
          });
        });
      }
      for (const journal of inPeriod(journals)) {
        (journal.journalLines || []).forEach((line, index) => {
          const id = idOfLine(line);
          const tax = Math.abs(Number(line.taxAmount) || 0);
          if (!id || !blockedName(id) || !(tax > 0) || ratePercent(line) !== 5) return;
          blocked.push({
            documentId: `${journal.manualJournalID}:vat:${index}`, id: journal.manualJournalID, number: journal.entryNumber || null,
            source: 'manual_journal', date: dateOf(journal), ...shown(id), description: line.description || journal.narration || null,
            amount: round2(tax), level: 'review', rule: 'uae_blocked_input_vat',
            note: `Input VAT of AED ${tax.toFixed(2)} on a manual journal to ${nameOf(id)}.`,
          });
        });
      }
    }
    const rows = [...vehicle, ...blocked].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    push('motor_vehicle_expenses', { count: rows.length, value: sumAbsoluteExposure(rows), items: rows, periodChecked: 'since_lock_date' });
  });

  // Inactive Contacts: as xeroSync.js, from the documents Akrio holds (invoices, bills, credit notes, journals,
  // expenses and bank lines). Zoho's word is "Mark as Inactive". The window is 24 months, not 18, because
  // contacts used only through banking are not visible while bank access is missing.
  attempt('inactive_contacts', () => {
    const months = uae.UAE_POLICY.inactiveContactMonths;
    const last = new Map();
    const note = (contactId, date) => { if (contactId && date && (!last.has(contactId) || date > last.get(contactId))) last.set(contactId, date); };
    for (const doc of [...invoices, ...credits]) if (doc.status !== 'VOIDED' && doc.status !== 'DELETED') note(doc.contact?.contactID, dateOf(doc));
    for (const row of bankRows) note(row.contact?.contactID, dateOf(row));
    for (const journal of journals) for (const line of journal.journalLines || []) note(line.contact?.contactID, dateOf(journal));
    const cutoffDate = new Date(`${period.end}T00:00:00.000Z`);
    cutoffDate.setUTCMonth(cutoffDate.getUTCMonth() - months);
    const cutoff = cutoffDate.toISOString().slice(0, 10);
    const rows = [];
    for (const contact of contacts) {
      if (contact.contactStatus !== 'ACTIVE') continue;
      const seen = last.get(contact.contactID) || null;
      if (seen && seen >= cutoff) continue;
      rows.push({ id: contact.contactID, name: contact.name, lastTransaction: seen || 'Never', basis: seen ? 'last transaction' : 'no transactions in Zoho Books' });
    }
    push('inactive_contacts', { count: rows.length, items: rows, periodChecked: `no_transaction_in_${months}_months_before_${period.end}` });
  });

  // =============================== Bank checks ===============================
  // The bank figures come from Zoho's banking data when the connection allows it, else from the latest reading of
  // Zoho Books' Banking page by the browser extension if it is under 7 days old. With neither, the check asks for
  // Zoho to be reconnected with bank access (or the page to be read) rather than showing a false OK.
  const bankAccounts = [...accountById.values()].filter(a => a.type === 'BANK' && a.status !== 'ARCHIVED');
  const apiBank = !bankingRefused && bankAccounts.some(a => a.bank && !a.bank.stale);
  const readingAgeDays = bankReading?.readAt ? (now.getTime() - new Date(bankReading.readAt).getTime()) / 86400000 : null;
  const freshReading = Boolean(bankReading && Array.isArray(bankReading.accounts) && readingAgeDays != null && readingAgeDays <= STALE_AFTER_DAYS);
  const asOfLabel = freshReading && !apiBank ? new Date(bankReading.readAt).toISOString().slice(0, 10) : todayIso;
  const accountByName = new Map(bankAccounts.map(a => [lower(a.name), a]));
  // The Banking page shows a foreign account's currency as Zoho prefixes it, often a symbol ("$", "US$", "£"),
  // never converted. Its ISO code is taken from the matching account in the chart when there is one, else from the
  // prefix when that is a code or an unambiguous symbol. Anything else stays as shown and counts as foreign, so a
  // foreign difference is never added to the base-currency total as if it were the same money.
  const SYMBOL_CODES = { '£': 'GBP', '€': 'EUR', '₹': 'INR', 'US$': 'USD' };
  const readingCurrency = (r, account) => {
    if (account && account.currencyCode) return String(account.currencyCode).toUpperCase();
    const shownAs = String(r.currency || '').trim();
    if (!shownAs) return null;
    if (/^[A-Za-z]{3}$/.test(shownAs)) return shownAs.toUpperCase();
    if (SYMBOL_CODES[shownAs]) return SYMBOL_CODES[shownAs];
    if (shownAs === '$' && ['USD', 'AUD', 'CAD', 'NZD', 'SGD', 'HKD'].includes(money.base)) return money.base;
    if (shownAs === '$') return 'USD';
    return shownAs;
  };
  // One record per bank account: its book balance, bank (feed) balance, uncategorised count, currency.
  const bankFacts = apiBank
    ? bankAccounts.filter(a => a.bank).map(a => ({
      accountId: a.accountID, name: a.name, currency: a.bank.currencyCode || a.currencyCode || null,
      isCard: a.bankAccountType === 'CREDITCARD', book: a.bank.bookBalance, bookBase: a.bank.bookBalanceBase,
      bank: a.bank.bankBalance, hasFeed: a.bank.feedsActive === true || (a.bank.feedsActive == null && Number(a.bank.bankBalance) !== 0),
      uncategorised: Number.isFinite(Number(a.bank.uncategorizedCount)) ? Number(a.bank.uncategorizedCount) : null, source: 'zoho_api',
    }))
    : freshReading ? bankReading.accounts.map(r => {
      const account = accountByName.get(lower(r.accountName));
      return {
        accountId: account ? account.accountID : null, name: r.accountName, currency: readingCurrency(r, account),
        isCard: account ? account.bankAccountType === 'CREDITCARD' : false, book: r.amountInBooks, bookBase: null,
        bank: r.amountInBank, hasFeed: bankFeedOf(r).state === 'shown', uncategorised: Number(r.uncategorised) || 0, source: 'zoho_banking_page',
      };
    }) : null;
  // No currency means the organisation's own; any other currency, code or symbol, is foreign unless it is the base.
  const sameAsBase = currency => !currency || String(currency).toUpperCase() === money.base;

  attempt('bank_balance', () => {
    if (!bankFacts) return mark('bank_balance', LABELS.bankAccess);
    const rows = [];
    for (const fact of bankFacts) {
      if (fact.hasFeed && fact.book != null && fact.bank != null) {
        const difference = round2(Number(fact.book) - Number(fact.bank));
        if (Math.abs(difference) > 0.01) {
          rows.push({
            accountId: fact.accountId, name: fact.name, xeroBalance: fact.book, ledgerBalance: fact.book, statementBalance: fact.bank,
            discrepancy: Math.abs(difference), amount: Math.abs(difference), rule: 'bank_feed_difference', source: fact.source,
            ...(fact.currency && !sameAsBase(fact.currency) ? { currency: fact.currency, potentialValue: 0 } : {}),
            description: `${fact.name}: balance in Zoho Books ${Number(fact.book).toFixed(2)} against the bank feed's ${Number(fact.bank).toFixed(2)}.`,
          });
        }
      }
      // An ordinary bank account overdrawn in the books (a credit card is normally negative): often a receipt
      // that has not been recorded.
      if (!fact.isCard && fact.book != null && Number(fact.book) < -0.005) {
        rows.push({
          accountId: fact.accountId, name: fact.name, ledgerBalance: fact.book, amount: Math.abs(Number(fact.book)),
          discrepancy: 0, rule: 'negative_bank_balance', level: 'review', source: fact.source, potentialValue: 0,
          ...(fact.currency && !sameAsBase(fact.currency) ? { currency: fact.currency } : {}),
          description: `${fact.name} is overdrawn in Zoho Books (${Number(fact.book).toFixed(2)}). Check for missing receipts or a wrong account.`,
        });
      }
    }
    if (!rows.length && !bankFacts.some(fact => fact.hasFeed)) return mark('bank_balance', 'not_configured');
    const value = rows.filter(row => row.rule === 'bank_feed_difference' && row.potentialValue !== 0).reduce((sum, row) => sum + row.discrepancy, 0);
    push('bank_balance', { count: rows.length, value, items: rows, periodChecked: `statement_comparison_as_of_${asOfLabel}` });
  });

  // Unprocessed Bank: bank lines waiting to be categorised in Zoho, one row per line from the API, or one row per
  // account (with its count) from the Banking page reading. Counted in lines, as Xero's is.
  attempt('unprocessed_bank', () => {
    if (apiBank) {
      const rows = statementLines.map(line => ({
        bankTransactionId: line.bankTransactionID, date: dateOf(line), reference: line.reference || null,
        description: line.description || null, contact: line.contact?.name || null, type: line.type,
        accountName: line.bankAccount?.name || null, accountId: line.bankAccount?.accountID || null, amount: line.total,
        ...(line.currencyCode && !sameAsBase(line.currencyCode) ? { currency: line.currencyCode, potentialValue: 0 } : {}),
      }));
      push('unprocessed_bank', { count: rows.length, value: exposure(rows), items: rows, periodChecked: `zoho_uncategorised_as_of_${asOfLabel}` });
      return;
    }
    if (!bankFacts) return mark('unprocessed_bank', LABELS.bankAccess);
    // One finding per account carrying its number of items (itemsToReconcile), as for Xero's Bank accounts page:
    // the check counts accounts and the page shows the items next to it (getLiveScreenItemTotal).
    const rows = bankFacts.filter(fact => fact.uncategorised > 0).map(fact => ({
      documentId: `zoho-bank:${fact.name}`, accountId: fact.accountId, name: fact.name, accountName: fact.name,
      itemsToReconcile: fact.uncategorised, amount: 0, source: fact.source,
      description: `${fact.uncategorised} uncategorised transaction(s) on ${fact.name} in Zoho Books' Banking page.`,
    }));
    push('unprocessed_bank', { count: rows.length, value: 0, items: rows, periodChecked: `zoho_uncategorised_as_of_${asOfLabel}` });
  });

  // Bank Statements Review: one reminder per bank, card or cash account in Zoho, cleared when the count of
  // uncategorised transactions is known to be 0 (from the API or the Banking page reading).
  attempt('bank_statements_review', () => {
    if (!accountsKnown) throw new Error('chart of accounts not read');
    const countFor = account => {
      const fact = (bankFacts || []).find(f => (f.accountId && f.accountId === account.accountID) || lower(f.name) === lower(account.name));
      return fact && fact.uncategorised != null ? fact.uncategorised : null;
    };
    const rows = bankAccounts.map(account => ({ account, count: countFor(account) }))
      .filter(({ count }) => count == null || count > 0)
      .map(({ account, count }) => ({
        documentId: `bank-statements-${account.accountID}`, number: null, date: null, source: 'bank_statements',
        ...shown(account.accountID),
        description: count == null
          ? `Open Banking in Zoho Books and confirm ${account.name} shows no Uncategorized transactions.`
          : `${account.name} has ${count} Uncategorized transaction(s) in Zoho Books. Open Banking and categorise or match them.`,
        amount: 0, level: 'review', rule: 'bank_statements_review', limit: null, uncategorised: count,
      }));
    push('bank_statements_review', { count: rows.length, value: 0, items: rows, periodChecked: 'since_lock_date' });
  });

  return { issues, notes, coverage };
}

// The checks that read invoice, bill, expense or journal lines: their pages say how many documents in the period
// have no lines read yet (the per-sync read cap), so a low count is not taken for a clean result.
const LINE_ITEM_CHECKS = Object.freeze(new Set([
  'multi_account_suppliers', 'multi_tax_suppliers', 'purchase_tax_missing', 'sales_tax_missing', 'low_cost_fixed_assets',
  'capital_item_review', 'misallocated_items', 'bill_or_direct', 'journal_revenue_vs_expense', 'journal_vat_control',
  'journal_to_bank', 'journal_fixed_asset_to_expense', 'tax_review_by_code', 'vat_scheme_threshold', 'motor_vehicle_expenses',
]));
// The sentence a line-item check's page shows, or null when every document in the period has been read.
function unreadLinesNote(checkType, coverage) {
  if (!LINE_ITEM_CHECKS.has(checkType) || !coverage) return null;
  const unread = Number(coverage.unreadInPeriod) || 0;
  const stale = Number(coverage.staleInPeriod) || 0;
  if (!unread && !stale) return null;
  const parts = [];
  if (unread) parts.push(`${unread} Zoho Books document${unread === 1 ? '' : 's'} in the period ${unread === 1 ? 'has' : 'have'} not had ${unread === 1 ? 'its' : 'their'} lines read yet, so ${unread === 1 ? 'it is' : 'they are'} not in this check`);
  if (stale) parts.push(`${stale} changed in Zoho Books since ${stale === 1 ? 'its' : 'their'} lines were read ${stale === 1 ? 'is' : 'are'} checked on the earlier lines`);
  return `${parts.join('; ')}. Akrio reads a limited number of documents per sync; the rest are read at the next syncs.`;
}

// Unreconciled Bank's figures as Zoho Books' Reconciliation Status report gives them: money in, money out, and the
// "Total value of unmatched transactions" (money in minus money out), for the rows a Zoho check stored (detail_json
// items, or the items themselves). Overall and per bank account. Rows from the 3 months before the period
// (display only) and rows in another currency (not converted) are left out, as they are of the check's value.
// gross is money in plus money out (the check's stored value). otherCurrency: how many rows of the check (not display
// only) are in another currency, listed and counted as issues but not added here, so the page can say why its count
// is below the issue count. Zoho's report gives these figures per account; "accounts" has them, and the overall
// figure is every account added together (the page labels it so). null when no row says its direction.
function unreconciledTotals(itemsOrJson) {
  let items = itemsOrJson;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch (error) { return null; } }
  if (!Array.isArray(items)) return null;
  const otherCurrency = items.filter(row => row && !row.displayOnly && row.currency).length;
  const rows = items.filter(row => row && !row.displayOnly && !row.currency && /^Money (in|out)$/.test(String(row.direction || '')));
  if (!rows.length) return null;
  const blank = name => ({ account: name, count: 0, moneyIn: 0, moneyOut: 0 });
  const total = blank(null);
  const byAccount = new Map();
  for (const row of rows) {
    const key = String(row.account || '');
    if (!byAccount.has(key)) byAccount.set(key, blank(row.account || null));
    const amount = Math.abs(Number(row.amount) || 0);
    for (const target of [total, byAccount.get(key)]) {
      target.count += 1;
      if (row.direction === 'Money in') target.moneyIn += amount; else target.moneyOut += amount;
    }
  }
  const finish = t => ({ ...t, moneyIn: round2(t.moneyIn), moneyOut: round2(t.moneyOut), net: round2(t.moneyIn - t.moneyOut), gross: round2(t.moneyIn + t.moneyOut) });
  return { ...finish(total), otherCurrency, accounts: [...byAccount.values()].map(finish) };
}

module.exports = { runZohoChecks, LABELS, LINE_ITEM_CHECKS, unreadLinesNote, ZOHO_CAPITAL_EXCLUDED_NAME, unreconciledTotals };
