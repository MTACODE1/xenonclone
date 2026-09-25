const { apiCall } = require('./xeroClient');
const { syncInsight } = require('./insightSync');
const {
  upsertOrganisation, upsertHealthScore,
  deleteIssuesForOrg, insertIssue: insertIssueDb, replaceIssueForCheck, getOrganisationByTenantId, getIssuesForOrg, getScoringObservations,
  upsertTransactionCounts, getSetting, upsertBankReconciliationXeroBalance,
  getBankReconciliationForOrg, upsertChartOfAccountsCache, getAccountCheckConfigurationForOrg,
  getExcludedBankAccountIds,
  getFiledAccountsForOrg, getLatestStatementImportsForOrg, getStatementLinesForOrg,
  getXeroBankItemsForOrg, replaceXeroBankItemsCache, updateFiledAccountsXeroBalance,
  updateStatementLineMatches, updateOrganisationAccountingSettings,
  createSyncRun, finishSyncRun, activateSyncRun, getIssuesForRun, getScoringObservationsForRun,
  mergeEntityCache, getCachedEntities, getEntityCacheWatermark,
  updateOrganisationCompanyNumber, upsertCompaniesHouseProfile, getCompaniesHouseProfileForOrg,
  upsertFiledAccountsFromCompaniesHouse, recordFiledAccountsExtraction
} = require('../db/queries');
const { fetchCompanyProfile, fetchFiledNetAssets, normalizeCompanyNumber } = require('./companiesHouse');
const { getDb: getDatabase } = require('../db/schema');
const {
  CHECK_DEFAULTS, CHECK_DEFINITIONS, NON_SCORED_CHECKS, calculateHealthScore, findDirectMatches,
  findDuplicateContacts, findDuplicates, excludeDuplicateDrafts, findUnexpectedDefaultLines,
  findMisallocatedLines, resolveCapitalReviewCandidateCodes,
  isOldDocument, isPurchaseTaxExemptAccount, resolvePeriodChecked, resolveSupplierPatternLookbackMonths,
  resolveMultiAccountPatternLookbackMonths,
  resolveMultiAccountSuppliersMinValue, resolveMultiTaxSuppliersMinValue,
  resolveCapitalReviewDefaultThreshold, resolveMisallocatedItemsDefaultThreshold,
  resolvePurchaseTaxMissingExcludeCodes, resolveDuplicateInvoiceWindowDays, resolveDuplicateBillWindowDays,
  resolveDuplicateInvoiceRequireExactReference, resolveDuplicateInvoiceIncludeFullyPaid,
  resolveDuplicateBillRequireExactReference, resolveDuplicateBillIncludeFullyPaid,
  resolveDuplicateInvoiceRequireExactTotal, resolveDuplicateBillRequireExactTotal,
  selectAuthorisedUnreconciled, selectOldCredits, sumAbsoluteExposure,
  grossLineAmount, netLineAmount, toDateString,
  withDisplayOnlyBankFindings
} = require('./checkRules');
const { calculateScoreBreakdown } = require('./scoreProfile');
const {
  allocateStatementMatches, extractNetAssetsFromBalanceSheet, balanceSheetHoldsBookkeeping,
  recomputeEvidenceIssues
} = require('./statementEvidence');
const { isWithinPeriod, resolvePeriod } = require('./periodResolver');

// Paginated invoice fetch — passing page triggers full record mode (with lineItems)
const pageDelay = () => new Promise(resolve => setTimeout(resolve, 1000));

// Some pagination loops (see fetchAllJournals) have no upper bound on how many pages they'll
// walk — for a client with an enormous history in Xero, that's not a crash, just an extremely
// long real-world wait (one client's journal fetch once ran 8 hours). Since sync jobs run one at
// a time, a single client's fetch taking that long blocks every other client's sync behind it.
// This races a promise against a timeout so a call that's taking unreasonably long fails fast
// (triggering whatever non-fatal fallback the caller already has) instead of blocking forever.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchAllInvoices(tenantId, ifModifiedSince = undefined) {
  const allInvoices = [];
  let page = 1;
  while (true) {
    const invoices = await apiCall(tenantId, async (xero, tid) => {
      const resp = await xero.accountingApi.getInvoices(
        tid, ifModifiedSince, undefined, 'UpdatedDateUTC ASC',
        undefined, undefined, undefined, undefined,
        page, true, undefined, undefined, false
      );
      return resp.body.invoices || [];
    });
    allInvoices.push(...invoices);
    if (invoices.length < 100) break;
    page++;
    // Brief pause between pages to stay within Xero's 60 req/min rate limit
    await pageDelay();
  }
  return allInvoices;
}

// Xero's paginated list endpoint occasionally returns invoices without lineItems even with
// summaryOnly=false — a known API quirk. Fetch those individually using the IDs filter, which
// always returns full records. Batched in 100s to stay within Xero's payload limits.
async function fetchInvoicesByIds(tenantId, ids) {
  const results = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const invoices = await apiCall(tenantId, async (xero, tid) => {
      const resp = await xero.accountingApi.getInvoices(
        tid, undefined, undefined, undefined,
        batch, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, false
      );
      return resp.body.invoices || [];
    });
    results.push(...invoices);
    if (i + 100 < ids.length) await pageDelay();
  }
  return results;
}

// Xero's own per-document History log (created/approved/edited, by whom, when) — fetched ONLY for
// the handful of documents inside a suspected duplicate cluster (see excludeDuplicateDrafts),
// never for the general population: it's one API call per document, so running it for every
// invoice would burn through the 60 req/min budget on a client with thousands of them. A
// duplicate cluster is rarely more than a handful of documents.
async function fetchDocumentHistory(tenantId, invoiceId) {
  try {
    return await apiCall(tenantId, async (xero, tid) => {
      const resp = await xero.accountingApi.getInvoiceHistory(tid, invoiceId);
      return (resp.body.historyRecords || []).map(record => ({
        details: record.details, user: record.user, dateUTC: record.dateUTC,
      }));
    });
  } catch (err) {
    console.error(`Invoice history fetch failed for ${invoiceId}:`, err.message);
    return null;
  }
}

// Live-only: a cacheOnly reanalysis (e.g. previewing a different period from what's already
// cached) skips the history fetch entirely rather than hitting Xero, so those documents simply
// show without a history note until the next real sync repopulates it.
async function buildDuplicateDraftFindings(tenantId, duplicateGroups, cacheOnly) {
  const findings = [];
  for (const group of duplicateGroups) {
    for (const doc of group.documents) {
      const history = cacheOnly ? undefined : await fetchDocumentHistory(tenantId, doc.id);
      findings.push({
        id: doc.id, number: doc.reference, contact: group.contact,
        date: doc.date, total: doc.amount, status: doc.status,
        displayOnly: true,
        suspectedDuplicateOf: group.documentIds.filter(id => id !== doc.id),
        history,
      });
      if (!cacheOnly) await pageDelay();
    }
  }
  return findings;
}

// Paginated contacts fetch — Xero returns up to 100 per call, like invoices
async function fetchAllContacts(tenantId, ifModifiedSince = undefined) {
  const allContacts = [];
  let page = 1;
  while (true) {
    const contacts = await apiCall(tenantId, async (xero, tid) => {
      const resp = await xero.accountingApi.getContacts(
        tid, ifModifiedSince, undefined, 'UpdatedDateUTC ASC', undefined, page, true, false
      );
      return resp.body.contacts || [];
    });
    allContacts.push(...contacts);
    if (contacts.length < 100) break;
    page++;
    await pageDelay();
  }
  return allContacts;
}

// Paginated credit notes fetch — Xero returns up to 100 per call, like invoices
async function fetchAllCreditNotes(tenantId, ifModifiedSince = undefined) {
  const allCreditNotes = [];
  let page = 1;
  while (true) {
    const creditNotes = await apiCall(tenantId, async (xero, tid) => {
      const resp = await xero.accountingApi.getCreditNotes(
        tid, ifModifiedSince, undefined, 'UpdatedDateUTC ASC', page
      );
      return resp.body.creditNotes || [];
    });
    allCreditNotes.push(...creditNotes);
    if (creditNotes.length < 100) break;
    page++;
    await pageDelay();
  }
  return allCreditNotes;
}

async function fetchAllBankTransactions(tenantId, ifModifiedSince = undefined) {
  const rows = [];
  for (let page = 1; ; page++) {
    const batch = await apiCall(tenantId, async (xero, tid) => {
      const response = await xero.accountingApi.getBankTransactions(
        tid, ifModifiedSince, undefined, 'UpdatedDateUTC ASC', page
      );
      return response.body.bankTransactions || [];
    });
    rows.push(...batch);
    if (batch.length < 100) break;
    await pageDelay();
  }
  return rows;
}

// Manual journals aren't otherwise fetched anywhere in this sync — needed for Turnover so a
// POSTED journal line coded straight to a revenue account (e.g. Hair of the Dog's rent income)
// counts, since it never appears as an invoice, credit note, or bank transaction line.
async function fetchAllManualJournals(tenantId, ifModifiedSince = undefined) {
  const rows = [];
  for (let page = 1; ; page++) {
    const batch = await apiCall(tenantId, async (xero, tid) => {
      const resp = await xero.accountingApi.getManualJournals(
        tid, ifModifiedSince, undefined, 'UpdatedDateUTC ASC', page
      );
      return resp.body.manualJournals || [];
    });
    rows.push(...batch);
    if (batch.length < 100) break;
    await pageDelay();
  }
  return rows;
}

async function fetchAllPayments(tenantId, ifModifiedSince = undefined) {
  const rows = [];
  for (let page = 1; ; page++) {
    const batch = await apiCall(tenantId, async (xero, tid) => {
      const response = await xero.accountingApi.getPayments(
        tid, ifModifiedSince, undefined, 'UpdatedDateUTC ASC', page
      );
      return response.body.payments || [];
    });
    rows.push(...batch);
    if (batch.length < 100) break;
    await pageDelay();
  }
  return rows;
}

async function fetchAllJournals(tenantId, ifModifiedSince = undefined) {
  const rows = [];
  let offset = 0;
  while (true) {
    const batch = await apiCall(tenantId, async (xero, tid) => {
      const response = await xero.accountingApi.getJournals(tid, ifModifiedSince, offset);
      return response.body.journals || [];
    });
    rows.push(...batch);
    if (batch.length < 100) break;
    const nextOffset = Math.max(...batch.map(item => Number(item.journalNumber) || 0));
    if (nextOffset <= offset) throw new Error('Journal pagination did not advance');
    offset = nextOffset;
    await pageDelay();
  }
  return rows;
}

function incrementalSince(orgId, entityType, options) {
  if (options.cacheOnly || options.forceFullRefresh) return undefined;
  const watermark = getEntityCacheWatermark(orgId, entityType);
  if (!watermark) return undefined;
  const fullRefreshDays = Math.max(1, Number(process.env.XERO_FULL_REFRESH_DAYS) || 7);
  if (Date.now() - new Date(watermark).getTime() >= fullRefreshDays * 86400000) return undefined;
  // Overlap five minutes so updates racing a paginated fetch cannot fall between watermarks.
  return new Date(new Date(watermark).getTime() - 5 * 60 * 1000);
}

async function refreshCachedEntities(orgId, tenantId, runId, entityType, fetcher, options) {
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


// Guards against overlapping syncs for the same tenant — e.g. a second Sync click before the
// first request returns. Two concurrent syncs don't just duplicate work, they compete for the
// same Xero per-app rate limit and back off against each other, making both far slower than
// either would be alone (observed: two syncs stuck retrying together for minutes).
const syncsInProgress = new Set();

async function syncOrganisation(tenantId, progressCallback, options = {}) {
  if (syncsInProgress.has(tenantId)) {
    throw new Error('A sync is already in progress for this organisation — please wait for it to finish.');
  }
  syncsInProgress.add(tenantId);
  const existing = await getOrganisationByTenantId(tenantId);
  if (!existing) {
    syncsInProgress.delete(tenantId);
    throw new Error('Organisation not found');
  }
  const runId = await createSyncRun(existing.id, options.checkType ? `check:${options.checkType}` : 'full');
  try {
    return await runSync(tenantId, progressCallback, { ...options, runId });
  } catch (error) {
    await finishSyncRun(runId, 'failed', error.message);
    throw error;
  } finally {
    syncsInProgress.delete(tenantId);
  }
}

async function runSync(tenantId, progressCallback, options = {}) {
  const emit = progressCallback || (() => {});
  emit({ step: 'start', message: 'Starting sync...' });

  // 1. Fetch org info
  emit({ step: 'org_info', message: 'Fetching organisation info...' });
  let orgInfo;
  try {
    const existingOrg = await getOrganisationByTenantId(tenantId);
    [orgInfo] = await refreshCachedEntities(
      existingOrg.id, tenantId, options.runId, 'organisation',
      () => apiCall(tenantId, async (xero, tid) => {
      const resp = await xero.accountingApi.getOrganisations(tid);
        return resp.body.organisations || [];
      }),
      { ...options, forceFullRefresh: true }
    );
  } catch (err) {
    throw new Error(`Failed to fetch org info: ${err.message}`);
  }

  await upsertOrganisation({
    xero_tenant_id: tenantId,
    name: orgInfo.name,
    client_ref: null,
    tag: null,
    connection_status: 'connected',
    last_synced_at: null,
  });

  const org = await getOrganisationByTenantId(tenantId);
  const orgId = org.id;

  // Use the most recent lock date available (period lock moves forward monthly)
  const candidates = [
    toDateString(orgInfo.periodLockDate),
    toDateString(orgInfo.endOfYearLockDate),
  ].filter(Boolean).sort().reverse();
  const actualLockDate = candidates[0] || null;
  const period = resolvePeriod(options.period || {}, {
    lockDate: actualLockDate,
    financialYearEndDay: orgInfo.financialYearEndDay,
    financialYearEndMonth: orgInfo.financialYearEndMonth,
    asOf: options.asOf,
  });
  await updateOrganisationAccountingSettings(orgId, {
    financialYearEndDay: orgInfo.financialYearEndDay,
    financialYearEndMonth: orgInfo.financialYearEndMonth,
  });

  // Companies House refresh is informational and must never fail a sync: derive the number from
  // Xero's registrationNumber when the client hasn't set one, then refresh the register snapshot
  // only if a key is configured.
  try {
    const companyNumber = normalizeCompanyNumber(org.company_number || orgInfo.registrationNumber);
    if (companyNumber) {
      if (companyNumber !== org.company_number) await updateOrganisationCompanyNumber(orgId, companyNumber);
      const apiKey = getSetting('companies_house_api_key');
      if (apiKey) {
        emit({ step: 'companies_house', message: 'Refreshing Companies House status...' });
        let madeUpTo = null;
        try {
          const { profile, raw } = await fetchCompanyProfile(companyNumber, apiKey);
          upsertCompaniesHouseProfile(orgId, { ...profile, rawJson: JSON.stringify(raw), fetchError: null });
          madeUpTo = profile.accountsLastMadeUpTo;
        } catch (chError) {
          const existing = getCompaniesHouseProfileForOrg(orgId);
          if (!existing) {
            upsertCompaniesHouseProfile(orgId, {
              companyNumber, sicCodes: [], rawJson: null, fetchError: chError.message,
            });
          }
        }

        // Read the filed net-assets figure straight out of the filed accounts document. This is
        // the external half of opening_balance_differences: Xero cannot know what was filed, but
        // the filing itself is public and machine-readable when submitted as iXBRL. Every attempt
        // (including each failure mode) is recorded as evidence; only a positively identified
        // figure is written to filed_accounts, and never over an accountant-entered one.
        if (madeUpTo && getSetting('companies_house_filed_accounts_disabled') !== '1') {
          emit({ step: 'companies_house_accounts', message: 'Reading filed accounts for net assets...' });
          try {
            const filed = await fetchFiledNetAssets(companyNumber, apiKey, { madeUpTo });
            let applied = false;
            if (filed.value != null) {
              applied = upsertFiledAccountsFromCompaniesHouse(orgId, {
                filingDate: madeUpTo,
                madeUpTo,
                netAssets: filed.value,
                sourceNote: `Companies House ${filed.filingDescription || 'accounts'}` +
                  ` filed ${filed.filingDate || 'unknown date'}` +
                  ` (${filed.conceptLabel || 'net assets'}, ${filed.confidence} confidence)`,
                chTransactionId: filed.transactionId,
                chDocumentId: filed.documentId,
                taxonomyConcept: filed.concept,
                contextRef: filed.contextRef,
                contextDate: filed.contextDate,
                extractionMethod: filed.method,
                extractionConfidence: filed.confidence,
              });
            }
            recordFiledAccountsExtraction(orgId, {
              madeUpTo, companyNumber,
              chTransactionId: filed.transactionId, chDocumentId: filed.documentId,
              filingDate: filed.filingDate, filingDescription: filed.filingDescription,
              contentType: filed.contentType, taxonomyConcept: filed.concept,
              contextRef: filed.contextRef, contextDate: filed.contextDate,
              extractedValue: filed.value, extractionMethod: filed.method,
              extractionConfidence: filed.confidence,
              // A figure we could read but did not apply was blocked by an existing manual entry;
              // say so rather than leaving the row looking like an unexplained success.
              failureReason: filed.value != null && !applied
                ? 'not_applied_manual_entry_exists'
                : filed.reason,
              availableDates: filed.availableDates, candidates: filed.candidates,
              applied,
            });
          } catch (filedError) {
            recordFiledAccountsExtraction(orgId, {
              madeUpTo, companyNumber, failureReason: `fetch_failed: ${filedError.message}`,
              applied: false,
            });
          }
        }
      }
    }
  } catch (chOuterError) {
    console.error('Companies House refresh skipped:', chOuterError.message);
  }

  emit({ step: 'period', message: `Using ${period.label}`, period });
  const lockDate = period.start;

  const runId = options.runId;
  const issueResults = [];
  const persistIssue = issue => {
    if (options.checkType && issue.check_type !== options.checkType) return;
    const scoped = {
      // A check's own semantic label (not_configured / needs_sync / etc.) survives instead of
      // being unconditionally replaced by the sync's period key — see resolvePeriodChecked.
      ...issue, period_checked: resolvePeriodChecked(issue.period_checked, period.key),
      run_id: runId, is_active: 0,
    };
    if (options.checkType) replaceIssueForCheck(scoped);
    else insertIssueDb(scoped);
    issueResults.push(scoped);
  };
  const insertIssue = persistIssue;

  // 2. Fetch all invoice/bill/contact data upfront — avoids redundant API calls and rate limiting
  emit({ step: 'fetch_data', message: 'Fetching invoice and contact data (this may take a moment)...' });

  // Fetch sequentially to avoid API rate limiting (parallel calls exhaust Xero's 60 req/min limit).
  // NOTE: a fetch failure resolves to `null`, not `[]` — checks below must be able to tell
  // "this dataset is genuinely empty" apart from "we don't know, the fetch failed", so that a
  // failed check is skipped (shown as "Not synced") rather than silently reported as clean.
  emit({ step: 'fetch_invoices', message: 'Refreshing invoice and bill cache...' });
  const allInvoices = await refreshCachedEntities(
    orgId, tenantId, runId, 'invoice',
    since => fetchAllInvoices(tenantId, since), options
  );
  if (!options.cacheOnly) {
    const needsHydration = allInvoices.filter(i => !i.lineItems || i.lineItems.length === 0);
    if (needsHydration.length > 0) {
      emit({ step: 'hydrate_invoices', message: `Re-fetching ${needsHydration.length} invoice(s) returned without line items...` });
      const hydrated = await fetchInvoicesByIds(tenantId, needsHydration.map(i => i.invoiceID));
      mergeEntityCache(orgId, 'invoice', hydrated, { runId });
      const hydratedMap = new Map(hydrated.map(i => [i.invoiceID, i]));
      for (let idx = 0; idx < allInvoices.length; idx++) {
        const h = hydratedMap.get(allInvoices[idx].invoiceID);
        if (h) allInvoices[idx] = h;
      }
    }
  }
  const accrecAuthorised = allInvoices.filter(item =>
    item.type === 'ACCREC' && ['AUTHORISED', 'PAID'].includes(item.status)
  );
  const accpayAuthorised = allInvoices.filter(item =>
    item.type === 'ACCPAY' && ['AUTHORISED', 'PAID'].includes(item.status)
  );
  const accrecDraft = allInvoices.filter(item =>
    item.type === 'ACCREC' && ['DRAFT', 'SUBMITTED'].includes(item.status)
  );
  const accpayDraft = allInvoices.filter(item =>
    item.type === 'ACCPAY' && ['DRAFT', 'SUBMITTED'].includes(item.status)
  );

  emit({ step: 'fetch_credits', message: 'Refreshing credit note cache...' });
  const allCredits = await refreshCachedEntities(
    orgId, tenantId, runId, 'credit_note',
    since => fetchAllCreditNotes(tenantId, since), options
  );
  const salesCredits = allCredits.filter(item => item.type === 'ACCRECCREDIT');
  const purchaseCredits = allCredits.filter(item => item.type === 'ACCPAYCREDIT');

  emit({ step: 'fetch_contacts', message: 'Refreshing contact cache...' });
  const contacts = await refreshCachedEntities(
    orgId, tenantId, runId, 'contact',
    since => fetchAllContacts(tenantId, since), options
  );

  emit({ step: 'fetch_accounts', message: 'Fetching chart of accounts...' });
  // GetAccounts has no `page` parameter in the Xero API — it always returns the full chart in one call.
  const chartOfAccounts = await refreshCachedEntities(
    orgId, tenantId, runId, 'account',
    since => apiCall(tenantId, async (xero, tid) => {
      const resp = await xero.accountingApi.getAccounts(tid, since, undefined, 'Code ASC');
      return resp.body.accounts || [];
    }),
    options
  );
  const chartOfAccountsAvailable = Array.isArray(chartOfAccounts);
  // A company not registered for VAT/sales tax has no tax scheme to apply — every
  // transaction legitimately has no tax code, so "missing tax code" isn't an issue.
  const vatRegistered = !!orgInfo.salesTaxBasis && orgInfo.salesTaxBasis !== 'NONE';
  // FIXED accounts are used by low-cost fixed assets and by purchase-tax-missing: Fast Track
  // Motor Vehicles / Plant & Machinery spends without tax (5 lines / £8,485) sit in Xenon's
  // purchase-tax-missing set and closed most of that client's undercount with no regression
  // on the other four measured clients.
  const fixedAssetAccountCodes = new Set(
    (chartOfAccounts || [])
      .filter(a => a.type === 'FIXED' && (!a._class || a._class === 'ASSET'))
      .map(a => a.code)
      .filter(Boolean)
  );
  // Xenon's purchase-tax-missing doc lists prepayment accounts as in scope by default — not
  // something that needed a per-client opt-in flag. Xero's own PREPAYMENT account type identifies
  // these directly, so they're auto-included like FIXED, with the manual
  // purchase_tax_include_asset_prepayment flag left in place for any account Xero doesn't
  // classify as PREPAYMENT but the accountant wants covered anyway.
  const prepaymentAccountCodes = new Set(
    (chartOfAccounts || []).filter(a => a.type === 'PREPAYMENT').map(a => a.code).filter(Boolean)
  );
  const expenseAccountCodes = new Set((chartOfAccounts || []).filter(a => a._class === 'EXPENSE').map(a => a.code).filter(Boolean));
  const revenueAccountCodes = new Set((chartOfAccounts || []).filter(a => a._class === 'REVENUE').map(a => a.code).filter(Boolean));
  // Turnover is a stricter subset of revenueAccountCodes: Xero's UK P&L splits Class=REVENUE
  // accounts into a "Turnover" section (Type REVENUE/SALES) and a separate "Other Income"
  // section (Type OTHERINCOME) — confirmed against the practice's own client data (F2: Minga's
  // Interest Income sits in Turnover, Hair of the Dog's sits in Other Income, same account name,
  // different Type). Currency gain/loss accounts need no special exclusion here: verified live
  // against 3 real clients (Minga, Gutter Guy, Hair of the Dog) that Xero's own
  // "Realised/Unrealised Currency Gains" accounts are Type=EXPENSE, Class=EXPENSE — already
  // outside this set on their own.
  const turnoverAccountCodes = new Set(
    (chartOfAccounts || [])
      .filter(a => a._class === 'REVENUE' && ['REVENUE', 'SALES'].includes(a.type))
      .map(a => a.code)
      .filter(Boolean)
  );
  const accountNameByCode = {};
  for (const a of (chartOfAccounts || [])) if (a.code) accountNameByCode[a.code] = a.name;
  if (chartOfAccountsAvailable) upsertChartOfAccountsCache(orgId, chartOfAccounts);

  // Which accounts count as capital-item candidates is an accountant judgment call, not something
  // a keyword rule can generalize across industries (an excavation company's asset account might
  // be named "Equipment hire", which a generic rule would wrongly treat as a rental cost). Set via
  // the per-client account picker, on top of Xenon's own documented out-of-the-box defaults —
  // account codes 461 (Printing & Stationery) and 473 (Repairs & Maintenance) "if they exist" —
  // so a freshly connected client isn't stuck showing "not configured" for codes Xenon would
  // already be monitoring. See resolveCapitalReviewCandidateCodes for the opt-out tri-state.
  const accountCheckConfigurations = getAccountCheckConfigurationForOrg(orgId);
  const accountConfigByCode = new Map(accountCheckConfigurations.map(account => [account.account_code, account]));
  const capitalReviewCandidateCodes = resolveCapitalReviewCandidateCodes(
    accountCheckConfigurations, accountNameByCode, org.account_settings_initialised
  );
  // £200, not the old unexplained £500 fallback — cross-checked against the practice's own real
  // Xenon general settings (7 Sep 2026): Low Cost Assets and Capital Item Review's two default
  // accounts (Repairs & Maintenance, Printing & Stationery) all show £200, matching the sibling
  // low_cost_fixed_assets check's own hardcoded LOW_COST_THRESHOLD and MBX's independently
  // confirmed per-account £200 (XENON_PARITY_SPEC.md's "Capital settings reconstructed" entry).
  const defaultCapitalReviewThreshold = resolveCapitalReviewDefaultThreshold(
    org, parseFloat(getSetting('capital_review_threshold')) || 200
  );

  const purchaseTaxExemptOverrideCodes = new Set(
    resolvePurchaseTaxMissingExcludeCodes(org, getSetting('purchase_tax_missing_exclude_codes') || '')
      .split(',').map(s => s.trim()).filter(Boolean)
  );
  const shouldCheckPurchaseTaxAccount = accountCode => {
    const config = accountConfigByCode.get(accountCode);
    if (config?.purchase_tax_ignore) return false;
    if (config?.purchase_tax_include_asset_prepayment) return true;
    const inScope = expenseAccountCodes.has(accountCode) || fixedAssetAccountCodes.has(accountCode) ||
      prepaymentAccountCodes.has(accountCode);
    return inScope &&
      !isPurchaseTaxExemptAccount(accountNameByCode[accountCode], purchaseTaxExemptOverrideCodes, accountCode);
  };

  emit({ step: 'fetch_bank', message: 'Refreshing bank transaction cache...' });
  const allBankTransactions = await refreshCachedEntities(
    orgId, tenantId, runId, 'bank_transaction',
    since => fetchAllBankTransactions(tenantId, since), options
  );
  const bankSpendTxns = allBankTransactions.filter(item =>
    item.type === 'SPEND' && item.status === 'AUTHORISED' && isWithinPeriod(toDateString(item.date), period)
  );
  const bankReceiveTxns = allBankTransactions.filter(item =>
    item.type === 'RECEIVE' && item.status === 'AUTHORISED' && isWithinPeriod(toDateString(item.date), period)
  );

  emit({ step: 'fetch_manual_journals', message: 'Refreshing manual journal cache...' });
  const allManualJournals = await refreshCachedEntities(
    orgId, tenantId, runId, 'manual_journal',
    since => fetchAllManualJournals(tenantId, since), options
  );
  const recentManualJournals = allManualJournals.filter(item =>
    item.status === 'POSTED' && isWithinPeriod(toDateString(item.date), period)
  );

  // Cache the standard Accounting API bank-side records used for local statement matching.
  // This is evidence matching only; it must not be represented as Xero-native reconciliation.
  emit({ step: 'cache_bank_evidence', message: 'Refreshing local bank matching evidence...' });
  const matchingPayments = await refreshCachedEntities(
    orgId, tenantId, runId, 'payment',
    since => fetchAllPayments(tenantId, since), options
  );
  const bankTransfers = options.cacheOnly
    ? getCachedEntities(orgId, 'bank_transfer')
    : await apiCall(tenantId, async (xero, tid) => {
      const resp = await xero.accountingApi.getBankTransfers(tid);
      return resp.body.bankTransfers || [];
    }).then(rows => {
      mergeEntityCache(orgId, 'bank_transfer', rows, { runId, fullRefresh: true });
      return getCachedEntities(orgId, 'bank_transfer');
    });
  const cachedBankItems = [];
  // Statement matching is scoped by the STATEMENT's dates, not by the selected report period, so
  // this cache must hold every AUTHORISED bank-side record regardless of date. Building it from
  // the period-filtered pools left an imported statement outside the current period with no
  // candidates at all, and every one of its lines was then reported as unprocessed.
  //
  // Transfer legs are deliberately excluded here: getBankTransfers already contributes both sides
  // of every transfer below, and Xero additionally exposes them as SPEND-TRANSFER/RECEIVE-TRANSFER
  // bank transactions. Including both would put two identical candidates on the same real bank
  // movement, letting two different statement lines each claim one.
  const STATEMENT_MATCHABLE_BANK_TYPES = new Set([
    'SPEND', 'RECEIVE',
    'SPEND-OVERPAYMENT', 'RECEIVE-OVERPAYMENT',
    'SPEND-PREPAYMENT', 'RECEIVE-PREPAYMENT',
  ]);
  for (const txn of (allBankTransactions || [])) {
    if (txn.status !== 'AUTHORISED') continue;
    if (!STATEMENT_MATCHABLE_BANK_TYPES.has(txn.type)) continue;
    const amount = Math.abs(Number(txn.total) || 0) * (/^SPEND/.test(txn.type) ? -1 : 1);
    cachedBankItems.push({
      cacheKey: `bank:${txn.bankTransactionID}`, sourceType: 'bank_transaction',
      sourceId: txn.bankTransactionID, bankAccountId: txn.bankAccount?.accountID,
      bankAccountName: txn.bankAccount?.name, transactionDate: toDateString(txn.date), amount,
      reference: txn.reference, description: txn.contact?.name,
    });
  }
  // DELETED payments are not money that moved. 5,602 of 17,031 cached payments on the reference
  // clients are DELETED, and every one of them was previously an eligible match — a statement line
  // could be marked "processed" against a payment that no longer exists in Xero, hiding a genuine
  // unprocessed item behind a deleted record.
  for (const payment of (matchingPayments || [])) {
    if (payment.status !== 'AUTHORISED') continue;
    const outgoing = /ACCPAY|REFUND/i.test(payment.paymentType || '');
    cachedBankItems.push({
      cacheKey: `payment:${payment.paymentID}`, sourceType: 'payment', sourceId: payment.paymentID,
      bankAccountId: payment.account?.accountID, bankAccountName: payment.account?.name,
      transactionDate: toDateString(payment.date),
      amount: Math.abs(Number(payment.amount) || 0) * (outgoing ? -1 : 1),
      reference: payment.reference || payment.invoice?.invoiceNumber,
      description: payment.invoice?.contact?.name || payment.creditNote?.contact?.name,
    });
  }
  // A batch payment leaves the bank as ONE debit for the whole batch, while Xero stores it as one
  // Payment per invoice (466 batches on the reference clients, median 5 payments, largest 223).
  // Without a batch-level candidate that single statement line can never match its members, so it
  // was reported as unprocessed however completely it had actually been processed. Members are
  // kept as candidates too, because some banks itemise the batch instead — one-to-one allocation
  // then consumes whichever representation the statement actually used.
  const batchPayments = new Map();
  for (const payment of (matchingPayments || [])) {
    if (payment.status !== 'AUTHORISED') continue;
    const batch = payment.batchPayment;
    if (!batch?.batchPaymentID || batch.status !== 'AUTHORISED') continue;
    if (!batchPayments.has(batch.batchPaymentID)) batchPayments.set(batch.batchPaymentID, batch);
  }
  for (const batch of batchPayments.values()) {
    const total = Number(batch.totalAmount);
    if (!Number.isFinite(total) || total === 0) continue;
    cachedBankItems.push({
      cacheKey: `batch:${batch.batchPaymentID}`, sourceType: 'batch_payment',
      sourceId: batch.batchPaymentID, bankAccountId: batch.account?.accountID,
      bankAccountName: batch.account?.name,
      transactionDate: toDateString(batch.date),
      amount: Math.abs(total) * (batch.type === 'RECBATCH' ? 1 : -1),
      reference: batch.reference || null, description: 'Batch payment',
    });
  }
  for (const transfer of bankTransfers) {
    const date = toDateString(transfer.date);
    const amount = Math.abs(Number(transfer.amount) || 0);
    for (const side of [
      { suffix: 'from', account: transfer.fromBankAccount, amount: -amount },
      { suffix: 'to', account: transfer.toBankAccount, amount },
    ]) cachedBankItems.push({
      cacheKey: `transfer:${transfer.bankTransferID}:${side.suffix}`, sourceType: 'transfer',
      sourceId: transfer.bankTransferID, bankAccountId: side.account?.accountID,
      bankAccountName: side.account?.name, transactionDate: date, amount: side.amount,
      reference: transfer.reference, description: 'Bank transfer',
    });
  }
  replaceXeroBankItemsCache(orgId, cachedBankItems.filter(item => item.sourceId && item.bankAccountId));
  const refreshedCache = getXeroBankItemsForOrg(orgId);
  // Re-match one statement at a time. Allocation is one-to-one WITHIN a statement — that is where
  // two lines competing for one Xero record is a real error — but never across statements, so a
  // superseded re-import of the same month cannot starve the current one of its matches.
  const linesByImport = new Map();
  for (const line of getStatementLinesForOrg(orgId)) {
    if (!linesByImport.has(line.import_id)) linesByImport.set(line.import_id, []);
    linesByImport.get(line.import_id).push(line);
  }
  const rematched = [];
  for (const lines of linesByImport.values()) {
    const allocated = allocateStatementMatches(lines.map(line => ({
      id: line.id,
      transactionDate: line.transaction_date, amount: line.amount,
      reference: line.reference, description: line.description,
      bankAccountId: line.bank_account_id,
    })), refreshedCache);
    rematched.push(...allocated);
  }
  updateStatementLineMatches(orgId, rematched);

  emit({ step: 'fetch_tax_rates', message: 'Fetching tax rates...' });
  // GetTaxRates has no `page` parameter — always returns the full list in one call.
  const taxRates = await refreshCachedEntities(
    orgId, tenantId, runId, 'tax_rate',
    () => apiCall(tenantId, async (xero, tid) => {
      const resp = await xero.accountingApi.getTaxRates(tid);
      return resp.body.taxRates || [];
    }),
    { ...options, forceFullRefresh: true }
  );
  const taxRateByType = {};
  for (const t of (taxRates || [])) if (t.taxType) taxRateByType[t.taxType] = t;

  const contactsById = {};
  for (const c of (contacts || [])) if (c.contactID) contactsById[c.contactID] = c;

  console.log(`Data fetched: ${accrecAuthorised?.length ?? 'FAILED'} sales invoices, ${accpayAuthorised?.length ?? 'FAILED'} purchase bills, ${contacts?.length ?? 'FAILED'} contacts, ${chartOfAccounts?.length ?? 'FAILED'} accounts, ${bankSpendTxns?.length ?? 'FAILED'} bank spend txns, ${bankReceiveTxns?.length ?? 'FAILED'} bank receive txns, ${taxRates?.length ?? 'FAILED'} tax rates`);

  emit({ step: 'running_checks', message: 'Running bookkeeping checks...' });

  const inPeriod = items => items.filter(item => isWithinPeriod(toDateString(item.date), period));
  const sinceLD = inPeriod;
  const throughPeriodEnd = items => items.filter(item => {
    const date = toDateString(item.date);
    return date && date <= period.end;
  });

  // Track most recent transaction date from invoices.
  // Exclude future-dated invoices — a transaction dated after today is a data-entry
  // error (e.g. a fat-fingered year), not genuinely "the most recent activity", and
  // letting one through skews this stat arbitrarily far (seen in practice: a real
  // client invoice dated 2626 instead of 2026).
  let mostRecentTransaction = null;
  try {
    const todayStr = period.end;
    const invDates = accrecAuthorised
      .filter(i => i.date)
      .map(i => toDateString(i.date))
      .filter(Boolean)
      .filter(d => d <= period.end)
      .sort().reverse();
    mostRecentTransaction = invDates[0] || null;
  } catch (e) {
    console.error('mostRecentTransaction calc failed (accrecAuthorised unavailable):', e.message);
  }

  let unreconciledCount = 0;
  let lastBankReconciled = null;

  // --- CRITICAL: Bank Balance Check ---
  // This check requires EXTERNAL bank statement evidence. The Xero half is fully available and is
  // fetched below: Reports/BankSummary gives Xero's calculated closing balance per bank account.
  // What no Xero endpoint can supply is the bank's own closing balance, because that is a fact
  // about the bank rather than about the ledger — Xero's reconciliation flags say "matched to a
  // statement line inside Xero", never "settled at the bank", so the external figure cannot be
  // derived from balances, transactions or reports. It comes from a statement CSV or an
  // accountant-entered closing balance. Until one exists the check reports Not configured; it
  // must never fall back to unreconciled volume, which counted the same money twice.
  try {
    const todayStr = period.end;
    // Bank Summary needs the accounting.reports.read scope, which a connection authorised before
    // that scope was added won't carry. Refresh balances when possible, but never let it fail the
    // check — otherwise a scope gap looks identical to a sync error.
    try {
      if (options.cacheOnly) throw new Error('cache-only recalculation uses stored report balances');
      // Bank Summary rejects windows longer than 365 days. For long since-lock-date periods,
      // request the most recent year ending at the report date.
      let summaryFrom = lockDate || undefined;
      if (summaryFrom && todayStr) {
        const earliest = new Date(`${todayStr}T00:00:00Z`);
        earliest.setUTCDate(earliest.getUTCDate() - 364);
        const earliestStr = earliest.toISOString().slice(0, 10);
        if (summaryFrom < earliestStr) summaryFrom = earliestStr;
      }
      const bankSummary = await apiCall(tenantId, async (xero, tid) => {
        const resp = await xero.accountingApi.getReportBankSummary(tid, summaryFrom, todayStr);
        return resp.body.reports?.[0];
      });
      const rows = (bankSummary?.rows || []).flatMap(r => r.rowType === 'Section' ? (r.rows || []) : []);
      for (const row of rows) {
        const cells = row.cells || [];
        const accountId = cells[0]?.attributes?.find(a => a.id === 'accountID')?.value;
        const closingBalance = parseFloat(cells[4]?.value);
        if (!accountId || isNaN(closingBalance)) continue;
        upsertBankReconciliationXeroBalance(orgId, accountId, cells[0]?.value, closingBalance, todayStr);
      }
    } catch (err) {
      console.error('Bank Summary refresh failed — using stored Xero balances:', err.message || err.body?.Detail || err);
    }
    const configuredAccounts = getBankReconciliationForOrg(orgId)
      .filter(a => a.statement_balance != null && a.xero_calculated_balance != null);
    const discrepancies = configuredAccounts
      .map(a => ({
        accountId: a.bank_account_id,
        name: a.bank_account_name,
        xeroBalance: a.xero_calculated_balance,
        statementBalance: a.statement_balance,
        discrepancy: Math.abs(a.xero_calculated_balance - a.statement_balance)
      }))
      .filter(a => a.discrepancy > 0.01);
    const issue = {
      org_id: orgId, check_type: 'bank_balance', importance: 'critical',
      count: discrepancies.length,
      potential_value_gbp: discrepancies.reduce((sum, a) => sum + a.discrepancy, 0),
      detail_json: JSON.stringify(discrepancies),
      period_checked: configuredAccounts.length ? `statement_comparison_as_of_${todayStr}` : 'not_configured'
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('bank_balance check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- CRITICAL: Unreconciled Bank Items ---
  // Xenon's Unreconciled Bank report is the union of:
  //   1. AUTHORISED bank transactions with IsReconciled=false
  //   2. AUTHORISED payments with IsReconciled=false (shown as ACCRECPAYMENT / ACCPAYPAYMENT)
  // Querying IsReconciled=false alone also returns DELETED transactions (752 of 829 on a
  // reference client) which Xenon excludes — verified against Xenon's per-account CSV export
  // where AUTHORISED bank + AUTHORISED payments matched the 117 headline exactly, aside from
  // a few items posted after Xenon's snapshot.
  // Xenon scopes this to the selected period, not to all history: clients with a recent lock
  // date report 0 here while still carrying thousands of older unreconciled items, so an
  // open-ended backlog count overstates them by orders of magnitude.
  try {
    // Xenon supports excluding individual bank accounts from this check — e.g. a dormant account
    // or a PayPal-style clearing account that would otherwise generate permanent false-positive
    // noise. Organisation-scoped, so excluding one client's account can never affect another's.
    const excludedBankAccountIds = getExcludedBankAccountIds(orgId);
    const bankAccountIds = new Set((chartOfAccounts || [])
      .filter(account => account.type === 'BANK' && !excludedBankAccountIds.has(account.accountID))
      .map(account => account.accountID));
    const items = selectAuthorisedUnreconciled(allBankTransactions, matchingPayments, bankAccountIds)
      .filter(item => isWithinPeriod(toDateString(item.date), period))
      .map(item => item.source === 'bank' ? {
      id: item.bankTransactionID, date: toDateString(item.date), amount: Math.abs(item.total || 0),
      contact: item.contact?.name, type: item.type, account: item.bankAccount?.name, source: item.source
    } : {
      id: item.paymentID, date: toDateString(item.date), amount: Math.abs(item.amount || 0),
      contact: item.invoice?.contact?.name || item.creditNote?.contact?.name,
      type: item.paymentType, account: item.account?.name, source: item.source
    });
    unreconciledCount = items.length;
    const issue = {
      org_id: orgId, check_type: 'unreconciled_bank_items', importance: 'critical',
      count: unreconciledCount,
      potential_value_gbp: sumAbsoluteExposure(items),
      detail_json: JSON.stringify(items),
      period_checked: period.key
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('unreconciled_bank_items check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- HIGH: Duplicate Invoices (AUTHORISED + SUBMITTED unpaid, same calendar day) ---
  try {
    const duplicateInvoicePool = inPeriod([
      ...accrecAuthorised.filter(i => i.status === 'AUTHORISED'),
      ...accrecDraft.filter(i => i.status === 'SUBMITTED'),
    ]);
    // Xenon's documented default requires at least one unpaid invoice in a match (same as
    // duplicate_bills below) — previously missing here, so fully-paid duplicate pairs were
    // incorrectly counted as issues.
    const duplicates = findDuplicates(
      duplicateInvoicePool,
      resolveDuplicateInvoiceWindowDays(org),
      {
        requireUnpaidPair: !resolveDuplicateInvoiceIncludeFullyPaid(org),
        requireExactReference: resolveDuplicateInvoiceRequireExactReference(org),
        requireExactTotal: resolveDuplicateInvoiceRequireExactTotal(org),
      }
    );
    const issue = {
      org_id: orgId, check_type: 'duplicate_invoices', importance: 'high',
      count: duplicates.length, potential_value_gbp: sumAbsoluteExposure(duplicates),
      detail_json: JSON.stringify(duplicates),
      period_checked: period.key
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('duplicate_invoices check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- HIGH: Duplicate Bills ---
  // Pool = DRAFT + AUTHORISED + PAID (not SUBMITTED). Window = 3 days. Emit only when at
  // least one of the twin bills still has amountDue > 0. Row-exact on MBX (10/£944) and
  // 4X4 (6/£493) View Issues; Rose/Handymanz/Fast Track stay at 0.
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
    const issue = {
      org_id: orgId, check_type: 'duplicate_bills', importance: 'high',
      count: duplicates.length, potential_value_gbp: sumAbsoluteExposure(duplicates),
      detail_json: JSON.stringify(duplicates),
      period_checked: period.key
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('duplicate_bills check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- HIGH: Old Unpaid Invoices (document date older than 60 days, amountDue > 0) ---
  try {
    const asOf = new Date(`${period.end}T00:00:00.000Z`);
    const overdue = throughPeriodEnd(accrecAuthorised).filter(i =>
      (i.amountDue || 0) > 0 && isOldDocument(i, asOf)
    );
    const issue = {
      org_id: orgId, check_type: 'old_unpaid_invoices', importance: 'high',
      count: overdue.length, potential_value_gbp: sumAbsoluteExposure(overdue, i => i.amountDue),
      detail_json: JSON.stringify(overdue.map(i => ({
        id: i.invoiceID, number: i.invoiceNumber, contact: i.contact?.name,
        date: toDateString(i.date), dueDate: toDateString(i.dueDate), amountDue: i.amountDue
      }))),
      period_checked: 'document_date_over_60_days_ago_all_time'
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('old_unpaid_invoices check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- HIGH: Old Sales Credits (ACCREC, older than 60 days, unallocated) ---
  try {
    const asOf = new Date(`${period.end}T00:00:00.000Z`);
    const credits = selectOldCredits(throughPeriodEnd(salesCredits), asOf);
    const issue = {
      org_id: orgId, check_type: 'old_sales_credits', importance: 'high',
      count: credits.length, potential_value_gbp: sumAbsoluteExposure(credits, c => c.remainingCredit),
      detail_json: JSON.stringify(credits.map(c => ({
        id: c.creditNoteID, number: c.creditNoteNumber, contact: c.contact?.name,
        date: toDateString(c.date), remaining: c.remainingCredit
      }))),
      period_checked: 'older_than_60_days'
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('old_sales_credits check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- HIGH: Old Unpaid Bills (document date older than 60 days) ---
  try {
    const asOf = new Date(`${period.end}T00:00:00.000Z`);
    const overdue = throughPeriodEnd(accpayAuthorised).filter(i => isOldDocument(i, asOf) && (i.amountDue || 0) > 0);
    const issue = {
      org_id: orgId, check_type: 'old_unpaid_bills', importance: 'high',
      count: overdue.length, potential_value_gbp: sumAbsoluteExposure(overdue, i => i.amountDue),
      detail_json: JSON.stringify(overdue.map(i => ({
        id: i.invoiceID, number: i.invoiceNumber, contact: i.contact?.name,
        date: toDateString(i.date), dueDate: toDateString(i.dueDate), amountDue: i.amountDue
      }))),
      period_checked: 'document_date_over_60_days_ago'
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('old_unpaid_bills check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- HIGH: Old Purchase Credits (ACCPAY, older than 60 days, unallocated) ---
  // Xenon: AUTHORISED only (MBX: SUBMITTED+AUTH=6 vs AUTH=4=Xenon; other clients unchanged).
  try {
    const asOf = new Date(`${period.end}T00:00:00.000Z`);
    const credits = selectOldCredits(
      throughPeriodEnd(purchaseCredits).filter((c) => c.status === 'AUTHORISED'),
      asOf
    );
    const issue = {
      org_id: orgId, check_type: 'old_purchase_credits', importance: 'high',
      count: credits.length, potential_value_gbp: sumAbsoluteExposure(credits, c => c.remainingCredit),
      detail_json: JSON.stringify(credits.map(c => ({
        id: c.creditNoteID, number: c.creditNoteNumber, contact: c.contact?.name,
        date: toDateString(c.date), remaining: c.remainingCredit
      }))),
      period_checked: 'older_than_60_days'
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('old_purchase_credits check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- MEDIUM: Unapproved Invoices (since lock date to avoid historical noise) ---
  try {
    const draftInvoices = sinceLD(accrecDraft);
    const duplicateInvoiceGroups = findDuplicates(draftInvoices);
    const invoices = excludeDuplicateDrafts(draftInvoices, undefined, duplicateInvoiceGroups);
    // Excluded duplicates still appear here as displayOnly findings (zero count/value impact,
    // per addFindingKeys/allocateFindingValues) so an accountant can see *why* the number dropped
    // and — via Xero's own History log on each one — decide whether to go delete the extras.
    const duplicateInvoiceFindings = await buildDuplicateDraftFindings(
      tenantId, duplicateInvoiceGroups, Boolean(options.cacheOnly)
    );
    const issue = {
      org_id: orgId, check_type: 'unapproved_invoices', importance: 'medium',
      // Potential value is an exposure magnitude, not a net position: a negative draft (e.g. an
      // opening-balance adjustment) must add to the amount needing review, not cancel other
      // drafts out. Verified against a reference report where |-12,902.76| + 54 matched exactly.
      count: invoices.length, potential_value_gbp: sumAbsoluteExposure(invoices, i => i.total),
      detail_json: JSON.stringify([
        ...invoices.map(i => ({
          id: i.invoiceID, number: i.invoiceNumber, contact: i.contact?.name,
          date: toDateString(i.date), total: i.total, status: i.status
        })),
        ...duplicateInvoiceFindings,
      ]),
      period_checked: 'since_lock_date'
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('unapproved_invoices check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- MEDIUM: Unapproved Bills (since lock date) ---
  try {
    const draftBills = sinceLD(accpayDraft);
    const duplicateBillGroups = findDuplicates(draftBills);
    const bills = excludeDuplicateDrafts(draftBills, undefined, duplicateBillGroups);
    const duplicateBillFindings = await buildDuplicateDraftFindings(
      tenantId, duplicateBillGroups, Boolean(options.cacheOnly)
    );
    const issue = {
      org_id: orgId, check_type: 'unapproved_bills', importance: 'medium',
      count: bills.length, potential_value_gbp: sumAbsoluteExposure(bills, i => i.total),
      detail_json: JSON.stringify([
        ...bills.map(i => ({
          id: i.invoiceID, number: i.invoiceNumber, contact: i.contact?.name,
          date: toDateString(i.date), total: i.total, status: i.status
        })),
        ...duplicateBillFindings,
      ]),
      period_checked: 'since_lock_date'
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('unapproved_bills check failed — skipping (will show as "Not synced"):', err.message);
  }

  // Shared by Multi-Account Suppliers and Multi-Tax Code Suppliers below. Xenon detects these
  // patterns over the reporting period OR a trailing lookback, whichever reaches further back —
  // Xenon's own published documentation for both checks states this lookback is "3 months prior to
  // the period selected" by DEFAULT and is changeable PER CLIENT on Xenon's settings page, not a
  // fixed value. 12 months is this app's own fallback, empirically tuned against five real clients
  // before this setting existed (period alone undercounts every short-period client — Rose 24 v 37,
  // 4X4 2 v 5, Handymanz 3 v 4 — while all-time wildly overcounts them — Rose 79, 4X4 17); it
  // remains the default for any client without an explicit value so nothing already-validated
  // changes, but `supplier_pattern_lookback_months` lets a new client be set to match its own real
  // Xenon configuration instead of assuming this one guess fits everyone.
  // Multi-account and multi-tax document the identical "3 months prior, changeable per client"
  // rule, so each gets its own independently-configurable lookback column rather than sharing
  // one — widening multi-tax for a client (e.g. Handymanz to 18 months) must not also widen
  // multi-account, which is validated separately against its own 12-month default.
  const supplierPatternLookbackMonths = resolveSupplierPatternLookbackMonths(org);
  const multiAccountLookbackMonths = resolveMultiAccountPatternLookbackMonths(org);
  const multiAccountLookbackFloor = new Date(`${period.end}T00:00:00Z`);
  multiAccountLookbackFloor.setUTCMonth(multiAccountLookbackFloor.getUTCMonth() - multiAccountLookbackMonths);
  const multiAccountPatternStart = [period.start, multiAccountLookbackFloor.toISOString().slice(0, 10)]
    .filter(Boolean).sort()[0];
  const lookbackFloorDate = new Date(`${period.end}T00:00:00Z`);
  lookbackFloorDate.setUTCMonth(lookbackFloorDate.getUTCMonth() - supplierPatternLookbackMonths);
  const multiTaxPatternStart = [period.start, lookbackFloorDate.toISOString().slice(0, 10)]
    .filter(Boolean).sort()[0];
  const withinMultiAccountWindow = items => items.filter(item => {
    const date = toDateString(item.date);
    return date && date >= multiAccountPatternStart && date <= period.end;
  });
  const withinPatternWindow = items => items.filter(item => {
    const date = toDateString(item.date);
    return date && date >= multiTaxPatternStart && date <= period.end;
  });
  // Drafts are excluded: they are not posted, and including them overcounted MBX (89 v 81).
  // Purchase credit notes are included: a credit note coded to a different account (or tax code)
  // than the supplier's bills is exactly the inconsistency these checks exist to surface.
  // Confirmed on Handymanz: Plumbfix has credit notes on accounts 325 and 473, making it the 4th
  // multi-account supplier that Xenon finds but we missed when checking bills only.
  // Multi-account uses a 12-month window; multi-tax uses the configurable lookback.
  const allBillsForMultiAccount = withinMultiAccountWindow([
    ...accpayAuthorised,
    ...purchaseCredits.filter(item => ['AUTHORISED', 'PAID'].includes(item.status)),
  ]);
  const bankSpendForMultiAccount = withinMultiAccountWindow(allBankTransactions.filter(item =>
    item.type === 'SPEND' && item.status === 'AUTHORISED'
  ));
  const allBillsForSupplierChecks = withinPatternWindow([
    ...accpayAuthorised,
    ...purchaseCredits.filter(item => ['AUTHORISED', 'PAID'].includes(item.status)),
  ]);
  const bankSpendForSupplierChecks = withinPatternWindow(allBankTransactions.filter(item =>
    item.type === 'SPEND' && item.status === 'AUTHORISED'
  ));

  // grossLineAmount/netLineAmount (shared, from checkRules.js): bills here are overwhelmingly
  // Exclusive (net) while bank spend is overwhelmingly Inclusive (gross); reconstructing a
  // consistent basis per line via each transaction's own lineAmountTypes rather than trusting
  // raw lineAmount avoids mixing the two conventions together. Verified against Fast Track
  // Excavations: summing raw (mixed) lineAmount understated Xenon's Multi-Account Suppliers
  // value by 6.6%; summing gross consistently closes it to within 0.75%.

  // --- MEDIUM: Multi-Account Suppliers ---
  // Detection uses the supplier-pattern window above. The £ value stays scoped to since-lock-date
  // spend on non-dominant accounts, so extending detection never inflates the reported exposure.
  try {
    const allTime = {};
    const sinceLDByContact = {};
    // txMeta carries what the drill-down UI needs to show each underlying transaction (date,
    // reference, which account it hit, and the raw Xero id for an "Open in Xero" link) — kept
    // separate from the aggregate totals above, which drive the actual count/value calculation.
    const record = (contactId, name, lineAmount, accountCode, isSinceLD, txMeta) => {
      if (!contactId || !accountCode) return;
      if (!allTime[contactId]) allTime[contactId] = { name, accountAmounts: {}, transactions: [] };
      const amount = Math.abs(lineAmount || 0);
      allTime[contactId].accountAmounts[accountCode] = (allTime[contactId].accountAmounts[accountCode] || 0) + amount;
      allTime[contactId].transactions.push({ ...txMeta, accountCode, accountName: accountNameByCode[accountCode] || null, amount });
      if (isSinceLD) {
        if (!sinceLDByContact[contactId]) sinceLDByContact[contactId] = {};
        sinceLDByContact[contactId][accountCode] = (sinceLDByContact[contactId][accountCode] || 0) + amount;
      }
    };
    for (const bill of allBillsForMultiAccount) {
      const isSinceLD = isWithinPeriod(toDateString(bill.date), period);
      for (const line of (bill.lineItems || [])) record(
        bill.contact?.contactID, bill.contact?.name, grossLineAmount(bill.lineAmountTypes, line), line.accountCode, isSinceLD,
        { date: toDateString(bill.date), reference: bill.reference || bill.invoiceNumber || null, description: line.description || null, source: 'bill', invoiceId: bill.invoiceID }
      );
    }
    for (const txn of bankSpendForMultiAccount) {
      const isSinceLD = isWithinPeriod(toDateString(txn.date), period);
      for (const line of (txn.lineItems || [])) record(
        txn.contact?.contactID, txn.contact?.name, grossLineAmount(txn.lineAmountTypes, line), line.accountCode, isSinceLD,
        { date: toDateString(txn.date), reference: txn.reference || null, description: line.description || null, source: 'bank_spend', bankTransactionId: txn.bankTransactionID }
      );
    }
    // Xenon applies no materiality floor here: a £25 floor dropped this to 70 against its 81 on
    // the reference client and to 1 against 5 and 4 on two others. The setting stays available
    // for practices that want to suppress trivial patterns, but it is off by default.
    const multiAccountMinValue = resolveMultiAccountSuppliersMinValue(
      org, parseFloat(getSetting('multi_account_suppliers_min_value')) || 0
    );
    const multi = [];
    for (const [id, v] of Object.entries(allTime)) {
      const accountCodes = Object.keys(v.accountAmounts);
      if (accountCodes.length <= 1) continue;
      // Same listing rule as multi-tax: history may inform which accounts a supplier uses, but
      // Xenon only lists suppliers with activity inside the checked period. Rose View Issues
      // (37 names) excludes Aldi (pre-period only); requiring since-lock-date activity makes
      // Rose exact without moving 4X4/MBX/Handymanz.
      const sinceLDAmounts = sinceLDByContact[id];
      if (!sinceLDAmounts) continue;
      const dominantCode = accountCodes.reduce((a, b) => v.accountAmounts[a] >= v.accountAmounts[b] ? a : b);
      const potentialValue = Object.keys(sinceLDAmounts).reduce((s, c) => c !== dominantCode ? s + sinceLDAmounts[c] : s, 0);
      if (potentialValue < multiAccountMinValue) continue;
      const transactions = [...v.transactions].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      multi.push({ contactId: id, name: v.name, accountCodes, dominantCode, potentialValue, transactions });
    }
    const issue = {
      org_id: orgId, check_type: 'multi_account_suppliers', importance: 'medium',
      count: multi.length,
      potential_value_gbp: multi.reduce((s, m) => s + m.potentialValue, 0),
      detail_json: JSON.stringify(multi.map(m => ({ contactId: m.contactId, name: m.name, accountCodes: m.accountCodes, potentialValue: m.potentialValue, transactions: m.transactions }))),
      period_checked: `supplier_pattern_from_${multiAccountPatternStart}_value_since_lock_date`
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('multi_account_suppliers check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- MEDIUM: Multi-Tax Code Suppliers ---
  // Same detection window / value-since-lock-date split as Multi-Account Suppliers above.
  // Internal reimbursement contacts named "Mileage" / "Mileage expense" are not suppliers:
  // Handymanz flagged exactly one such contact ([NONE, INPUT2]); excluding that name pattern
  // made the client exact vs Xenon without moving Fast Track (exact) or regressing the others.
  const isMileageReimbursementContact = name => /^mileage(\s+expense)?$/i.test(String(name || '').trim());
  try {
    const allTimeTax = {};
    const sinceLDTaxByContact = {};
    const processTaxSource = (contactId, contactName, lines, isSinceLD, lineAmountTypes, txMeta) => {
      if (!contactId || isMileageReimbursementContact(contactName)) return;
      if (!allTimeTax[contactId]) allTimeTax[contactId] = { name: contactName, taxAmounts: {}, transactions: [] };
      for (const line of lines) {
        const tax = line.taxType || 'NONE';
        // A £0.00 line does not "use" a tax code — checked on the RAW line amount, before net
        // conversion below. Xenon's View Issues confirms the check itself: suppliers whose only
        // second code sits on a zero-value line (TPS Huddersfield, MANDMORELTD in 4X4) are NOT
        // flagged, while suppliers with a £0.01+ rounding line (Volkswagen) ARE. It has to run on
        // the raw amount specifically: a genuine VAT-only line (e.g. an Inclusive line with
        // lineAmount=24, taxAmount=24) nets to exactly £0 below despite being a real £24
        // transaction on a real tax code, and gating on the post-conversion net value would wrongly
        // treat that as a phantom line and silently drop the tax code it uses.
        if ((line.lineAmount || 0) === 0) continue;
        // Net (ex-VAT), not raw/mixed: a tax-code inconsistency is about the taxable base, and
        // reconstructing net per-line (via the transaction's own lineAmountTypes) rather than
        // trusting lineAmount's mixed inclusive/exclusive convention closed Fast Track Excavations
        // from +132% over Xenon's value to +2.6%.
        const amt = Math.abs(netLineAmount(lineAmountTypes, line));
        allTimeTax[contactId].taxAmounts[tax] = (allTimeTax[contactId].taxAmounts[tax] || 0) + amt;
        allTimeTax[contactId].transactions.push({
          ...txMeta, taxCode: tax, accountCode: line.accountCode,
          accountName: accountNameByCode[line.accountCode] || null,
          description: line.description || null, amount: amt,
        });
        if (isSinceLD) {
          if (!sinceLDTaxByContact[contactId]) sinceLDTaxByContact[contactId] = {};
          sinceLDTaxByContact[contactId][tax] = (sinceLDTaxByContact[contactId][tax] || 0) + amt;
        }
      }
    };
    for (const bill of allBillsForSupplierChecks) {
      const isSinceLD = isWithinPeriod(toDateString(bill.date), period);
      processTaxSource(bill.contact?.contactID, bill.contact?.name, bill.lineItems || [], isSinceLD, bill.lineAmountTypes,
        { date: toDateString(bill.date), reference: bill.reference || bill.invoiceNumber || null, source: 'bill', invoiceId: bill.invoiceID });
    }
    for (const txn of bankSpendForSupplierChecks) {
      processTaxSource(txn.contact?.contactID, txn.contact?.name, txn.lineItems || [],
        isWithinPeriod(toDateString(txn.date), period), txn.lineAmountTypes,
        { date: toDateString(txn.date), reference: txn.reference || null, source: 'bank_spend', bankTransactionId: txn.bankTransactionID });
    }
    // Same as Multi-Account Suppliers above: no floor by default.
    const multiTaxMinValue = resolveMultiTaxSuppliersMinValue(
      org, parseFloat(getSetting('multi_tax_suppliers_min_value')) || 0
    );
    const multi = [];
    for (const [id, v] of Object.entries(allTimeTax)) {
      // "No VAT" counts as a tax code: a supplier billed at 20% on some lines and no VAT on
      // others is exactly the inconsistency this check exists to surface, and treating NONE as
      // absent undercounted every client measured (Fast Track 21 v 45, Rose 1 v 28).
      const taxCodes = Object.keys(v.taxAmounts);
      if (taxCodes.length <= 1) continue;
      // Xenon looks back for tax codes ("including 3 months earlier") but only LISTS suppliers
      // that traded inside the checked period. Rose View Issues (28 names) and Handymanz View
      // Issues (7 names) both exclude pre-period-only multi-tax contacts (JS/Metis/Aldi/FORGN;
      // ebay/Pest Control). Requiring since-lock-date activity removes those false positives.
      const sinceLDAmounts = sinceLDTaxByContact[id];
      if (!sinceLDAmounts) continue;
      // Dominant = tax code with the highest total amount across the detection window
      const dominantTax = taxCodes.reduce((a, b) => v.taxAmounts[a] >= v.taxAmounts[b] ? a : b);
      // NONE stays eligible to BE the dominant code (finance/lease contacts often have NONE as
      // their largest amount — loan repayments — with VAT only on the smaller original asset
      // line), but a NONE-tax line never contributes to the £ value: it isn't a taxable-base
      // inconsistency, just a correctly VAT-free line (e.g. loan/lease repayments alongside a
      // VAT-bearing asset purchase). Excluding NONE from the value sum (keeping it for multiplicity
      // and dominant selection) closed Fast Track Excavations from +132% over Xenon's value to +2.6%.
      const nonDominantValue = Object.keys(sinceLDAmounts).reduce((s, t) => (t !== dominantTax && t !== 'NONE') ? s + sinceLDAmounts[t] : s, 0);
      if (nonDominantValue < multiTaxMinValue) continue;
      const transactions = [...v.transactions].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      multi.push({ contactId: id, name: v.name, taxCodes, dominantTax, nonDominantValue, transactions });
    }
    const issue = {
      org_id: orgId, check_type: 'multi_tax_suppliers', importance: 'medium',
      count: multi.length,
      potential_value_gbp: multi.reduce((s, m) => s + m.nonDominantValue, 0),
      detail_json: JSON.stringify(multi.map(m => ({ contactId: m.contactId, name: m.name, taxCodes: m.taxCodes, dominantTax: m.dominantTax, nonDominantValue: m.nonDominantValue, transactions: m.transactions }))),
      period_checked: `supplier_pattern_from_${multiTaxPatternStart}_value_since_lock_date`
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('multi_tax_suppliers check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- MEDIUM: Purchase Tax Missing (bills + bank spend since lock date, expense accounts only, unique txn count) ---
  try {
    if (!chartOfAccountsAvailable) throw new Error('chart of accounts unavailable this sync — cannot classify expense accounts');
    let issue;
    if (!vatRegistered) {
      // Not VAT-registered — no tax scheme applies, so a missing tax code isn't an issue.
      issue = { org_id: orgId, check_type: 'purchase_tax_missing', importance: 'medium', count: 0, potential_value_gbp: 0, detail_json: '[]', period_checked: 'not_vat_registered' };
    } else {
      const taxMissingLines = [];
      const billsToCheck = inPeriod(accpayAuthorised);
      for (const bill of billsToCheck) {
        for (const line of (bill.lineItems || [])) {
          if (
            (!line.taxType || line.taxType === 'NONE') &&
            (line.lineAmount || 0) > 0 &&
            line.accountCode && shouldCheckPurchaseTaxAccount(line.accountCode)
          ) {
            taxMissingLines.push({
              invoiceId: bill.invoiceID, contact: bill.contact?.name,
              date: toDateString(bill.date), accountCode: line.accountCode,
              description: line.description, amount: netLineAmount(bill.lineAmountTypes, line), source: 'bill'
            });
          }
        }
      }
      for (const txn of inPeriod(bankSpendTxns || [])) {
        for (const line of (txn.lineItems || [])) {
          if (
            (!line.taxType || line.taxType === 'NONE') &&
            (line.lineAmount || 0) > 0 &&
            line.accountCode && shouldCheckPurchaseTaxAccount(line.accountCode)
          ) {
            taxMissingLines.push({
              invoiceId: txn.bankTransactionID, contact: txn.contact?.name,
              date: toDateString(txn.date), accountCode: line.accountCode,
              description: line.description, amount: netLineAmount(txn.lineAmountTypes, line), source: 'bank_spend'
            });
          }
        }
      }
      issue = {
        org_id: orgId, check_type: 'purchase_tax_missing', importance: 'medium',
        // Count each offending LINE, not each distinct invoice/transaction — a bill with 5 lines
        // missing tax is 5 issues to fix, not 1 (verified against a reference client: our old
        // per-invoice count was 26 while the real per-line count was 76, even though the £ total
        // — which was already summed per-line — matched exactly).
        count: taxMissingLines.length,
        potential_value_gbp: sumAbsoluteExposure(taxMissingLines),
        detail_json: JSON.stringify(taxMissingLines),
        period_checked: period.key
      };
    }
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('purchase_tax_missing check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- MEDIUM: Sales Tax Missing (invoices + bank receipts since lock date, revenue accounts only, unique line count) ---
  try {
    if (!chartOfAccountsAvailable) throw new Error('chart of accounts unavailable this sync — cannot classify revenue accounts');
    let issue;
    if (!vatRegistered) {
      // Not VAT-registered — no tax scheme applies, so a missing tax code isn't an issue.
      issue = { org_id: orgId, check_type: 'sales_tax_missing', importance: 'medium', count: 0, potential_value_gbp: 0, detail_json: '[]', period_checked: 'not_vat_registered' };
    } else {
      const recentInvoices = sinceLD(accrecAuthorised);
      const taxMissingLines = [];
      for (const inv of recentInvoices) {
        for (const line of (inv.lineItems || [])) {
          // Only flag lines on revenue/income accounts with missing tax and positive amount
          if (
            (!line.taxType || line.taxType === 'NONE') &&
            (line.lineAmount || 0) > 0 &&
            line.accountCode && revenueAccountCodes.has(line.accountCode)
          ) {
            taxMissingLines.push({
              invoiceId: inv.invoiceID, number: inv.invoiceNumber, contact: inv.contact?.name,
              date: toDateString(inv.date), accountCode: line.accountCode,
              description: line.description, amount: netLineAmount(inv.lineAmountTypes, line), source: 'invoice'
            });
          }
        }
      }
      // Bank deposits coded straight to a revenue account bypass invoicing entirely, so they need
      // the same check purchase_tax_missing already runs against bank spend transactions — without
      // this, a client whose income mostly arrives as direct deposits (not invoices) would show as
      // clean here while genuinely missing sales tax on the bulk of its revenue.
      for (const txn of bankReceiveTxns) {
        for (const line of (txn.lineItems || [])) {
          if (
            (!line.taxType || line.taxType === 'NONE') &&
            (line.lineAmount || 0) > 0 &&
            line.accountCode && revenueAccountCodes.has(line.accountCode)
          ) {
            taxMissingLines.push({
              invoiceId: txn.bankTransactionID, contact: txn.contact?.name,
              date: toDateString(txn.date), accountCode: line.accountCode,
              description: line.description, amount: netLineAmount(txn.lineAmountTypes, line), source: 'bank_receive'
            });
          }
        }
      }
      issue = {
        org_id: orgId, check_type: 'sales_tax_missing', importance: 'medium',
        // Count each offending line, not each distinct invoice — see purchase_tax_missing above.
        count: taxMissingLines.length,
        potential_value_gbp: sumAbsoluteExposure(taxMissingLines),
        detail_json: JSON.stringify(taxMissingLines),
        period_checked: period.key
      };
    }
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('sales_tax_missing check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- MEDIUM: Capital Item Review (lines on capital-candidate accounts >= threshold since lock date) ---
  try {
    if (!chartOfAccountsAvailable) throw new Error('chart of accounts unavailable this sync — cannot classify expense accounts');
    let issue;
    if (capitalReviewCandidateCodes.size === 0) {
      // Not configured for this client yet — 0/OK would look identical to "checked, genuinely
      // clean", which is false. Distinguish it so the UI can show "Not configured" instead.
      issue = { org_id: orgId, check_type: 'capital_item_review', importance: 'medium', count: null, potential_value_gbp: 0, detail_json: '[]', period_checked: 'not_configured' };
    } else {
      const capitalItems = [];
      const billsSinceLD = inPeriod(accpayAuthorised);
      for (const bill of billsSinceLD) {
        for (const line of (bill.lineItems || [])) {
          // Xenon Capital Item Review compares net (ex-VAT). Bank SPEND lines are usually
          // Inclusive, so raw lineAmount would overstate and inflate the count.
          const amount = Math.abs(netLineAmount(bill.lineAmountTypes, line));
          const threshold = accountConfigByCode.get(line.accountCode)?.capital_review_threshold || defaultCapitalReviewThreshold;
          if (amount >= threshold && line.accountCode && capitalReviewCandidateCodes.has(line.accountCode)) {
            capitalItems.push({
              invoiceId: bill.invoiceID, contact: bill.contact?.name,
              date: toDateString(bill.date), accountCode: line.accountCode,
              description: line.description, amount
            });
          }
        }
      }
      for (const txn of inPeriod(bankSpendTxns || [])) {
        for (const line of (txn.lineItems || [])) {
          const amount = Math.abs(netLineAmount(txn.lineAmountTypes, line));
          const threshold = accountConfigByCode.get(line.accountCode)?.capital_review_threshold || defaultCapitalReviewThreshold;
          if (amount >= threshold && line.accountCode && capitalReviewCandidateCodes.has(line.accountCode)) {
            capitalItems.push({
              invoiceId: txn.bankTransactionID, contact: txn.contact?.name,
              date: toDateString(txn.date), accountCode: line.accountCode,
              description: line.description, amount, source: 'bank_spend'
            });
          }
        }
      }
      // Rose Capital Item Review lists expense-coded RECEIVE lines too (e.g. ABI overpayment
      // refunded onto 473). Net basis and the same per-account threshold still apply.
      for (const txn of bankReceiveTxns) {
        for (const line of (txn.lineItems || [])) {
          const amount = Math.abs(netLineAmount(txn.lineAmountTypes, line));
          const threshold = accountConfigByCode.get(line.accountCode)?.capital_review_threshold || defaultCapitalReviewThreshold;
          if (amount >= threshold && line.accountCode && capitalReviewCandidateCodes.has(line.accountCode)) {
            capitalItems.push({
              invoiceId: txn.bankTransactionID, contact: txn.contact?.name,
              date: toDateString(txn.date), accountCode: line.accountCode,
              description: line.description, amount, source: 'bank_receive'
            });
          }
        }
      }
      issue = {
        org_id: orgId, check_type: 'capital_item_review', importance: 'medium',
        count: capitalItems.length,
        potential_value_gbp: sumAbsoluteExposure(capitalItems),
        detail_json: JSON.stringify(capitalItems),
        period_checked: period.key
      };
    }
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('capital_item_review check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- LOW: Duplicate Contacts (strict matching — active customer/supplier contacts) ---
  try {
    const activeContacts = contacts.filter(c => c.contactStatus === 'ACTIVE' && (c.isCustomer || c.isSupplier));
    const duplicates = findDuplicateContacts(activeContacts);
    const issue = {
      org_id: orgId, check_type: 'duplicate_contacts', importance: 'low',
      count: duplicates.length, potential_value_gbp: 0,
      detail_json: JSON.stringify(duplicates),
      period_checked: 'active_customer_supplier_contacts'
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('duplicate_contacts check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- LOW: Contact Defaults (active customers or suppliers missing a default account/tax code) ---
  // Xero's Contact object has no single "defaultAccountCode" field — sales and purchases
  // defaults are separate (salesDefaultAccountCode/accountsReceivableTaxType for customers,
  // purchasesDefaultAccountCode/accountsPayableTaxType for suppliers), so each role is checked
  // against its own pair of fields rather than one that doesn't exist on the API object.
  try {
    const missing = contacts.filter(c => {
      if (c.contactStatus !== 'ACTIVE') return false;
      const missingSalesDefaults = c.isCustomer && (!c.salesDefaultAccountCode || !c.accountsReceivableTaxType);
      const missingPurchaseDefaults = c.isSupplier && (!c.purchasesDefaultAccountCode || !c.accountsPayableTaxType);
      return missingSalesDefaults || missingPurchaseDefaults;
    });
    const issue = {
      org_id: orgId, check_type: 'contact_defaults', importance: 'low',
      count: missing.length, potential_value_gbp: 0,
      detail_json: JSON.stringify(missing.map(c => ({
        id: c.contactID, name: c.name, isCustomer: c.isCustomer, isSupplier: c.isSupplier,
        salesDefaultAccountCode: c.salesDefaultAccountCode, purchasesDefaultAccountCode: c.purchasesDefaultAccountCode,
        accountsReceivableTaxType: c.accountsReceivableTaxType, accountsPayableTaxType: c.accountsPayableTaxType
      }))),
      period_checked: 'active_customers_or_suppliers'
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('contact_defaults check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- LOW: Inactive Contacts (active customer/supplier with no transaction in last 18 months) ---
  // Xenon's threshold is 18 months from sync date (confirmed from Xenon UI: "contacts that have
  // a most recent transaction of 18 months or older"). A Xenon "OK" may reflect dismissed findings
  // (the "Show dismissed" toggle hides previously reviewed contacts), not genuinely zero inactives.
  // Xero's contact.updatedDateUTC is a record-edit timestamp, not trading activity: it moves when
  // anyone touches the contact (or when a merge/bulk edit runs) and it stays stale for contacts
  // that trade through repeating invoices, so it both missed and invented inactivity. Last activity
  // is derived from the cached documents themselves; updatedDateUTC is only a fallback for contacts
  // that have never transacted, so a contact created last week is not reported as inactive.
  try {
    const lastActivityByContact = new Map();
    const activityBasisByContact = new Map();
    const noteActivity = (contactId, date, basis) => {
      if (!contactId || !date) return;
      const known = lastActivityByContact.get(contactId);
      if (known && date <= known) return;
      lastActivityByContact.set(contactId, date);
      activityBasisByContact.set(contactId, basis);
    };
    const noteDocumentActivity = document => {
      // A voided or deleted document is not trading activity — it never happened. Rose alone
      // holds 20,764 deleted documents, which would otherwise mask 20 dormant contacts.
      if (document.status === 'VOIDED' || document.status === 'DELETED') return;
      noteActivity(document.contact?.contactID, toDateString(document.date), 'last transaction');
    };
    for (const document of allInvoices) noteDocumentActivity(document);
    for (const document of allCredits) noteDocumentActivity(document);
    for (const document of allBankTransactions) noteDocumentActivity(document);
    // Settling an invoice is trading activity in its own right, and its date is independent of the
    // document's: an invoice raised just before the 12-month cutoff and paid inside it left the
    // contact looking dormant while it was actively paying down its account. Measured across five
    // reference clients this wrongly listed 34 contacts (worst case paid 5 months before the run
    // date while reported as no activity for 12+ months), and each finding row displayed the
    // document date as "last transaction", which was simply untrue. DELETED payments are excluded
    // for the same reason as voided documents — 5,602 of the 17,031 cached payments are DELETED.
    for (const payment of (matchingPayments || [])) {
      if (payment.status !== 'AUTHORISED') continue;
      const contactId = payment.invoice?.contact?.contactID ||
        payment.creditNote?.contact?.contactID ||
        payment.prepayment?.contact?.contactID ||
        payment.overpayment?.contact?.contactID;
      noteActivity(contactId, toDateString(payment.date), 'last payment');
    }

    // Xenon flags contacts with no transaction in the last 18 months (from sync date).
    // The "Show dismissed" toggle in Xenon hides previously-reviewed contacts, so a Xenon
    // "OK" for an active client may simply reflect dismissed findings, not zero inactive contacts.
    const cutoffDate = new Date(`${period.end}T00:00:00.000Z`);
    cutoffDate.setUTCMonth(cutoffDate.getUTCMonth() - 18);
    const cutoff = cutoffDate.toISOString().slice(0, 10);
    const inactive = [];
    for (const contact of contacts) {
      if (contact.contactStatus !== 'ACTIVE') continue;
      if (!contact.isCustomer && !contact.isSupplier) continue;
      const lastTransaction = lastActivityByContact.get(contact.contactID) || null;
      const lastSeen = lastTransaction || toDateString(contact.updatedDateUTC);
      if (!lastSeen || lastSeen >= cutoff) continue;
      inactive.push({
        id: contact.contactID, name: contact.name,
        lastTransaction: lastTransaction || 'Never',
        basis: lastTransaction
          ? activityBasisByContact.get(contact.contactID)
          : 'contact record (no transactions)'
      });
    }
    const issue = {
      org_id: orgId, check_type: 'inactive_contacts', importance: 'low',
      count: inactive.length, potential_value_gbp: 0,
      detail_json: JSON.stringify(inactive),
      period_checked: `no_transaction_in_18_months_before_${period.end}`
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('inactive_contacts check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- MEDIUM: Low Cost Fixed Assets (fixed-asset-coded lines <= £200 since lock date) ---
  try {
    if (!chartOfAccountsAvailable) throw new Error('chart of accounts unavailable this sync — cannot classify fixed asset accounts');
    const LOW_COST_THRESHOLD = 200;
    const lowCostItems = [];
    const billsSinceLD = inPeriod(accpayAuthorised);
    for (const bill of billsSinceLD) {
      for (const line of (bill.lineItems || [])) {
        // Xenon describes and reports this threshold on net (ex-VAT) value. Xero's lineAmount is
        // mixed: Inclusive documents carry gross here, while Exclusive documents carry net.
        const amount = Math.abs(netLineAmount(bill.lineAmountTypes, line));
        if (amount > 0 && amount <= LOW_COST_THRESHOLD && line.accountCode && fixedAssetAccountCodes.has(line.accountCode)) {
          lowCostItems.push({
            invoiceId: bill.invoiceID, contact: bill.contact?.name,
            date: toDateString(bill.date), accountCode: line.accountCode,
            description: line.description, amount
          });
        }
      }
    }
    for (const txn of inPeriod(bankSpendTxns || [])) {
      for (const line of (txn.lineItems || [])) {
        const amount = Math.abs(netLineAmount(txn.lineAmountTypes, line));
        if (amount > 0 && amount <= LOW_COST_THRESHOLD && line.accountCode && fixedAssetAccountCodes.has(line.accountCode)) {
          lowCostItems.push({
            invoiceId: txn.bankTransactionID, contact: txn.contact?.name,
            date: toDateString(txn.date), accountCode: line.accountCode,
            description: line.description, amount, source: 'bank_spend'
          });
        }
      }
    }
    const issue = {
      org_id: orgId, check_type: 'low_cost_fixed_assets', importance: 'medium',
      count: lowCostItems.length,
      potential_value_gbp: sumAbsoluteExposure(lowCostItems),
      detail_json: JSON.stringify(lowCostItems),
      period_checked: `fixed_asset_accounts_lte_${LOW_COST_THRESHOLD}_since_lock_date`
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('low_cost_fixed_assets check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- MEDIUM: Misallocated Items (lines on vaguely-named accounts >= threshold since lock date) ---
  try {
    if (!chartOfAccountsAvailable) throw new Error('chart of accounts unavailable this sync — cannot classify accounts');
    const VAGUE_ACCOUNT_NAME = /\b(general|miscellaneous|misc|sundry|other|various)\b/i;
    const defaultMisallocatedThreshold = resolveMisallocatedItemsDefaultThreshold(
      org, parseFloat(getSetting('misallocated_items_threshold')) || 100
    );
    const configuredMisallocatedCodes = accountCheckConfigurations
      .filter(account => account.monitor_misallocated)
      .map(account => account.account_code);
    // Xenon's Misallocated Items documentation covers four sources: Supplier Bill Line Items,
    // Customer Invoice Line Items, Money Out, and Money In — this previously only ever checked the
    // first and third (bills + Money Out), a confirmed coverage gap. An explicit accountant
    // configuration (monitor_misallocated ticked on a specific account) applies to whichever side
    // that account is naturally used on, so both sides share the SAME configured list unfiltered;
    // only the "nothing configured" vague-name fallback is split by account class, so the fallback
    // change here is purely additive for a never-configured client — expense-side detection on
    // bills/Money Out is completely unchanged, and revenue-side vague accounts (e.g. "Other Income")
    // are now ALSO monitored on invoices/Money In where they were never checked before.
    const monitoredExpenseCodes = new Set(configuredMisallocatedCodes.length
      ? configuredMisallocatedCodes
      : [...expenseAccountCodes].filter(code => VAGUE_ACCOUNT_NAME.test(accountNameByCode[code])));
    const monitoredRevenueCodes = new Set(configuredMisallocatedCodes.length
      ? configuredMisallocatedCodes
      : [...revenueAccountCodes].filter(code => VAGUE_ACCOUNT_NAME.test(accountNameByCode[code])));
    const getThresholdForAccount = code =>
      accountConfigByCode.get(code)?.misallocated_threshold || defaultMisallocatedThreshold;
    const misallocated = [
      ...findMisallocatedLines(inPeriod(accpayAuthorised), monitoredExpenseCodes, getThresholdForAccount, 'bill'),
      ...findMisallocatedLines(inPeriod(accrecAuthorised), monitoredRevenueCodes, getThresholdForAccount, 'invoice'),
      ...findMisallocatedLines(inPeriod(bankSpendTxns || []), monitoredExpenseCodes, getThresholdForAccount, 'bank_spend'),
      ...findMisallocatedLines(inPeriod(bankReceiveTxns || []), monitoredRevenueCodes, getThresholdForAccount, 'bank_receive'),
    ];
    const issue = {
      org_id: orgId, check_type: 'misallocated_items', importance: 'medium',
      count: misallocated.length,
      potential_value_gbp: sumAbsoluteExposure(misallocated),
      detail_json: JSON.stringify(misallocated),
      period_checked: configuredMisallocatedCodes.length
        ? 'configured_accounts_and_thresholds_since_lock_date'
        : `vague_account_fallback_gte_${defaultMisallocatedThreshold}_since_lock_date`
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('misallocated_items check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- MEDIUM: Unexpected Account Used (line's account differs from the contact's own default) ---
  // Only checked when the contact HAS a default set — a missing default is contact_defaults' job,
  // not this check's, so the two don't double-flag the same root cause.
  try {
    const unexpectedAccount = [];
    const billsSinceLD = inPeriod(accpayAuthorised);
    for (const { document: bill, line, expected } of findUnexpectedDefaultLines(
      billsSinceLD, contactsById, 'purchasesDefaultAccountCode', 'accountCode'
    )) {
      unexpectedAccount.push({
        contactId: bill.contact?.contactID, contact: bill.contact?.name,
        date: toDateString(bill.date), accountCode: line.accountCode,
        expectedAccountCode: expected,
        description: line.description, amount: Math.abs(netLineAmount(bill.lineAmountTypes, line)), source: 'bill'
      });
    }
    const invoicesSinceLD = sinceLD(accrecAuthorised);
    for (const inv of invoicesSinceLD) {
      const contact = contactsById[inv.contact?.contactID];
      if (!contact?.salesDefaultAccountCode) continue;
      for (const line of (inv.lineItems || [])) {
        if (line.accountCode && line.accountCode !== contact.salesDefaultAccountCode) {
          unexpectedAccount.push({
            contactId: inv.contact?.contactID, contact: inv.contact?.name,
            date: toDateString(inv.date), accountCode: line.accountCode,
            expectedAccountCode: contact.salesDefaultAccountCode,
            description: line.description, amount: Math.abs(netLineAmount(inv.lineAmountTypes, line)), source: 'invoice'
          });
        }
      }
    }
    for (const txn of inPeriod(bankSpendTxns || [])) {
      const contact = contactsById[txn.contact?.contactID];
      if (!contact?.purchasesDefaultAccountCode) continue;
      for (const line of (txn.lineItems || [])) {
        if (line.accountCode && line.accountCode !== contact.purchasesDefaultAccountCode) {
          unexpectedAccount.push({
            contactId: txn.contact?.contactID, contact: txn.contact?.name,
            date: toDateString(txn.date), accountCode: line.accountCode,
            expectedAccountCode: contact.purchasesDefaultAccountCode,
            description: line.description, amount: Math.abs(netLineAmount(txn.lineAmountTypes, line)), source: 'bank_spend'
          });
        }
      }
    }
    for (const txn of bankReceiveTxns) {
      const contact = contactsById[txn.contact?.contactID];
      if (!contact?.salesDefaultAccountCode) continue;
      for (const line of (txn.lineItems || [])) {
        if (line.accountCode && line.accountCode !== contact.salesDefaultAccountCode) {
          unexpectedAccount.push({
            contactId: txn.contact?.contactID, contact: txn.contact?.name,
            date: toDateString(txn.date), accountCode: line.accountCode,
            expectedAccountCode: contact.salesDefaultAccountCode,
            description: line.description, amount: Math.abs(netLineAmount(txn.lineAmountTypes, line)), source: 'bank_receive'
          });
        }
      }
    }
    const issue = {
      org_id: orgId, check_type: 'unexpected_account_used', importance: 'medium',
      count: unexpectedAccount.length,
      potential_value_gbp: sumAbsoluteExposure(unexpectedAccount),
      detail_json: JSON.stringify(unexpectedAccount),
      period_checked: period.key
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('unexpected_account_used check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- MEDIUM: Unexpected Tax Code Used (line's tax type differs from the contact's own default) ---
  try {
    const unexpectedTax = [];
    const billsSinceLD = inPeriod(accpayAuthorised);
    for (const { document: bill, line, expected } of findUnexpectedDefaultLines(
      billsSinceLD, contactsById, 'accountsPayableTaxType', 'taxType'
    )) {
      unexpectedTax.push({
        contactId: bill.contact?.contactID, contact: bill.contact?.name,
        date: toDateString(bill.date), taxType: line.taxType,
        expectedTaxType: expected,
        description: line.description, amount: Math.abs(netLineAmount(bill.lineAmountTypes, line)), source: 'bill'
      });
    }
    const invoicesSinceLD = sinceLD(accrecAuthorised);
    for (const inv of invoicesSinceLD) {
      const contact = contactsById[inv.contact?.contactID];
      if (!contact?.accountsReceivableTaxType) continue;
      for (const line of (inv.lineItems || [])) {
        if (line.taxType && line.taxType !== contact.accountsReceivableTaxType) {
          unexpectedTax.push({
            contactId: inv.contact?.contactID, contact: inv.contact?.name,
            date: toDateString(inv.date), taxType: line.taxType,
            expectedTaxType: contact.accountsReceivableTaxType,
            description: line.description, amount: Math.abs(netLineAmount(inv.lineAmountTypes, line)), source: 'invoice'
          });
        }
      }
    }
    for (const txn of inPeriod(bankSpendTxns || [])) {
      const contact = contactsById[txn.contact?.contactID];
      if (!contact?.accountsPayableTaxType) continue;
      for (const line of (txn.lineItems || [])) {
        if (line.taxType && line.taxType !== contact.accountsPayableTaxType) {
          unexpectedTax.push({
            contactId: txn.contact?.contactID, contact: txn.contact?.name,
            date: toDateString(txn.date), taxType: line.taxType,
            expectedTaxType: contact.accountsPayableTaxType,
            description: line.description, amount: Math.abs(netLineAmount(txn.lineAmountTypes, line)), source: 'bank_spend'
          });
        }
      }
    }
    for (const txn of bankReceiveTxns) {
      const contact = contactsById[txn.contact?.contactID];
      if (!contact?.accountsReceivableTaxType) continue;
      for (const line of (txn.lineItems || [])) {
        if (line.taxType && line.taxType !== contact.accountsReceivableTaxType) {
          unexpectedTax.push({
            contactId: txn.contact?.contactID, contact: txn.contact?.name,
            date: toDateString(txn.date), taxType: line.taxType,
            expectedTaxType: contact.accountsReceivableTaxType,
            description: line.description, amount: Math.abs(netLineAmount(txn.lineAmountTypes, line)), source: 'bank_receive'
          });
        }
      }
    }
    const issue = {
      org_id: orgId, check_type: 'unexpected_tax_code_used', importance: 'medium',
      count: unexpectedTax.length,
      potential_value_gbp: sumAbsoluteExposure(unexpectedTax),
      detail_json: JSON.stringify(unexpectedTax),
      period_checked: period.key
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('unexpected_tax_code_used check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- MEDIUM: Invoice or Direct (bank deposit coded to income where a same-contact unpaid
  // invoice of the same amount exists no more than 30 days before the deposit) ---
  try {
    // Draft/submitted invoices are always outstanding (amountDue == total while unapproved) and
    // are a common real match here: an invoice left in draft while the customer's payment was
    // instead coded straight to income as a raw deposit.
    const unpaidInvoices = [...accrecAuthorised.filter(i => (i.amountDue || 0) > 0), ...accrecDraft];
    const matches = findDirectMatches(bankReceiveTxns, unpaidInvoices, revenueAccountCodes)
      .map(({ transaction, document }) => ({
        bankTransactionId: transaction.bankTransactionID, contact: transaction.contact?.name,
        date: toDateString(transaction.date), amount: transaction.total,
        invoiceId: document.invoiceID, invoiceNumber: document.invoiceNumber
      }));
    const issue = {
      org_id: orgId, check_type: 'invoice_or_direct', importance: 'medium',
      count: matches.length,
      potential_value_gbp: sumAbsoluteExposure(matches),
      detail_json: JSON.stringify(matches),
      period_checked: 'since_lock_date'
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('invoice_or_direct check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- MEDIUM: Bill or Direct (bank payment coded to expense where a same-contact unpaid
  // AUTHORISED or DRAFT bill of the same amount exists no more than 30 days before the payment).
  // Validated against Xenon's full MBX row list: DRAFT bills are included, SUBMITTED are not,
  // and pairing is one-to-one (handled inside findDirectMatches).
  try {
    const unpaidBills = [
      ...accpayAuthorised.filter(i => i.status === 'AUTHORISED' && (i.amountDue || 0) > 0),
      ...accpayDraft.filter(i => i.status === 'DRAFT'),
    ];
    const matches = findDirectMatches(inPeriod(bankSpendTxns || []), unpaidBills, expenseAccountCodes)
      .map(({ transaction, document }) => ({
        bankTransactionId: transaction.bankTransactionID, contact: transaction.contact?.name,
        date: toDateString(transaction.date), amount: transaction.total,
        invoiceId: document.invoiceID, invoiceNumber: document.invoiceNumber
      }));
    const issue = {
      org_id: orgId, check_type: 'bill_or_direct', importance: 'medium',
      count: matches.length,
      potential_value_gbp: sumAbsoluteExposure(matches),
      detail_json: JSON.stringify(matches),
      period_checked: 'since_lock_date'
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('bill_or_direct check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- MEDIUM: Undocumented Bills (no attachment on AUTHORISED unpaid/open bills) ---
  // Paid bills are excluded — Xenon reports 0 for Handymanz while a single PAID bill without
  // an attachment would otherwise keep this permanently non-zero.
  try {
    const billsSinceLD = inPeriod(accpayAuthorised).filter(b => b.status === 'AUTHORISED');
    const undocumented = billsSinceLD.filter(b => !b.hasAttachments);
    const issue = {
      org_id: orgId, check_type: 'undocumented_bills', importance: 'medium',
      count: undocumented.length, potential_value_gbp: 0,
      detail_json: JSON.stringify(undocumented.map(b => ({
        invoiceId: b.invoiceID, number: b.invoiceNumber, contact: b.contact?.name,
        date: toDateString(b.date), total: b.total
      }))),
      period_checked: 'since_lock_date'
    };
    insertIssue(issue); issueResults.push(issue);
  } catch (err) {
    console.error('undocumented_bills check failed — skipping (will show as "Not synced"):', err.message);
  }

  // --- MEDIUM: Sales Tax on Bills / Purchase Tax on Invoices (wrong-direction tax code) ---
  // Uses each TaxRate's canApplyToRevenue/canApplyToExpenses flags to tell a sales-only code
  // from a purchase-only one — a tax type valid for both (or neither, e.g. "NONE") isn't an error.
  // A bill/invoice is definitionally an expenditure/income document, so any line on it with the
  // wrong-direction tax code is worth flagging regardless of which account it's coded to (e.g. a
  // supplier discount booked to a revenue account with a sales tax code is still a bill-side
  // miscoding). Bank SPEND/RECEIVE observations are retained for display but are optional and
  // therefore do not affect the headline count, exposure, or health score.
  // The financial-impact figure is the line's tax amount (the actual VAT put at risk), not its
  // net value — the error here is which tax rate applied, not the size of the transaction.
  try {
    if (!taxRates) throw new Error('tax rates unavailable this sync — cannot classify tax code direction');
    if (!chartOfAccountsAvailable) throw new Error('chart of accounts unavailable this sync — cannot classify account direction');
    const salesOnlyTaxTypes = new Set(Object.values(taxRateByType).filter(t => t.canApplyToRevenue && !t.canApplyToExpenses).map(t => t.taxType));
    const purchaseOnlyTaxTypes = new Set(Object.values(taxRateByType).filter(t => t.canApplyToExpenses && !t.canApplyToRevenue).map(t => t.taxType));

    const salesTaxOnBills = [];
    const salesTaxOnBankSpend = [];
    const billsSinceLD = inPeriod(accpayAuthorised);
    for (const bill of billsSinceLD) {
      for (const line of (bill.lineItems || [])) {
        if (line.taxType && salesOnlyTaxTypes.has(line.taxType)) {
          salesTaxOnBills.push({
            invoiceId: bill.invoiceID, contact: bill.contact?.name,
            date: toDateString(bill.date), taxType: line.taxType, accountCode: line.accountCode,
            description: line.description, amount: line.taxAmount, source: 'bill'
          });
        }
      }
    }
    for (const txn of bankSpendTxns) {
      for (const line of (txn.lineItems || [])) {
        if (line.taxType && salesOnlyTaxTypes.has(line.taxType) && line.accountCode && expenseAccountCodes.has(line.accountCode)) {
          salesTaxOnBankSpend.push({
            invoiceId: txn.bankTransactionID, contact: txn.contact?.name,
            date: toDateString(txn.date), taxType: line.taxType, accountCode: line.accountCode,
            description: line.description, amount: line.taxAmount, source: 'bank_spend'
          });
        }
      }
    }
    const salesTaxOnBillsResult = withDisplayOnlyBankFindings(salesTaxOnBills, salesTaxOnBankSpend);
    insertIssue({
      org_id: orgId, check_type: 'sales_tax_on_bills', importance: 'medium',
      count: salesTaxOnBillsResult.count,
      potential_value_gbp: salesTaxOnBillsResult.potentialValue,
      detail_json: JSON.stringify(salesTaxOnBillsResult.details),
      period_checked: 'since_lock_date'
    });
    issueResults.push({ check_type: 'sales_tax_on_bills', importance: 'medium', count: salesTaxOnBillsResult.count, potential_value_gbp: salesTaxOnBillsResult.potentialValue });

    const purchaseTaxOnInvoices = [];
    const purchaseTaxOnBankReceive = [];
    const invoicesSinceLD = sinceLD(accrecAuthorised);
    for (const inv of invoicesSinceLD) {
      for (const line of (inv.lineItems || [])) {
        if (line.taxType && purchaseOnlyTaxTypes.has(line.taxType)) {
          purchaseTaxOnInvoices.push({
            invoiceId: inv.invoiceID, contact: inv.contact?.name,
            date: toDateString(inv.date), taxType: line.taxType, accountCode: line.accountCode,
            description: line.description, amount: line.taxAmount, source: 'invoice'
          });
        }
      }
    }
    for (const txn of bankReceiveTxns) {
      for (const line of (txn.lineItems || [])) {
        if (line.taxType && purchaseOnlyTaxTypes.has(line.taxType) && line.accountCode && revenueAccountCodes.has(line.accountCode)) {
          purchaseTaxOnBankReceive.push({
            invoiceId: txn.bankTransactionID, contact: txn.contact?.name,
            date: toDateString(txn.date), taxType: line.taxType, accountCode: line.accountCode,
            description: line.description, amount: line.taxAmount, source: 'bank_receive'
          });
        }
      }
    }
    const purchaseTaxOnInvoicesResult = withDisplayOnlyBankFindings(purchaseTaxOnInvoices, purchaseTaxOnBankReceive);
    insertIssue({
      org_id: orgId, check_type: 'purchase_tax_on_invoices', importance: 'medium',
      count: purchaseTaxOnInvoicesResult.count,
      potential_value_gbp: purchaseTaxOnInvoicesResult.potentialValue,
      detail_json: JSON.stringify(purchaseTaxOnInvoicesResult.details),
      period_checked: 'since_lock_date'
    });
    issueResults.push({ check_type: 'purchase_tax_on_invoices', importance: 'medium', count: purchaseTaxOnInvoicesResult.count, potential_value_gbp: purchaseTaxOnInvoicesResult.potentialValue });
  } catch (err) {
    console.error('sales_tax_on_bills/purchase_tax_on_invoices check failed — skipping (will show as "Not synced"):', err.message);
  }

  // Refresh statement-date Xero balances and filed-account comparisons, then derive the local
  // evidence checks. Missing Xero reports remain "needs sync", never a false clean result.
  if (!options.cacheOnly) for (const statement of getLatestStatementImportsForOrg(orgId)) {
    try {
      const bankSummary = await apiCall(tenantId, async (xero, tid) => {
        const response = await xero.accountingApi.getReportBankSummary(
          tid, statement.statement_start_date, statement.statement_end_date
        );
        return response.body.reports?.[0];
      });
      const rows = (bankSummary?.rows || []).flatMap(row => row.rowType === 'Section' ? (row.rows || []) : []);
      for (const row of rows) {
        const cells = row.cells || [];
        const accountId = cells[0]?.attributes?.find(attribute => attribute.id === 'accountID')?.value;
        const closingBalance = Number(String(cells[4]?.value || '').replace(/,/g, ''));
        if (accountId === statement.bank_account_id && Number.isFinite(closingBalance)) {
          upsertBankReconciliationXeroBalance(
            orgId, accountId, cells[0]?.value, closingBalance, statement.statement_end_date
          );
        }
      }
    } catch (error) {
      console.error(`Statement-date Bank Summary failed for ${statement.statement_end_date}:`, error.message);
    }
  }
  if (!options.cacheOnly) for (const filed of getFiledAccountsForOrg(orgId)) {
    try {
      const report = await apiCall(tenantId, async (xero, tid) => {
        const response = await xero.accountingApi.getReportBalanceSheet(tid, filed.filing_date);
        return response.body.reports?.[0];
      });
      const netAssets = extractNetAssetsFromBalanceSheet(report);
      // Written even when null IF we're confident there's genuinely no bookkeeping at this date —
      // that's what separates "nothing to compare" from "not synced yet". But null can also mean
      // extraction just failed this one time (no Net Assets row found, an unparseable value, an
      // occasional different report shape) — that case must NOT overwrite a previously-good
      // figure, or a single transient miss permanently breaks a working comparison with no way to
      // self-heal (the per-check Reanalyse button intentionally can't re-run this fetch).
      if (netAssets != null || !balanceSheetHoldsBookkeeping(report)) {
        updateFiledAccountsXeroBalance(orgId, filed.filing_date, netAssets);
      }
    } catch (error) {
      console.error(`Filed-account Balance Sheet failed for ${filed.filing_date}:`, error.message);
    }
  }
  await recomputeEvidenceIssues(orgId, period.key, options.checkType || null, {
    runId, isActive: 0, deferScoreRefresh: true,
  });

  // 3. Calculate health score
  emit({ step: 'score', message: 'Calculating health score...' });
  // Read back normalized results after persistent review states have been applied by insertIssue.
  // This also guarantees display-only observations never affect totals or scoring.
  const reviewedIssues = getIssuesForRun(orgId, runId, options.checkType || null);
  const scoreBreakdown = calculateScoreBreakdown(
    getScoringObservationsForRun(orgId, runId, options.checkType || null), {
      nonScoredChecks: NON_SCORED_CHECKS,
      asOf: new Date(`${period.end}T00:00:00.000Z`),
    });
  const score = scoreBreakdown.score;
  // Exclude non-scored checks from totals (Xenon shows these separately with N/A count)
  const totalIssues = reviewedIssues
    .filter(i => !NON_SCORED_CHECKS.includes(i.check_type))
    .reduce((s, i) => s + (i.count || 0), 0);
  const totalPotentialErrors = reviewedIssues
    .filter(i => !NON_SCORED_CHECKS.includes(i.check_type))
    .reduce((s, i) => s + (i.potential_value_gbp || 0), 0);

  // A checkType-scoped run recomputes only ONE check; the health_scores row's period fields
  // describe what period the dashboard AS A WHOLE currently reflects, and only a full sync
  // actually brings every check current for a new period. Persisting the reanalysed check's own
  // period here would mark the whole dashboard "current" for a period only one check actually
  // reflects — the stale-period banner (org.period_key !== selectedPeriod.key) would then read
  // false, and every other still-stale check would look up to date. Preserve the previously
  // active period instead; only a full sync (no checkType) is allowed to move it forward. Falls
  // back to this run's own period if there is no previous health score yet (first-ever sync).
  const persistedPeriod = options.checkType && org.period_key
    ? { key: org.period_key, type: org.period_type, start: org.period_start, end: org.period_end, label: org.period_label }
    : { key: period.key, type: period.type, start: period.start, end: period.end, label: period.label };

  await upsertHealthScore(orgId, {
    score, total_issues: totalIssues, total_potential_errors_gbp: totalPotentialErrors,
    last_bank_reconciled: lastBankReconciled,
    most_recent_transaction: mostRecentTransaction,
    unreconciled_bank_items: reviewedIssues.find(i => i.check_type === 'unreconciled_bank_items')?.count || 0,
    lock_date: actualLockDate,
    period_key: persistedPeriod.key,
    period_type: persistedPeriod.type,
    period_start: persistedPeriod.start,
    period_end: persistedPeriod.end,
    period_label: persistedPeriod.label,
    score_profile_version: scoreBreakdown.profileVersion,
    score_breakdown_json: JSON.stringify(scoreBreakdown),
    run_id: runId,
    is_active: 0,
  });

  // 4. Fetch transaction counts for the selected report period
  emit({ step: 'transaction_counts', message: 'Calculating transaction counts...' });
  try {
    // Counts reuse the same cache snapshot fetched for checks.
    const allAccrec = allInvoices.filter(item =>
      item.type === 'ACCREC' && ['AUTHORISED', 'PAID', 'VOIDED'].includes(item.status)
    );
    const allAccpay = allInvoices.filter(item =>
      item.type === 'ACCPAY' && ['AUTHORISED', 'PAID', 'VOIDED'].includes(item.status)
    );

    const recentAccrec = inPeriod(allAccrec);
    const recentAccpay = inPeriod(allAccpay);
    const recentSalesCN = inPeriod(salesCredits)
      .filter(c => c.status === 'AUTHORISED' || c.status === 'PAID' || c.status === 'VOIDED');
    const recentPurchaseCN = inPeriod(purchaseCredits)
      .filter(c => c.status === 'AUTHORISED' || c.status === 'PAID' || c.status === 'VOIDED');

    // Turnover: net-of-VAT, base-currency total of every posting to a Turnover-section account
    // (Class=REVENUE, Type in REVENUE/SALES — see turnoverAccountCodes above) across invoices,
    // credit notes, revenue-coded bank lines and manual journals — not just summed invoice
    // totals. A prior investigation (Turnover Mismatch handover doc, 24 Sep 2026) found the old
    // invoice-only SubTotal sum wrong on 3/3 real clients checked: it missed non-invoice revenue
    // entirely (Gutter Guy: £0 vs Xero's £85,840.34, 100% booked via bank Receive Money), counted
    // foreign-currency invoices at face value instead of base currency (Minga: +£32,781.33), and
    // never netted sales credit notes (Minga: CN-251 £5,166 left in). See F1-F12/RC1-RC4 in that
    // document for the full evidence trail.
    const netAmountBase = (line, doc) => {
      const net = doc.lineAmountTypes === 'Inclusive'
        ? (line.lineAmount || 0) - (line.taxAmount || 0)
        : (line.lineAmount || 0);
      // ManualJournalLine carries no CurrencyRate — Xero manual journals are always base currency.
      return net / (doc.currencyRate || 1);
    };
    const turnoverLineAmount = (line, doc) =>
      (line.accountCode && turnoverAccountCodes.has(line.accountCode)) ? netAmountBase(line, doc) : 0;

    let turnover = 0;
    for (const inv of recentAccrec.filter(i => i.status === 'AUTHORISED' || i.status === 'PAID')) {
      for (const line of (inv.lineItems || [])) turnover += turnoverLineAmount(line, inv);
    }
    // Credit notes reverse revenue on the accounts they're coded to (RC3) — subtracted, not ignored.
    for (const cn of recentSalesCN.filter(c => c.status === 'AUTHORISED' || c.status === 'PAID')) {
      for (const line of (cn.lineItems || [])) turnover -= turnoverLineAmount(line, cn);
    }
    // A RECEIVE bank line coded to a revenue account is a cash sale, just as valid as an invoice
    // (F6: Gutter Guy books 100% of its revenue this way and has zero invoices).
    for (const bt of bankReceiveTxns) {
      for (const line of (bt.lineItems || [])) turnover += turnoverLineAmount(line, bt);
    }
    // A SPEND line on a revenue account is a refund/contra against a cash sale — deducted.
    for (const bt of bankSpendTxns) {
      for (const line of (bt.lineItems || [])) turnover -= turnoverLineAmount(line, bt);
    }
    // A POSTED manual journal line to a revenue account is revenue (F8: Hair of the Dog's £12,000
    // rent journal). ManualJournalLine.LineAmount is signed debit-positive/credit-negative, so a
    // credit (negative) to a revenue account must increase turnover: contribution = -LineAmount.
    for (const mj of recentManualJournals) {
      for (const line of (mj.journalLines || [])) {
        if (!line.accountCode || !turnoverAccountCodes.has(line.accountCode)) continue;
        const net = mj.lineAmountTypes === 'Inclusive'
          ? (line.lineAmount || 0) - (line.taxAmount || 0)
          : (line.lineAmount || 0);
        turnover += -net;
      }
    }

    // Cross-check against Xero's own P&L for the same period — this is what a client's accountant
    // actually sees, so it's the authoritative figure; a mismatch means our account-set/dataset
    // assumptions have drifted from this client's real chart of accounts, not that Xero is wrong.
    // A relative tolerance (not a flat £1) avoids constant false-positive flags on a
    // multi-million-pound client's routine FX/rounding noise while still catching a real
    // miscalculation on a small one. Never fails the sync — this is a diagnostic, not a gate.
    let turnoverPlValue = null;
    let turnoverPlMismatch = 0;
    // Xero's Reports/ProfitAndLoss endpoint hard-rejects any fromDate/toDate more than 365 days
    // apart (confirmed live: "The fromDate and toDate parameters must be with 365 days of each
    // other"). A client with an old or unset lock date (since_lock_date falls back to
    // 2000-01-01) routinely produces a multi-year window, so skip the call rather than let every
    // such client fail this check on every sync — the calculated turnover itself has no such
    // limit, only this secondary cross-check does.
    const periodDays = (new Date(`${period.end}T00:00:00Z`) - new Date(`${period.start}T00:00:00Z`)) / 86400000;
    if (periodDays > 365) {
      console.warn(`[turnover_pl_mismatch] org ${orgId}: skipped, period spans ${Math.round(periodDays)} days (Xero's P&L report caps at 365)`);
    } else {
      // isWithinPeriod (periodResolver.js) deliberately excludes the lock date itself for
      // since_lock_date periods, matching Xenon's own "Activity Since <date>" convention — but
      // Xero's Reports/ProfitAndLoss fromDate is inclusive of that day. Left unadjusted, any
      // client with a transaction dated exactly on their lock date gets a false mismatch flag
      // every run (confirmed live: County Gas Services' £460 lock-date-dated receipt accounted
      // for its entire £2,300-vs-£2,760 "mismatch" — the £2,300 figure was correct all along).
      const plFromDate = period.type === 'since_lock_date'
        ? new Date(new Date(`${period.start}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10)
        : period.start;
      try {
        const plResp = await apiCall(tenantId, async (xero, tid) => xero.accountingApi.getReportProfitAndLoss(
          tid, plFromDate, period.end, undefined, undefined,
          undefined, undefined, undefined, undefined, true
        ));
        const report = (plResp.body.reports || [])[0];
        for (const section of (report?.rows || [])) {
          for (const row of (section.rows || [])) {
            if (row.rowType === 'SummaryRow' && ['Total Income', 'Total Turnover'].includes(row.cells?.[0]?.value)) {
              turnoverPlValue = parseFloat(row.cells[row.cells.length - 1].value) || 0;
            }
          }
        }
        if (turnoverPlValue != null) {
          const tolerance = Math.max(1, Math.abs(turnoverPlValue) * 0.005);
          turnoverPlMismatch = Math.abs(turnover - turnoverPlValue) > tolerance ? 1 : 0;
          if (turnoverPlMismatch) {
            console.warn(`[turnover_pl_mismatch] org ${orgId}: calculated £${turnover.toFixed(2)} vs Xero P&L £${turnoverPlValue.toFixed(2)} (period ${period.key})`);
          }
        }
      } catch (plError) {
        // xero-node rejects with the raw HTTP response object, not a normal Error — the real
        // reason lives at response.body.Message, and plError.message is always undefined here.
        const reason = plError?.response?.body?.Message || plError.message;
        console.error('Turnover P&L cross-check unavailable — continuing without it:', reason);
      }
    }

    const customerInvoices = recentAccrec.length;
    const supplierBills = recentAccpay.length;
    const creditNotesSales = recentSalesCN.length;
    const creditNotesPurchase = recentPurchaseCN.length;

    const bankProcessed = allBankTransactions
      .filter(item => isWithinPeriod(toDateString(item.date), period)).length;

    // Journals are only used for the panorama transaction-count card. A network blip here must
    // never discard a completed health-check run — Rose already lost an 8-hour sync that way,
    // because fetchAllJournals' pagination loop has no upper bound on how long it can run for a
    // client with a huge journal history. The try/catch alone only helps once it throws — it
    // does nothing while the fetch is just still going, which is what actually happened. Capped
    // with a timeout so a client whose full journal history would take unreasonably long just
    // skips its journal count for this sync, instead of blocking the whole one-at-a-time queue.
    let journalCount = 0;
    try {
      const allJournals = await withTimeout(
        refreshCachedEntities(
          orgId, tenantId, runId, 'journal',
          since => fetchAllJournals(tenantId, since), options
        ),
        90000,
        'Journal fetch'
      );
      journalCount = allJournals
        .filter(item => isWithinPeriod(toDateString(item.journalDate), period)).length;
    } catch (journalError) {
      console.error('Journal count unavailable — continuing without it:', journalError.message);
    }

    // journalCount is deliberately excluded here, even though it's fetched above — every invoice,
    // bill, bank transaction, and credit note already generates its own journal entry in Xero, on
    // top of journal-only entries (payroll, depreciation, opening balances, manual journals) that
    // have no equivalent in this count at all. Adding it in double-counted (and then some) the
    // same activity already summed below — confirmed against a 16-client Xenon Connect comparison
    // where Akrio's total was 2x-100x Xenon's for nearly every client, tracking almost exactly with
    // each client's journal volume. `journalCount`/`journals` stays its own separate stat (shown
    // independently on the client and transactions pages) — only the sum here was wrong.
    const totalTransactions = customerInvoices + supplierBills + creditNotesSales + creditNotesPurchase + bankProcessed;

    upsertTransactionCounts(orgId, {
      period: period.type,
      period_start: period.start,
      period_end: period.end,
      months_covered: period.monthsCovered,
      turnover,
      total_transactions: totalTransactions,
      customer_invoices: customerInvoices,
      supplier_bills: supplierBills,
      credit_notes_sales: creditNotesSales,
      credit_notes_purchase: creditNotesPurchase,
      bank_processed: bankProcessed,
      journals: journalCount,
      turnover_pl_value: turnoverPlValue,
      turnover_pl_mismatch: turnoverPlMismatch,
      run_id: runId,
      is_active: 0,
    });
  } catch (err) {
    console.error('Transaction counts failed — activating check results anyway:', err.message);
  }

  await activateSyncRun(orgId, runId, options.checkType || null);

  // Refresh Insight KPI data (P&L + Balance Sheet) in the background — failure does not block sync
  try {
    emit({ step: 'insight', message: 'Refreshing Insight KPIs…' });
    await syncInsight(tenantId, orgId, {
      toDate: period.end,
      fyEndMonth: orgInfo?.financialYearEndMonth || 3,
      fyEndDay:   orgInfo?.financialYearEndDay   || 31,
    });
  } catch (e) {
    console.warn('[syncOrganisation] insightSync failed (non-fatal):', e.message);
  }

  emit({ step: 'done', message: 'Sync complete!' });
  return { score, totalIssues, totalPotentialErrors, period };
}

module.exports = { syncOrganisation, CHECK_DEFINITIONS, calculateHealthScore };
