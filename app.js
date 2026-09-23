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
const { getPool } = require('./src/db/mysqlPool');

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

// TEMPORARY full-portfolio verification against the 16-client Xenon comparison document
// (2026-09-23) — logs to stdout only. ?sync=1 enqueues full re-syncs for all 16 (they run one at
// a time; this route just queues them and returns immediately). ?client=<orgId> dumps one client's
// full 29-check + transaction_counts detail; no param lists sync status for all 16. Will be
// removed in the very next commit right after use.
const PORTFOLIO_CLIENTS = [
  { orgId: 28, name: 'Gutter Guy', tenantId: '0b18676b-274f-4e68-bdd6-333a22a0586d' },
  { orgId: 29, name: 'Positive Internet Marketing', tenantId: '8e258ca9-afe3-48e0-9512-b146fd427089' },
  { orgId: 31, name: 'Reality Ratio', tenantId: '68978f4e-9c40-45db-a93a-f72b08fb5179' },
  { orgId: 34, name: 'Harlow Online', tenantId: '9caea78f-72f0-405f-83bb-b3056cad5cd0' },
  { orgId: 38, name: 'Bevilacqua', tenantId: '52ea5c06-d9ac-492f-a956-e1d5aa1c1aa7' },
  { orgId: 43, name: 'Lisa Potter-Dixon', tenantId: '08c79357-b7d3-4702-bf57-479b4dd9de45' },
  { orgId: 86, name: 'Differentiate Coaching', tenantId: '36c0c654-e65e-4867-bcae-2a2be813d59b' },
  { orgId: 87, name: 'Rail Infra Clean', tenantId: 'fa86af28-97a2-40f9-97c4-143df29c1f13' },
  { orgId: 89, name: 'BCB Solutions', tenantId: 'dc8b7142-5660-4018-a9b8-967e0afd7334' },
  { orgId: 92, name: 'Upcycle My Stuff', tenantId: '1d08f7d6-0518-483b-ad83-be328148212c' },
  { orgId: 96, name: 'County Gas', tenantId: 'cac3a30e-976a-4f74-b30e-3b24052a84ef' },
  { orgId: 165, name: 'Anthrotek', tenantId: '5b899db0-0d45-4bba-97c7-825ecce3262d' },
  { orgId: 167, name: 'Minga Coffee', tenantId: 'aaabeb82-feca-4f8f-b24e-e48ef4ef03d6' },
  { orgId: 170, name: 'LiveAdventure', tenantId: '41e70693-8c82-4cf5-8593-2d9087c4543f' },
  { orgId: 247, name: 'Hair of the Dog', tenantId: '0fdc25de-9cc8-447c-ac49-fab27e4a87f1' },
  { orgId: 381, name: 'After Dark Bookshop', tenantId: '761d594a-8352-48da-b079-b2e135423744' },
];

app.get(BASE_PATH + '/__debug_portfolio__', async (req, res) => {
  try {
    const db = getDb();
    if (req.query.sync === '1') {
      const results = [];
      for (const c of PORTFOLIO_CLIENTS) {
        try {
          const started = await startJob(`${c.tenantId}:all:since_lock_date::`, progress =>
            syncOrganisation(c.tenantId, progress, { period: { type: 'since_lock_date' } }),
            { tenantId: c.tenantId, mode: 'full' });
          results.push({ name: c.name, id: started.job.id, existing: started.existing });
        } catch (err) {
          results.push({ name: c.name, error: err.message });
        }
      }
      console.log(`[debug_portfolio] enqueued all 16: ${JSON.stringify(results)}`);
      return res.send('enqueued');
    }
    if (req.query.client) {
      const c = PORTFOLIO_CLIENTS.find(x => String(x.orgId) === String(req.query.client));
      if (!c) return res.status(404).send('unknown client');
      const issues = db.prepare(
        `SELECT check_type, count, potential_value_gbp, period_checked FROM issues WHERE org_id = ? AND is_active = 1 ORDER BY check_type`
      ).all(c.orgId);
      const tx = db.prepare(
        `SELECT total_transactions, customer_invoices, supplier_bills, credit_notes_sales, credit_notes_purchase, bank_processed, journals, turnover, synced_at
         FROM transaction_counts WHERE org_id = ? ORDER BY synced_at DESC LIMIT 1`
      ).get(c.orgId);
      console.log(`[debug_portfolio] ${c.name} (org ${c.orgId}) transaction_counts: ${JSON.stringify(tx)}`);
      for (const i of issues) console.log(`[debug_portfolio] ${c.name} check | ${i.check_type} | count=${i.count} | value=${i.potential_value_gbp} | period=${i.period_checked}`);
      return res.send('logged');
    }
    for (const c of PORTFOLIO_CLIENTS) {
      const [rows] = await getPool().query(
        `SELECT status, started_at, completed_at FROM akrio_sync_runs WHERE org_id = ? ORDER BY started_at DESC LIMIT 1`,
        [c.orgId]
      );
      console.log(`[debug_portfolio] ${c.name} (org ${c.orgId}) latest run: ${JSON.stringify(rows[0] || null)}`);
    }
    res.send('logged');
  } catch (err) {
    console.error('[debug_portfolio] error:', err.message, err.stack);
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
