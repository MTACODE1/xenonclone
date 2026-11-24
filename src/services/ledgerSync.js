// Sync for a QuickBooks or Zoho Books client: read the documents through the provider, keep them in
// the same entity cache Xero and FreeAgent use, then run the shared ledger checks (ledgerChecks.js).
// Every sync reads the full lists (the same choice as FreeAgent): that is what removes a deleted
// document from the cache, and these ledgers have few clients here.
// A provider with fetchAccounting (Zoho) also reads the chart of accounts, tax rates, manual
// journals, bank accounts and lines and expenses, then the line items of invoices and bills; those
// are kept in the Xero entity types (account, tax_rate, manual_journal, bank_transaction) and the
// read status in 'organisation' (docs/zoho-data-contract.md), and handed to the checks as `accounting`.
const { hydrateOrgIfEmpty, drain: drainCacheSaves } = require('../db/xeroCacheStore');
const {
  getOrganisationByFreeAgentCompanyId, upsertFreeAgentOrganisation, markOrganisationDisconnectedByFreeAgentCompany,
  mergeEntityCacheAsync, getCachedEntitiesAsync, createSyncRun, finishSyncRun,
  updateOrganisationAccountingSettings,
} = require('../db/queries');
const { resolvePeriod } = require('./periodResolver');
const { runLedgerChecks } = require('./ledgerChecks');
const ledgers = require('./ledgers');
const { saveOrgCurrency, getStoredOrgCurrency } = require('../db/orgCurrency');

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

// A year end the company settings gave that can be saved: a whole day 1-31 and month 1-12, or null.
function validYearEnd(info) {
  const day = Number(info && info.financialYearEndDay);
  const month = Number(info && info.financialYearEndMonth);
  if (info?.financialYearEndDay == null || info?.financialYearEndMonth == null) return null;
  if (!Number.isInteger(day) || !Number.isInteger(month) || day < 1 || day > 31 || month < 1 || month > 12) return null;
  return { financialYearEndDay: day, financialYearEndMonth: month };
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
  // The cached invoices and bills, read at most once per sync: the opening balances and the line items
  // both carry cached copies forward.
  let cachedDocs = null;
  const cachedDocuments = async () => {
    if (!cachedDocs) {
      await hydrateOrgIfEmpty(org.id);
      cachedDocs = await getCachedEntitiesAsync(org.id, 'invoice');
    }
    return cachedDocs;
  };
  if (!options.cacheOnly) {
    emit({ step: 'fetch_documents', message: `Reading invoices, bills, credit notes and contacts from ${label}...` });
    // The organisation's currency, so Zoho reads the exchange rate only of vendor credits in another one.
    // cachedOpeningBalances: the opening balances the last good sync cached, which Zoho keeps for a contact
    // whose opening balances could not be read this time (so the full cache refresh does not delete them).
    docs = await provider.fetchDocuments(externalId, {
      emit,
      baseCurrency: info.baseCurrency || null,
      cachedOpeningBalances: async () => (await cachedDocuments()).filter(doc => doc && doc.isOpeningBalance),
    });
  }
  const accountingData = typeof provider.fetchAccounting === 'function'
    ? await readAccounting(provider, externalId, org, docs, emit, cachedDocuments, options)
    : null;
  const invoices = await refreshCache(org.id, options.runId, 'invoice', [...docs.invoices, ...docs.bills], options);
  const contacts = await refreshCache(org.id, options.runId, 'contact', docs.contacts, options);
  const credits = await refreshCache(org.id, options.runId, 'credit_note', docs.credits, options);

  // The client's own currency, which the checks convert other currencies into.
  // A cache-only run has not read the company settings, so it uses the currency the last sync stored.
  // None stored yet (or unreadable) is passed on as null, not as GBP: the checks then leave documents
  // unconverted for this run, as before, rather than treat an AED client's own documents as foreign.
  const baseCurrency = info.baseCurrency
    || await getStoredOrgCurrency(org.id).catch(error => {
      console.error(`[ledgerSync] currency not read for organisation ${org.id}: ${error.message}`);
      return null;
    });

  return runLedgerChecks({
    org, runId: options.runId, period, invoices, contacts, credits, options, emit,
    accounting: accountingData,
    // Zoho's VAT registration and zone flags (null on a cache-only run: the checks use the stored copy).
    taxProfile: info.taxProfile || null,
    ledger: provider.ledger,
    lockDate: info.lockDate || null,
    baseCurrency,
    saveOrganisation: async () => {
      await upsertFreeAgentOrganisation({
        freeagent_company_id: identifier, name: info.name || org.name, client_ref: org.client_ref, tag: org.tag,
        connection_status: 'connected', last_synced_at: null,
      });
      // The currency the client's books are kept in (AED for the UAE Zoho clients), so the pages show
      // it instead of "£". Display only: a failure here is logged and must not fail a good sync.
      // A cache-only run has not read the company settings, so it leaves the stored value alone.
      if (info.baseCurrency) {
        await saveOrgCurrency(org.id, info.baseCurrency)
          .catch(error => console.error(`[ledgerSync] currency not saved for organisation ${org.id}: ${error.message}`));
      }
      // The client's year end (31/12 for a Zoho organisation whose year starts in January), saved the
      // way the Xero sync saves it, so the client page's period menu uses it instead of the default
      // 31/03. Only a valid day and month are saved: none given (or a cache-only run) leaves the stored
      // year end alone. A failure is logged and does not fail a good sync.
      const yearEnd = validYearEnd(info);
      if (yearEnd) {
        await updateOrganisationAccountingSettings(org.id, yearEnd)
          .catch(error => console.error(`[ledgerSync] year end not saved for organisation ${org.id}: ${error.message}`));
      }
    },
  });
}

// The cache types the accounting data is kept in (the Xero ones, so the Xero shapes and the cache's
// id fields fit; see ENTITY_ID_FIELDS in src/db/queries.js).
const ACCOUNTING_TYPES = { accounts: 'account', taxRates: 'tax_rate', manualJournals: 'manual_journal', bankTransactions: 'bank_transaction' };

async function cachedRows(orgId, entityType) {
  await hydrateOrgIfEmpty(orgId);
  return getCachedEntitiesAsync(orgId, entityType);
}

// Reads (or, on a cache-only run, loads) the accounting data and the line items. A section the
// provider could not read this time is not written, so the cache keeps the last good copy; the line
// items go into docs (changed in place) and are cached with the invoices. Returns what the checks get.
async function readAccounting(provider, externalId, org, docs, emit, cachedDocuments, options) {
  // Keyed by the client's identifier ("zoho-<organization_id>"), the one record of its kind.
  const statusId = ledgers.identifierFor(provider.ledger.key, externalId);
  if (options.cacheOnly) {
    const out = {};
    for (const [name, type] of Object.entries(ACCOUNTING_TYPES)) out[name] = await cachedRows(org.id, type);
    const statusRows = await cachedRows(org.id, 'organisation');
    out.readStatus = statusRows.find(row => row && row.organisationID === statusId) || null;
    return out;
  }
  const budget = provider.createReadBudget();
  const read = await provider.fetchAccounting(externalId, {
    emit, readBudget: budget, cached: type => cachedRows(org.id, type),
  });
  const lineItems = await provider.fetchLineItems(externalId, docs, { emit, readBudget: budget, cachedDocuments });
  const out = {};
  for (const [name, type] of Object.entries(ACCOUNTING_TYPES)) {
    const section = read[name];
    if (section.fresh) {
      await mergeEntityCacheAsync(org.id, type, section.rows, { runId: options.runId, fullRefresh: true });
      out[name] = null; // read back below, after the saves are drained
    } else {
      out[name] = section.rows;
    }
  }
  const readStatus = {
    organisationID: statusId, ledger: provider.ledger.key, readAt: new Date().toISOString(),
    permissions: read.status.permissions, sections: read.status.sections,
    lineItems: { ...lineItems },
    detailReads: { limit: budget.limit, used: budget.used, listCalls: budget.listCalls, capReached: budget.capReached, dailyLimit: budget.dailyLimit, notRead: budget.notRead },
  };
  await mergeEntityCacheAsync(org.id, 'organisation', [readStatus], { runId: options.runId, fullRefresh: true });
  await drainCacheSaves();
  for (const [name, type] of Object.entries(ACCOUNTING_TYPES)) {
    if (out[name] === null) out[name] = await getCachedEntitiesAsync(org.id, type);
  }
  out.readStatus = readStatus;
  return out;
}

module.exports = { syncLedgerOrganisation, isAuthFailure, validYearEnd };
