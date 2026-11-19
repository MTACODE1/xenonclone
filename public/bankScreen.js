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
    const finish = pending.get(data.requestId);
    pending.delete(data.requestId);
    finish(data);
  });

  function askExtension(message, timeoutMs) {
    return new Promise(resolve => {
      const requestId = 'r' + Date.now() + '-' + (++counter);
      const timer = setTimeout(() => { pending.delete(requestId); resolve(null); }, timeoutMs);
      pending.set(requestId, data => { clearTimeout(timer); resolve(data); });
      window.postMessage({ source: FROM_PAGE, requestId, ...message }, window.location.origin);
    });
  }

  const extensionInstalled = async () => Boolean(await askExtension({ type: 'PING' }, 1500));

  async function getJson(url, options) {
    const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' }, ...options });
    const type = response.headers.get('content-type') || '';
    if (!type.includes('json')) throw new Error(response.status === 503 ? 'Akrio Verify is starting up. Try again in a minute.' : 'Your Akrio Verify session has ended. Sign in again.');
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Akrio Verify could not save the reading.');
    return body;
  }

  // Reads one client in Xero through the extension and saves it. Throws an Error with a plain message.
  async function updateOne(base, csrfToken, tenantId, shortCode) {
    const answer = await askExtension({ type: 'READ_BANK_PAGE', shortCode }, 120000);
    if (!answer) throw new Error('The extension did not answer in time.');
    if (!answer.ok) throw new Error(answer.message || 'Xero could not be read.');
    return getJson(base + '/api/bank-screen/readings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ ...answer.reading, tenantId }),
    });
  }

  const money = value => (value == null ? '—' : (value < 0 ? '(' : '') + Math.abs(value).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (value < 0 ? ')' : ''));
  const el = (tag, text, style) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (style) node.style.cssText = style; return node; };

  function feedStatus(account) {
    if (account.stoppedImporting) return { label: 'Stopped importing', tone: 'bad' };
    if (account.feedProblem) return { label: 'Feed problem', tone: 'bad' };
    if (account.noFeed) return { label: 'No bank feed', tone: 'muted' };
    return { label: 'Connected', tone: 'good' };
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

  function tile(label, value, sub, tone) {
    const box = el('div', null, 'flex:1 1 170px;border:1px solid #E5EAF2;border-radius:10px;padding:12px 14px;background:#fff;');
    box.appendChild(el('div', label, 'font-size:0.68rem;letter-spacing:0.06em;text-transform:uppercase;color:#7C8FAC;font-weight:600;'));
    box.appendChild(el('div', value, 'font-size:1.35rem;font-weight:700;margin-top:2px;font-variant-numeric:tabular-nums;color:' + (tone === 'bad' ? '#B42318' : tone === 'warn' ? '#B25E09' : '#2A3547') + ';'));
    if (sub) box.appendChild(el('div', sub, 'font-size:0.72rem;color:#7C8FAC;margin-top:2px;'));
    return box;
  }

  function renderReading(body, data) {
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
    const tiles = el('div', null, 'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px;');
    tiles.appendChild(tile('Items to reconcile', total.toLocaleString('en-GB'), 'across ' + accounts.length + (accounts.length === 1 ? ' bank account' : ' bank accounts'), total ? 'warn' : null));
    tiles.appendChild(tile('Bank feeds with a problem', String(feedIssues), feedIssues ? 'not importing new transactions' : 'all connected feeds are working', feedIssues ? 'bad' : null));
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
      if (account.itemsToReconcile) items.appendChild(badge(account.itemsToReconcile.toLocaleString('en-GB'), 'warn'));
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
    const load = async () => { data = await getJson(base + '/api/bank-screen/latest/' + encodeURIComponent(tenantId)); renderReading(body, data); };
    try { await load(); } catch (error) { body.textContent = error.message; return; }
    button.addEventListener('click', async () => {
      note.style.color = '#5A6A85';
      if (!data.shortCode) { note.textContent = 'This client has no Xero short code yet. Run a sync first.'; return; }
      if (!(await extensionInstalled())) { note.textContent = 'The Akrio Verify browser extension is not installed in this browser (or this page needs a reload after installing it).'; return; }
      button.disabled = true; button.textContent = 'Reading Xero…'; note.textContent = '';
      try {
        await updateOne(base, card.dataset.csrf, tenantId, data.shortCode);
        await load();
        note.style.color = '#0B8F76'; note.textContent = 'Updated just now';
      } catch (error) {
        note.style.color = '#B42318'; note.textContent = error.message;
      } finally { button.disabled = false; button.textContent = 'Update from Xero'; }
    });
  }

  function setUpAllClients(bar) {
    const base = bar.dataset.basePath || '';
    const start = bar.querySelector('[data-bank-screen-all-start]');
    const stop = bar.querySelector('[data-bank-screen-all-stop]');
    const note = bar.querySelector('[data-bank-screen-all-note]');
    const failures = bar.querySelector('[data-bank-screen-all-failures]');
    let stopRequested = false;
    stop.addEventListener('click', () => { stopRequested = true; note.textContent += ' Stopping after this client…'; });
    start.addEventListener('click', async () => {
      failures.textContent = '';
      if (!(await extensionInstalled())) { note.textContent = 'The Akrio Verify browser extension is not installed in this browser.'; return; }
      start.disabled = true; stop.hidden = false; stopRequested = false;
      let done = 0, failed = 0;
      try {
        const { organisations } = await getJson(base + '/api/bank-screen/organisations');
        for (const org of organisations) {
          if (stopRequested) break;
          note.textContent = 'Reading ' + (done + failed + 1) + ' of ' + organisations.length + ': ' + org.name;
          try { await updateOne(base, bar.dataset.csrf, org.tenantId, org.shortCode); done++; }
          catch (error) {
            failed++; failures.appendChild(el('div', org.name + ': ' + error.message));
            // Signed out of Xero or Verify: every further client would fail the same way.
            if (/Sign in/.test(error.message)) { stopRequested = true; }
          }
        }
        note.textContent = (stopRequested ? 'Stopped. ' : 'Finished. ') + done + ' updated, ' + failed + ' failed, ' + (organisations.length - done - failed) + ' not attempted.';
      } catch (error) { note.textContent = error.message; }
      finally { start.disabled = false; stop.hidden = true; }
    });
  }

  document.querySelectorAll('[data-bank-screen-card]').forEach(setUpClientCard);
  document.querySelectorAll('[data-bank-screen-all]').forEach(setUpAllClients);
})();
