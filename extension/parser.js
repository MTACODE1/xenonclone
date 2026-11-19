// Pure text parsing for one bank-account widget on Xero's "Bank accounts" page.
// No DOM access here, so the same file runs in the extension and under `node --test`.
// Xero's public API does not give the unreconciled count or the statement balance (confirmed by
// Xero support, Nov 2026), so the visible page is the only source of these figures.
(function (root) {
  'use strict';

  // "(1,234.56)" and "-1,234.56" are negative; anything that is not a plain amount is null, never 0.
  function parseAmount(value) {
    if (value == null) return null;
    const match = String(value).trim().match(/^(\()?(-)?\s*([\d,]+(?:\.\d+)?)\)?$/);
    if (!match) return null;
    const amount = Number(match[3].replace(/,/g, ''));
    if (!Number.isFinite(amount)) return null;
    const negative = Boolean(match[1] || match[2]);
    return negative && amount !== 0 ? -amount : amount;
  }

  const lineAfterTab = (text, label) => {
    const match = text.match(new RegExp('(?:^|\\n)' + label + '[^\\t\\n]*\\t([^\\n]*)'));
    return match ? match[1].trim() : null;
  };

  // widget = { headerText, text, feedProblem, noFeed } as collected from the page.
  function parseWidget(widget) {
    const text = String((widget && widget.text) || '').replace(/\r/g, '');
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    const accountName = String((widget && widget.headerText) || lines[0] || '').trim();
    const reconcile = text.match(/(?:^|\n)\s*Reconcile ([\d,]+) items?\s*(?:\n|$)/);
    const dateLabel = text.match(/Statement balance \(([^)\n]{1,20})\)/);
    // The line under the name is the account number / currency label when Xero shows one.
    const second = lines[0] === accountName ? lines[1] : null;
    const accountNumber = second && second.length <= 64
      && !/^(Reconcile |Reconciled$|Balance in Xero|Statement balance|There is a problem|Why is this)/.test(second) ? second : null;
    return {
      accountName,
      accountNumber,
      itemsToReconcile: reconcile ? Number(reconcile[1].replace(/,/g, '')) : null,
      reconciled: /(?:^|\n)\s*Reconciled\s*(?:\n|$)/.test(text),
      balancesDiffer: /Why is this different\?/.test(text),
      balanceInXero: parseAmount(lineAfterTab(text, 'Balance in Xero')),
      statementBalance: parseAmount(lineAfterTab(text, 'Statement balance')),
      // Xero shows the statement date without a year ("Oct 12"). It is kept exactly as shown.
      statementDateLabel: dateLabel ? dateLabel[1].trim() : null,
      feedProblem: Boolean(widget && widget.feedProblem) || /There is a problem with this bank feed/i.test(text),
      stoppedImporting: /stopped importing/i.test(text),
      // Xero offers "Get bank feeds" on an account that has no automatic feed. The button does not always
      // carry the same marker, so its text counts as well.
      noFeed: Boolean(widget && widget.noFeed) || /(?:^|\n)\s*Get bank feeds\s*(?:\n|$)/.test(text),
    };
  }

  // The organisation short code is the path segment after /app/ ("!AbC12").
  function shortCodeFromPath(pathname) {
    const match = String(pathname || '').match(/^\/app\/([^/]+)\/manage-bank-accounts\/?$/);
    if (!match) return null;
    try { return decodeURIComponent(match[1]); } catch (error) { return null; }
  }

  const SHORT_CODE = /^![A-Za-z0-9!-]{2,12}$/;
  const isShortCode = value => typeof value === 'string' && SHORT_CODE.test(value);
  const bankAccountsUrl = shortCode => 'https://go.xero.com/app/' + shortCode + '/manage-bank-accounts';

  const api = { parseAmount, parseWidget, shortCodeFromPath, isShortCode, bankAccountsUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AkrioBankParser = api;
})(typeof self !== 'undefined' ? self : this);
