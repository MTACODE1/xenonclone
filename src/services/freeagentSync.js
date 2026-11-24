const { hydrateOrgIfEmpty, drain: drainXeroCacheSaves } = require('../db/xeroCacheStore');
const {
  fetchAllInvoices, fetchAllBills, fetchAllContacts, fetchAllCreditNotes, fetchContactsById,
} = require('./freeagentAdapter');
const {
  getOrganisationByFreeAgentCompanyId, upsertFreeAgentOrganisation,
  mergeEntityCacheAsync, getCachedEntitiesAsync, getEntityCacheWatermark,
  createSyncRun, finishSyncRun,
} = require('../db/queries');
const { resolvePeriod } = require('./periodResolver');
const { runLedgerChecks } = require('./ledgerChecks');

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

// Every FreeAgent sync reads the whole list (since 24 Nov 2026). A full read is what removes a
// document deleted in FreeAgent from the cache, and it replaced the caches built while paging was
// broken (first 25 rows only). FreeAgent clients are few; set FREEAGENT_INCREMENTAL=1 to go back
// to reading only what changed since the last sync.
function incrementalSince(orgId, entityType, options) {
  if (options.cacheOnly || options.forceFullRefresh) return undefined;
  if (process.env.FREEAGENT_INCREMENTAL !== '1') return undefined;
  const watermark = getEntityCacheWatermark(orgId, entityType);
  if (!watermark) return undefined;
  return new Date(new Date(watermark).getTime() - 5 * 60 * 1000);
}

async function refreshCachedEntities(orgId, runId, entityType, fetcher, options) {
  await hydrateOrgIfEmpty(orgId);
  if (options.cacheOnly) {
    const cached = await getCachedEntitiesAsync(orgId, entityType);
    if (!cached.length) throw new Error(`No cached ${entityType} data is available`);
    return cached;
  }
  const since = incrementalSince(orgId, entityType, options);
  const fetched = await fetcher(since);
  // Written and read in steps, so a large client does not hold the server (queries.js).
  await mergeEntityCacheAsync(orgId, entityType, fetched, { runId, fullRefresh: !since });
  await drainXeroCacheSaves();
  return getCachedEntitiesAsync(orgId, entityType);
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
  const period = resolvePeriod(options.period || {}, { lockDate: null, ledgerName: 'FreeAgent', asOf: options.asOf });

  // Contacts are read once and shared by the invoice, bill and credit note reads (they used to be
  // read four times per sync).
  let contactsByUrl = null;
  const contactMap = async () => (contactsByUrl = contactsByUrl || await fetchContactsById(companyId));

  emit({ step: 'fetch_invoices', message: 'Refreshing invoice and bill cache...' });
  const invoices = await refreshCachedEntities(
    orgId, runId, 'invoice',
    async since => [
      ...(await fetchAllInvoices(companyId, since, await contactMap())),
      ...(await fetchAllBills(companyId, since, await contactMap())),
    ],
    options
  );

  emit({ step: 'fetch_contacts', message: 'Refreshing contact cache...' });
  const contacts = await refreshCachedEntities(
    orgId, runId, 'contact', since => fetchAllContacts(companyId, since), options
  );

  emit({ step: 'fetch_credits', message: 'Refreshing credit note cache...' });
  const allCredits = await refreshCachedEntities(
    orgId, runId, 'credit_note', async since => fetchAllCreditNotes(companyId, since, await contactMap()), options
  );
  return runLedgerChecks({
    org, runId, period, invoices, contacts, credits: allCredits, options, emit,
    ledger: { key: 'freeagent', purchaseCredits: false, drafts: true },
    saveOrganisation: () => upsertFreeAgentOrganisation({
      freeagent_company_id: companyId, name: org.name, client_ref: org.client_ref, tag: org.tag,
      connection_status: 'connected', last_synced_at: null,
    }),
  });
}

module.exports = { syncFreeAgentOrganisation };
