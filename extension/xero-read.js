// Injected into Xero's "Bank accounts" page by the service worker. Reads only what is visible on the
// page; it never clicks, submits or calls Xero's own data endpoints. The last expression is the result.
(async function () {
  'use strict';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const widgets = () => document.querySelectorAll('[data-automationid="bankWidget"]');
  const text = el => (el && el.innerText) || '';
  // With no bank accounts the page still shows its own heading and "Add bank account" button. Until those
  // are there the page is still loading (Xero can take 20 seconds or more), so "no widgets" means nothing yet.
  const rendered = () => /Bank accounts/.test(text(document.body)) && /Add bank account/.test(text(document.body));
  // The page is a single-page app: widgets and their balances arrive over a few seconds. Wait until the
  // widgets' text has been unchanged for three checks in a row, and never give up on an unfinished page
  // before 50 seconds.
  let last = null, stable = 0, settled = false;
  for (let i = 0; i < 50; i++) {
    await sleep(1000);
    const now = [...widgets()].map(text).join('\u0001');
    if (now === last) stable++; else { stable = 0; last = now; }
    if (i >= 4 && stable >= 3 && (widgets().length > 0 || rendered())) { settled = true; break; }
  }
  const accounts = [...widgets()].map(widget => self.AkrioBankParser.parseWidget({
    headerText: text(widget.querySelector('[data-automationid="bankWidgetHeader"]')),
    text: text(widget),
    feedProblem: Boolean(widget.querySelector('[data-automationid="bankfeedErrorLabel"]')),
    noFeed: Boolean(widget.querySelector('[data-automationid="getBankFeeds"]')),
  }));
  return {
    host: location.host,
    shortCode: self.AkrioBankParser.shortCodeFromPath(location.pathname),
    pageTitle: document.title.slice(0, 200),
    settled,
    pageRendered: rendered(),
    accounts,
  };
})();
