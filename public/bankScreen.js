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
    if (account.stoppedImporting) return 'Stopped importing';
    if (account.feedProblem) return 'Problem with bank feed';
    if (account.noFeed) return 'No bank feed';
    return 'OK';
  }

  function renderReading(body, data) {
    body.textContent = '';
    const reading = data.reading;
    if (!reading) { body.appendChild(el('p', 'Nothing has been read from Xero for this client yet.', 'color:#7C8FAC;font-size:0.85rem;')); return; }
    const when = new Date(reading.readAt);
    const line = el('p', 'Read from Xero on ' + when.toLocaleString('en-GB') + (reading.readByName ? ' by ' + reading.readByName : '') + '.', 'font-size:0.8rem;color:#5A6A85;margin-bottom:8px;');
    if (reading.freshness === 'stale') line.appendChild(el('strong', ' OUT OF DATE: older than ' + data.staleAfterDays + ' days. Update before relying on it.', 'color:#B42318;'));
    body.appendChild(line);
    if (!reading.accounts.length) { body.appendChild(el('p', 'Xero showed no bank accounts for this client.', 'font-size:0.85rem;')); return; }
    const table = el('table'); table.className = 'table';
    const head = el('tr');
    ['Bank account', 'Items to reconcile', 'Balance in Xero', 'Statement balance', 'Statement date (as Xero shows it)', 'Bank feed'].forEach(title => head.appendChild(el('th', title)));
    table.appendChild(head);
    let total = 0;
    for (const account of reading.accounts) {
      const row = el('tr');
      row.appendChild(el('td', account.accountName + (account.accountNumber ? ' · ' + account.accountNumber : '')));
      const items = account.itemsToReconcile != null ? String(account.itemsToReconcile)
        : account.reconciled ? '0 (reconciled)' : account.balancesDiffer ? '0, but balances differ' : 'Not shown';
      total += account.itemsToReconcile || 0;
      row.appendChild(el('td', items, account.itemsToReconcile ? 'font-weight:600;' : ''));
      row.appendChild(el('td', money(account.balanceInXero)));
      row.appendChild(el('td', money(account.statementBalance)));
      row.appendChild(el('td', account.statementDateLabel || '—'));
      const status = feedStatus(account);
      row.appendChild(el('td', status, status === 'OK' ? '' : 'color:#B42318;font-weight:600;'));
      table.appendChild(row);
    }
    body.appendChild(table);
    body.appendChild(el('p', 'Total items to reconcile: ' + total + '. Xero shows the statement date without a year.', 'font-size:0.75rem;color:#7C8FAC;margin-top:6px;'));
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
      button.disabled = true; note.textContent = 'Reading Xero…';
      try {
        await updateOne(base, card.dataset.csrf, tenantId, data.shortCode);
        await load();
        note.textContent = 'Updated.';
      } catch (error) {
        note.style.color = '#B42318'; note.textContent = error.message;
      } finally { button.disabled = false; }
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
