const express = require('express');
const router = express.Router();
const {
  getAllOrganisations, getOrganisationByTenantId, getSetting, getAllTransactionCounts,
  getPanoramaOrganisations,
} = require('../db/queries');
const { syncOrganisation } = require('../services/xeroSync');
const { periodInput, PERIOD_TYPES, resolvePeriod } = require('../services/periodResolver');
const { cancelJob, getJob, startJob, subscribe } = require('../services/syncJobs');

function requestedPeriod(query) {
  return periodInput(query, getSetting('default_sync_period') || 'since_lock_date');
}

// No current caller passes checkType here (this route only ever does full syncs today), but this
// mirrors src/routes/client.js's per-check reanalyse route exactly so that if per-check reanalysis
// is ever wired up from the dashboard, it inherits the same fix rather than the bug that fix was
// written for: cacheOnly must only skip the live Xero fetch when reanalysing a genuinely different
// period than the one currently active, not unconditionally.
function startOrganisationJob(tenantId, query = {}, checkType = null) {
  const period = requestedPeriod(query);
  const key = `${tenantId}:${checkType || 'all'}:${period.type}:${period.from || ''}:${period.to || ''}`;
  let cacheOnly, asOf;
  if (checkType) {
    const org = getOrganisationByTenantId(tenantId);
    const resolvedPeriod = resolvePeriod(period, {
      lockDate: org?.lock_date,
      financialYearEndDay: org?.financial_year_end_day,
      financialYearEndMonth: org?.financial_year_end_month,
    });
    cacheOnly = Boolean(org?.period_key) && resolvedPeriod.key === org.period_key;
    asOf = org?.period_end || undefined;
  }
  return startJob(key, progress =>
    syncOrganisation(tenantId, progress, { period, checkType, cacheOnly, asOf }),
    { tenantId, mode: checkType ? `check:${checkType}` : 'full', payload: { period, checkType, cacheOnly, asOf } }
  );
}

router.get('/', (req, res) => {
  const staleBefore = Date.now() - 36 * 60 * 60 * 1000;
  const orgs = getAllOrganisations().map(org => ({
    ...org,
    isStale: !org.last_successful_sync_at ||
      new Date(org.last_successful_sync_at).getTime() < staleBefore,
  }));
  const connected = orgs.filter(o => o.connection_status === 'connected');
  const avgScore = connected.length
    ? Math.round(connected.filter(o => o.score != null).reduce((s, o) => s + o.score, 0) / (connected.filter(o => o.score != null).length || 1))
    : null;
  res.render('index', { orgs, avgScore, totalConnected: connected.length });
});

router.get('/panorama', (req, res) => {
  let orgs = getPanoramaOrganisations();
  const { sort, tag, status, search } = req.query;
  if (tag) orgs = orgs.filter(o => o.tag === tag);
  if (status) orgs = orgs.filter(o => o.connection_status === status);
  if (search) orgs = orgs.filter(o => o.name.toLowerCase().includes(search.toLowerCase()));
  const nullableNumber = (value, fallback) => value == null ? fallback : Number(value);
  if (sort === 'score_asc') orgs.sort((a, b) => nullableNumber(a.score, Infinity) - nullableNumber(b.score, Infinity));
  else if (sort === 'score_desc') orgs.sort((a, b) => nullableNumber(b.score, -Infinity) - nullableNumber(a.score, -Infinity));
  else if (sort === 'issues') orgs.sort((a, b) => (b.total_issues || 0) - (a.total_issues || 0));
  else if (sort === 'recent_transaction') orgs.sort((a, b) => String(b.most_recent_transaction || '').localeCompare(String(a.most_recent_transaction || '')));
  else if (sort === 'lock_date') orgs.sort((a, b) => String(a.lock_date || '9999').localeCompare(String(b.lock_date || '9999')));
  else if (sort === 'name') orgs.sort((a, b) => a.name.localeCompare(b.name));
  const staleBefore = Date.now() - 36 * 60 * 60 * 1000;
  orgs = orgs.map(org => ({
    ...org,
    isStale: !org.last_successful_sync_at ||
      new Date(org.last_successful_sync_at).getTime() < staleBefore,
  }));

  const totalIssues = orgs.reduce((s, o) => s + (o.total_issues || 0), 0);
  const totalErrors = orgs.reduce((s, o) => s + (o.total_potential_errors_gbp || 0), 0);
  const totalUnreconciled = orgs.reduce((s, o) => s + (o.unreconciled_bank_items || 0), 0);
  const avgScore = orgs.filter(o => o.score != null).length
    ? Math.round(orgs.filter(o => o.score != null).reduce((s, o) => s + o.score, 0) / orgs.filter(o => o.score != null).length)
    : null;
  const allTags = [...new Set(getAllOrganisations().map(o => o.tag).filter(Boolean))];

  res.render('panorama', { orgs, totalIssues, totalErrors, totalUnreconciled, avgScore, allTags, query: req.query });
});

router.post('/sync/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  try {
    const started = startOrganisationJob(tenantId, req.query);
    return res.status(started.existing ? 200 : 202).json({
      success: true, jobId: started.job.id, existing: started.existing,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

router.post('/sync-all', async (req, res) => {
  const orgs = getAllOrganisations().filter(o => o.connection_status === 'connected');
  const period = requestedPeriod(req.query);
  const results = [];
  for (const org of orgs) {
    try {
      const started = startOrganisationJob(org.xero_tenant_id, req.query);
      results.push({
        tenantId: org.xero_tenant_id, jobId: started.job.id, existing: started.existing,
      });
    } catch (error) {
      results.push({ tenantId: org.xero_tenant_id, error: error.message });
    }
  }
  res.status(202).json({ success: true, period, results });
});

router.get('/transactions', (req, res) => {
  const selectedPeriod = PERIOD_TYPES.includes(req.query.period)
    ? req.query.period : (getSetting('default_sync_period') || 'since_lock_date');
  let custom = null;
  if (selectedPeriod === 'custom') {
    try {
      custom = resolvePeriod(periodInput(req.query, selectedPeriod));
    } catch (error) {
      return res.status(400).send(error.message);
    }
  }
  let rows = getAllTransactionCounts(selectedPeriod, custom?.start || null, custom?.end || null);
  const { sort, search } = req.query;
  if (search) rows = rows.filter(r => r.name.toLowerCase().includes(search.toLowerCase()));
  if (sort === 'turnover') rows.sort((a, b) => (b.turnover || 0) - (a.turnover || 0));
  else if (sort === 'transactions') rows.sort((a, b) => (b.total_transactions || 0) - (a.total_transactions || 0));
  else rows.sort((a, b) => a.name.localeCompare(b.name));

  const totals = {
    turnover: rows.reduce((s, r) => s + (r.turnover || 0), 0),
    total_transactions: rows.reduce((s, r) => s + (r.total_transactions || 0), 0),
    customer_invoices: rows.reduce((s, r) => s + (r.customer_invoices || 0), 0),
    supplier_bills: rows.reduce((s, r) => s + (r.supplier_bills || 0), 0),
    credit_notes_sales: rows.reduce((s, r) => s + (r.credit_notes_sales || 0), 0),
    credit_notes_purchase: rows.reduce((s, r) => s + (r.credit_notes_purchase || 0), 0),
    bank_processed: rows.reduce((s, r) => s + (r.bank_processed || 0), 0),
    journals: rows.reduce((s, r) => s + (r.journals || 0), 0),
  };
  res.render('transactions', { rows, totals, query: { ...req.query, period: selectedPeriod } });
});

router.get('/sync-jobs/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Sync job not found or expired' });
  res.json(job);
});

router.post('/sync-jobs/:jobId/cancel', (req, res) => {
  const job = cancelJob(req.params.jobId);
  if (!job) return res.status(409).json({ error: 'Only queued jobs can be cancelled safely' });
  res.json(job);
});

router.get('/sync-jobs/:jobId/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  const unsubscribe = subscribe(req.params.jobId, job => {
    res.write(`data: ${JSON.stringify(job)}\n\n`);
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) res.end();
  });
  if (!unsubscribe) return res.end(`event: error\ndata: ${JSON.stringify({ error: 'Sync job not found or expired' })}\n\n`);
  req.on('close', unsubscribe);
});

router.get('/health', (req, res) => {
  const orgs = getAllOrganisations();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    organisations: orgs.map(o => ({
      name: o.name,
      tenantId: o.xero_tenant_id,
      connectionStatus: o.connection_status,
      lastSynced: o.last_successful_sync_at || o.last_synced_at,
      healthScore: o.score,
    }))
  });
});

module.exports = router;
