// Service worker. On request from an Akrio Verify page it opens one Xero "Bank accounts" page in a
// background tab, reads what the page shows, closes the tab and returns the reading. One at a time.
importScripts('parser.js');

const ALLOWED_SENDERS = [
  'https://wf.morethanaccountants.co.uk/akrio-verify/',
  'http://localhost:3000/',
  'https://localhost:3000/',
];
const LOAD_TIMEOUT_MS = 60000;
const fail = (error, message) => ({ ok: false, error, message });

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
  try {
    progress('opening');
    tab = await chrome.tabs.create({ url: self.AkrioBankParser.bankAccountsUrl(shortCode), active: false });
    await waitForLoad(tab.id);
    progress('loaded');
    const loaded = await chrome.tabs.get(tab.id);
    let host = '';
    try { host = new URL(loaded.url || '').host; } catch (error) { host = ''; }
    if (host === 'login.xero.com') return fail('not_signed_in', 'Sign in to Xero in this browser, then try again.');
    if (host !== 'go.xero.com') return fail('unexpected_page', 'Xero opened a different page than expected.');
    progress('reading');
    const [injected] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['parser.js', 'xero-read.js'] });
    const page = injected && injected.result;
    if (!page) return fail('not_readable', 'Xero\'s page could not be read.');
    if (page.host !== 'go.xero.com' || page.shortCode !== shortCode) {
      return fail('wrong_organisation', 'Xero did not open this client. Check that your Xero login has access to it.');
    }
    if (!page.settled) return fail('not_settled', 'Xero was too slow to show the bank accounts. Try again in a moment.');
    if (!page.accounts.length && !page.pageRendered) {
      return fail('not_readable', 'Xero\'s Bank accounts page did not load for this client.');
    }
    return { ok: true, reading: { shortCode, pageTitle: page.pageTitle, accounts: page.accounts } };
  } catch (error) {
    if (error && error.message === 'timeout') return fail('timeout', 'Xero took too long to load.');
    return fail('extension_error', 'The Xero page could not be read: ' + String((error && error.message) || error).slice(0, 200));
  } finally {
    if (tab && tab.id != null) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

let queue = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const fromVerify = sender.id === chrome.runtime.id && typeof sender.url === 'string'
    && ALLOWED_SENDERS.some(prefix => sender.url.startsWith(prefix));
  if (!fromVerify || !message || message.type !== 'READ_BANK_PAGE') return false;
  // Stage updates go only to the Verify tab that asked; a closed tab simply misses them.
  const progress = stage => {
    if (sender.tab && sender.tab.id != null) chrome.tabs.sendMessage(sender.tab.id, { type: 'READ_PROGRESS', stage }).catch(() => {});
  };
  queue = queue.then(() => readBankPage(message.shortCode, progress)).then(sendResponse, () => sendResponse(fail('extension_error', 'Unexpected error.')));
  return true; // answer asynchronously
});
