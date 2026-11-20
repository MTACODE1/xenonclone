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

  // ---- one account's unreconciled statement lines (Xero's "Bank statements" tab) ----

  // Xero's account id, from a link on the Bank accounts page (".../BankTransactions.aspx?accountId=<32 hex>" or
  // ".../BankRec.aspx?accountID=<guid>"). Returned as 32 lower-case hex digits, or null.
  function accountIdFromHref(href) {
    const match = String(href || '').match(/[?&]accountid=([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})(?:&|#|$)/i);
    return match ? match[1].replace(/-/g, '').toLowerCase() : null;
  }
  const isAccountId = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
  // Opening through Xero's own organisation switch makes sure the page belongs to this client.
  const statementsUrl = (shortCode, accountId) => 'https://go.xero.com/organisationlogin/default.aspx?shortcode='
    + encodeURIComponent(shortCode) + '&redirecturl=' + encodeURIComponent('/Bank/Statements.aspx?accountID=' + accountId);
  const sameName = (a, b) => String(a || '').trim().replace(/\s+/g, ' ').toLowerCase() === String(b || '').trim().replace(/\s+/g, ' ').toLowerCase();

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  // "12 Oct 2026" -> "2026-10-12". Anything else is null: a date is never guessed.
  function parseXeroDate(value) {
    const match = String(value || '').trim().match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})$/);
    if (!match) return null;
    const month = MONTHS[match[2].toLowerCase()];
    const day = Number(match[1]);
    if (!month || day < 1 || day > 31) return null;
    return match[3] + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  }

  // columns: the table's header texts; rows: each row's cell texts, as read from the page. Only rows Xero
  // marks "Unreconciled" and that carry a date are lines; the columns are found by their headings, so a
  // reordered or extra column cannot shift the figures.
  function parseStatementRows(columns, rows) {
    const index = name => (columns || []).findIndex(column => String(column || '').trim().toLowerCase() === name);
    const at = { date: index('date'), type: index('type'), payee: index('payee'), particulars: index('particulars'),
      code: index('code'), reference: index('reference'), spent: index('spent'), received: index('received'),
      source: index('source'), status: index('status') };
    if (at.date < 0 || at.status < 0 || at.spent < 0 || at.received < 0) return null;
    const cell = (row, i) => (i >= 0 && row[i] != null ? String(row[i]).trim() : '');
    const lines = [];
    for (const row of rows || []) {
      if (!Array.isArray(row) || cell(row, at.status) !== 'Unreconciled') continue;
      const date = parseXeroDate(cell(row, at.date));
      if (!date) continue;
      lines.push({
        date, type: cell(row, at.type) || null, payee: cell(row, at.payee) || null,
        particulars: cell(row, at.particulars) || null, code: cell(row, at.code) || null,
        reference: cell(row, at.reference) || null,
        spent: parseAmount(cell(row, at.spent)), received: parseAmount(cell(row, at.received)),
        source: cell(row, at.source) || null,
      });
    }
    return lines;
  }

  const api = {
    parseAmount, parseWidget, shortCodeFromPath, isShortCode, bankAccountsUrl,
    accountIdFromHref, isAccountId, statementsUrl, sameName, parseXeroDate, parseStatementRows,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AkrioBankParser = api;
})(typeof self !== 'undefined' ? self : this);
