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
  // widgets' text has been unchanged for three checks in a row, for up to 50 seconds.
  // Xero's own error page for this screen; nothing will load, so there is no point waiting.
  const xeroError = () => /We can.t show this page right now/i.test(text(document.body));
  const collect = () => [...widgets()].map(widget => ({
    headerText: text(widget.querySelector('[data-automationid="bankWidgetHeader"]')),
    hasHeader: Boolean(widget.querySelector('[data-automationid="bankWidgetHeader"]')),
    text: text(widget),
    feedProblem: Boolean(widget.querySelector('[data-automationid="bankfeedErrorLabel"]')),
    noFeed: Boolean(widget.querySelector('[data-automationid="getBankFeeds"]')),
  }));
  // The wording every bank card carries. Seen on the page with no cards found means the cards' marker changed.
  const cardsText = () => /Balance in Xero|Statement balance|No transactions imported|Reconcile \d/.test(text(document.body));
  const problemsOf = raw => self.AkrioBankParser.bankPageProblems({
    widgets: raw, accounts: raw.map(widget => self.AkrioBankParser.parseWidget(widget)), cardsTextOnPage: cardsText(),
  });
  // A card that is still loading, or half drawn, can look "unrecognised" for a moment (Rose and Caramel's Qatari
  // Riyal card, 21 Nov 2026: refused once although the card was a normal "No transactions imported" card). So the
  // page only counts as settled once no card is loading AND no card looks unrecognised. A problem that is still
  // there after the whole wait, with the cards unchanged for 3 seconds, is a real change to Xero's page.
  let last = null, stable = 0, settled = false, stableWithProblems = false;
  for (let i = 0; i < 50; i++) {
    await sleep(1000);
    const now = [...widgets()].map(text).join('\u0001');
    if (now === last) stable++; else { stable = 0; last = now; }
    // Xero draws the page heading and "Add bank account" button a few seconds BEFORE the bank accounts
    // themselves, so an empty page only counts as "no bank accounts" after 25 seconds of nothing appearing.
    if (xeroError()) break;
    const raw = collect();
    // A card still "Loading your bank transactions" has no count yet, so the page is not settled.
    const loading = raw.some(widget => self.AkrioBankParser.isLoadingCard(widget));
    const problems = raw.length ? problemsOf(raw) : [];
    stableWithProblems = i >= 4 && stable >= 3 && raw.length > 0 && !loading && problems.length > 0;
    if (i >= 4 && stable >= 3 && raw.length > 0 && !loading && !problems.length) { settled = true; break; }
    if (i >= 25 && raw.length === 0 && rendered()) { settled = true; break; }
  }
  const raw = collect();
  const accounts = raw.map(widget => self.AkrioBankParser.parseWidget(widget));
  const cardsTextOnPage = cardsText();
  return {
    stableWithProblems,
    loadingCards: raw.filter(widget => self.AkrioBankParser.isLoadingCard(widget)).map(widget => widget.headerText.trim().slice(0, 80)),
    problems: self.AkrioBankParser.bankPageProblems({ widgets: raw, accounts, cardsTextOnPage }),
    host: location.host,
    shortCode: self.AkrioBankParser.shortCodeFromPath(location.pathname),
    pageTitle: document.title.slice(0, 200),
    settled,
    pageRendered: rendered(),
    xeroError: xeroError(),
    accounts,
  };
})();
