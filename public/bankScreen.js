// Page side of the "bank feed read from Xero's screen" feature. It asks the Akrio Verify browser
// extension to read one client's Xero Bank accounts page, saves the answer to Verify, and shows the
// latest saved reading. Used on the client page (one client) and the dashboard (all clients).
(function () {
  'use strict';
  const FROM_PAGE = 'akrio-verify-page';
  const FROM_EXTENSION = 'akrio-verify-extension';
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
      const requestId = 'r' + Date.now() + '-' + (++counter);
      const timer = setTimeout(() => { pending.delete(requestId); resolve(null); }, timeoutMs);
      pending.set(requestId, { onProgress, finish: data => { clearTimeout(timer); resolve(data); } });
      window.postMessage({ source: FROM_PAGE, requestId, ...message }, window.location.origin);
    });
  }

  // The extension's helper is only added once this page has finished loading, which on a busy page can take
  // several seconds. Ask a few times before deciding it is missing, so the "Add the extension" banner never
  // shows to someone who has it. The answer is remembered for the rest of the page's life.
  let installedCheck = null;
  const extensionInstalled = () => {
    if (!installedCheck) {
      installedCheck = (async () => {
        for (let attempt = 0; attempt < 8; attempt++) {
          if (await askExtension({ type: 'PING' }, 1000)) return true;
        }
        return false;
      })().then(found => { if (!found) installedCheck = null; return found; });
    }
    return installedCheck;
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
      // Only a bounce to the login page means the Verify session has ended; anything else is a server hiccup.
      if (response.redirected && /\/login(\?|$)/.test(response.url)) throw problem('verify_signed_out', 'Your Akrio Verify session has ended. Sign in to Akrio Verify again.');
      if (response.status === 503) throw problem('verify_starting', 'Akrio Verify is starting up. Try again in a minute.');
      throw problem('verify_error', 'Akrio Verify gave an unexpected answer (status ' + response.status + '). Nothing was saved for this client.');
    }
    const body = await response.json();
    if (!response.ok) throw problem(response.status === 503 ? 'verify_starting' : 'verify_refused', body.error || 'Akrio Verify could not save the reading.');
    return body;
  }

  // Reads one client in Xero through the extension and saves it. Throws an Error with a plain message.
  async function updateOne(base, csrfToken, tenantId, shortCode, onStage = () => {}) {
    onStage('opening');
    const answer = await askExtension({ type: 'READ_BANK_PAGE', shortCode }, 150000, onStage);
    if (!answer) throw new Error('The extension did not answer in time.');
    if (!answer.ok) { const error = new Error(answer.message || 'Xero could not be read.'); error.code = answer.error; throw error; }
    onStage('saving');
    const save = () => getJson(base + '/api/bank-screen/readings', {
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

  // A progress bar that follows the real stages of a read. Between stages it creeps forward slowly, so it keeps
  // moving while Xero's page loads but never reaches the next stage's mark before that stage really starts.
  const STAGES = {
    opening: { at: 8, upTo: 35, label: 'Opening Xero…' },
    loaded: { at: 40, upTo: 55, label: 'Xero is open. Waiting for the bank accounts to load…' },
    reading: { at: 58, upTo: 88, label: 'Reading the bank accounts…' },
    saving: { at: 92, upTo: 97, label: 'Saving to Akrio Verify…' },
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

  const money = value => (value == null ? '—' : (value < 0 ? '(' : '') + Math.abs(value).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (value < 0 ? ')' : ''));
  const el = (tag, text, style) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (style) node.style.cssText = style; return node; };

  function feedStatus(account) {
    if (account.stoppedImporting) return { label: 'Stopped importing', tone: 'bad' };
    if (account.feedProblem) return { label: 'Feed problem', tone: 'bad' };
    if (account.noFeed) return { label: 'No bank feed', tone: 'muted' };
    // Xero only tells us when something is wrong; an account with no warning is not proven to have a live feed.
    return { label: 'No problem shown', tone: 'good' };
  }

  const TONES = {
    bad: 'background:#FDEDE8;color:#B42318;',
    warn: 'background:#FEF5E5;color:#B25E09;',
    good: 'background:#E6FFFA;color:#0B8F76;',
    muted: 'background:#EEF1F6;color:#5A6A85;',
  };
  const badge = (label, tone) => el('span', label, 'display:inline-block;padding:2px 10px;border-radius:999px;font-size:0.72rem;font-weight:600;white-space:nowrap;' + TONES[tone]);
  const NUM = 'text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;';

  function timeAgo(date, now) {
    const minutes = Math.round((now - date) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + ' min ago';
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    const days = Math.round(hours / 24);
    return days + (days === 1 ? ' day ago' : ' days ago');
  }

  const ALERT_TONES = {
    bad: 'background:#FDEDE8;border:1px solid #F7C6BB;color:#7A271A;',
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

  // A plain title and next step for each way a read can fail.
  function failureBox(error) {
    const XERO_LOGIN = { label: 'Open Xero sign-in', href: 'https://login.xero.com/' };
    switch (error.code) {
      case 'not_signed_in': return alertBox('bad', 'Xero is not signed in', 'Sign in to Xero in this browser, then click "Update from Xero" again.', XERO_LOGIN);
      case 'wrong_organisation': return alertBox('bad', 'Xero did not open this client', 'Your Xero login may not have access to this client. Check you are signed in to Xero with the practice login that can open it.', XERO_LOGIN);
      case 'timeout': case 'not_settled': return alertBox('bad', 'Xero took too long to load', 'Nothing was saved. Xero is slow at the moment. Try again in a minute.');
      case 'xero_error': return alertBox('bad', 'Xero cannot show this page right now', 'Xero itself is showing an error for this client\'s Bank accounts page. Nothing was saved. Try again later.');
      case 'not_readable': case 'unexpected_page': return alertBox('bad', 'Xero\'s Bank accounts page could not be read', 'Nothing was saved. Open the client in Xero to check the Bank accounts page loads, then try again.');
      case 'page_changed': return alertBox('bad', 'Xero has changed its page', error.message || 'Nothing was saved. The extension needs an update: please tell Aditya.');
      case 'verify_signed_out': return alertBox('bad', 'Akrio Verify is signed out', 'Sign in to Akrio Verify again, then click "Update from Xero".');
      case 'verify_starting': return alertBox('bad', 'Akrio Verify is starting up', 'Nothing was saved. Try again in a minute.');
      case 'no_extension': return alertBox('bad', 'Browser extension not found', 'Install the Akrio Verify extension in this browser, or reload this page if you have just installed it.');
      case 'no_short_code': return alertBox('bad', 'This client has not been synced yet', 'Run a sync for this client first, then try again.');
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

  // ---- "items to reconcile" list: read live from Xero when someone clicks a count ----
  // The lines are not saved anywhere; each click reads Xero's "Bank statements" tab for that account afresh.
  const LINES_VERSION = [1, 3, 0]; // the first extension version that can read statement lines
  async function extensionVersion() {
    for (let attempt = 0; attempt < 8; attempt++) {
      const answer = await askExtension({ type: 'PING' }, 1000);
      if (answer) return String(answer.version || '0');
    }
    return null;
  }
  const versionAtLeast = (version, wanted) => {
    const parts = String(version).split('.').map(Number);
    for (let i = 0; i < wanted.length; i++) {
      if ((parts[i] || 0) > wanted[i]) return true;
      if ((parts[i] || 0) < wanted[i]) return false;
    }
    return true;
  };
  const ukDate = iso => { const [y, m, d] = iso.split('-'); return d + '/' + m + '/' + y; };
  const ageDays = iso => Math.max(0, Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(iso)) / 86400000));
  let linesBusy = false;

  function linesTable(lines) {
    const wrap = el('div', null, 'overflow:auto;max-height:52vh;border:1px solid #E5EAF2;border-radius:8px;');
    const table = el('table'); table.className = 'data-table'; table.style.width = '100%';
    const head = el('tr');
    [['Date', ''], ['Age', NUM], ['Particulars', ''], ['Reference', ''], ['Spent', NUM], ['Received', NUM]]
      .forEach(([title, style]) => head.appendChild(el('th', title, style + 'position:sticky;top:0;background:#F2F6FA;')));
    const thead = el('thead'); thead.appendChild(head); table.appendChild(thead);
    const tbody = el('tbody');
    for (const line of lines) {
      const row = el('tr');
      row.appendChild(el('td', ukDate(line.date), 'white-space:nowrap;'));
      const days = ageDays(line.date);
      row.appendChild(el('td', days + (days === 1 ? ' day' : ' days'), NUM + (days > 30 ? 'color:#B42318;font-weight:600;' : 'color:#5A6A85;')));
      const what = el('td');
      what.appendChild(el('div', line.particulars || line.payee || '—', 'color:#2A3547;'));
      if (line.payee && line.particulars) what.appendChild(el('div', line.payee, 'font-size:0.72rem;color:#7C8FAC;'));
      row.appendChild(what);
      row.appendChild(el('td', [line.reference, line.code].filter(Boolean).join(' · ') || '—', 'color:#5A6A85;'));
      row.appendChild(el('td', line.spent == null ? '' : money(line.spent), NUM));
      row.appendChild(el('td', line.received == null ? '' : money(line.received), NUM));
      tbody.appendChild(row);
    }
    table.appendChild(tbody); wrap.appendChild(table);
    return wrap;
  }

  // accounts: the accounts whose lines to show (one when a row's count is clicked, all with items from the tile).
  function linesCsv(accountName, lines) {
    const cell = value => '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
    const rows = [['Bank account', 'Date', 'Age (days)', 'Type', 'Payee', 'Particulars', 'Code', 'Reference', 'Spent', 'Received', 'Source']];
    for (const line of lines) rows.push([accountName, ukDate(line.date), ageDays(line.date), line.type, line.payee, line.particulars, line.code, line.reference, line.spent, line.received, line.source]);
    return rows.map(row => row.map(cell).join(',')).join('\r\n');
  }
  function downloadButton(accountName, lines) {
    const button = el('button', 'Download CSV'); button.type = 'button'; button.className = 'btn btn-outlined btn-sm';
    button.addEventListener('click', () => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob(['\uFEFF' + linesCsv(accountName, lines)], { type: 'text/csv;charset=utf-8' }));
      link.download = 'items-to-reconcile-' + accountName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) + '.csv';
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    });
    return button;
  }

  // context: { base, csrf, tenantId } of the client card, used to save the list to Akrio Verify.
  async function openLinesDialog(shortCode, accounts, context = {}) {
    const dialog = el('dialog', null, 'border:none;border-radius:12px;padding:0;width:min(980px,94vw);max-height:90vh;box-shadow:0 20px 60px rgba(20,30,50,0.35);');
    const header = el('div', null, 'display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:16px 20px;border-bottom:1px solid #E5EAF2;background:#F2F6FA;');
    const titles = el('div');
    titles.appendChild(el('div', 'Items to reconcile', 'font-weight:700;font-size:1rem;color:#2A3547;'));
    titles.appendChild(el('div', 'Bank statement lines Xero lists as Unreconciled, read from Xero just now. Nothing is changed in Xero.', 'font-size:0.75rem;color:#7C8FAC;margin-top:2px;'));
    const close = el('button', 'Close'); close.type = 'button'; close.className = 'btn btn-outlined btn-sm';
    header.appendChild(titles); header.appendChild(close);
    const content = el('div', null, 'padding:16px 20px;overflow:auto;max-height:calc(90vh - 80px);');
    dialog.appendChild(header); dialog.appendChild(content);
    document.body.appendChild(dialog);
    let closed = false;
    const afterClose = () => { if (context.saved) { window.location.hash = 'bank-screen'; window.location.reload(); } };
    const shut = () => { closed = true; if (dialog.open) dialog.close(); dialog.remove(); afterClose(); };
    close.addEventListener('click', shut);
    dialog.addEventListener('close', () => { if (!closed) { closed = true; dialog.remove(); afterClose(); } });
    dialog.addEventListener('click', event => { if (event.target === dialog) shut(); });
    dialog.showModal();

    const version = await extensionVersion();
    if (!version) { content.appendChild(failureBox({ code: 'no_extension' })); return; }
    if (!versionAtLeast(version, LINES_VERSION)) {
      content.appendChild(alertBox('bad', 'The browser extension needs updating',
        'Listing the items needs version ' + LINES_VERSION.join('.') + ' of the Akrio Verify extension; this browser has ' + version + '. Update or reload the extension (chrome://extensions), reload this page and try again.'));
      return;
    }
    if (linesBusy) { content.appendChild(alertBox('muted', 'Another list is still being read', 'Wait for it to finish, then try again.')); return; }
    linesBusy = true;
    try {
      for (const account of accounts) {
        if (closed) return;
        const section = el('div', null, 'margin-bottom:22px;');
        const heading = el('div', null, 'display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:8px;');
        heading.appendChild(el('div', account.accountName, 'font-weight:700;color:#2A3547;'));
        const summary = el('div', 'Xero shows ' + account.itemsToReconcile.toLocaleString('en-GB') + ' to reconcile', 'font-size:0.78rem;color:#5A6A85;');
        heading.appendChild(summary); section.appendChild(heading);
        const progress = progressBar(); progress.element.style.padding = '0 0 8px';
        section.appendChild(progress.element);
        content.appendChild(section);
        progress.start();
        const answer = await askExtension({ type: 'READ_BANK_LINES', shortCode, accountName: account.accountName }, 150000, progress.stage);
        if (closed) return;
        if (!answer || !answer.ok) {
          progress.fail();
          const error = answer ? { code: answer.error, message: answer.message } : { message: 'The extension did not answer in time.' };
          section.appendChild(['not_signed_in', 'wrong_organisation', 'timeout', 'page_changed'].includes(error.code)
            ? failureBox(error) : alertBox('bad', 'The items could not be listed', error.message || 'Try again.'));
          if (error.code === 'not_signed_in') return; // every further account would fail the same way
          continue;
        }
        progress.done();
        const lines = answer.lines.lines;
        const spent = lines.reduce((sum, line) => sum + (line.spent || 0), 0);
        const received = lines.reduce((sum, line) => sum + (line.received || 0), 0);
        const oldest = lines.reduce((min, line) => (min == null || line.date < min ? line.date : min), null);
        summary.textContent = lines.length.toLocaleString('en-GB') + (lines.length === 1 ? ' line' : ' lines')
          + ' · spent ' + money(spent) + ' · received ' + money(received)
          + (oldest ? ' · oldest ' + ukDate(oldest) + ' (' + ageDays(oldest) + ' days)' : '');
        if (answer.lines.truncated) {
          section.appendChild(alertBox('muted', 'Only the first ' + lines.length.toLocaleString('en-GB') + ' lines are listed',
            'Xero has ' + (answer.lines.totalShownByXero != null ? answer.lines.totalShownByXero.toLocaleString('en-GB') : 'more') + ' unreconciled lines on this account. Open the account in Xero to see them all.'));
        } else if (lines.length !== account.itemsToReconcile) {
          section.appendChild(alertBox('muted', 'The number has changed since the last update',
            'The last "Update from Xero" showed ' + account.itemsToReconcile.toLocaleString('en-GB') + ' to reconcile; Xero lists ' + lines.length.toLocaleString('en-GB') + ' unreconciled statement lines now. Click "Update from Xero" to refresh the figures on this page.'));
        }
        if (lines.length) {
          const tools = el('div', null, 'display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-bottom:8px;');
          const saved = el('span', '', 'font-size:0.75rem;color:#7C8FAC;');
          tools.appendChild(saved); tools.appendChild(downloadButton(account.accountName, lines));
          section.appendChild(tools);
          section.appendChild(linesTable(lines));
          // Keep the list in Akrio Verify: it gives the Unprocessed Bank check its value and the age of the oldest item.
          if (context.tenantId) {
            getJson((context.base || '') + '/api/bank-screen/lines', {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': context.csrf },
              body: JSON.stringify({ ...answer.lines, tenantId: context.tenantId }),
            }).then(() => { saved.textContent = 'Saved to Akrio Verify'; context.saved = true; })
              .catch(error => { saved.textContent = 'Shown here, but not saved: ' + error.message; });
          }
        } else section.appendChild(el('p', 'Xero lists no unreconciled statement lines for this account now.', 'font-size:0.85rem;color:#5A6A85;margin:0;'));
      }
    } finally { linesBusy = false; }
  }

  function renderReading(body, data, context = {}) {
    body.textContent = '';
    const reading = data.reading;
    if (!reading) {
      body.appendChild(el('p', 'Nothing has been read from Xero for this client yet. Click "Update from Xero" to read it now.', 'color:#7C8FAC;font-size:0.85rem;margin:0;'));
      return;
    }
    const when = new Date(reading.readAt);
    const stale = reading.freshness === 'stale';
    const accounts = reading.accounts;
    const total = accounts.reduce((sum, account) => sum + (account.itemsToReconcile || 0), 0);
    const feedIssues = accounts.filter(account => account.stoppedImporting || account.feedProblem).length;
    const differing = accounts.filter(account => account.balancesDiffer).length;

    if (stale) {
      body.appendChild(el('div', 'This reading is more than ' + data.staleAfterDays + ' days old. Update it before relying on these figures.',
        'background:#FDEDE8;color:#B42318;border-radius:8px;padding:8px 12px;font-size:0.8rem;font-weight:600;margin-bottom:12px;'));
    }
    for (const account of accounts) {
      const since = account.statementDateLabel ? ' The last statement date Xero shows is ' + account.statementDateLabel + '.' : '';
      if (account.stoppedImporting) {
        body.appendChild(alertBox('bad', 'Bank not connected: ' + account.accountName,
          'This account has stopped importing transactions from the bank.' + since + ' Renew the bank connection in Xero (Accounting > Bank accounts > Renew bank connection). Until then, no new transactions reach Xero or Akrio Verify.'));
      } else if (account.feedProblem) {
        body.appendChild(alertBox('bad', 'Bank feed problem: ' + account.accountName,
          'Xero reports a problem with this bank feed.' + since + ' Open the account in Xero and click Details to see what Xero needs.'));
      } else if (account.noFeed) {
        body.appendChild(alertBox('muted', 'No bank feed: ' + account.accountName,
          'This account has no automatic bank feed, so statements only arrive when someone imports them into Xero.' + since));
      }
    }
    const tiles = el('div', null, 'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px;');
    const itemsTile = tile('Items to reconcile', total.toLocaleString('en-GB'), 'across ' + accounts.length + (accounts.length === 1 ? ' bank account' : ' bank accounts') + (total && data.shortCode ? ' · click to list them' : ''), total ? 'warn' : null);
    if (total && data.shortCode) {
      itemsTile.style.cursor = 'pointer'; itemsTile.tabIndex = 0; itemsTile.setAttribute('role', 'button');
      itemsTile.title = 'List the items to reconcile (read from Xero now)';
      const openAll = () => openLinesDialog(data.shortCode, accounts.filter(account => account.itemsToReconcile), context);
      itemsTile.addEventListener('click', openAll);
      itemsTile.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openAll(); } });
    }
    tiles.appendChild(itemsTile);
    tiles.appendChild(tile('Bank feeds with a problem', String(feedIssues), feedIssues ? 'not importing new transactions' : 'Xero shows no bank feed problems', feedIssues ? 'bad' : null));
    tiles.appendChild(tile('Balances that differ', String(differing), 'nothing to reconcile, but Xero and the statement disagree', differing ? 'warn' : null));
    tiles.appendChild(tile('Last read from Xero', timeAgo(when, new Date()), when.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) + (reading.readByName ? ' · ' + reading.readByName : ''), stale ? 'bad' : null));
    body.appendChild(tiles);

    if (!accounts.length) { body.appendChild(el('p', 'Xero showed no bank accounts for this client.', 'font-size:0.85rem;margin:0;')); return; }
    const wrap = el('div'); wrap.className = 'table-wrap'; wrap.style.overflowX = 'auto';
    const table = el('table'); table.className = 'data-table'; table.style.width = '100%';
    const thead = el('thead'); const head = el('tr');
    [['Bank account', ''], ['To reconcile', NUM], ['Balance in Xero', NUM], ['Statement balance', NUM], ['Difference', NUM], ['Statement date', ''], ['Bank feed', '']]
      .forEach(([title, style]) => head.appendChild(el('th', title, style)));
    thead.appendChild(head); table.appendChild(thead);
    const tbody = el('tbody');
    for (const account of accounts) {
      const row = el('tr');
      const name = el('td');
      name.appendChild(el('div', account.accountName, 'font-weight:600;color:#2A3547;'));
      if (account.accountNumber) name.appendChild(el('div', account.accountNumber, 'font-size:0.72rem;color:#7C8FAC;'));
      row.appendChild(name);

      const items = el('td', null, NUM);
      if (account.itemsToReconcile && data.shortCode) {
        const open = el('button', null, 'border:none;background:none;padding:0;cursor:pointer;');
        open.type = 'button'; open.title = 'List these items (read from Xero now)';
        open.setAttribute('aria-label', 'List the ' + account.itemsToReconcile + ' items to reconcile for ' + account.accountName);
        const pill = badge(account.itemsToReconcile.toLocaleString('en-GB') + ' ›', 'warn'); pill.style.textDecoration = 'underline';
        open.appendChild(pill);
        open.addEventListener('click', () => openLinesDialog(data.shortCode, [account], context));
        items.appendChild(open);
      } else if (account.itemsToReconcile) items.appendChild(badge(account.itemsToReconcile.toLocaleString('en-GB'), 'warn'));
      else if (account.itemsToReconcile === 0 || account.reconciled) items.appendChild(badge('Reconciled', 'good'));
      else if (account.balancesDiffer) items.appendChild(badge('0 · balances differ', 'warn'));
      else items.appendChild(el('span', 'Not shown', 'color:#7C8FAC;'));
      row.appendChild(items);

      row.appendChild(el('td', money(account.balanceInXero), NUM));
      row.appendChild(el('td', money(account.statementBalance), NUM));
      const both = account.balanceInXero != null && account.statementBalance != null;
      const difference = both ? Math.round((account.statementBalance - account.balanceInXero) * 100) / 100 : null;
      row.appendChild(el('td', difference == null ? '—' : difference === 0 ? '0.00' : money(difference), NUM + (difference ? 'color:#B25E09;font-weight:600;' : 'color:#7C8FAC;')));
      row.appendChild(el('td', account.statementDateLabel || '—', 'white-space:nowrap;'));
      const status = feedStatus(account);
      const feed = el('td'); feed.appendChild(badge(status.label, status.tone)); row.appendChild(feed);
      tbody.appendChild(row);
    }
    table.appendChild(tbody); wrap.appendChild(table); body.appendChild(wrap);
    body.appendChild(el('p', 'Difference = statement balance less balance in Xero. Xero shows the statement date without a year, so it is shown here exactly as Xero shows it.', 'font-size:0.72rem;color:#7C8FAC;margin:8px 0 0;'));
  }

  async function setUpClientCard(card) {
    const base = card.dataset.basePath || '';
    const tenantId = card.dataset.tenantId;
    const body = card.querySelector('[data-bank-screen-body]');
    const button = card.querySelector('[data-bank-screen-update]');
    const note = card.querySelector('[data-bank-screen-note]');
    let data;
    const load = async () => { data = await getJson(base + '/api/bank-screen/latest/' + encodeURIComponent(tenantId)); renderReading(body, data, { base, csrf: card.dataset.csrf, tenantId }); };
    try { await load(); } catch (error) { body.textContent = error.message; return; }
    const progress = progressBar();
    body.parentNode.insertBefore(progress.element, body);
    extensionInstalled().then(installed => {
      if (installed) return;
      const holder = el('div', null, 'padding:16px 16px 0;'); holder.appendChild(installBanner(storeUrlOf(card)));
      holder.firstChild.style.marginBottom = '0'; body.parentNode.insertBefore(holder, progress.element);
    });
    const failures = el('div');
    body.parentNode.insertBefore(failures, body);
    failures.style.cssText = 'padding:16px 16px 0;';
    failures.hidden = true;
    const showFailure = error => { failures.textContent = ''; failures.appendChild(failureBox(error)); failures.hidden = false; note.textContent = ''; };
    button.addEventListener('click', async () => {
      failures.hidden = true; note.textContent = ''; note.style.color = '#5A6A85';
      if (!data.shortCode) { showFailure({ code: 'no_short_code' }); return; }
      if (!(await extensionInstalled())) { showFailure({ code: 'no_extension' }); return; }
      button.disabled = true; button.textContent = 'Reading Xero…';
      progress.start();
      try {
        const saved = await updateOne(base, card.dataset.csrf, tenantId, data.shortCode, progress.stage);
        await load();
        progress.done();
        note.style.color = '#0B8F76'; note.textContent = 'Updated just now';
        // The Bank Balance and Unprocessed Bank checks on this page were recalculated from the new reading;
        // reload so their results and the health score show it, keeping this card in view.
        if (saved && saved.checksUpdated) {
          note.textContent = 'Updated just now. Refreshing the checks…';
          setTimeout(() => { window.location.hash = 'bank-screen'; window.location.reload(); }, 800);
        }
      } catch (error) {
        progress.fail();
        showFailure(error);
      } finally { button.disabled = false; button.textContent = 'Update from Xero'; }
    });
  }

  // Shown when the extension is not in this browser. The page cannot install it by itself (Chrome does not
  // allow that), so the button opens the extension's Chrome Web Store page, where one click adds it.
  function installBanner(storeUrl) {
    const box = el('div', null, 'display:flex;gap:14px;align-items:center;flex-wrap:wrap;border:1px solid #C9D8FF;background:#F3F7FF;border-radius:10px;padding:12px 14px;margin-bottom:12px;');
    box.setAttribute('role', 'note');
    const words = el('div', null, 'flex:1 1 300px;font-size:0.8rem;color:#2A3547;line-height:1.45;');
    words.appendChild(el('div', 'Add the Akrio Verify extension', 'font-weight:700;margin-bottom:2px;'));
    const steps = el('div', storeUrl
      ? 'Bank feeds are read from Xero by a small browser extension, and it is not in this browser yet. Click "Add extension", then "Add to Chrome" on the page that opens, and come back here.'
      : 'Bank feeds are read from Xero by a small browser extension, and it is not in this browser yet. Ask your Akrio Verify administrator to install it for you.');
    words.appendChild(steps); box.appendChild(words);
    const buttons = el('div', null, 'display:flex;gap:8px;align-items:center;');
    const reload = el('button', 'I have added it'); reload.type = 'button'; reload.className = 'btn btn-outlined btn-sm';
    reload.title = 'Reloads this page so it can find the extension';
    reload.addEventListener('click', () => window.location.reload());
    if (storeUrl) {
      const add = el('a', 'Add extension'); add.className = 'btn btn-primary btn-sm';
      add.href = storeUrl; add.target = '_blank'; add.rel = 'noopener';
      add.addEventListener('click', () => { steps.textContent = 'After clicking "Add to Chrome" on the store page, come back here and click "I have added it".'; });
      buttons.appendChild(add);
    }
    buttons.appendChild(reload); box.appendChild(buttons);
    return box;
  }
  // Chrome Web Store addresses only; anything else is ignored.
  const storeUrlOf = node => (/^https:\/\/chromewebstore\.google\.com\/detail\//.test(node.dataset.storeUrl || '') ? node.dataset.storeUrl : '');

  const duration = seconds => {
    const minutes = Math.round(seconds / 60);
    return minutes < 1 ? 'less than a minute' : 'about ' + minutes + (minutes === 1 ? ' minute' : ' minutes');
  };

  // Dashboard panel: read every client the staff member can access, one after another.
  function setUpAllClients(panel) {
    const base = panel.dataset.basePath || '';
    const RECENT_MS = 60 * 60 * 1000;
    const STOP_REASONS = {
      not_signed_in: ['Xero is not signed in', 'Sign in to Xero in this browser, then start again. Clients already read are kept.'],
      verify_signed_out: ['Akrio Verify is signed out', 'Sign in to Akrio Verify again, then start again.'],
      verify_starting: ['Akrio Verify is starting up', 'Start again in a minute. Clients already read are kept.'],
    };
    const show = (node, visible) => { node.style.display = visible ? '' : 'none'; };

    const head = el('div', null, 'display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;');
    const titles = el('div', null, 'flex:1 1 320px;');
    titles.appendChild(el('div', 'Bank feeds from Xero', 'font-weight:700;font-size:0.95rem;color:#2A3547;'));
    titles.appendChild(el('div', 'Reads items to reconcile, bank balances and feed status for every client through the browser extension. Stay signed in to Xero and keep this tab open while it runs.', 'font-size:0.75rem;color:#7C8FAC;margin-top:2px;'));
    const actions = el('div', null, 'display:flex;gap:8px;align-items:center;');
    const start = el('button', 'Update all clients'); start.type = 'button'; start.className = 'btn btn-primary btn-sm';
    const stop = el('button', 'Stop'); stop.type = 'button'; stop.className = 'btn btn-outlined btn-sm'; show(stop, false);
    actions.appendChild(stop); actions.appendChild(start);
    head.appendChild(titles); head.appendChild(actions); panel.appendChild(head);

    const running = el('div', null, 'margin-top:12px;'); show(running, false);
    const runningLine = el('div', null, 'display:flex;justify-content:space-between;gap:12px;font-size:0.78rem;color:#5A6A85;margin-bottom:6px;');
    const current = el('span'); const eta = el('span', '', 'white-space:nowrap;font-variant-numeric:tabular-nums;');
    runningLine.appendChild(current); runningLine.appendChild(eta);
    const track = el('div', null, 'height:8px;border-radius:999px;background:#E5EAF2;overflow:hidden;');
    const fill = el('div', null, 'height:100%;width:0%;border-radius:999px;background:#5D87FF;transition:width 0.4s ease;');
    track.setAttribute('role', 'progressbar'); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
    track.appendChild(fill); running.appendChild(runningLine); running.appendChild(track); panel.appendChild(running);

    const stopBox = el('div', null, 'margin-top:12px;'); show(stopBox, false); panel.appendChild(stopBox);
    const summary = el('div', null, 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px;font-size:0.8rem;'); show(summary, false); panel.appendChild(summary);
    const failBox = el('details', null, 'margin-top:10px;border:1px solid #F7C6BB;border-radius:8px;background:#FFF8F6;'); show(failBox, false);
    const failTitle = el('summary', '', 'cursor:pointer;padding:8px 12px;font-size:0.8rem;font-weight:600;color:#7A271A;');
    const failList = el('div', null, 'padding:0 12px 8px;');
    failBox.appendChild(failTitle); failBox.appendChild(failList); panel.appendChild(failBox);

    const setFill = percent => { fill.style.width = percent + '%'; track.setAttribute('aria-valuenow', String(percent)); };
    extensionInstalled().then(installed => { if (!installed) panel.insertBefore(installBanner(storeUrlOf(panel)), head); });
    let stopRequested = false;
    stop.addEventListener('click', () => { stopRequested = true; stop.disabled = true; stop.textContent = 'Stopping…'; });

    start.addEventListener('click', async () => {
      show(stopBox, false); show(summary, false); show(failBox, false); failList.textContent = ''; stopBox.textContent = '';
      if (!(await extensionInstalled())) {
        stopBox.appendChild(failureBox({ code: 'no_extension' })); show(stopBox, true); return;
      }
      start.disabled = true; start.textContent = 'Updating…';
      stop.disabled = false; stop.textContent = 'Stop'; show(stop, true);
      stopRequested = false; fill.style.background = '#5D87FF'; setFill(0); show(running, true);
      current.textContent = 'Getting the client list…'; eta.textContent = '';
      let done = 0, failed = 0, skipped = 0, total = 0, stoppedBy = null;
      try {
        const { organisations } = await getJson(base + '/api/bank-screen/organisations');
        total = organisations.length;
        // Clients read in the last hour are left alone, so a run that was interrupted carries on where it stopped.
        // Decided once at the start: a client that passes the one-hour mark during the run must not be both
        // skipped and read (that is how "116 of 115" appeared).
        const runStartedAt = Date.now();
        const recentIds = new Set(organisations
          .filter(org => org.lastReadAt && runStartedAt - Date.parse(org.lastReadAt) < RECENT_MS)
          .map(org => org.tenantId));
        const recent = org => recentIds.has(org.tenantId);
        skipped = recentIds.size;
        const startedAt = Date.now();
        for (const org of organisations) {
          if (stopRequested) break;
          if (recent(org)) continue;
          const position = done + failed + skipped;
          current.textContent = 'Reading ' + (position + 1) + ' of ' + total + ' · ' + org.name;
          const read = done + failed;
          eta.textContent = read >= 3 ? duration(((Date.now() - startedAt) / 1000 / read) * (total - position)) + ' left' : '';
          setFill(Math.round((position / total) * 100));
          try { await updateOne(base, panel.dataset.csrf, org.tenantId, org.shortCode); done++; }
          catch (error) {
            failed++;
            const row = el('div', null, 'display:flex;gap:10px;padding:6px 0;border-top:1px solid #F7DAD3;font-size:0.78rem;');
            const link = el('a', org.name, 'flex:0 0 240px;font-weight:600;'); link.href = base + '/client/' + encodeURIComponent(org.tenantId);
            row.appendChild(link); row.appendChild(el('span', error.message, 'color:#7A271A;'));
            failList.appendChild(row);
            // Signed out of Xero or of Verify, or Verify restarting: every further client would fail the same way.
            if (STOP_REASONS[error.code]) { stoppedBy = error.code; stopRequested = true; }
          }
        }
      } catch (error) {
        stopBox.appendChild(alertBox('bad', 'The update could not start', error.message)); show(stopBox, true);
      } finally {
        const notAttempted = Math.max(0, total - done - failed - skipped);
        const complete = total > 0 && notAttempted === 0;
        show(running, false); show(stop, false);
        start.disabled = false; start.textContent = complete ? 'Update all clients' : (total ? 'Carry on' : 'Update all clients');
        if (stoppedBy) { stopBox.appendChild(alertBox('bad', STOP_REASONS[stoppedBy][0], STOP_REASONS[stoppedBy][1])); show(stopBox, true); }
        if (total) {
          summary.textContent = '';
          summary.appendChild(el('strong', complete ? 'Finished' : 'Stopped before the end', 'color:' + (complete ? '#0B8F76' : '#B25E09') + ';margin-right:4px;'));
          summary.appendChild(badge(done + ' updated', 'good'));
          if (skipped) summary.appendChild(badge(skipped + ' already read in the last hour', 'muted'));
          if (failed) summary.appendChild(badge(failed + ' failed', 'bad'));
          if (notAttempted) summary.appendChild(badge(notAttempted + ' not attempted', 'warn'));
          show(summary, true);
        }
        if (failed) { failTitle.textContent = failed + (failed === 1 ? ' client' : ' clients') + ' could not be read'; failBox.open = failed <= 5; show(failBox, true); }
      }
    });
  }

  document.querySelectorAll('[data-bank-screen-card]').forEach(setUpClientCard);
  document.querySelectorAll('[data-bank-screen-all]').forEach(setUpAllClients);
})();
