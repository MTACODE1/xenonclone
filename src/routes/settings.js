const express = require('express');
const router = express.Router();
const { getSetting, setSetting, getAllOrganisations, updateOrganisationMeta, getOrganisationByTenantId } = require('../db/queries');
const { getDb } = require('../db/schema');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { PERIOD_TYPES } = require('../services/periodResolver');

const uploadDir = path.join(__dirname, '../../data/uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({ dest: uploadDir, limits: { fileSize: 5 * 1024 * 1024 } });

// --- Activity Banding defaults ---
const BANDING_METRICS = [
  { key: 'turnover', label: 'Turnover', unit: '£' },
  { key: 'total_transaction', label: 'Total Transaction', unit: '' },
  { key: 'invoice_count', label: 'Invoice Count', unit: '' },
  { key: 'bill_count', label: 'Bill Count', unit: '' },
  { key: 'bank_activity_count', label: 'Bank Activity Count', unit: '' },
];

const BANDING_DEFAULTS = {
  turnover: [
    { name: 'Package 1', from: 0, to: 0, color: '#ffffff' },
    { name: 'Package 2', from: 1, to: 866, color: '#dbeafe' },
    { name: 'Package 3', from: 867, to: 6666, color: '#93c5fd' },
    { name: 'Package 4', from: 6667, to: 12500, color: '#6096ba' },
    { name: 'Package 5', from: 12501, to: 25000, color: '#2a6496' },
    { name: 'Package 6', from: 25001, to: 41666, color: '#1a3a5c' },
    { name: 'Package 7', from: 41667, to: null, color: '#0d1b2a' },
  ],
  total_transaction: [
    { name: 'Package 1', from: 0, to: 0, color: '#ffffff' },
    { name: 'Package 2', from: 1, to: 10, color: '#fce4ec' },
    { name: 'Package 3', from: 11, to: 50, color: '#f48fb1' },
    { name: 'Package 4', from: 51, to: 100, color: '#ec407a' },
    { name: 'Package 5', from: 101, to: 250, color: '#9c27b0' },
    { name: 'Package 6', from: 251, to: 500, color: '#6a1b9a' },
    { name: 'Package 7', from: 501, to: 750, color: '#4a148c' },
    { name: 'Package 8', from: 751, to: null, color: '#000000' },
  ],
};
BANDING_DEFAULTS.invoice_count = BANDING_DEFAULTS.total_transaction.map(b => ({ ...b }));
BANDING_DEFAULTS.bill_count = BANDING_DEFAULTS.total_transaction.map(b => ({ ...b }));
BANDING_DEFAULTS.bank_activity_count = BANDING_DEFAULTS.total_transaction.map(b => ({ ...b }));

function getBandings(metric) {
  const stored = getSetting(`activity_banding_${metric}`);
  if (stored) {
    try { return JSON.parse(stored); } catch (_) {}
  }
  return BANDING_DEFAULTS[metric] || [];
}

// --- Tag helpers ---
function getAllTags() {
  const stored = getSetting('org_tags_list');
  if (stored) {
    try { return JSON.parse(stored); } catch (_) {}
  }
  return [];
}

function saveTags(tags) {
  setSetting('org_tags_list', JSON.stringify(tags));
}

// --- CTA helpers ---
const CTA_TYPES = [
  { type: 'telephone', label: 'Telephone', defaultBtn: 'Call Me', placeholder: 'Telephone Number' },
  { type: 'email', label: 'Email', defaultBtn: 'Email Me', placeholder: 'Email Address' },
  { type: 'skype', label: 'Skype', defaultBtn: 'Skype Me', placeholder: 'Skype Username' },
  { type: 'whatsapp', label: 'WhatsApp', defaultBtn: 'WhatsApp Me', placeholder: 'WhatsApp Number' },
  { type: 'zoom', label: 'Zoom', defaultBtn: 'Book Zoom Meeting', placeholder: 'URL to Booking Page' },
  { type: 'meeting', label: 'Meeting', defaultBtn: 'Book Meeting', placeholder: 'URL to Booking Page' },
];

function getCTASettings() {
  const stored = getSetting('cta_settings');
  if (stored) {
    try { return JSON.parse(stored); } catch (_) {}
  }
  return {};
}

function verifyCsrf(req, res, next) {
  const supplied = req.body?.csrf_token || req.get('x-csrf-token');
  if (!req.session.csrfToken || supplied !== req.session.csrfToken) {
    return res.status(403).send('Invalid form token');
  }
  next();
}

// ---- GET /settings ----
router.get('/', (req, res) => {
  const tab = req.query.tab || 'practice';
  const metric = BANDING_METRICS.find(m => m.key === req.query.metric) ? req.query.metric : 'turnover';
  const companiesHouseKey = getSetting('companies_house_api_key') || '';
  const settings = {
    practiceName: getSetting('practice_name') || '',
    practiceLogo: getSetting('practice_logo') || '',
    defaultSyncPeriod: getSetting('default_sync_period') || 'since_lock_date',
    companiesHouseKeySet: !!companiesHouseKey,
  };

  const orgs = getAllOrganisations();
  const allTags = getAllTags();
  // Gather tags in use on orgs but not in allTags list — preserve backward compat
  const orgTagsInUse = [...new Set(orgs.map(o => o.tag).filter(Boolean))];
  const mergedTags = [...new Set([...allTags, ...orgTagsInUse])];
  const ctaSettings = getCTASettings();

  res.render('settings', {
    settings, query: req.query, tab, metric,
    bandingMetrics: BANDING_METRICS,
    bandings: getBandings(metric),
    orgs,
    allTags: mergedTags,
    ctaSettings,
    ctaTypes: CTA_TYPES,
  });
});

// ---- POST /settings (practice tab) ----
router.post('/', upload.single('logo'), verifyCsrf, (req, res) => {
  const { practice_name, default_sync_period, companies_house_api_key } = req.body;
  setSetting('practice_name', practice_name || '');
  const allowedDefault = PERIOD_TYPES.filter(type => type !== 'custom');
  setSetting('default_sync_period', allowedDefault.includes(default_sync_period) ? default_sync_period : 'since_lock_date');
  if (req.body.clear_companies_house_api_key === '1') {
    setSetting('companies_house_api_key', '');
  } else if (companies_house_api_key && companies_house_api_key.trim()) {
    const candidate = companies_house_api_key.trim();
    if (/[\s]/.test(candidate) || candidate.includes('://') || candidate.includes('/')) {
      return res.redirect('/settings?ch_key_error=1');
    }
    setSetting('companies_house_api_key', candidate);
  }
  if (req.file) {
    setSetting('practice_logo', '/uploads/' + req.file.filename);
  }
  res.redirect('/settings?saved=1');
});

// ---- POST /settings/banding ----
router.post('/banding', express.urlencoded({ extended: true }), verifyCsrf, (req, res) => {
  const { metric } = req.body;
  if (!BANDING_METRICS.find(m => m.key === metric)) {
    return res.status(400).send('Unknown metric');
  }
  const names = [].concat(req.body['band_name'] || []);
  const froms = [].concat(req.body['band_from'] || []);
  const tos   = [].concat(req.body['band_to']   || []);
  const colors = [].concat(req.body['band_color'] || []);

  const bands = names.map((name, i) => ({
    name: String(name).trim() || `Package ${i + 1}`,
    from: parseInt(froms[i], 10) || 0,
    to: tos[i] === '' || tos[i] == null ? null : (parseInt(tos[i], 10) || 0),
    color: /^#[0-9a-f]{3,6}$/i.test(colors[i]) ? colors[i] : '#ffffff',
  })).filter(b => b.name);

  setSetting(`activity_banding_${metric}`, JSON.stringify(bands));
  res.redirect(`/settings?tab=banding&metric=${metric}&saved=1`);
});

// ---- POST /settings/banding/reset ----
router.post('/banding/reset', express.urlencoded({ extended: true }), verifyCsrf, (req, res) => {
  const { metric } = req.body;
  if (BANDING_METRICS.find(m => m.key === metric)) {
    setSetting(`activity_banding_${metric}`, JSON.stringify(BANDING_DEFAULTS[metric] || []));
  }
  res.redirect(`/settings?tab=banding&metric=${metric}&saved=1`);
});

// ---- POST /settings/tags/create ----
router.post('/tags/create', express.urlencoded({ extended: true }), verifyCsrf, (req, res) => {
  const name = String(req.body.tag_name || '').trim();
  if (!name) return res.redirect('/settings?tab=tags');
  const tags = getAllTags();
  if (!tags.includes(name)) {
    tags.push(name);
    saveTags(tags);
  }
  res.redirect('/settings?tab=tags&saved=1');
});

// ---- POST /settings/tags/delete ----
router.post('/tags/delete', express.urlencoded({ extended: true }), verifyCsrf, (req, res) => {
  const name = String(req.body.tag_name || '').trim();
  const tags = getAllTags().filter(t => t !== name);
  saveTags(tags);
  // Remove from orgs that have this tag
  const db = getDb();
  db.prepare(`UPDATE organisations SET tag = NULL WHERE tag = ?`).run(name);
  res.redirect('/settings?tab=tags&saved=1');
});

// ---- POST /settings/tags/assign ----
router.post('/tags/assign', express.urlencoded({ extended: true }), verifyCsrf, (req, res) => {
  const { tenant_id, tag_name } = req.body;
  const org = tenant_id ? getOrganisationByTenantId(tenant_id) : null;
  if (!org) return res.redirect('/settings?tab=tags');
  // Toggle: if same tag is already set, remove it; otherwise set it
  const newTag = org.tag === tag_name ? null : (tag_name || null);
  updateOrganisationMeta(tenant_id, { client_ref: org.client_ref, tag: newTag });
  res.redirect('/settings?tab=tags');
});

// ---- POST /settings/cta ----
router.post('/cta', express.urlencoded({ extended: true }), verifyCsrf, (req, res) => {
  const cta = {};
  for (const ct of CTA_TYPES) {
    cta[ct.type] = {
      enabled: req.body[`cta_enabled_${ct.type}`] === '1',
      label: String(req.body[`cta_label_${ct.type}`] || ct.defaultBtn).trim(),
      value: String(req.body[`cta_value_${ct.type}`] || '').trim(),
    };
  }
  setSetting('cta_settings', JSON.stringify(cta));
  res.redirect('/settings?tab=cta&saved=1');
});

module.exports = router;
