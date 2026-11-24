const {
  activateSyncRun,
  insertIssue: insertIssueDb, replaceIssueForCheck, getScoringObservationsForRun,
  upsertHealthScore, upsertTransactionCounts,
} = require('../db/queries');
const {
  NON_SCORED_CHECKS, findDuplicates, excludeDuplicateDrafts, findDuplicateContactsAsync,
  isOldDocument, isOverdueMoreThan, selectOldCredits, sumAbsoluteExposure,
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
//           drafts: has draft invoices/bills (unapproved_* run, else not applicable) }
// A check the ledger cannot supply gets period_checked "not_applicable_<key>" (periodStatus.js).
async function runLedgerChecks({ org, runId, period, invoices, contacts, credits: allCredits, options = {}, emit = () => {}, ledger, saveOrganisation, lockDate = null, baseCurrency = null }) {
  const orgId = org.id;
  // A document raised in another currency (a USD invoice on an AED client) keeps its own figures:
  // these ledgers give no rate the checks use, so nothing is converted. Its row records its own
  // currency, the same "currency" field the Xero checks add, so the check page shows "USD 1,000.00"
  // and not the client's currency in front of a dollar figure. A document in the client's own
  // currency gets no field, so its row is exactly what it was. FreeAgent clients are UK (GBP).
  const cleanCode = code => {
    const text = String(code == null ? '' : code).trim().toUpperCase();
    return /^[A-Z]{3}$/.test(text) ? text : null;
  };
  const base = cleanCode(baseCurrency) || 'GBP';
  const ownCurrency = doc => {
    const code = cleanCode(doc && doc.currencyCode);
    return code && code !== base ? { currency: code } : {};
  };
  const salesCredits = allCredits.filter(item => item.type === 'ACCRECCREDIT');
  const purchaseCredits = allCredits.filter(item => item.type === 'ACCPAYCREDIT');
  const notApplicable = `not_applicable_${ledger.key}`;

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
    const duplicateInvoicePool = inPeriod([
      ...accrecAuthorised.filter(i => i.status === 'AUTHORISED'),
      ...accrecDraft.filter(i => i.status === 'SUBMITTED'),
    ]);
    const duplicates = findDuplicates(
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
      count: duplicates.length, potential_value_gbp: sumAbsoluteExposure(duplicates),
      detail_json: JSON.stringify(duplicates), period_checked: period.key,
    });
  } catch (err) {
    console.error('duplicate_invoices check failed — skipping (will show as "Not synced"):', err.message);
  }

  try {
    const duplicateBillPool = inPeriod([
      ...accpayAuthorised,
      ...accpayDraft.filter(i => i.status === 'DRAFT'),
    ]);
    const duplicates = findDuplicates(
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
      count: duplicates.length, potential_value_gbp: sumAbsoluteExposure(duplicates),
      detail_json: JSON.stringify(duplicates), period_checked: period.key,
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
      count: overdue.length, potential_value_gbp: sumAbsoluteExposure(overdue, i => i.amountDue),
      detail_json: JSON.stringify(overdue.map(i => ({
        id: i.invoiceID, number: i.invoiceNumber, contact: i.contact?.name,
        date: toDateString(i.date), dueDate: toDateString(i.dueDate), amountDue: i.amountDue,
        ...ownCurrency(i),
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
      count: credits.length, potential_value_gbp: sumAbsoluteExposure(credits, c => c.remainingCredit),
      detail_json: JSON.stringify(credits.map(c => ({
        id: c.creditNoteID, number: c.creditNoteNumber, contact: c.contact?.name,
        date: toDateString(c.date), remaining: c.remainingCredit,
        ...ownCurrency(c),
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
      count: overdue.length, potential_value_gbp: sumAbsoluteExposure(overdue, i => i.amountDue),
      detail_json: JSON.stringify(overdue.map(i => ({
        id: i.invoiceID, number: i.invoiceNumber, contact: i.contact?.name,
        date: toDateString(i.date), dueDate: toDateString(i.dueDate), amountDue: i.amountDue,
        ...ownCurrency(i),
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
        count: credits.length, potential_value_gbp: sumAbsoluteExposure(credits, c => c.remainingCredit),
        detail_json: JSON.stringify(credits.map(c => ({
          id: c.creditNoteID, number: c.creditNoteNumber, contact: c.contact?.name,
          date: toDateString(c.date), remaining: c.remainingCredit,
          ...ownCurrency(c),
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
    const draftInvoices = inPeriod(accrecDraft);
    const duplicateInvoiceGroups = findDuplicates(draftInvoices);
    const invoicesFinding = excludeDuplicateDrafts(draftInvoices, undefined, duplicateInvoiceGroups);
    const duplicateInvoiceFindings = duplicateInvoiceGroups.flatMap(group => group.documents.map(doc => ({
      id: doc.id, number: doc.reference, contact: group.contact,
      date: doc.date, total: doc.amount, status: doc.status,
      displayOnly: true,
      suspectedDuplicateOf: group.documentIds.filter(id => id !== doc.id),
      history: undefined,
    })));
    persistIssue({
      org_id: orgId, check_type: 'unapproved_invoices', importance: 'medium',
      count: invoicesFinding.length, potential_value_gbp: sumAbsoluteExposure(invoicesFinding, i => i.total),
      detail_json: JSON.stringify([
        ...invoicesFinding.map(i => ({
          id: i.invoiceID, number: i.invoiceNumber, contact: i.contact?.name,
          date: toDateString(i.date), total: i.total, status: i.status,
          ...ownCurrency(i),
        })),
        ...duplicateInvoiceFindings,
      ]),
      period_checked: period.key,
    });
  } catch (err) {
    console.error('unapproved_invoices check failed — skipping (will show as "Not synced"):', err.message);
  }

  if (ledger.drafts) try {
    const draftBills = inPeriod(accpayDraft);
    const duplicateBillGroups = findDuplicates(draftBills);
    const billsFinding = excludeDuplicateDrafts(draftBills, undefined, duplicateBillGroups);
    const duplicateBillFindings = duplicateBillGroups.flatMap(group => group.documents.map(doc => ({
      id: doc.id, number: doc.reference, contact: group.contact,
      date: doc.date, total: doc.amount, status: doc.status,
      displayOnly: true,
      suspectedDuplicateOf: group.documentIds.filter(id => id !== doc.id),
      history: undefined,
    })));
    persistIssue({
      org_id: orgId, check_type: 'unapproved_bills', importance: 'medium',
      count: billsFinding.length, potential_value_gbp: sumAbsoluteExposure(billsFinding, i => i.total),
      detail_json: JSON.stringify([
        ...billsFinding.map(i => ({
          id: i.invoiceID, number: i.invoiceNumber, contact: i.contact?.name,
          date: toDateString(i.date), total: i.total, status: i.status,
          ...ownCurrency(i),
        })),
        ...duplicateBillFindings,
      ]),
      period_checked: period.key,
    });
  } catch (err) {
    console.error('unapproved_bills check failed — skipping (will show as "Not synced"):', err.message);
  }

  try {
    const billsSinceLD = inPeriod(accpayAuthorised).filter(b => b.status === 'AUTHORISED');
    const undocumented = billsSinceLD.filter(b => !b.hasAttachments);
    persistIssue({
      org_id: orgId, check_type: 'undocumented_bills', importance: 'medium',
      count: undocumented.length, potential_value_gbp: 0,
      detail_json: JSON.stringify(undocumented.map(b => ({
        invoiceId: b.invoiceID, number: b.invoiceNumber, contact: b.contact?.name,
        date: toDateString(b.date), total: b.total,
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
  const recentAccrec = inPeriod(invoices.filter(i => i.type === 'ACCREC' && ['AUTHORISED', 'PAID', 'VOIDED'].includes(i.status)));
  const recentAccpay = inPeriod(invoices.filter(i => i.type === 'ACCPAY' && ['AUTHORISED', 'PAID', 'VOIDED'].includes(i.status)));
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
  const turnoverKnown = turnoverDocs.every(d => d.subTotal != null && Number.isFinite(Number(d.subTotal)));
  const turnover = !turnoverKnown ? null : recentAccrec
    .filter(i => i.status === 'AUTHORISED' || i.status === 'PAID')
    .reduce((s, i) => s + (i.subTotal || 0), 0)
    - recentSalesCN
      .filter(c => c.status === 'AUTHORISED' || c.status === 'PAID')
      .reduce((s, c) => s + (c.subTotal || 0), 0);
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
