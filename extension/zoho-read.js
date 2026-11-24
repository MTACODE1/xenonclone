// Injected into Zoho Books' Banking page (#/banking) by the service worker, after zoho-parser.js. Reads only what
// is visible on the page: it never clicks, types, submits or calls Zoho's own data endpoints. The last expression
// is the result.
(async function () {
  'use strict';
  const parser = self.AkrioZohoParser;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const text = el => (el && el.innerText) || '';
  // The accounts table is the one table whose text has "Uncategorized" (Zoho's spelling; the British spelling is
  // accepted too in case a UK data centre uses it).
  const table = () => [...document.querySelectorAll('table')].find(node => /Uncategori[sz]ed/i.test(text(node))) || null;
  // Zoho Books is a single-page app: the address changes and the table is drawn some seconds after the page
  // "loads". The page counts as read once the table's HTML has stayed the same for three checks in a row and
  // parses without a problem, for up to 50 seconds.
  let last = null, stable = 0, settled = false, stableWithProblems = false;
  for (let i = 0; i < 50; i++) {
    await sleep(1000);
    // Signed out, or sent to another screen or organisation: stop waiting, the service worker says what happened.
    if (!parser.isBooksHost(location.host) || !parser.isBankingHash(location.hash)) break;
    const node = table();
    const html = node ? node.outerHTML : null;
    if (html === last) stable++; else { stable = 0; last = html; }
    if (!html) continue;
    const { accounts, problems } = parser.parseBankingTable(html);
    stableWithProblems = i >= 3 && stable >= 3 && problems.length > 0;
    if (i >= 3 && stable >= 3 && accounts.length > 0 && !problems.length) { settled = true; break; }
  }
  const node = table();
  const parsed = node ? parser.parseBankingTable(node.outerHTML) : { accounts: [], problems: [] };
  // The summary above the table ("1 Uncategorized Transactions Categorize now"); only the number is kept.
  const summaryTotal = parser.parseSummaryTotal(text(document.body).slice(0, 20000));
  return {
    host: location.host,
    orgId: parser.orgIdFromPath(location.pathname),
    onBanking: parser.isBankingHash(location.hash),
    pageTitle: document.title.slice(0, 200),
    tableFound: Boolean(node),
    settled,
    stableWithProblems,
    problems: parsed.problems,
    accounts: parsed.accounts,
    summaryTotal,
  };
})();
