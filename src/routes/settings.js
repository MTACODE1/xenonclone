const express = require('express');
const router = express.Router();
const { getSetting, setSetting } = require('../db/queries');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { PERIOD_TYPES } = require('../services/periodResolver');

const uploadDir = path.join(__dirname, '../../data/uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({ dest: uploadDir, limits: { fileSize: 5 * 1024 * 1024 } });

router.get('/', (req, res) => {
  const companiesHouseKey = getSetting('companies_house_api_key') || '';
  const settings = {
    practiceName: getSetting('practice_name') || '',
    practiceLogo: getSetting('practice_logo') || '',
    defaultSyncPeriod: getSetting('default_sync_period') || 'since_lock_date',
    companiesHouseKeySet: !!companiesHouseKey,
  };
  res.render('settings', { settings, query: req.query });
});

router.post('/', upload.single('logo'), (req, res) => {
  const { practice_name, default_sync_period, companies_house_api_key } = req.body;
  setSetting('practice_name', practice_name || '');
  const allowedDefault = PERIOD_TYPES.filter(type => type !== 'custom');
  setSetting('default_sync_period', allowedDefault.includes(default_sync_period) ? default_sync_period : 'since_lock_date');
  // A blank field leaves the stored key untouched (so the masked form never wipes it); the
  // explicit clear checkbox removes it.
  if (req.body.clear_companies_house_api_key === '1') {
    setSetting('companies_house_api_key', '');
  } else if (companies_house_api_key && companies_house_api_key.trim()) {
    // A pasted URL or a value with spaces is never a key — Companies House would only answer
    // "Invalid Authorization header", so reject it here where the cause is still obvious.
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

module.exports = router;
