const {
  fetchAllInvoices, fetchAllBills, fetchAllContacts, fetchAllCreditNotes,
} = require('./freeagentAdapter');
const {
  getOrganisationByFreeAgentCompanyId, upsertFreeAgentOrganisation,
  mergeEntityCache, getCachedEntities, getEntityCacheWatermark,
  createSyncRun, finishSyncRun, activateSyncRun,
  insertIssue: insertIssueDb, replaceIssueForCheck, getScoringObservationsForRun,
  upsertHealthScore, upsertTransactionCounts,
} = require('../db/queries');
const {
  NON_SCORED_CHECKS, findDuplicates, excludeDuplicateDrafts, findDuplicateContacts,
  isOldDocument, selectOldCredits, sumAbsoluteExposure,
  resolveDuplicateInvoiceWindowDays, resolveDuplicateBillWindowDays,
  resolveDuplicateInvoiceRequireExactReference, resolveDuplicateInvoiceIncludeFullyPaid,
  resolveDuplicateBillRequireExactReference, resolveDuplicateBillIncludeFullyPaid,
  resolveDuplicateInvoiceRequireExactTotal, resolveDuplicateBillRequireExactTotal,
  resolvePeriodChecked, toDateString,
} = require('./checkRules');
const { calculateScoreBreakdown } = require('./scoreProfile');
const { isWithinPeriod, resolvePeriod } = require('./periodResolver');

// FreeAgent sync — deliberately NOT the same code path as runSync (xeroSync.js). Xero's runSync
// unconditionally calls ~8 Xero-only endpoints before it ever reaches scoring (org settings, bank
// transactions, payments, tax rates, journals, chart of accounts, Companies House) — none of those
// have a FreeAgent equivalent yet. Bolting a provider-branch into that 2000-line function to reach
// a handful of checks would touch code every live Xero client depends on today. This runs its own
// fetches through the same entity cache (mergeEntityCache/getCachedEntities — already
// provider-agnostic) and computes only the checks that need invoices/bills/credit notes/contacts.
// Every other check simply has no issue row for this run, which is the same "will show as Not
// synced" state a failed Xero check already leaves behind — see the try/catch convention around
// each check in runSync. Two checks (old_purchase_credits, contact_defaults) have no FreeAgent
// equivalent at all — see the not_applicable_freeagent block below — and are marked "Not
// applicable" rather than left on "Not synced" forever. A later stage will add bank
// transactions/explanations + chart of accounts (categories) + tax rates to unlock the remaining
// ~14 checks.

function incrementalSince(orgId, entityType, options) {
  if (options.cacheOnly || options.forceFullRefresh) return undefined;
  const watermark = getEntityCacheWatermark(orgId, entityType);
  if (!watermark) return undefined;
  return new Date(new Date(watermark).getTime() - 5 * 60 * 1000);
}

async function refreshCachedEntities(orgId, runId, entityType, fetcher, options) {
  if (options.cacheOnly) {
    const cached = getCachedEntities(orgId, entityType);
    if (!cached.length) throw new Error(`No cached ${entityType} data is available`);
    return cached;
  }
  const since = incrementalSince(orgId, entityType, options);
  const fetched = await fetcher(since);
  mergeEntityCache(orgId, entityType, fetched, { runId, fullRefresh: !since });
  return getCachedEntities(orgId, entityType);
}

const syncsInProgress = new Set();

async function syncFreeAgentOrganisation(companyId, progressCallback, options = {}) {
  if (syncsInProgress.has(companyId)) {
    throw new Error('A sync is already in progress for this organisation — please wait for it to finish.');
  }
  syncsInProgress.add(companyId);
  const existing = await getOrganisationByFreeAgentCompanyId(companyId);
  if (!existing) {
    syncsInProgress.delete(companyId);
    throw new Error('Organisation not found');
  }
  const runId = await createSyncRun(existing.id, options.checkType ? `check:${options.checkType}` : 'full');
  try {
    return await runFreeAgentSync(companyId, progressCallback, { ...options, runId });
  } catch (error) {
    await finishSyncRun(runId, 'failed', error.message);
    throw error;
  } finally {
    syncsInProgress.delete(companyId);
  }
}

async function runFreeAgentSync(companyId, progressCallback, options = {}) {
  const emit = progressCallback || (() => {});
  emit({ step: 'start', message: 'Starting sync...' });

  const org = await getOrganisationByFreeAgentCompanyId(companyId);
  if (!org) throw new Error('Organisation not found');
  const orgId = org.id;
  const runId = options.runId;

  // No FreeAgent equivalent wired up yet for lock date / financial year end (Stage 2) — resolve
  // against whatever period the caller asked for with no lock-date override, same as a Xero
  // client would get before its first-ever sync populates one.
  const period = resolvePeriod(options.period || {}, { lockDate: null, asOf: options.asOf });

  emit({ step: 'fetch_invoices', message: 'Refreshing invoice and bill cache...' });
  const invoices = await refreshCachedEntities(
    orgId, runId, 'invoice',
    async since => [...(await fetchAllInvoices(companyId, since)), ...(await fetchAllBills(companyId, since))],
    options
  );

  emit({ step: 'fetch_contacts', message: 'Refreshing contact cache...' });
  const contacts = await refreshCachedEntities(
    orgId, runId, 'contact', since => fetchAllContacts(companyId, since), options
  );

  emit({ step: 'fetch_credits', message: 'Refreshing credit note cache...' });
  const allCredits = await refreshCachedEntities(
    orgId, runId, 'credit_note', since => fetchAllCreditNotes(companyId, since), options
  );
  // FreeAgent's /v2/credit_notes is sales-side only — there is no purchase/supplier credit note
  // concept, so purchaseCredits is always empty and old_purchase_credits is marked not-applicable
  // below rather than computed.
  const salesCredits = allCredits.filter(item => item.type === 'ACCRECCREDIT');

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

  const asOf = new Date(`${period.end}T00:00:00.000Z`);

  try {
    const overdue = throughPeriodEnd(accrecAuthorised).filter(i => (i.amountDue || 0) > 0 && isOldDocument(i, asOf));
    persistIssue({
      org_id: orgId, check_type: 'old_unpaid_invoices', importance: 'high',
      count: overdue.length, potential_value_gbp: sumAbsoluteExposure(overdue, i => i.amountDue),
      detail_json: JSON.stringify(overdue.map(i => ({
        id: i.invoiceID, number: i.invoiceNumber, contact: i.contact?.name,
        date: toDateString(i.date), dueDate: toDateString(i.dueDate), amountDue: i.amountDue,
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
      }))),
      period_checked: 'older_than_60_days',
    });
  } catch (err) {
    console.error('old_sales_credits check failed — skipping (will show as "Not synced"):', err.message);
  }

  try {
    const overdue = throughPeriodEnd(accpayAuthorised).filter(i => isOldDocument(i, asOf) && (i.amountDue || 0) > 0);
    persistIssue({
      org_id: orgId, check_type: 'old_unpaid_bills', importance: 'high',
      count: overdue.length, potential_value_gbp: sumAbsoluteExposure(overdue, i => i.amountDue),
      detail_json: JSON.stringify(overdue.map(i => ({
        id: i.invoiceID, number: i.invoiceNumber, contact: i.contact?.name,
        date: toDateString(i.date), dueDate: toDateString(i.dueDate), amountDue: i.amountDue,
      }))),
      period_checked: 'document_date_over_60_days_ago',
    });
  } catch (err) {
    console.error('old_unpaid_bills check failed — skipping (will show as "Not synced"):', err.message);
  }

  // old_purchase_credits has no FreeAgent equivalent — FreeAgent's credit_notes resource is
  // sales-side only (see salesCredits above). Marked not-applicable rather than left "Not synced".
  persistIssue({
    org_id: orgId, check_type: 'old_purchase_credits', importance: 'high',
    count: 0, potential_value_gbp: 0, detail_json: JSON.stringify([]),
    period_checked: 'not_applicable_freeagent',
  });

  // unapproved_invoices/unapproved_bills: same duplicate-draft exclusion as Xero, but without the
  // per-document History API lookup (fetchDocumentHistory in xeroSync.js calls Xero's
  // getInvoiceHistory, which has no FreeAgent equivalent yet) — excluded duplicate drafts still
  // appear as display-only findings, just without the "who created/approved this" note.
  try {
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
        })),
        ...duplicateInvoiceFindings,
      ]),
      period_checked: period.key,
    });
  } catch (err) {
    console.error('unapproved_invoices check failed — skipping (will show as "Not synced"):', err.message);
  }

  try {
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
    // FreeAgent contacts have no isCustomer/isSupplier flag (unlike Xero) — active status alone
    // is the closest equivalent filter available.
    const activeContacts = contacts.filter(c => c.contactStatus === 'ACTIVE');
    const duplicates = findDuplicateContacts(activeContacts);
    persistIssue({
      org_id: orgId, check_type: 'duplicate_contacts', importance: 'low',
      count: duplicates.length, potential_value_gbp: 0,
      detail_json: JSON.stringify(duplicates),
      period_checked: 'active_customer_supplier_contacts',
    });
  } catch (err) {
    console.error('duplicate_contacts check failed — skipping (will show as "Not synced"):', err.message);
  }

  // contact_defaults has no FreeAgent equivalent — FreeAgent contacts carry no default
  // account-code/tax-code fields at all (unlike Xero's salesDefaultAccountCode/
  // accountsReceivableTaxType etc.). Marked not-applicable rather than left "Not synced".
  persistIssue({
    org_id: orgId, check_type: 'contact_defaults', importance: 'low',
    count: 0, potential_value_gbp: 0, detail_json: JSON.stringify([]),
    period_checked: 'not_applicable_freeagent',
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
    lock_date: null,
    period_key: persistedPeriod.key, period_type: persistedPeriod.type,
    period_start: persistedPeriod.start, period_end: persistedPeriod.end, period_label: persistedPeriod.label,
    score_profile_version: scoreBreakdown.profileVersion,
    score_breakdown_json: JSON.stringify(scoreBreakdown),
    run_id: runId, is_active: 0,
  });

  await upsertFreeAgentOrganisation({
    freeagent_company_id: companyId, name: org.name, client_ref: org.client_ref, tag: org.tag,
    connection_status: 'connected', last_synced_at: null,
  });

  // activateSyncRun refuses to activate a full run without a staged transaction_counts row (see
  // queries.js) — bank/journal data isn't fetched yet for FreeAgent (Group B, not built), so those
  // fields are 0 rather than omitted; everything else uses the same data the checks above already
  // computed.
  emit({ step: 'transaction_counts', message: 'Calculating transaction counts...' });
  const recentAccrec = inPeriod(invoices.filter(i => i.type === 'ACCREC' && ['AUTHORISED', 'PAID', 'VOIDED'].includes(i.status)));
  const recentAccpay = inPeriod(invoices.filter(i => i.type === 'ACCPAY' && ['AUTHORISED', 'PAID', 'VOIDED'].includes(i.status)));
  const recentSalesCN = inPeriod(salesCredits).filter(c => ['AUTHORISED', 'PAID', 'VOIDED'].includes(c.status));
  const turnover = recentAccrec
    .filter(i => i.status === 'AUTHORISED' || i.status === 'PAID')
    .reduce((s, i) => s + (i.subTotal || 0), 0);
  upsertTransactionCounts(orgId, {
    period: period.type,
    period_start: period.start,
    period_end: period.end,
    months_covered: period.monthsCovered,
    turnover,
    total_transactions: recentAccrec.length + recentAccpay.length + recentSalesCN.length,
    customer_invoices: recentAccrec.length,
    supplier_bills: recentAccpay.length,
    credit_notes_sales: recentSalesCN.length,
    credit_notes_purchase: 0,
    bank_processed: 0,
    journals: 0,
    run_id: runId,
    is_active: 0,
  });

  await activateSyncRun(orgId, runId, options.checkType || null);
  emit({ step: 'done', message: 'Sync complete!' });

  return { score: scoreBreakdown.score, totalIssues, totalPotentialErrors, period };
}

module.exports = { syncFreeAgentOrganisation };
