// Page side of the "bank feed read from Zoho Books' screen" feature, for Zoho Books clients only. It asks the Akrio
// Verify browser extension to read one client's Zoho Books Banking page, saves the answer to Verify and shows the
// latest saved reading. Used on a Zoho client's page (one client) and the dashboard (every Zoho client). Kept apart
// from bankScreen.js so the Xero card and its "Update all clients" run are not changed.
(function () {
  'use strict';
  const FROM_PAGE = 'akrio-verify-page';
  const FROM_EXTENSION = 'akrio-verify-extension';
  const ZOHO_VERSION = [1, 5, 0]; // the first extension version that can read Zoho Books
  const pending = new Map();
  let counter = 0;

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== FROM_EXTENSION || !pending.has(data.requestId)) return;
    const entry = pending.get(data.requestId);
    if (data.type === 'READ_PROGRESS') { if (entry.onProgress) entry.onProgress(data.stage); return; }
    pending.delete(data.requestId);
    entry.finish(data);
  });

  function askExtension(message, timeoutMs, onProgress) {
    return new Promise(resolve => {
      // Request ids start with "z" so they can never be mistaken for the Xero card's on the same page.
      const requestId = 'z' + Date.now() + '-' + (++counter);
      const timer = setTimeout(() => { pending.delete(requestId); resolve(null); }, timeoutMs);
      pending.set(requestId, { onProgress, finish: data => { clearTimeout(timer); resolve(data); } });
      window.postMessage({ source: FROM_PAGE, requestId, ...message }, window.location.origin);
    });
  }

  // The extension's helper is added once the page has loaded, so it is asked a few times before it counts as missing.
  let versionCheck = null;
  const extensionVersion = () => {
    if (!versionCheck) {
      versionCheck = (async () => {
        for (let attempt = 0; attempt < 8; attempt++) {
          const answer = await askExtension({ type: 'PING' }, 1000);
          if (answer) return String(answer.version || '0');
        }
        return null;
      })().then(found => { if (!found) versionCheck = null; return found; });
    }
    return versionCheck;
  };
  const versionAtLeast = (version, wanted) => {
    const parts = String(version).split('.').map(Number);
    for (let i = 0; i < wanted.length; i++) {
      if ((parts[i] || 0) > wanted[i]) return true;
      if ((parts[i] || 0) < wanted[i]) return false;
    }
    return true;
  };

  function problem(code, message) { const error = new Error(message); error.code = code; return error; }

  async function getJson(url, options) {
    let response;
    try {
      response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' }, ...options });
    } catch (error) {
      throw problem('verify_unreachable', 'Akrio Verify could not be reached. Check your connection.');
    }
    const isJson = (response.headers.get('content-type') || '').includes('json');
    if (!isJson) {
      if (response.redirected && /\/login(\?|$)/.test(response.url)) throw problem('verify_signed_out', 'Your Akrio Verify session has ended. Sign in to Akrio Verify again.');
      if (response.status === 503) throw problem('verify_starting', 'Akrio Verify is starting up. Try again in a minute.');
      throw problem('verify_error', 'Akrio Verify gave an unexpected answer (status ' + response.status + '). Nothing was saved for this client.');
    }
    const body = await response.json();
    if (!response.ok) throw problem(response.status === 503 ? 'verify_starting' : 'verify_refused', body.error || 'Akrio Verify could not save the reading.');
    return body;
  }

  // Checks the extension is there and new enough. Throws an Error with a code the failure box understands.
  async function readyExtension() {
    const version = await extensionVersion();
    if (!version) throw problem('no_extension', 'The extension was not found.');
    if (!versionAtLeast(version, ZOHO_VERSION)) {
      throw problem('old_extension', 'Reading Zoho Books needs version ' + ZOHO_VERSION.join('.') + ' of the Akrio Verify extension; this browser has ' + version + '.');
    }
  }

  // Reads one Zoho Books client through the extension and saves it. Throws an Error with a plain message.
  async function updateOne(base, csrfToken, tenantId, orgId, booksHost, onStage = () => {}) {
    onStage('opening');
    const answer = await askExtension({ type: 'READ_ZOHO_BANKING', orgId, booksHost }, 150000, onStage);
    if (!answer) throw new Error('The extension did not answer in time.');
    if (!answer.ok) { const error = new Error(answer.message || 'Zoho Books could not be read.'); error.code = answer.error; throw error; }
    onStage('saving');
    const save = () => getJson(base + '/api/bank-screen/zoho/readings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ ...answer.reading, tenantId }),
    });
    try { return await save(); } catch (error) {
      // The figures are already read; a passing server hiccup should not lose them. Try the save once more.
      if (error.code !== 'verify_error' && error.code !== 'verify_unreachable') throw error;
      await new Promise(resolve => setTimeout(resolve, 3000));
      return save();
    }
  }

  // ---- drawing ----
  const el = (tag, text, style) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (style) node.style.cssText = style; return node; };
  const money = (value, currency) => (value == null ? '—'
    : (value < 0 ? '(' : '') + (currency || '') + Math.abs(value).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 3 }) + (value < 0 ? ')' : ''));
  const TONES = {
    bad: 'background:#FDEDE8;color:#B42318;',
    warn: 'background:#FEF5E5;color:#B25E09;',
    good: 'background:#E6FFFA;color:#0B8F76;',
    muted: 'background:#EEF1F6;color:#5A6A85;',
  };
  const badge = (label, tone) => el('span', label, 'display:inline-block;padding:2px 10px;border-radius:999px;font-size:0.72rem;font-weight:600;white-space:nowrap;' + TONES[tone]);
  const NUM = 'text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;';
  const ALERT_TONES = {
    bad: 'background:#FDEDE8;border:1px solid #F7C6BB;color:#7A271A;',
    warn: 'background:#FEF5E5;border:1px solid #F8DDB1;color:#7A4510;',
    muted: 'background:#F4F6FA;border:1px solid #E5EAF2;color:#5A6A85;',
  };
  function alertBox(tone, title, message, link) {
    const box = el('div', null, 'border-radius:8px;padding:10px 14px;margin-bottom:10px;font-size:0.8rem;line-height:1.45;' + ALERT_TONES[tone]);
    box.setAttribute('role', tone === 'bad' ? 'alert' : 'note');
    box.appendChild(el('div', title, 'font-weight:700;margin-bottom:2px;'));
    box.appendChild(el('div', message));
    if (link) {
      const anchor = el('a', link.label, 'display:inline-block;margin-top:6px;font-weight:600;');
      anchor.href = link.href; anchor.target = '_blank'; anchor.rel = 'noopener';
      box.appendChild(anchor);
    }
    return box;
  }

  const ZOHO_HOST = /^books\.(zoho\.(com|eu|in|com\.au|jp|sa|uk|ae|com\.cn)|zohocloud\.ca)$/;
  const bankingLink = (booksHost, orgId) => (ZOHO_HOST.test(String(booksHost || '')) && /^\d{5,20}$/.test(String(orgId || ''))
    ? { label: 'Open Banking in Zoho Books', href: 'https://' + booksHost + '/app/' + orgId + '#/banking' } : null);

  function failureBox(error, link) {
    switch (error.code) {
      case 'zoho_access_needed': return alertBox('bad', 'Allow the extension to open Zoho Books', 'Chrome needs your permission once. The extension has opened a tab: click "Allow Zoho Books" there, then click "Update from Zoho Books" again.');
      case 'not_signed_in': return alertBox('bad', 'Zoho Books is not signed in', 'Sign in to Zoho Books in this browser, then click "Update from Zoho Books" again.', link);
      case 'wrong_organisation': return alertBox('bad', 'Zoho Books did not open this client', 'Your Zoho login may not have access to this organisation. Check you are signed in to Zoho with a login that can open it.', link);
      case 'timeout': case 'not_settled': return alertBox('bad', 'Zoho Books took too long to load', 'Nothing was saved. Try again in a minute.');
      case 'not_readable': case 'unexpected_page': return alertBox('bad', 'Zoho Books\' Banking page could not be read', (error.message || '') + ' Nothing was saved. Open the client\'s Banking page in Zoho Books to check it loads, then try again.', link);
      case 'no_bank_accounts': return alertBox('warn', 'No bank accounts in Zoho Books', 'This client has no bank or card accounts on Zoho Books\' Banking page, so there is nothing to read.', link);
      case 'unsupported_format': return alertBox('bad', 'Amounts in a format the extension cannot read yet', error.message || 'Nothing was saved. Please tell Aditya.');
      case 'page_changed': return alertBox('bad', 'Zoho Books has changed its page', error.message || 'Nothing was saved. The extension needs an update: please tell Aditya.');
      case 'verify_signed_out': return alertBox('bad', 'Akrio Verify is signed out', 'Sign in to Akrio Verify again, then click "Update from Zoho Books".');
      case 'verify_starting': return alertBox('bad', 'Akrio Verify is starting up', 'Nothing was saved. Try again in a minute.');
      case 'no_extension': return alertBox('bad', 'Browser extension not found', 'Install the Akrio Verify extension in this browser, or reload this page if you have just installed it.');
      case 'old_extension': return alertBox('bad', 'The extension needs updating', error.message + ' Update or reload the extension (chrome://extensions), reload this page and try again.');
      default: return alertBox('bad', 'The bank feed could not be updated', error.message || 'Nothing was saved. Try again.');
    }
  }

  function tile(label, value, sub, tone) {
    const box = el('div', null, 'flex:1 1 170px;border:1px solid #E5EAF2;border-radius:10px;padding:12px 14px;background:#fff;');
    box.appendChild(el('div', label, 'font-size:0.68rem;letter-spacing:0.06em;text-transform:uppercase;color:#7C8FAC;font-weight:600;'));
    box.appendChild(el('div', value, 'font-size:1.35rem;font-weight:700;margin-top:2px;font-variant-numeric:tabular-nums;color:' + (tone === 'bad' ? '#B42318' : tone === 'warn' ? '#B25E09' : '#2A3547') + ';'));
    if (sub) box.appendChild(el('div', sub, 'font-size:0.72rem;color:#7C8FAC;margin-top:2px;'));
    return box;
  }

  function timeAgo(date, now) {
    const minutes = Math.round((now - date) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + ' min ago';
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    const days = Math.round(hours / 24);
    return days + (days === 1 ? ' day ago' : ' days ago');
  }
  // The full date and time, UK order, so a stale reading says exactly when it was taken (no year is ever guessed:
  // it is the stored instant).
  const whenRead = date => date.toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  function renderReading(body, data) {
    body.textContent = '';
    const reading = data.reading;
    const link = bankingLink(data.booksHost, data.orgId);
    if (!reading) {
      body.appendChild(alertBox('muted', 'No reading yet', 'Click "Update from Zoho Books" while you are signed in to Zoho Books to read this client\'s Banking page.', link));
      return;
    }
    const readAt = new Date(reading.readAt);
    const now = Date.now();
    if (reading.freshness === 'stale') {
      body.appendChild(alertBox('warn', 'This reading is out of date',
        'It was taken ' + timeAgo(readAt, now) + ' (' + whenRead(readAt) + '), more than ' + data.staleAfterDays
        + ' days ago. Zoho Books may show different figures now. Click "Update from Zoho Books" for a fresh reading.'));
    }
    const tiles = el('div', null, 'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px;');
    tiles.appendChild(tile('Uncategorised', String(reading.uncategorisedTotal), 'transactions waiting in Zoho Books', reading.uncategorisedTotal > 0 ? 'warn' : null));
    tiles.appendChild(tile('Bank accounts', String(reading.accounts.length), 'active accounts on the Banking page'));
    tiles.appendChild(tile('Read', timeAgo(readAt, now), whenRead(readAt) + (reading.readByName ? ' · by ' + reading.readByName : ''), reading.freshness === 'stale' ? 'warn' : null));
    body.appendChild(tiles);
    if (reading.summaryDiffers) {
      body.appendChild(alertBox('muted', 'Zoho\'s own total is different',
        'Zoho Books\' summary said ' + reading.summaryTotal + ' uncategorised transactions; the active accounts below add up to '
        + reading.uncategorisedTotal + '. Inactive accounts are hidden on the Banking page and may hold the rest.'));
    }
    const wrap = el('div', null, 'overflow-x:auto;');
    const table = el('table', null, 'width:100%;border-collapse:collapse;font-size:0.8rem;');
    const head = el('tr');
    ['Bank account', 'Uncategorised', 'Amount in Bank', 'Amount in Zoho Books', 'Difference', 'Bank feed'].forEach((label, i) => {
      head.appendChild(el('th', label, 'padding:8px 10px;border-bottom:1px solid #E5EAF2;color:#5A6A85;font-weight:600;' + (i > 0 && i < 5 ? NUM : 'text-align:left;')));
    });
    const thead = el('thead'); thead.appendChild(head); table.appendChild(thead);
    const tbody = el('tbody');
    for (const account of reading.accounts) {
      const row = el('tr');
      const cell = (content, style) => { const td = el('td', null, 'padding:8px 10px;border-bottom:1px solid #F2F4F8;' + (style || '')); if (content instanceof Node) td.appendChild(content); else td.textContent = content; row.appendChild(td); return td; };
      const name = el('div');
      name.appendChild(el('div', account.accountName, 'font-weight:600;color:#2A3547;'));
      if (account.accountNumber) name.appendChild(el('div', account.accountNumber, 'font-size:0.72rem;color:#7C8FAC;'));
      cell(name);
      cell(String(account.uncategorised), NUM + (account.uncategorised > 0 ? 'color:#B25E09;font-weight:600;' : ''));
      // Rule (see services/zohoBankScreenReading.js): a bank amount of 0.00 is what Zoho shows when no feed is
      // connected, so it is shown as "not available" and no difference is worked out from it.
      if (account.bankFeed === 'not_available') {
        cell('Not available', NUM + 'color:#7C8FAC;').title = 'Zoho Books shows ' + money(0, account.currency) + ': no bank feed, so no statement balance is available.';
      } else {
        cell(money(account.amountInBank, account.currency), NUM);
      }
      cell(money(account.amountInBooks, account.currency), NUM);
      cell(account.difference == null ? '—' : money(account.difference, account.currency), NUM + (account.difference ? 'color:#B42318;font-weight:600;' : ''));
      const feed = account.bankFeed === 'not_available'
        ? badge('No bank feed / statement balance not available', 'muted')
        : account.difference ? badge('Balances differ', 'bad') : badge('Balances agree', 'good');
      cell(feed);
      tbody.appendChild(row);
    }
    table.appendChild(tbody); wrap.appendChild(table); body.appendChild(wrap);
    const foot = el('div', null, 'font-size:0.72rem;color:#7C8FAC;margin-top:10px;line-height:1.45;');
    foot.textContent = 'As shown on Zoho Books\' Banking page. Zoho shows 0.00 in "Amount in Bank" for an account with no bank feed, '
      + 'so those accounts are shown as "not available" rather than as a difference. Zoho gives no statement date on this page.';
    body.appendChild(foot);
    if (link) {
      const anchor = el('a', link.label, 'display:inline-block;margin-top:8px;font-size:0.78rem;font-weight:600;');
      anchor.href = link.href; anchor.target = '_blank'; anchor.rel = 'noopener';
      body.appendChild(anchor);
    }
  }

  // ---- screen vs Zoho's API (services/zohoBankComparison.js works the comparison out; this only draws it) ----
  const MARKS = {
    equal: ['✓', 'color:#0B8F76;font-weight:700;'],
    no_feed: ['✓', 'color:#0B8F76;font-weight:700;'],
    differ: ['✗', 'color:#B42318;font-weight:700;'],
    missing: ['—', 'color:#7C8FAC;'],
  };
  const countText = value => (value == null ? '—' : String(value));
  function comparisonCell(cell, kind, screenCurrency, apiCurrency) {
    const td = el('td', null, 'padding:8px 10px;border-bottom:1px solid #F2F4F8;vertical-align:top;' + NUM);
    const show = kind === 'count' ? countText : (value, currency) => money(value, currency);
    const line = (label, value) => {
      const div = el('div', null, 'font-size:0.76rem;');
      div.appendChild(el('span', label + ' ', 'color:#7C8FAC;'));
      div.appendChild(el('span', value));
      return div;
    };
    if (cell.status === 'no_feed') {
      td.appendChild(el('div', 'No bank feed', 'color:#5A6A85;'));
    } else {
      td.appendChild(line('Screen', show(cell.screen, screenCurrency)));
      td.appendChild(line('API', show(cell.api, apiCurrency || screenCurrency)));
    }
    const mark = MARKS[cell.status] || MARKS.missing;
    const verdict = el('div', null, 'margin-top:2px;font-size:0.76rem;');
    verdict.appendChild(el('span', mark[0], mark[1]));
    if (cell.status === 'differ') {
      verdict.appendChild(el('span', ' ' + (kind === 'count' ? (cell.difference > 0 ? '+' : '') + cell.difference
        : money(cell.difference, screenCurrency || apiCurrency)), 'color:#B42318;font-weight:600;'));
    } else if (cell.status === 'missing' && cell.reasonText) {
      verdict.appendChild(el('span', ' ' + cell.reasonText, 'color:#7C8FAC;'));
    }
    td.appendChild(verdict);
    return td;
  }

  function renderComparison(container, comparison) {
    container.textContent = '';
    container.appendChild(el('div', 'Zoho Books screen compared with Zoho\'s API', 'font-weight:700;font-size:0.85rem;color:#2A3547;margin:18px 0 6px;'));
    const times = comparison.times || {};
    const when = value => (value ? whenRead(new Date(value)) : 'never');
    let timeText = 'Screen read: ' + when(times.readAt) + ' · API sync: ' + when(times.syncedAt);
    if (times.apiFiguresEarlier) timeText += ' · API bank figures: from an earlier sync (time unknown)';
    if (times.newer === 'screen') timeText += ' · the screen reading is newer';
    else if (times.newer === 'api') timeText += ' · the API sync is newer';
    container.appendChild(el('div', timeText, 'font-size:0.74rem;color:#7C8FAC;margin-bottom:8px;'));
    if (comparison.differentTimes) {
      container.appendChild(alertBox('warn', 'Read at different times', times.apiFiguresEarlier
        ? 'Zoho\'s API bank figures were not read at the last sync (' + when(times.syncedAt) + '); they come from an earlier sync, time unknown. '
          + 'The figures are compared anyway, but Zoho Books may have changed in between. Sync again for current API figures.'
        : 'The screen reading (' + when(times.readAt) + ') is older than the last sync from Zoho\'s API (' + when(times.syncedAt)
        + '). The figures are compared anyway, but Zoho Books may have changed in between. Click "Update from Zoho Books" for a fresh reading.'));
    }
    if (comparison.apiState === 'not_authorized') {
      container.appendChild(alertBox('bad', 'Reconnect Zoho Books to allow bank access',
        'Zoho\'s API refused Akrio Verify the bank accounts, so the screen figures cannot be compared with it.',
        { label: 'Reconnect Zoho Books', href: (container.dataset.basePath || '') + '/auth/zoho/connect' }));
    }
    const overall = comparison.overall || {};
    const tone = overall.state === 'agree' ? 'color:#0B8F76;' : overall.state === 'differ' ? 'color:#B42318;' : 'color:#5A6A85;';
    container.appendChild(el('div', overall.text || '', 'font-weight:700;font-size:0.82rem;margin-bottom:8px;' + tone));
    if (!comparison.rows || !comparison.rows.length) return;
    const wrap = el('div', null, 'overflow-x:auto;');
    const table = el('table', null, 'width:100%;border-collapse:collapse;font-size:0.8rem;');
    const head = el('tr');
    ['Bank account', 'Amount in Zoho Books', 'Amount in Bank', 'Uncategorised'].forEach((label, i) => {
      head.appendChild(el('th', label, 'padding:8px 10px;border-bottom:1px solid #E5EAF2;color:#5A6A85;font-weight:600;' + (i ? NUM : 'text-align:left;')));
    });
    const thead = el('thead'); thead.appendChild(head); table.appendChild(thead);
    const tbody = el('tbody');
    for (const row of comparison.rows) {
      const tr = el('tr');
      const name = el('td', null, 'padding:8px 10px;border-bottom:1px solid #F2F4F8;vertical-align:top;');
      name.appendChild(el('div', row.accountName, 'font-weight:600;color:#2A3547;'));
      if (row.accountNumber) name.appendChild(el('div', row.accountNumber, 'font-size:0.72rem;color:#7C8FAC;'));
      if (row.kind === 'only_screen') name.appendChild(badge('Only on screen', 'warn'));
      if (row.kind === 'only_api') name.appendChild(badge(row.apiInactive ? 'Only in API (inactive in Zoho)' : 'Only in API', row.apiInactive ? 'muted' : 'warn'));
      if (row.differentTimes) name.appendChild(badge('Read at different times', 'muted'));
      if (row.currencyDiffers) name.appendChild(el('div', 'Currency on screen ' + row.screenCurrency + ', in the API ' + row.apiCurrency, 'font-size:0.72rem;color:#B25E09;'));
      if (row.apiStale) name.appendChild(el('div', 'API figures carried from an earlier sync', 'font-size:0.72rem;color:#7C8FAC;'));
      tr.appendChild(name);
      tr.appendChild(comparisonCell(row.books, 'amount', row.screenCurrency, row.apiCurrency));
      tr.appendChild(comparisonCell(row.bank, 'amount', row.screenCurrency, row.apiCurrency));
      tr.appendChild(comparisonCell(row.uncategorised, 'count', row.screenCurrency, row.apiCurrency));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody); wrap.appendChild(table); container.appendChild(wrap);
    container.appendChild(el('div', 'Amounts are in each account\'s own currency and agree when within half a cent; differences are screen minus API. '
      + 'Uncategorised counts must be equal. "No bank feed": Amount in Bank is 0.00 with no feed on both sides, counted as agreeing.',
    'font-size:0.72rem;color:#7C8FAC;margin-top:8px;line-height:1.45;'));
  }

  const STAGES = {
    opening: { at: 8, upTo: 35, label: 'Opening Zoho Books…' },
    loaded: { at: 40, upTo: 55, label: 'Zoho Books is open. Waiting for the bank accounts to load…' },
    reading: { at: 58, upTo: 88, label: 'Reading the bank accounts…' },
    saving: { at: 90, upTo: 99, label: 'Saving to Akrio Verify…' },
  };
  function progressBar() {
    const wrap = el('div', null, 'padding:14px 16px 0;');
    const label = el('div', '', 'font-size:0.78rem;color:#5A6A85;margin-bottom:6px;');
    const track = el('div', null, 'height:8px;border-radius:999px;background:#E5EAF2;overflow:hidden;');
    const fill = el('div', null, 'height:100%;width:0%;border-radius:999px;background:#5D87FF;transition:width 0.4s ease;');
    track.setAttribute('role', 'progressbar'); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
    track.appendChild(fill); wrap.appendChild(label); wrap.appendChild(track); wrap.hidden = true;
    let value = 0, ceiling = 0, timer = null;
    const paint = () => { fill.style.width = value + '%'; track.setAttribute('aria-valuenow', String(Math.round(value))); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    return {
      element: wrap,
      start() { stop(); value = 0; ceiling = 0; fill.style.background = '#5D87FF'; paint(); wrap.hidden = false;
        timer = setInterval(() => { if (value < ceiling) { value = Math.min(ceiling, value + Math.max(0.3, (ceiling - value) * 0.06)); paint(); } }, 400); },
      stage(name) { const stage = STAGES[name]; if (!stage) return; value = Math.max(value, stage.at); ceiling = stage.upTo; label.textContent = stage.label; paint(); },
      done() { stop(); value = 100; label.textContent = 'Done.'; fill.style.background = '#13B89A'; paint(); setTimeout(() => { wrap.hidden = true; }, 1500); },
      fail() { stop(); wrap.hidden = true; },
    };
  }

  async function setUpClientCard(card) {
    const base = card.dataset.basePath || '';
    const tenantId = card.dataset.tenantId;
    const body = card.querySelector('[data-zoho-bank-screen-body]');
    const button = card.querySelector('[data-zoho-bank-screen-update]');
    const note = card.querySelector('[data-zoho-bank-screen-note]');
    let data;
    const load = async () => {
      data = await getJson(base + '/api/bank-screen/zoho/latest/' + encodeURIComponent(tenantId));
      renderReading(body, data);
      // The comparison with Zoho's API is extra: if it cannot be loaded, the reading above still stands.
      const compared = el('div');
      compared.dataset.basePath = base;
      body.appendChild(compared);
      try {
        const answer = await getJson(base + '/api/bank-screen/zoho/comparison/' + encodeURIComponent(tenantId));
        renderComparison(compared, answer.comparison);
      } catch (error) {
        compared.appendChild(el('div', 'The comparison with Zoho\'s API could not be loaded: ' + error.message, 'font-size:0.75rem;color:#7C8FAC;margin-top:12px;'));
      }
    };
    try { await load(); } catch (error) { body.textContent = error.message; return; }
    const progress = progressBar();
    body.parentNode.insertBefore(progress.element, body);
    const failures = el('div', null, 'padding:16px 16px 0;');
    failures.hidden = true;
    body.parentNode.insertBefore(failures, body);
    const showFailure = error => { failures.textContent = ''; failures.appendChild(failureBox(error, bankingLink(data.booksHost, data.orgId))); failures.hidden = false; note.textContent = ''; };
    button.addEventListener('click', async () => {
      failures.hidden = true; note.textContent = ''; note.style.color = '#5A6A85';
      button.disabled = true; button.textContent = 'Reading Zoho Books…';
      try {
        await readyExtension();
        progress.start();
        await updateOne(base, card.dataset.csrf, tenantId, data.orgId, data.booksHost, progress.stage);
        await load();
        progress.done();
        // The bank checks are worked out by the sync, so they use this reading from the next sync on.
        note.style.color = '#0B8F76'; note.textContent = 'Updated just now. The bank checks use it from the next sync.';
      } catch (error) {
        progress.fail();
        showFailure(error);
      } finally { button.disabled = false; button.textContent = 'Update from Zoho Books'; }
    });
  }

  // Dashboard panel: read every Zoho Books client the staff member can access, one after another, each in a
  // background tab of this browser that the extension opens and closes again (as the Xero run does). Clients read in
  // the last hour are left alone, so a stopped run carries on where it stopped.
  function setUpAllClients(panel) {
    const base = panel.dataset.basePath || '';
    const RECENT_MS = 60 * 60 * 1000;
    const STOP_REASONS = {
      not_signed_in: ['Zoho Books is not signed in', 'Sign in to Zoho Books in this browser, then start again. Clients already read are kept.'],
      zoho_access_needed: ['Allow the extension to open Zoho Books', 'The extension has opened a tab: click "Allow Zoho Books" there, then start again.'],
      verify_signed_out: ['Akrio Verify is signed out', 'Sign in to Akrio Verify again, then start again.'],
      verify_starting: ['Akrio Verify is starting up', 'Start again in a minute. Clients already read are kept.'],
    };
    const show = (node, visible) => { node.style.display = visible ? '' : 'none'; };
    const head = el('div', null, 'display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;');
    const titles = el('div', null, 'flex:1 1 320px;');
    titles.appendChild(el('div', 'Bank feeds from Zoho Books', 'font-weight:700;font-size:0.95rem;color:#2A3547;'));
    titles.appendChild(el('div', 'Reads uncategorised transactions and bank balances from the Banking page of every Zoho Books client through the browser extension. Stay signed in to Zoho Books and keep this tab open while it runs.', 'font-size:0.75rem;color:#7C8FAC;margin-top:2px;'));
    const actions = el('div', null, 'display:flex;gap:8px;align-items:center;');
    const start = el('button', 'Update all Zoho clients'); start.type = 'button'; start.className = 'btn btn-primary btn-sm';
    const stop = el('button', 'Stop'); stop.type = 'button'; stop.className = 'btn btn-outlined btn-sm'; show(stop, false);
    actions.appendChild(stop); actions.appendChild(start);
    head.appendChild(titles); head.appendChild(actions); panel.appendChild(head);
    const status = el('div', '', 'margin-top:10px;font-size:0.78rem;color:#5A6A85;'); show(status, false); panel.appendChild(status);
    const stopBox = el('div', null, 'margin-top:12px;'); show(stopBox, false); panel.appendChild(stopBox);
    const failList = el('div', null, 'margin-top:8px;'); panel.appendChild(failList);
    let stopRequested = false;
    stop.addEventListener('click', () => { stopRequested = true; stop.disabled = true; stop.textContent = 'Stopping…'; });

    start.addEventListener('click', async () => {
      show(stopBox, false); stopBox.textContent = ''; failList.textContent = '';
      try { await readyExtension(); } catch (error) { stopBox.appendChild(failureBox(error)); show(stopBox, true); return; }
      start.disabled = true; start.textContent = 'Updating…';
      stop.disabled = false; stop.textContent = 'Stop'; show(stop, true);
      stopRequested = false; show(status, true); status.textContent = 'Getting the client list…';
      let done = 0, failed = 0, skipped = 0, total = 0, stoppedBy = null;
      try {
        const { organisations } = await getJson(base + '/api/bank-screen/zoho/organisations');
        total = organisations.length;
        const runStartedAt = Date.now();
        const recentIds = new Set(organisations
          .filter(org => org.lastReadAt && runStartedAt - Date.parse(org.lastReadAt) < RECENT_MS).map(org => org.tenantId));
        skipped = recentIds.size;
        for (const org of organisations) {
          if (stopRequested) break;
          if (recentIds.has(org.tenantId)) continue;
          status.textContent = 'Reading ' + (done + failed + skipped + 1) + ' of ' + total + ' · ' + org.name;
          try {
            await updateOne(base, panel.dataset.csrf, org.tenantId, org.orgId, org.booksHost);
            done++;
          } catch (error) {
            failed++;
            const row = el('div', null, 'display:flex;gap:10px;padding:6px 0;border-top:1px solid #F7DAD3;font-size:0.78rem;');
            const link = el('a', org.name, 'flex:0 0 240px;font-weight:600;'); link.href = base + '/client/' + encodeURIComponent(org.tenantId);
            row.appendChild(link); row.appendChild(el('span', error.message, 'color:#7A271A;'));
            failList.appendChild(row);
            if (STOP_REASONS[error.code]) { stoppedBy = error.code; stopRequested = true; }
          }
        }
      } catch (error) {
        stopBox.appendChild(alertBox('bad', 'The update could not start', error.message)); show(stopBox, true);
      } finally {
        show(stop, false);
        start.disabled = false; start.textContent = 'Update all Zoho clients';
        if (stoppedBy) { stopBox.appendChild(alertBox('bad', STOP_REASONS[stoppedBy][0], STOP_REASONS[stoppedBy][1])); show(stopBox, true); }
        const notAttempted = Math.max(0, total - done - failed - skipped);
        status.textContent = total
          ? (notAttempted ? 'Stopped before the end: ' : 'Finished: ') + done + ' updated'
            + (skipped ? ', ' + skipped + ' already read in the last hour' : '') + (failed ? ', ' + failed + ' failed' : '')
            + (notAttempted ? ', ' + notAttempted + ' not attempted' : '') + '.'
          : 'No Zoho Books clients to update.';
      }
    });
  }

  document.querySelectorAll('[data-zoho-bank-screen-card]').forEach(setUpClientCard);
  document.querySelectorAll('[data-zoho-bank-screen-all]').forEach(setUpAllClients);
})();
