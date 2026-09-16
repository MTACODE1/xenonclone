const { fetchAllInvoices, fetchAllBills, fetchAllContacts } = require('./freeagentAdapter');
const {
  getOrganisationByFreeAgentCompanyId, upsertFreeAgentOrganisation,
  mergeEntityCache, getCachedEntities, getEntityCacheWatermark,
  createSyncRun, finishSyncRun, activateSyncRun,
  insertIssue: insertIssueDb, replaceIssueForCheck, getScoringObservationsForRun,
  upsertHealthScore,
} = require('../db/queries');
const {
  NON_SCORED_CHECKS, findDuplicates, sumAbsoluteExposure,
  resolveDuplicateInvoiceWindowDays, resolveDuplicateBillWindowDays,
  resolveDuplicateInvoiceRequireExactReference, resolveDuplicateInvoiceIncludeFullyPaid,
  resolveDuplicateBillRequireExactReference, resolveDuplicateBillIncludeFullyPaid,
  resolveDuplicateInvoiceRequireExactTotal, resolveDuplicateBillRequireExactTotal,
  resolvePeriodChecked, toDateString,
} = require('./checkRules');
const { calculateScoreBreakdown } = require('./scoreProfile');
const { isWithinPeriod, resolvePeriod } = require('./periodResolver');

// Stage 1 FreeAgent sync — deliberately NOT the same code path as runSync (xeroSync.js). Xero's
// runSync unconditionally calls ~8 Xero-only endpoints before it ever reaches scoring (org
// settings, credit notes, bank transactions, payments, tax rates, journals, chart of accounts) —
// none of those have a FreeAgent equivalent yet. Bolting a provider-branch into that 2000-line
// function to reach two checks would touch code every live Xero client depends on today for a
// proof that only needs invoices/bills/contacts. This runs those three fetches through the same
// entity cache (mergeEntityCache/getCachedEntities — already provider-agnostic) and computes only
// duplicate_invoices/duplicate_bills. Every other check simply has no issue row for this run, which
// is the same "will show as Not synced" state a failed Xero check already leaves behind — see the
// try/catch convention around each check in runSync. Stage 2 will add the missing FreeAgent
// fetchers (bills' bank-transaction-explanation join, tax rates, etc.) one check at a time.

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
  await refreshCachedEntities(orgId, runId, 'contact', since => fetchAllContacts(companyId, since), options);

  const accrecAuthorised = invoices.filter(i => i.type === 'ACCREC' && ['AUTHORISED', 'PAID'].includes(i.status));
  const accrecDraft = invoices.filter(i => i.type === 'ACCREC' && ['DRAFT', 'SUBMITTED'].includes(i.status));
  const accpayAuthorised = invoices.filter(i => i.type === 'ACCPAY' && ['AUTHORISED', 'PAID'].includes(i.status));
  const accpayDraft = invoices.filter(i => i.type === 'ACCPAY' && ['DRAFT', 'SUBMITTED'].includes(i.status));
  const inPeriod = items => items.filter(item => isWithinPeriod(toDateString(item.date), period));

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

  await activateSyncRun(orgId, runId, options.checkType || null);
  emit({ step: 'done', message: 'Sync complete!' });

  return { score: scoreBreakdown.score, totalIssues, totalPotentialErrors, period };
}

module.exports = { syncFreeAgentOrganisation };
