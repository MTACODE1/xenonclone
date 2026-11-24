// Sync for a QuickBooks or Zoho Books client: read the documents through the provider, keep them in
// the same entity cache Xero and FreeAgent use, then run the shared ledger checks (ledgerChecks.js).
// Every sync reads the full lists (the same choice as FreeAgent): that is what removes a deleted
// document from the cache, and these ledgers have few clients here.
const { hydrateOrgIfEmpty, drain: drainCacheSaves } = require('../db/xeroCacheStore');
const {
  getOrganisationByFreeAgentCompanyId, upsertFreeAgentOrganisation, markOrganisationDisconnectedByFreeAgentCompany,
  mergeEntityCacheAsync, getCachedEntitiesAsync, createSyncRun, finishSyncRun,
} = require('../db/queries');
const { resolvePeriod } = require('./periodResolver');
const { runLedgerChecks } = require('./ledgerChecks');
const ledgers = require('./ledgers');

const syncsInProgress = new Set();

async function refreshCache(orgId, runId, entityType, rows, options) {
  await hydrateOrgIfEmpty(orgId);
  if (options.cacheOnly) {
    const cached = await getCachedEntitiesAsync(orgId, entityType);
    if (!cached.length) throw new Error(`No cached ${entityType} data is available`);
    return cached;
  }
  await mergeEntityCacheAsync(orgId, entityType, rows, { runId, fullRefresh: true });
  await drainCacheSaves();
  return getCachedEntitiesAsync(orgId, entityType);
}

// A sign-in the provider no longer accepts (revoked, expired refresh token) marks the client
// disconnected, as a dead Xero connection does, so Sync All stops retrying it every night.
function isAuthFailure(error) {
  return Boolean(error) && (error.authFailure === true || /invalid_grant/i.test(String(error.message)));
}

async function syncLedgerOrganisation(identifier, progressCallback, options = {}) {
  const key = ledgers.ledgerOfIdentifier(identifier);
  if (!key) throw new Error(`Not a QuickBooks or Zoho client: ${identifier}`);
  if (syncsInProgress.has(identifier)) {
    throw new Error('A sync is already in progress for this organisation — please wait for it to finish.');
  }
  syncsInProgress.add(identifier);
  try {
    const org = await getOrganisationByFreeAgentCompanyId(identifier);
    if (!org) throw new Error('Organisation not found');
    const runId = await createSyncRun(org.id, options.checkType ? `check:${options.checkType}` : 'full');
    try {
      return await runLedgerSync(key, identifier, org, progressCallback, { ...options, runId });
    } catch (error) {
      await finishSyncRun(runId, 'failed', error.message);
      if (isAuthFailure(error)) {
        await markOrganisationDisconnectedByFreeAgentCompany(identifier).catch(() => {});
      }
      throw error;
    }
  } finally {
    syncsInProgress.delete(identifier);
  }
}

async function runLedgerSync(key, identifier, org, progressCallback, options) {
  const emit = progressCallback || (() => {});
  const provider = ledgers.provider(key);
  const externalId = ledgers.externalIdOf(identifier);
  const label = ledgers.ledgerLabel(key);
  emit({ step: 'start', message: `Starting ${label} sync...` });

  let info = {};
  if (!options.cacheOnly) {
    emit({ step: 'company', message: `Reading ${label} company settings...` });
    info = (await provider.fetchCompanyInfo(externalId)) || {};
  }
  const period = resolvePeriod(options.period || {}, {
    lockDate: info.lockDate || null,
    ledgerName: label,
    financialYearEndDay: info.financialYearEndDay,
    financialYearEndMonth: info.financialYearEndMonth,
    asOf: options.asOf,
  });

  let docs = { invoices: [], bills: [], credits: [], contacts: [] };
  if (!options.cacheOnly) {
    emit({ step: 'fetch_documents', message: `Reading invoices, bills, credit notes and contacts from ${label}...` });
    docs = await provider.fetchDocuments(externalId, { emit });
  }
  const invoices = await refreshCache(org.id, options.runId, 'invoice', [...docs.invoices, ...docs.bills], options);
  const contacts = await refreshCache(org.id, options.runId, 'contact', docs.contacts, options);
  const credits = await refreshCache(org.id, options.runId, 'credit_note', docs.credits, options);

  return runLedgerChecks({
    org, runId: options.runId, period, invoices, contacts, credits, options, emit,
    ledger: provider.ledger,
    lockDate: info.lockDate || null,
    saveOrganisation: () => upsertFreeAgentOrganisation({
      freeagent_company_id: identifier, name: info.name || org.name, client_ref: org.client_ref, tag: org.tag,
      connection_status: 'connected', last_synced_at: null,
    }),
  });
}

module.exports = { syncLedgerOrganisation, isAuthFailure };
