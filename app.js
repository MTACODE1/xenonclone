require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const https = require('https');
const cron = require('node-cron');
const crypto = require('crypto');

const { getDb } = require('./src/db/schema');
const { getAllOrganisations, getSetting } = require('./src/db/queries');
const { syncOrganisation } = require('./src/services/xeroSync');
const { startJob } = require('./src/services/syncJobs');

// Init DB on startup
getDb();

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src/views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'data/uploads')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const isSecureRedirect = process.env.XERO_REDIRECT_URI?.startsWith('https://');
// Behind Railway (and most PaaS), TLS terminates at the platform's edge and the
// container is always spoken to over plain HTTP — only serve our own local
// self-signed cert when actually running standalone in local dev.
const useLocalTlsServer = isSecureRedirect && process.env.NODE_ENV !== 'production';

app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET || 'xero-dashboard-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: isSecureRedirect, maxAge: 24 * 60 * 60 * 1000 }
}));

app.use((req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  res.locals.practiceName = getSetting('practice_name') || '';
  res.locals.cssVersion = '20260807';
  next();
});

// Routes
const authRoutes = require('./src/routes/auth');
const dashboardRoutes = require('./src/routes/dashboard');
const clientRoutes = require('./src/routes/client');
const settingsRoutes = require('./src/routes/settings');
const validationRoutes = require('./src/routes/validation');

app.use('/auth', authRoutes);
app.use('/client', clientRoutes);
app.use('/settings', settingsRoutes);
app.use('/validation', validationRoutes);
app.use('/', dashboardRoutes);

// Nightly sync at 2am
cron.schedule('0 2 * * *', () => {
  console.log('[cron] Running nightly sync...');
  const orgs = getAllOrganisations().filter(o => o.connection_status === 'connected');
  const period = { type: getSetting('default_sync_period') || 'since_lock_date' };
  for (const org of orgs) {
    try {
      startJob(
        `${org.xero_tenant_id}:all:${period.type}::`,
        progress => syncOrganisation(org.xero_tenant_id, progress, { period }),
        {
          tenantId: org.xero_tenant_id, orgId: org.id, mode: 'full',
          payload: { period, source: 'nightly' },
        }
      );
      console.log(`[cron] Enqueued: ${org.name}`);
    } catch (err) {
      console.error(`[cron] Failed to sync ${org.name}:`, err.message);
    }
  }
});

const PORT = process.env.PORT || 3000;

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
