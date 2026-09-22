require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const https = require('https');
const cron = require('node-cron');
const crypto = require('crypto');

const { getDb } = require('./src/db/schema');
const { getAllOrganisations, getSetting, getStaffById } = require('./src/db/queries');
const { syncOrganisation } = require('./src/services/xeroSync');
const { syncFreeAgentOrganisation } = require('./src/services/freeagentSync');
const { startJob } = require('./src/services/syncJobs');
const MysqlSessionStore = require('./src/services/mysqlSessionStore');
const { bootstrapAdmin } = require('./src/services/bootstrapAdmin');
const { isStaffManager, canAccessSettings } = require('./src/services/staffPermissions');

// Init DB on startup
getDb();

const app = express();

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required in production');
}

// Set when Akrio is reverse-proxied under a path on another app's domain
// (e.g. AKRIO_BASE_PATH=/akrio-verify for wf.morethanaccountants.co.uk/akrio-verify).
// Left blank for local dev / a dedicated subdomain, where Akrio owns the whole origin.
const BASE_PATH = (process.env.AKRIO_BASE_PATH || '').replace(/\/$/, '');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src/views'));
app.use(BASE_PATH, express.static(path.join(__dirname, 'public')));
app.use(BASE_PATH + '/uploads', express.static(path.join(__dirname, 'data/uploads')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const isSecureRedirect = process.env.XERO_REDIRECT_URI?.startsWith('https://');
// Behind Railway (and most PaaS), TLS terminates at the platform's edge and the
// container is always spoken to over plain HTTP — only serve our own local
// self-signed cert when actually running standalone in local dev.
const useLocalTlsServer = isSecureRedirect && process.env.NODE_ENV !== 'production';

app.set('trust proxy', 1);

app.use(session({
  store: new MysqlSessionStore(),
  secret: process.env.SESSION_SECRET || 'xero-dashboard-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isSecureRedirect,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  }
}));

// Sweeps expired session rows hourly so the sessions table doesn't grow unbounded.
setInterval(() => MysqlSessionStore.pruneExpired().catch(err => console.error('[sessions] prune failed:', err.message)), 60 * 60 * 1000).unref();

app.use(async (req, res, next) => {
  try {
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    res.locals.csrfToken = req.session.csrfToken;
    res.locals.practiceName = getSetting('practice_name') || '';
    res.locals.cssVersion = '20260807';
    res.locals.staffName = req.session.staffName || null;
    res.locals.staffRole = req.session.staffRole || null;
    res.locals.isStaffManager = isStaffManager(req.session.staffRole);
    res.locals.canAccessSettings = res.locals.isStaffManager
      || (req.session.staffId ? canAccessSettings(await getStaffById(req.session.staffId)) : false);
    // Every root-relative link/form/asset in the views is written as "<%= basePath %>/...",
    // so the whole app moves cleanly under a path prefix (e.g. /akrio-verify) with one change.
    res.locals.basePath = BASE_PATH;
    next();
  } catch (error) {
    next(error);
  }
});

// res.redirect('/x') is written all over the routes as a plain root-relative path — Express
// does NOT rewrite that for a sub-mounted app, so under a BASE_PATH it would bounce the
// browser to the wrong (unprefixed) URL. Patch res.redirect once here instead of touching
// every call site.
if (BASE_PATH) {
  app.use((req, res, next) => {
    const originalRedirect = res.redirect.bind(res);
    res.redirect = (a, b) => {
      if (typeof b === 'string') {
        return originalRedirect(a, b.startsWith('/') && !b.startsWith(BASE_PATH) ? BASE_PATH + b : b);
      }
      if (typeof a === 'string') {
        return originalRedirect(a.startsWith('/') && !a.startsWith(BASE_PATH) ? BASE_PATH + a : a);
      }
      return originalRedirect(a, b);
    };
    next();
  });
}

// Routes
const authRoutes = require('./src/routes/auth');
const freeagentAuthRoutes = require('./src/routes/freeagentAuth');
const dashboardRoutes = require('./src/routes/dashboard');
const clientRoutes = require('./src/routes/client');
const settingsRoutes = require('./src/routes/settings');
const validationRoutes = require('./src/routes/validation');
const staffAuthRoutes = require('./src/routes/staffAuth');
const staffRoutes = require('./src/routes/staff');
const { requireStaffLogin, requireStaffManager, requireSettingsAccess } = require('./src/middleware/staffAuth');

// TEMPORARY one-off diagnostic for the Anthrotek/Hair of the Dog Xenon-vs-Akrio comparisons
// (2026-09-22) — logs to stdout only, no data leaves via the HTTP response. ?sync=1 enqueues fresh
// full syncs for both clients (via the same startJob path the real Sync button uses); with no
// query param it just dumps the current local-SQLite state for both. Will be removed in the very
// next commit right after use.
app.get(BASE_PATH + '/__debug_compare__', async (req, res) => {
  try {
    const db = getDb();
    if (req.query.sync === '1') {
      const started = await Promise.all([
        startJob('5b899db0-0d45-4bba-97c7-825ecce3262d:all:since_lock_date::', progress =>
          syncOrganisation('5b899db0-0d45-4bba-97c7-825ecce3262d', progress, { period: { type: 'since_lock_date' } }),
          { tenantId: '5b899db0-0d45-4bba-97c7-825ecce3262d', mode: 'full' }),
        startJob('0fdc25de-9cc8-447c-ac49-fab27e4a87f1:all:since_lock_date::', progress =>
          syncOrganisation('0fdc25de-9cc8-447c-ac49-fab27e4a87f1', progress, { period: { type: 'since_lock_date' } }),
          { tenantId: '0fdc25de-9cc8-447c-ac49-fab27e4a87f1', mode: 'full' }),
      ]);
      console.log(`[debug_compare] enqueued: ${JSON.stringify(started.map(s => ({ id: s.job.id, existing: s.existing })))}`);
      return res.send('enqueued');
    }
    for (const [label, orgId] of [['Anthrotek', 165], ['Hair of the Dog', 247]]) {
      const totalIssues = db.prepare('SELECT COUNT(*) c FROM issues WHERE org_id = ?').get(orgId);
      console.log(`[debug_compare] ${label} (org ${orgId}) total issue rows: ${totalIssues.c}`);
      if (label === 'Anthrotek') {
        for (const checkType of ['multi_account_suppliers', 'multi_tax_suppliers']) {
          const issue = db.prepare(`SELECT detail_json, synced_at FROM issues WHERE org_id = ? AND check_type = ? ORDER BY synced_at DESC LIMIT 1`).get(orgId, checkType);
          const detail = issue ? JSON.parse(issue.detail_json) : [];
          console.log(`[debug_compare] ${label} ${checkType} (synced_at=${issue?.synced_at}): ${detail.length} items`);
          for (const item of detail) console.log(`[debug_compare] ${label} ${checkType} | ${item.contactId} | ${JSON.stringify(item.name)}`);
        }
        const contacts = db.prepare(
          `SELECT entity_id, json FROM xero_entity_cache WHERE org_id = ? AND entity_type = 'contact'
           AND (LOWER(json) LIKE '%peltier%' OR LOWER(json) LIKE '%tareque%' OR LOWER(json) LIKE '%companies house%')`
        ).all(orgId);
        for (const c of contacts) console.log(`[debug_compare] ${label} contact ${c.entity_id} | ${JSON.stringify(JSON.parse(c.json).name)}`);
      } else {
        const issue = db.prepare(`SELECT detail_json, synced_at FROM issues WHERE org_id = ? AND check_type = 'old_unpaid_bills' ORDER BY synced_at DESC LIMIT 1`).get(orgId);
        const detail = issue ? JSON.parse(issue.detail_json) : [];
        console.log(`[debug_compare] ${label} old_unpaid_bills (synced_at=${issue?.synced_at}): ${detail.length} items`);
        for (const item of detail) console.log(`[debug_compare] ${label} old_unpaid_bills | ${item.number} | ${item.contact} | due=${item.amountDue}`);
        const bills = db.prepare(
          `SELECT entity_id, json FROM xero_entity_cache WHERE org_id = ? AND entity_type = 'invoice'
           AND LOWER(json) LIKE '%carlsberg%'`
        ).all(orgId);
        for (const b of bills) {
          const p = JSON.parse(b.json);
          console.log(`[debug_compare] ${label} carlsberg bill ${b.entity_id} | ref=${p.invoiceNumber} status=${p.status} amountDue=${p.amountDue} date=${p.date}`);
        }
      }
    }
    res.send('logged');
  } catch (err) {
    console.error('[debug_compare] error:', err.message, err.stack);
    res.status(500).send('error, see logs');
  }
});

app.use(BASE_PATH + '/login', staffAuthRoutes); // reachable pre-auth
app.use(requireStaffLogin); // everything below requires a staff session

// /auth is Xero OAuth (connect/callback/disconnect a client's Xero org) — now implicitly
// staff-gated by the requireStaffLogin above, since only a logged-in admin/staff clicking
// "Connect Client" should ever start that flow.
app.use(BASE_PATH + '/auth', authRoutes);
app.use(BASE_PATH + '/auth/freeagent', freeagentAuthRoutes);
// Per-:tenantId access enforcement (resolveOrgAccess) is mounted INSIDE client.js itself via
// router.use('/:tenantId', ...) — Express only populates req.params from a path pattern that
// contains the named param, so it can't be applied here as plain middleware on the bare '/client'
// prefix.
app.use(BASE_PATH + '/client', clientRoutes);
app.use(BASE_PATH + '/settings', requireSettingsAccess, settingsRoutes);
app.use(BASE_PATH + '/staff', requireStaffManager, staffRoutes);
app.use(BASE_PATH + '/validation', validationRoutes);
app.use(BASE_PATH, dashboardRoutes);

// Nightly sync at 2am
cron.schedule('0 2 * * *', async () => {
  console.log('[cron] Running nightly sync...');
  try {
    const orgs = (await getAllOrganisations()).filter(o => o.connection_status === 'connected');
    const period = { type: getSetting('default_sync_period') || 'since_lock_date' };
    for (const org of orgs) {
      const identifier = org.xero_tenant_id || org.freeagent_company_id;
      const runSync = org.freeagent_company_id
        ? progress => syncFreeAgentOrganisation(identifier, progress, { period })
        : progress => syncOrganisation(identifier, progress, { period });
      try {
        await startJob(
          `${identifier}:all:${period.type}::`,
          runSync,
          {
            tenantId: identifier, orgId: org.id, mode: 'full',
            payload: { period, source: 'nightly' },
          }
        );
        console.log(`[cron] Enqueued: ${org.name}`);
      } catch (err) {
        console.error(`[cron] Failed to sync ${org.name}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[cron] Nightly sync failed to start:', err.message);
  }
});

const PORT = process.env.PORT || 3000;

// bootstrapAdmin needs the staff table (now in MySQL) before anything can log in, so the server
// only starts accepting connections once it's confirmed done.
bootstrapAdmin().then(() => {
  if (useLocalTlsServer) {
    const sslOptions = {
      key: fs.readFileSync(path.join(__dirname, 'certs/localhost-key.pem')),
      cert: fs.readFileSync(path.join(__dirname, 'certs/localhost-cert.pem')),
    };
    https.createServer(sslOptions, app).listen(PORT, () => {
      console.log(`Xero Dashboard running at https://localhost:${PORT}`);
    });
  } else {
    app.listen(PORT, () => {
      console.log(`Xero Dashboard running at http://localhost:${PORT} (NODE_ENV=${process.env.NODE_ENV || 'development'})`);
    });
  }
}).catch(error => {
  console.error('[bootstrap] Failed to start:', error);
  process.exit(1);
});
