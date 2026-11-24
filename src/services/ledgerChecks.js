const {
  activateSyncRun,
  insertIssue: insertIssueDb, replaceIssueForCheck, getScoringObservationsForRun,
  upsertHealthScore, upsertTransactionCounts,
} = require('../db/queries');
const {
  NON_SCORED_CHECKS, findDuplicates, excludeDuplicateDrafts, findDuplicateContactsAsync,
  isOldDocument, isOverdueMoreThan, selectOldCredits, sumAbsoluteExposure, amountInBase,
  resolveDuplicateInvoiceWindowDays, resolveDuplicateBillWindowDays,
  resolveDuplicateInvoiceRequireExactReference, resolveDuplicateInvoiceIncludeFullyPaid,
  resolveDuplicateBillRequireExactReference, resolveDuplicateBillIncludeFullyPaid,
  resolveDuplicateInvoiceRequireExactTotal, resolveDuplicateBillRequireExactTotal,
  resolvePeriodChecked, toDateString, ageingDate,
} = require('./checkRules');
const { calculateScoreBreakdown } = require('./scoreProfile');
const { isWithinPeriod } = require('./periodResolver');

// The checks every non-Xero ledger (FreeAgent, QuickBooks, Zoho Books) runs on its documents.
// Moved out of freeagentSync.js on 24 Nov 2026 so QuickBooks and Zoho run exactly the same checks
// on the same Xero-shaped documents (invoices/bills with type ACCREC/ACCPAY and Xero statuses,
// credit notes ACCRECCREDIT/ACCPAYCREDIT with positive amounts, contacts with contactStatus).
//
// ledger: { key: 'freeagent' | 'quickbooks' | 'zoho',
//           purchaseCredits: has supplier credits (old_purchase_credits runs, else not applicable),
//           drafts: has draft invoices/bills (unapproved_* run, else not applicable),
//           exchangeRates: its documents carry a usable currencyRate (Zoho, QuickBooks; not FreeAgent) }
// A check the ledger cannot supply gets period_checked "not_applicable_<key>" (periodStatus.js).
async function runLedgerChecks({ org, runId, period, invoices, contacts, credits: allCredits, options = {}, emit = () => {}, ledger, saveOrganisation, lockDate = null, baseCurrency = null }) {
  const orgId = org.id;
  // A document raised in another currency (a USD invoice on an AED client) is converted to the
  // client's own currency for every total, with the same amountInBase the Xero checks use: each
  // document carries currencyRate in Xero's convention (units of its own currency per one unit of
  // the client's currency; the Zoho and QuickBooks adapters turn their rates round to match).
  // Its row keeps its own currency and figure ("currency": "USD", amountDue 1000) for the
  // accountant, with the converted figure beside it in "baseAmount", rounded to the penny (fils) per
  // document as the ledger itself holds it, so a check's total is the sum of the figures its rows show.
  // A foreign document with no usable rate is never counted as if it were in the client's currency:
  // its row is kept and marked "noExchangeRate", and it is left out of the money totals (the counts
  // still include it). A document in the client's own currency gets no extra field, so its row is
  // exactly what it was.
  //
  // Conversion runs only when the ledger supplies rates (ledger.exchangeRates: Zoho, QuickBooks) AND
  // the client's currency is known. Otherwise the checks behave exactly as before conversion existed:
  // a foreign document's row is only tagged with its currency and its figure is added as it stands.
  //  - FreeAgent maps no exchange rate (its rate's direction is unverified, see Turnover below), and
  //    its clients are UK (GBP), so a rare non-GBP document there must not suddenly drop out of totals.
  //  - A cache-only re-run of a Zoho/QuickBooks client whose currency has not been stored yet (no full
  //    sync since this shipped, or a failed save) does not know the client's currency; guessing GBP
  //    would mark every AED document as foreign with no rate and zero every total.
  const cleanCode = code => {
    const text = String(code == null ? '' : code).trim().toUpperCase();
    return /^[A-Z]{3}$/.test(text) ? text : null;
  };
  const knownBase = cleanCode(baseCurrency);
  const base = knownBase || 'GBP';
  const converts = ledger.exchangeRates === true && Boolean(knownBase);
  if (ledger.exchangeRates === true && !knownBase) {
    console.log(`[ledgerChecks] organisation ${orgId}: currency not known yet, so documents in other currencies are not converted this run`);
  }
  const foreignCode = doc => {
    const code = cleanCode(doc && doc.currencyCode);
    return code && code !== base ? code : null;
  };
  const hasUsableRate = doc => {
    const rate = Number(doc && doc.currencyRate);
    return Number.isFinite(rate) && rate > 0;
  };
  const noRate = doc => converts && Boolean(foreignCode(doc)) && !hasUsableRate(doc);
  // Half-up to 2 decimals, immune to the binary noise the rate inversion leaves (10 x 3.6725 comes out
  // as 36.724999...; the ledger's own figure is 36.73).
  const roundMoney = value => {
    const number = Number(value) || 0;
    const sign = number < 0 ? -1 : 1;
    return sign * Number(`${Math.round(Number(`${Math.abs(number).toFixed(8)}e2`))}e-2`);
  };
  // A foreign document's amount in the client's currency, rounded per document; a same-currency
  // document's amount is amountInBase's (its rate is 1 or absent), unrounded, exactly as before.
  const converted = (amount, doc) => (foreignCode(doc) ? roundMoney(amountInBase(amount, doc)) : amountInBase(amount, doc));
  // The amount in the client's currency for a total; 0 (left out) when it cannot be converted. With
  // conversion off, the amount as it stands (as before).
  const inBase = (amount, doc) => {
    if (!converts) return amount;
    return noRate(doc) ? 0 : converted(amount, doc);
  };
  // The fields a row of a foreign document carries; none for a document in the client's currency.
  // potentialValue is the row's share of the check's total, as on the Xero rows: insertIssue
  // (allocateFindingValues) shares the total out by it before it falls back to amountDue/remaining/
  // amount/total, which here are in the document's own currency. 0 for a row with no rate, which is
  // not in the total. baseAmount is the converted figure the check page shows beside the original.
  // With conversion off, only the currency tag (as before).
  const currencyFields = (doc, amount) => {
    const code = foreignCode(doc);
    if (!code) return {};
    if (!converts) return { currency: code };
    if (!hasUsableRate(doc)) return { currency: code, noExchangeRate: true, potentialValue: 0 };
    const value = converted(amount, doc);
    return { currency: code, baseAmount: value, potentialValue: value };
  };
  const docsById = new Map(invoices.map(doc => [doc.invoiceID, doc]));
  // Duplicates are looked for within one currency at a time when converting: "USD 100" and "AED 100"
  // to the same supplier are not the same bill entered twice, and a group's exposure and nested
  // figures are then all in the one currency its row names. A pool in a single currency is grouped
  // exactly as before. With conversion off, grouping is as before.
  const findDuplicatesByCurrency = (items, ...args) => {
    if (!converts) return findDuplicates(items, ...args);
    const byCurrency = new Map();
    for (const item of items) {
      const code = foreignCode(item) || base;
      if (!byCurrency.has(code)) byCurrency.set(code, []);
      byCurrency.get(code).push(item);
    }
    if (byCurrency.size <= 1) return findDuplicates(items, ...args);
    return [...byCurrency.values()].flatMap(pool => findDuplicates(pool, ...args))
      .sort((a, b) => String(b.date2 || '').localeCompare(String(a.date2 || '')));
  };
  // A duplicate group's exposure is its latest document's total (findDuplicates' "amount"), converted
  // with that document's rate; its row says which currency the group is in.
  const groupDoc = group => docsById.get(group.id2) || null;
  const groupExposure = group => {
    if (!converts) return group.amount;
    const doc = groupDoc(group);
    return doc ? inBase(group.amount, doc) : Number(group.amount) || 0;
  };
  const withGroupCurrency = group => {
    if (!converts) return group;
    const doc = groupDoc(group);
    return doc ? { ...group, ...currencyFields(doc, group.amount) } : group;
  };
  const salesCredits = allCredits.filter(item => item.type === 'ACCRECCREDIT');
  const purchaseCredits = allCredits.filter(item => item.type === 'ACCPAYCREDIT');
  const notApplicable = `not_applicable_${ledger.key}`;

  // Opening balances brought forward (Zoho's hidden "Customer/Vendor opening balance" documents, marked
  // isOpeningBalance by the Zoho adapter) are money still owed, so Old Unpaid Invoices/Bills count them.
  // They are not sales or purchases raised in the period: duplicates, unapproved, undocumented bills,
  // turnover and the transaction counts leave them out (two of them for one contact are not a duplicate).
  const isOpeningBalance = doc => Boolean(doc && doc.isOpeningBalance);
  const notOpeningBalance = items => items.filter(item => !isOpeningBalance(item));
  const accrecAuthorised = invoices.filter(i => i.type === 'ACCREC' && ['AUTHORISED', 'PAID'].includes(i.status));
  const accrecDraft = invoices.filter(i => i.type === 'ACCREC' && ['DRAFT', 'SUBMITTED'].includes(i.status));
  const accpayAuthorised = invoices.filter(i => i.type === 'ACCPAY' && ['AUTHORISED', 'PAID'].includes(i.status));
  const accpayDraft = invoices.filter(i => i.type === 'ACCPAY' && ['DRAFT', 'SUBMITTED'].includes(i.status));
  const inPeriod = items => items.filter(item => isWithinPeriod(toDateString(item.date), period));
  const throughPeriodEnd = items => items.filter(item => {
    const date = toDateString(item.date);
    return date && date <= period.end;
  });

  emit({ step: 'running_checks', message: 'Running bookkeeping checks...' });
  const issueResults = [];
  const persistIssue = issue => {
    if (options.checkType && issue.check_type !== options.checkType) return;
    const scoped = {
      ...issue, period_checked: resolvePeriodChecked(issue.period_checked, period.key),
      run_id: runId, is_active: 0,
    };
    if (options.checkType) replaceIssueForCheck(scoped);
    else insertIssueDb(scoped);
    issueResults.push(scoped);
  };

  try {
    const duplicateInvoicePool = notOpeningBalance(inPeriod([
      ...accrecAuthorised.filter(i => i.status === 'AUTHORISED'),
      ...accrecDraft.filter(i => i.status === 'SUBMITTED'),
    ]));
    const duplicates = findDuplicatesByCurrency(
      duplicateInvoicePool,
      resolveDuplicateInvoiceWindowDays(org),
      {
        requireUnpaidPair: !resolveDuplicateInvoiceIncludeFullyPaid(org),
        requireExactReference: resolveDuplicateInvoiceRequireExactReference(org),
        requireExactTotal: resolveDuplicateInvoiceRequireExactTotal(org),
      }
    );
    persistIssue({
      org_id: orgId, check_type: 'duplicate_invoices', importance: 'high',
      count: duplicates.length, potential_value_gbp: sumAbsoluteExposure(duplicates, groupExposure),
      detail_json: JSON.stringify(duplicates.map(withGroupCurrency)), period_checked: period.key,
    });
  } catch (err) {
    console.error('duplicate_invoices check failed — skipping (will show as "Not synced"):', err.message);
  }

  try {
    const duplicateBillPool = notOpeningBalance(inPeriod([
      ...accpayAuthorised,
      ...accpayDraft.filter(i => i.status === 'DRAFT'),
    ]));
    const duplicates = findDuplicatesByCurrency(
      duplicateBillPool,
      resolveDuplicateBillWindowDays(org),
      {
        requireUnpaidPair: !resolveDuplicateBillIncludeFullyPaid(org),
        requireExactReference: resolveDuplicateBillRequireExactReference(org),
        requireExactTotal: resolveDuplicateBillRequireExactTotal(org),
      }
    );
    persistIssue({
      org_id: orgId, check_type: 'duplicate_bills', importance: 'high',
      count: duplicates.length, potential_value_gbp: sumAbsoluteExposure(duplicates, groupExposure),
      detail_json: JSON.stringify(duplicates.map(withGroupCurrency)), period_checked: period.key,
    });
  } catch (err) {
    console.error('duplicate_bills check failed — skipping (will show as "Not synced"):', err.message);
  }

  // As at the end of the current month, like Xero's aged reports and the Xero checks (Abdur, Nov 2026).
  const asOf = new Date(`${ageingDate(period.end)}T00:00:00.000Z`);

  try {
    const overdue = throughPeriodEnd(accrecAuthorised).filter(i => (i.amountDue || 0) > 0 && isOldDocument(i, asOf));
    persistIssue({
      org_id: orgId, check_type: 'old_unpaid_invoices', importance: 'high',
      count: overdue.length, potential_value_gbp: sumAbsoluteExposure(overdue, i => inBase(i.amountDue, i)),
      detail_json: JSON.stringify(overdue.map(i => ({
        id: i.invoiceID, number: i.invoiceNumber, contact: i.contact?.name,
        date: toDateString(i.date), dueDate: toDateString(i.dueDate), amountDue: i.amountDue,
        ...currencyFields(i, i.amountDue),
        ...(isOpeningBalance(i) ? { openingBalance: true } : {}),
      }))),
      period_checked: 'document_date_over_60_days_ago_all_time',
    });
  } catch (err) {
    console.error('old_unpaid_invoices check failed — skipping (will show as "Not synced"):', err.message);
  }

  try {
    const credits = selectOldCredits(throughPeriodEnd(salesCredits), asOf);
    persistIssue({
      org_id: orgId, check_type: 'old_sales_credits', importance: 'high',
      count: credits.length, potential_value_gbp: sumAbsoluteExposure(credits, c => inBase(c.remainingCredit, c)),
      detail_json: JSON.stringify(credits.map(c => ({
        id: c.creditNoteID, number: c.creditNoteNumber, contact: c.contact?.name,
        date: toDateString(c.date), remaining: c.remainingCredit,
        ...currencyFields(c, c.remainingCredit),
      }))),
      period_checked: 'older_than_60_days',
    });
  } catch (err) {
    console.error('old_sales_credits check failed — skipping (will show as "Not synced"):', err.message);
  }

  try {
    const overdue = throughPeriodEnd(accpayAuthorised).filter(i => isOverdueMoreThan(i, asOf) && (i.amountDue || 0) > 0);
    persistIssue({
      org_id: orgId, check_type: 'old_unpaid_bills', importance: 'high',
      count: overdue.length, potential_value_gbp: sumAbsoluteExposure(overdue, i => inBase(i.amountDue, i)),
      detail_json: JSON.stringify(overdue.map(i => ({
        id: i.invoiceID, number: i.invoiceNumber, contact: i.contact?.name,
        date: toDateString(i.date), dueDate: toDateString(i.dueDate), amountDue: i.amountDue,
        ...currencyFields(i, i.amountDue),
        ...(isOpeningBalance(i) ? { openingBalance: true } : {}),
      }))),
      period_checked: 'due_date_over_60_days_ago',
    });
  } catch (err) {
    console.error('old_unpaid_bills check failed — skipping (will show as "Not synced"):', err.message);
  }

  // Supplier credits: QuickBooks (vendor credits) and Zoho (vendor credits) have them; FreeAgent's
  // credit notes are sales-side only, so there the check is marked not applicable.
  if (ledger.purchaseCredits) {
    try {
      const credits = selectOldCredits(throughPeriodEnd(purchaseCredits).filter(c => c.status === 'AUTHORISED'), asOf);
      persistIssue({
        org_id: orgId, check_type: 'old_purchase_credits', importance: 'high',
        count: credits.length, potential_value_gbp: sumAbsoluteExposure(credits, c => inBase(c.remainingCredit, c)),
        detail_json: JSON.stringify(credits.map(c => ({
          id: c.creditNoteID, number: c.creditNoteNumber, contact: c.contact?.name,
          date: toDateString(c.date), remaining: c.remainingCredit,
          ...currencyFields(c, c.remainingCredit),
        }))),
        period_checked: 'older_than_60_days',
      });
    } catch (err) {
      console.error('old_purchase_credits check failed — skipping (will show as "Not synced"):', err.message);
    }
  } else {
    persistIssue({
      org_id: orgId, check_type: 'old_purchase_credits', importance: 'high',
      count: 0, potential_value_gbp: 0, detail_json: JSON.stringify([]),
      period_checked: notApplicable,
    });
  }

  // unapproved_invoices/unapproved_bills: same duplicate-draft exclusion as Xero, but without the
  // per-document History API lookup (fetchDocumentHistory in xeroSync.js calls Xero's
  // getInvoiceHistory, which has no FreeAgent equivalent yet) — excluded duplicate drafts still
  // appear as display-only findings, just without the "who created/approved this" note.
  // QuickBooks has no draft invoices or bills, so there the two checks are marked not applicable.
  if (!ledger.drafts) {
    for (const checkType of ['unapproved_invoices', 'unapproved_bills']) {
      persistIssue({
        org_id: orgId, check_type: checkType, importance: 'medium',
        count: 0, potential_value_gbp: 0, detail_json: JSON.stringify([]), period_checked: notApplicable,
      });
    }
  }
  if (ledger.drafts) try {
    const draftInvoices = notOpeningBalance(inPeriod(accrecDraft));
    const duplicateInvoiceGroups = findDuplicatesByCurrency(draftInvoices);
    const invoicesFinding = excludeDuplicateDrafts(draftInvoices, undefined, duplicateInvoiceGroups);
    const duplicateInvoiceFindings = duplicateInvoiceGroups.flatMap(group => group.documents.map(doc => ({
      id: doc.id, number: doc.reference, contact: group.contact,
      date: doc.date, total: doc.amount, status: doc.status,
      displayOnly: true,
      suspectedDuplicateOf: group.documentIds.filter(id => id !== doc.id),
      history: undefined,
      ...(converts && docsById.has(doc.id) ? currencyFields(docsById.get(doc.id), doc.amount) : {}),
    })));
    persistIssue({
      org_id: orgId, check_type: 'unapproved_invoices', importance: 'medium',
      count: invoicesFinding.length, potential_value_gbp: sumAbsoluteExposure(invoicesFinding, i => inBase(i.total, i)),
      detail_json: JSON.stringify([
        ...invoicesFinding.map(i => ({
          id: i.invoiceID, number: i.invoiceNumber, contact: i.contact?.name,
          date: toDateString(i.date), total: i.total, status: i.status,
          ...currencyFields(i, i.total),
        })),
        ...duplicateInvoiceFindings,
      ]),
      period_checked: period.key,
    });
  } catch (err) {
    console.error('unapproved_invoices check failed — skipping (will show as "Not synced"):', err.message);
  }

  if (ledger.drafts) try {
    const draftBills = notOpeningBalance(inPeriod(accpayDraft));
    const duplicateBillGroups = findDuplicatesByCurrency(draftBills);
    const billsFinding = excludeDuplicateDrafts(draftBills, undefined, duplicateBillGroups);
    const duplicateBillFindings = duplicateBillGroups.flatMap(group => group.documents.map(doc => ({
      id: doc.id, number: doc.reference, contact: group.contact,
      date: doc.date, total: doc.amount, status: doc.status,
      displayOnly: true,
      suspectedDuplicateOf: group.documentIds.filter(id => id !== doc.id),
      history: undefined,
      ...(converts && docsById.has(doc.id) ? currencyFields(docsById.get(doc.id), doc.amount) : {}),
    })));
    persistIssue({
      org_id: orgId, check_type: 'unapproved_bills', importance: 'medium',
      count: billsFinding.length, potential_value_gbp: sumAbsoluteExposure(billsFinding, i => inBase(i.total, i)),
      detail_json: JSON.stringify([
        ...billsFinding.map(i => ({
          id: i.invoiceID, number: i.invoiceNumber, contact: i.contact?.name,
          date: toDateString(i.date), total: i.total, status: i.status,
          ...currencyFields(i, i.total),
        })),
        ...duplicateBillFindings,
      ]),
      period_checked: period.key,
    });
  } catch (err) {
    console.error('unapproved_bills check failed — skipping (will show as "Not synced"):', err.message);
  }

  try {
    const billsSinceLD = notOpeningBalance(inPeriod(accpayAuthorised)).filter(b => b.status === 'AUTHORISED');
    const undocumented = billsSinceLD.filter(b => !b.hasAttachments);
    persistIssue({
      org_id: orgId, check_type: 'undocumented_bills', importance: 'medium',
      count: undocumented.length, potential_value_gbp: 0,
      detail_json: JSON.stringify(undocumented.map(b => ({
        invoiceId: b.invoiceID, number: b.invoiceNumber, contact: b.contact?.name,
        date: toDateString(b.date), total: b.total,
        // (No tag here before conversion existed, so none with conversion off.)
        ...(converts ? currencyFields(b, b.total) : {}),
      }))),
      period_checked: period.key,
    });
  } catch (err) {
    console.error('undocumented_bills check failed — skipping (will show as "Not synced"):', err.message);
  }

  try {
    // FreeAgent contacts have no isCustomer/isSupplier flag (unlike Xero), but the same role
    // still exists in FreeAgent's own data: a contact is a customer if it's ever appeared on an
    // invoice, a supplier if it's ever appeared on a bill. `invoices` here is the full merged
    // invoice+bill cache (all statuses, all time), matching Xero's isCustomer/isSupplier being a
    // persistent role rather than something scoped to the current period.
    const customerContactIds = new Set(
      invoices.filter(i => i.type === 'ACCREC' && i.contact?.contactID).map(i => i.contact.contactID)
    );
    const supplierContactIds = new Set(
      invoices.filter(i => i.type === 'ACCPAY' && i.contact?.contactID).map(i => i.contact.contactID)
    );
    const activeContacts = contacts.filter(c =>
      c.contactStatus === 'ACTIVE' && (customerContactIds.has(c.contactID) || supplierContactIds.has(c.contactID))
    );
    // Pauses now and then so the server keeps answering while a large contact list is compared.
    const duplicates = await findDuplicateContactsAsync(activeContacts);
    persistIssue({
      org_id: orgId, check_type: 'duplicate_contacts', importance: 'low',
      count: duplicates.length, potential_value_gbp: 0,
      detail_json: JSON.stringify(duplicates),
      period_checked: 'active_customer_supplier_contacts',
    });
  } catch (err) {
    console.error('duplicate_contacts check failed — skipping (will show as "Not synced"):', err.message);
  }

  // contact_defaults: FreeAgent, QuickBooks and Zoho contacts carry no default account code
  // (Xero's salesDefaultAccountCode/purchasesDefaultAccountCode), so it is marked not applicable.
  persistIssue({
    org_id: orgId, check_type: 'contact_defaults', importance: 'low',
    count: 0, potential_value_gbp: 0, detail_json: JSON.stringify([]),
    period_checked: notApplicable,
  });

  emit({ step: 'score', message: 'Calculating health score...' });
  const scoreBreakdown = calculateScoreBreakdown(
    getScoringObservationsForRun(orgId, runId, options.checkType || null), {
      nonScoredChecks: NON_SCORED_CHECKS,
      asOf: new Date(`${period.end}T00:00:00.000Z`),
    });
  const totalIssues = issueResults.reduce((s, i) => s + (i.count || 0), 0);
  const totalPotentialErrors = issueResults.reduce((s, i) => s + (i.potential_value_gbp || 0), 0);

  const persistedPeriod = options.checkType && org.period_key
    ? { key: org.period_key, type: org.period_type, start: org.period_start, end: org.period_end, label: org.period_label }
    : { key: period.key, type: period.type, start: period.start, end: period.end, label: period.label };

  await upsertHealthScore(orgId, {
    score: scoreBreakdown.score, total_issues: totalIssues, total_potential_errors_gbp: totalPotentialErrors,
    last_bank_reconciled: null, most_recent_transaction: null, unreconciled_bank_items: 0,
    lock_date: lockDate || null,
    period_key: persistedPeriod.key, period_type: persistedPeriod.type,
    period_start: persistedPeriod.start, period_end: persistedPeriod.end, period_label: persistedPeriod.label,
    score_profile_version: scoreBreakdown.profileVersion,
    score_breakdown_json: JSON.stringify(scoreBreakdown),
    run_id: runId, is_active: 0,
  });

  if (saveOrganisation) await saveOrganisation();

  // activateSyncRun refuses to activate a full run without a staged transaction_counts row (see
  // queries.js) — bank/journal data isn't fetched yet for FreeAgent (Group B, not built), so those
  // fields are 0 rather than omitted; everything else uses the same data the checks above already
  // computed.
  emit({ step: 'transaction_counts', message: 'Calculating transaction counts...' });
  // Opening balances are not documents raised in the period (see isOpeningBalance above).
  const recentAccrec = notOpeningBalance(inPeriod(invoices.filter(i => i.type === 'ACCREC' && ['AUTHORISED', 'PAID', 'VOIDED'].includes(i.status))));
  const recentAccpay = notOpeningBalance(inPeriod(invoices.filter(i => i.type === 'ACCPAY' && ['AUTHORISED', 'PAID', 'VOIDED'].includes(i.status))));
  const recentSalesCN = inPeriod(salesCredits).filter(c => ['AUTHORISED', 'PAID', 'VOIDED'].includes(c.status));
  const recentPurchaseCN = inPeriod(purchaseCredits).filter(c => ['AUTHORISED', 'PAID', 'VOIDED'].includes(c.status));
  // Turnover still has two known gaps vs. the Xero calculation (currency conversion and account
  // classification) — deliberately deferred, not overlooked. Currency: FreeAgent's exchange-rate
  // field direction is the opposite convention from Xero's and this Stage 1 integration has no
  // live multi-currency data to verify it against (the one connected client is GBP-locked) — do
  // not guess it blind on real client money. Classification: FreeAgent doesn't fetch its own
  // chart-of-accounts/categories at all yet (Group B, not built), so there's no revenue-account
  // filter equivalent to Xero's turnoverAccountCodes; every ACCREC invoice line still counts,
  // whatever category it's coded to. Credit-note netting below IS safe to ship now — the
  // direction is unambiguous and doesn't depend on either of those two gaps.
  // Turnover is net of VAT. A ledger whose lists carry no net figure (Zoho Books list answers have
  // only gross totals) gives null, shown as "not available", rather than a false £0.
  const turnoverDocs = [
    ...recentAccrec.filter(i => i.status === 'AUTHORISED' || i.status === 'PAID'),
    ...recentSalesCN.filter(c => c.status === 'AUTHORISED' || c.status === 'PAID'),
  ];
  // In the client's own currency (amountInBase, as for the checks above). A foreign document with no
  // usable exchange rate would make the figure wrong whichever way it was counted, so turnover is then
  // "not available" too, rather than a sum that silently leaves it out or counts it 1:1.
  const turnoverKnown = turnoverDocs.every(d => d.subTotal != null && Number.isFinite(Number(d.subTotal)) && !noRate(d));
  const turnover = !turnoverKnown ? null : recentAccrec
    .filter(i => i.status === 'AUTHORISED' || i.status === 'PAID')
    .reduce((s, i) => s + (converts ? converted(i.subTotal || 0, i) : (i.subTotal || 0)), 0)
    - recentSalesCN
      .filter(c => c.status === 'AUTHORISED' || c.status === 'PAID')
      .reduce((s, c) => s + (converts ? converted(c.subTotal || 0, c) : (c.subTotal || 0)), 0);
  upsertTransactionCounts(orgId, {
    period: period.type,
    period_start: period.start,
    period_end: period.end,
    months_covered: period.monthsCovered,
    turnover,
    total_transactions: recentAccrec.length + recentAccpay.length + recentSalesCN.length + recentPurchaseCN.length,
    customer_invoices: recentAccrec.length,
    supplier_bills: recentAccpay.length,
    credit_notes_sales: recentSalesCN.length,
    credit_notes_purchase: recentPurchaseCN.length,
    bank_processed: 0,
    journals: 0,
    run_id: runId,
    is_active: 0,
  });

  await activateSyncRun(orgId, runId, options.checkType || null);
  // Save this sync's results to MySQL within about a minute (see snapshotStore.requestResultSave). Never fails the sync.
  try { require('../db/snapshotStore').requestResultSave(); } catch (snapshotError) { console.error('[snapshot] could not queue a result save:', snapshotError.message); }
  emit({ step: 'done', message: 'Sync complete!' });

  return { score: scoreBreakdown.score, totalIssues, totalPotentialErrors, period };
}

module.exports = { runLedgerChecks };
