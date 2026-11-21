// Service worker. On request from an Akrio Verify page it opens one Xero "Bank accounts" page in a
// background tab, reads what the page shows, closes the tab and returns the reading. One at a time.
// A second request type reads one bank account's unreconciled statement lines the same way (readBankLines).
importScripts('parser.js');

const ALLOWED_SENDERS = ['https://wf.morethanaccountants.co.uk/akrio-verify/'];
const LOAD_TIMEOUT_MS = 60000;
const fail = (error, message) => ({ ok: false, error, message });
const NOT_SIGNED_IN = 'Sign in to Xero in this browser, then try again.';
// Xero changed a page the extension reads. Nothing is saved; the toolbar icon turns red until a read works again.
const pageChanged = (pageName, problems) => ({
  ok: false, error: 'page_changed', problems: problems.slice(0, 20),
  message: 'Xero has changed its ' + pageName + ' page, so nothing was saved. Akrio Verify needs an update; please tell Aditya. ('
    + problems.slice(0, 5).join('; ').slice(0, 300) + ')',
});

// ---- toolbar icon: green tick after a good read, red after a fault that needs fixing, amber when Xero needs
// the user (signed out) or was only slow. The last state is kept so it survives the browser restarting.
const STATUS_LOOK = {
  ok: { text: '✓', colour: '#12B76A' },
  fault: { text: '!', colour: '#D92D20' },
  attention: { text: '!', colour: '#F79009' },
};
// Only faults that need a fix in the extension turn it red. A page that did not load, a redirect or a slow
// Xero are amber: trying again usually works.
const FAULTS = new Set(['page_changed', 'extension_error']);
function statusOf(result) {
  if (result && result.ok) return 'ok';
  return FAULTS.has(result && result.error) ? 'fault' : 'attention';
}
function showStatus(state) {
  if (!state || !STATUS_LOOK[state.status] || !chrome.action) return;
  const look = STATUS_LOOK[state.status];
  chrome.action.setBadgeText({ text: look.text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: look.colour }).catch(() => {});
  const when = new Date(state.at).toLocaleString();
  chrome.action.setTitle({ title: state.status === 'ok'
    ? 'Akrio Verify: last Xero read worked (' + when + ').'
    : 'Akrio Verify: last Xero read failed (' + when + '). ' + String(state.message || '').slice(0, 400) }).catch(() => {});
}
async function recordStatus(result) {
  const state = { status: statusOf(result), error: (result && result.error) || null, message: (result && result.message) || null, at: Date.now() };
  showStatus(state);
  try { await chrome.storage.local.set({ lastStatus: state }); } catch (error) { /* the icon still shows it */ }
}
async function restoreStatus() {
  try { showStatus((await chrome.storage.local.get('lastStatus')).lastStatus); } catch (error) { /* nothing saved yet */ }
}
chrome.runtime.onStartup.addListener(restoreStatus);
chrome.runtime.onInstalled.addListener(restoreStatus);

function waitForLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, LOAD_TIMEOUT_MS);
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') { cleanup(); resolve(); } };
    const onRemoved = id => { if (id === tabId) { cleanup(); reject(new Error('closed')); } };
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then(tab => { if (tab.status === 'complete') { cleanup(); resolve(); } }).catch(() => {});
  });
}

async function readBankPage(shortCode, progress = () => {}) {
  if (!self.AkrioBankParser.isShortCode(shortCode)) return fail('bad_short_code', 'This client has no valid Xero short code.');
  let tab;
  const closeLater = setTimeout(() => { if (tab && tab.id != null) chrome.tabs.remove(tab.id).catch(() => {}); }, READ_DEADLINE_MS + 1000);
  try {
    progress('opening');
    tab = await chrome.tabs.create({ url: self.AkrioBankParser.bankAccountsUrl(shortCode), active: false });
    await waitForLoad(tab.id);
    progress('loaded');
    const loaded = await chrome.tabs.get(tab.id);
    let host = '';
    try { host = new URL(loaded.url || '').host; } catch (error) { host = ''; }
    if (host === 'login.xero.com') return fail('not_signed_in', NOT_SIGNED_IN);
    if (host !== 'go.xero.com') return fail('unexpected_page', 'Xero opened a different page than expected.');
    progress('reading');
    // When Xero's session has expired, go.xero.com loads first and then sends the tab to its sign-in page. That
    // can happen while the page is being read, so the tab's address is checked again afterwards.
    const signedOut = async () => {
      try { return new URL((await chrome.tabs.get(tab.id)).url || '').host === 'login.xero.com'; } catch (error) { return false; }
    };
    let page = null;
    try {
      const [injected] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['parser.js', 'xero-read.js'] });
      page = injected && injected.result;
    } catch (error) {
      if (await signedOut()) return fail('not_signed_in', NOT_SIGNED_IN);
      throw error;
    }
    if (await signedOut()) return fail('not_signed_in', NOT_SIGNED_IN);
    if (!page) {
      // The read was cut off, usually because the tab was being sent somewhere else. Give that a moment to land.
      await new Promise(resolve => setTimeout(resolve, 2500));
      if (await signedOut()) return fail('not_signed_in', NOT_SIGNED_IN);
      return fail('not_readable', 'Xero\'s page could not be read.');
    }
    if (page.host !== 'go.xero.com' || page.shortCode !== shortCode) {
      return fail('wrong_organisation', 'Xero did not open this client. Check that your Xero login has access to it.');
    }
    if (page.xeroError) return fail('xero_error', 'Xero says it cannot show this client\'s Bank accounts page right now. Try again later, or open it in Xero to check.');
    if (!page.settled) return fail('not_settled', 'Xero was too slow to show the bank accounts. Try again in a moment.');
    if (Array.isArray(page.problems) && page.problems.length) return pageChanged('Bank accounts', page.problems);
    if (!page.accounts.length && !page.pageRendered) {
      return fail('not_readable', 'Xero\'s Bank accounts page did not load for this client.');
    }
    return { ok: true, reading: { shortCode, pageTitle: page.pageTitle, accounts: page.accounts } };
  } catch (error) {
    if (error && error.message === 'timeout') return fail('timeout', 'Xero took too long to load.');
    return fail('extension_error', 'The Xero page could not be read: ' + String((error && error.message) || error).slice(0, 200));
  } finally {
    clearTimeout(closeLater);
    if (tab && tab.id != null) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// Polls the tab until it shows a fully loaded go.xero.com/Bank/Statements.aspx ('ok'), stays on Xero's sign-in page
// for 15 seconds ('login'), or 60 seconds pass ('timeout' / 'other').
async function waitForStatementsPage(tabId) {
  const started = Date.now();
  let onLoginSince = null;
  while (Date.now() - started < LOAD_TIMEOUT_MS) {
    await new Promise(resolve => setTimeout(resolve, 500));
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch (error) { return 'closed'; }
    let url;
    try { url = new URL(tab.url || tab.pendingUrl || ''); } catch (error) { continue; }
    if (url.host === 'go.xero.com' && /^\/Bank\/Statements\.aspx$/i.test(url.pathname) && tab.status === 'complete') return 'ok';
    if (url.host === 'login.xero.com' && /\/identity\/user\/login/i.test(url.pathname) && tab.status === 'complete') {
      onLoginSince = onLoginSince || Date.now();
      if (Date.now() - onLoginSince > 15000) return 'login';
    } else {
      onLoginSince = null;
    }
  }
  return 'timeout';
}

// The unreconciled statement lines of ONE bank account, for the "items to reconcile" list in Akrio Verify.
// Opens the client's Bank accounts page (which also makes Xero switch to that client), finds the account by
// its name, opens that account's "Bank statements" tab in the same background tab and reads the lines Xero
// lists as Unreconciled. Nothing is saved or changed in Xero.
async function readBankLines(shortCode, accountName, progress = () => {}) {
  const parser = self.AkrioBankParser;
  if (!parser.isShortCode(shortCode)) return fail('bad_short_code', 'This client has no valid Xero short code.');
  if (typeof accountName !== 'string' || !accountName.trim() || accountName.length > 255) return fail('bad_account', 'No bank account was named.');
  let tab;
  const closeLater = setTimeout(() => { if (tab && tab.id != null) chrome.tabs.remove(tab.id).catch(() => {}); }, READ_DEADLINE_MS + 1000);
  const hostOf = async () => { try { return new URL((await chrome.tabs.get(tab.id)).url || '').host; } catch (error) { return ''; } };
  try {
    progress('opening');
    tab = await chrome.tabs.create({ url: parser.bankAccountsUrl(shortCode), active: false });
    await waitForLoad(tab.id);
    progress('loaded');
    let host = await hostOf();
    if (host === 'login.xero.com') return fail('not_signed_in', NOT_SIGNED_IN);
    if (host !== 'go.xero.com') return fail('unexpected_page', 'Xero opened a different page than expected.');
    // The bank account widgets (and the links that carry each account's id) arrive a few seconds after the page.
    let found = null;
    try {
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
          const collect = () => [...document.querySelectorAll('[data-automationid="bankWidget"]')].map(widget => ({
            name: ((widget.querySelector('[data-automationid="bankWidgetHeader"]') || {}).innerText || '').trim(),
            hrefs: [...widget.querySelectorAll('a[href]')].map(link => link.getAttribute('href')).filter(href => /accountid=/i.test(href)),
          }));
          let last = -1, stable = 0;
          for (let i = 0; i < 45; i++) {
            await sleep(1000);
            const count = collect().filter(account => account.hrefs.length).length;
            if (count === last && count > 0) stable++; else { stable = 0; last = count; }
            if (stable >= 2) break;
          }
          return { host: location.host, path: location.pathname, accounts: collect() };
        },
      });
      found = injected && injected.result;
    } catch (error) {
      if ((await hostOf()) === 'login.xero.com') return fail('not_signed_in', NOT_SIGNED_IN);
      throw error;
    }
    if ((await hostOf()) === 'login.xero.com') return fail('not_signed_in', NOT_SIGNED_IN);
    if (!found || found.host !== 'go.xero.com' || parser.shortCodeFromPath(found.path) !== shortCode) {
      return fail('wrong_organisation', 'Xero did not open this client. Check that your Xero login has access to it.');
    }
    const matches = found.accounts.filter(account => parser.sameName(account.name, accountName));
    if (matches.length !== 1) return fail('account_not_found', 'Xero\'s Bank accounts page does not show an account called "' + accountName.slice(0, 80) + '".');
    const accountId = matches[0].hrefs.map(parser.accountIdFromHref).find(parser.isAccountId);
    if (!accountId) return fail('account_not_found', 'Xero does not give a link to this account\'s statement lines.');

    progress('reading');
    await chrome.tabs.update(tab.id, { url: parser.statementsUrl(shortCode, accountId) });
    // Xero's organisation switch passes through its sign-in server for a moment (about two seconds, seen live
    // 21 Nov 2026) before landing on the statements page, even when signed in. So wait for the tab to LAND,
    // and only call it "not signed in" when it stays on the sign-in page.
    const landed = await waitForStatementsPage(tab.id);
    if (landed === 'login') return fail('not_signed_in', NOT_SIGNED_IN);
    if (landed !== 'ok') return fail('unexpected_page', 'Xero opened a different page than expected.');
    let page = null;
    try {
      const [injected] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['xero-lines.js'] });
      page = injected && injected.result;
    } catch (error) {
      if ((await hostOf()) === 'login.xero.com') return fail('not_signed_in', NOT_SIGNED_IN);
      throw error;
    }
    if (!page) return fail('not_readable', 'Xero\'s statement lines could not be read.');
    // The page must be this account's own Bank statements tab: right address, and the account's name in its heading.
    if (page.host !== 'go.xero.com' || !/^\/Bank\/Statements\.aspx$/i.test(page.path)
      || !String(page.heading || '').toLowerCase().includes(accountName.trim().replace(/\s+/g, ' ').toLowerCase())) {
      return fail('wrong_account', 'Xero did not open this bank account\'s statement lines.');
    }
    if (!page.ok) {
      // A missing table, search box or filter is a changed page; a search that never finished is only slow.
      if (page.reason === 'search_timeout') return fail('timeout', 'Xero took too long to load.');
      return pageChanged('Bank statements', [String(page.reason || 'unknown')]);
    }
    if (page.statusFilter !== 'Unreconciled') return pageChanged('Bank statements', ['status_filter']);
    const lines = parser.parseStatementRows(page.columns, page.rows);
    const problems = parser.statementProblems(page.columns, page.rows, lines, page.totalShownByXero, Boolean(page.truncated));
    if (problems.length) return pageChanged('Bank statements', problems);
    // accountId lets Akrio Verify link each line to this account's Reconcile tab in Xero.
    return { ok: true, lines: { shortCode, accountName, accountId, lines, truncated: Boolean(page.truncated), totalShownByXero: page.totalShownByXero } };
  } catch (error) {
    if (error && error.message === 'timeout') return fail('timeout', 'Xero took too long to load.');
    return fail('extension_error', 'The Xero page could not be read: ' + String((error && error.message) || error).slice(0, 200));
  } finally {
    clearTimeout(closeLater);
    if (tab && tab.id != null) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// One read can never hold up the ones after it. Chrome may pause a background tab (for example while the
// computer is busy or the window is hidden), and then the page script never finishes; without a deadline
// every later client would wait behind it and the whole run would stall.
const READ_DEADLINE_MS = 110000;
function withDeadline(work) {
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve(fail('timeout', 'Xero took too long to load.')), READ_DEADLINE_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

let queue = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const fromVerify = sender.id === chrome.runtime.id && typeof sender.url === 'string'
    && ALLOWED_SENDERS.some(prefix => sender.url.startsWith(prefix));
  if (!fromVerify || !message || !['READ_BANK_PAGE', 'READ_BANK_LINES'].includes(message.type)) return false;
  // Stage updates go only to the Verify tab that asked; a closed tab simply misses them.
  const progress = stage => {
    if (sender.tab && sender.tab.id != null) chrome.tabs.sendMessage(sender.tab.id, { type: 'READ_PROGRESS', stage }).catch(() => {});
  };
  const work = message.type === 'READ_BANK_LINES'
    ? () => readBankLines(message.shortCode, message.accountName, progress)
    : () => readBankPage(message.shortCode, progress);
  const answer = async result => { await recordStatus(result); sendResponse(result); };
  queue = queue.then(() => withDeadline(work())).then(answer, () => answer(fail('extension_error', 'Unexpected error.')));
  return true; // answer asynchronously
});
