// Pure parsing for the accounts table on Zoho Books' Banking page (https://books.zoho.<dc>/app/<org id>#/banking).
// No DOM access here, so the same file runs in the extension and under `node --test`. The page script hands it the
// table's HTML exactly as the page has it, so the tests run the very same code on a saved copy of the page.
// Zoho's API refuses the bank endpoints to Verify's sign-in (no banking scope) and has no report endpoints, so
// the visible page is the only place these figures can come from. Kept apart from parser.js so the Xero reader
// is not touched by anything here.
(function (root) {
  'use strict';

  // Zoho Books runs in separate data centres, each on its own domain. A tab on any other host is never read.
  const BOOKS_HOSTS = ['books.zoho.com', 'books.zoho.eu', 'books.zoho.in', 'books.zoho.com.au', 'books.zoho.jp',
    'books.zoho.sa', 'books.zoho.uk', 'books.zoho.ae', 'books.zoho.com.cn', 'books.zohocloud.ca'];
  const DEFAULT_BOOKS_HOST = 'books.zoho.com';
  const isBooksHost = host => BOOKS_HOSTS.includes(String(host || '').toLowerCase());
  // Zoho's own sign-in pages (accounts.zoho.<dc>): a tab that lands there means the user is signed out.
  const isZohoSignInHost = host => /^accounts\.(zoho\.(com|eu|in|com\.au|jp|sa|uk|ae|com\.cn)|zohocloud\.ca)$/i.test(String(host || ''));

  // Zoho's organization_id is a plain number (about 9 to 12 digits seen). Verify stores it as "zoho-<id>".
  const isZohoOrgId = value => typeof value === 'string' && /^\d{5,20}$/.test(value);
  const bankingUrl = (host, orgId) => 'https://' + host + '/app/' + orgId + '#/banking';
  // "/app/60012345678" -> "60012345678". Zoho keeps the organisation in the path and the screen in the hash.
  function orgIdFromPath(pathname) {
    const match = String(pathname || '').match(/^\/app\/(\d{5,20})\/?$/);
    return match ? match[1] : null;
  }
  // "#/banking" (the overview), optionally with a query; never an account's own page ("#/banking/123...").
  const isBankingHash = hash => /^#\/banking\/?(\?[^#]*)?$/.test(String(hash || ''));

  // ---- text helpers ----
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function decode(text) {
    return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : whole;
    });
  }
  // The visible words of a piece of HTML: comments, scripts and styles dropped, tags removed, spaces collapsed.
  function textOf(html) {
    return decode(String(html || '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ' '))
      .replace(/[\s ​]+/g, ' ').trim();
  }
  const firstTag = (html, tag) => {
    const match = String(html || '').match(new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '\\s*>', 'i'));
    return match ? textOf(match[1]) : null;
  };
  const attrClass = openTag => { const match = String(openTag).match(/\bclass\s*=\s*"([^"]*)"/i); return match ? match[1] : ''; };

  // ---- amounts ----
  // Zoho puts the currency in front of the figure and the minus inside it: "AED895,408.35", "$-55,254.31".
  // A minus in front ("-$1.00") or brackets are read as negative too. Thousands separators are commas (Indian
  // grouping "8,95,408.35" included) and the decimal point is a dot; up to three decimals (BHD, KWD, OMR).
  // Anything else (another number format, a figure without digits) is null, never 0, so the page check refuses
  // the reading rather than saving a wrong figure.
  const CURRENCY = "[A-Za-z]{1,4}\\$?|[$£€₹¥]";
  const AMOUNT = new RegExp('^(\\()?\\s*(-)?\\s*(' + CURRENCY + ')?\\s*(-)?\\s*(\\d{1,3}(?:,\\d{2,3})*|\\d+)(\\.\\d{1,3})?\\s*(\\))?$');
  function parseZohoAmount(value) {
    if (value == null) return null;
    const match = decode(String(value)).replace(/[  ]/g, ' ').trim().match(AMOUNT);
    if (!match) return null;
    const [, open, minusBefore, currency, minusAfter, whole, decimals, close] = match;
    if (Boolean(open) !== Boolean(close)) return null;
    if (minusBefore && minusAfter) return null;
    // Commas must group in threes at the right-hand end ("1,234" or Indian "1,23,456"), never "12,34".
    if (whole.includes(',') && !/,\d{3}$/.test(whole)) return null;
    const amount = Number(whole.replace(/,/g, '') + (decimals || ''));
    if (!Number.isFinite(amount)) return null;
    const negative = Boolean(open || minusBefore || minusAfter) && amount !== 0;
    return { amount: negative ? -amount : amount, currency: currency || null };
  }

  // An amount Zoho shows in a format this reader does not support yet, as opposed to a page that has changed:
  // European number format ("1.234,56"), or a currency other than the prefixes above or written after the figure
  // ("د.إ1,000.00", "₱1,000.00", "1,000.00 €"). Such a client can never be read until support is added, so it
  // gets its own problem code and message instead of "Zoho Books has changed its Banking page".
  function isUnsupportedAmountFormat(value) {
    const text = decode(String(value == null ? '' : value)).replace(/[  ]/g, ' ').trim();
    if (!/\d/.test(text) || parseZohoAmount(text)) return false;
    const figure = text.replace(/[^\d.,]/g, '');
    if (/^\d{1,3}(\.\d{3})+(,\d{1,3})?$|^\d+,\d{1,2}$/.test(figure)) return true;
    const rest = text.replace(/[\d.,\s()-]/g, '');
    if (!rest) return false;
    if (!new RegExp('^(?:' + CURRENCY + ')$').test(rest)) return true;
    return /\d\s*[^\d\s.,()-]+$/.test(text); // a known currency, but after the figure
  }

  // The Uncategorized cell: empty when nothing waits (Zoho shows no link then), else a link "<n> transactions"
  // ("1 transaction" handled as well). Anything else is null: not a count Zoho is known to show.
  function parseUncategorised(value) {
    const text = textOf(value == null ? '' : String(value));
    if (text === '') return 0;
    const match = text.match(/^(\d{1,3}(?:,\d{3})*|\d+) transactions?$/i);
    return match ? Number(match[1].replace(/,/g, '')) : null;
  }

  // The summary above the table says "<n> Uncategorized Transactions" for the whole organisation. Kept with the
  // reading so a difference from the rows (for example an inactive account Zoho hides) can be shown.
  function parseSummaryTotal(text) {
    const match = String(text || '').match(/(\d{1,3}(?:,\d{3})*|\d+)\s+Uncategori[sz]ed\s+Transactions?/i);
    return match ? Number(match[1].replace(/,/g, '')) : null;
  }

  // ---- the accounts table ----
  const COLUMNS = {
    details: /^account details$/i,
    uncategorised: /^uncategori[sz]ed$/i,
    bank: /^amount in bank$/i,
    books: /^amount in zoho books$/i,
  };
  const MAX_TABLE_HTML = 600000;

  // table = the outer HTML of the one table on the Banking page whose text has "Uncategorized".
  // Returns { headers, rows: [{ cells: [html], rowClass }] } with header texts in order and each body row's cells.
  function splitTable(html) {
    const source = String(html || '').slice(0, MAX_TABLE_HTML);
    const headers = [];
    const head = source.match(/<thead\b[^>]*>([\s\S]*?)<\/thead\s*>/i);
    const headerSource = head ? head[1] : source;
    const th = /<th\b[^>]*>([\s\S]*?)<\/th\s*>/gi;
    let match;
    while ((match = th.exec(headerSource))) headers.push(textOf(match[1]));
    const bodySource = head ? source.slice(source.indexOf(head[0]) + head[0].length) : source;
    const rows = [];
    const tr = /<tr\b([^>]*)>([\s\S]*?)<\/tr\s*>/gi;
    while ((match = tr.exec(bodySource))) {
      const cells = [];
      const td = /<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi;
      let cell;
      while ((cell = td.exec(match[2]))) cells.push(cell[1]);
      if (cells.length) rows.push({ cells, rowClass: attrClass('<tr' + match[1] + '>') });
    }
    return { headers, rows };
  }

  // One row -> one bank account, figures as Zoho shows them. Unreadable values stay null (the check below
  // then names them); nothing is defaulted except the empty Uncategorized cell, which is Zoho's "none".
  function parseRow(cells, at) {
    const cell = name => (at[name] >= 0 && cells[at[name]] != null ? cells[at[name]] : null);
    const details = cell('details') || '';
    // The name is the link in the first cell; the masked number ("xxxx0001") is the small line under it.
    const accountName = (firstTag(details, 'a') || textOf(details).split(' xxxx')[0] || '').trim();
    const accountNumber = (firstTag(details, 'p') || '').trim() || null;
    const bankText = textOf(cell('bank'));
    const booksText = textOf(cell('books'));
    const bank = parseZohoAmount(bankText);
    const books = parseZohoAmount(booksText);
    return {
      accountName,
      accountNumber,
      uncategorised: cell('uncategorised') == null ? null : parseUncategorised(cell('uncategorised')),
      amountInBank: bank ? bank.amount : null,
      amountInBooks: books ? books.amount : null,
      // The currency exactly as Zoho prefixes it ("AED", "$"). Zoho shows one currency per account.
      currency: (books && books.currency) || (bank && bank.currency) || null,
      // Kept as shown so the page can display Zoho's own wording next to the parsed figure.
      amountInBankText: bankText.slice(0, 40) || null,
      amountInBooksText: booksText.slice(0, 40) || null,
    };
  }

  // Returns { accounts, problems }. A problem is a short code, with the account's name when it is about one row.
  // Problems mean Zoho has changed the page (or the page is half drawn): nothing is saved while there are any.
  function parseBankingTable(html) {
    const problems = [];
    const { headers, rows } = splitTable(html);
    const at = {};
    for (const [name, pattern] of Object.entries(COLUMNS)) at[name] = headers.findIndex(header => pattern.test(header));
    for (const [name, index] of Object.entries(at)) if (index < 0) problems.push('column_' + name);
    if (problems.length) return { accounts: [], problems };
    const accounts = [];
    rows.forEach((row, i) => {
      const account = parseRow(row.cells, at);
      const label = String(account.accountName || 'Row ' + (i + 1)).slice(0, 60);
      if (!account.accountName) problems.push(label + ': account_name');
      if (account.accountName.length > 255) problems.push(label + ': account_name_length');
      if (account.accountNumber && account.accountNumber.length > 64) problems.push(label + ': account_number');
      if (account.uncategorised == null) problems.push(label + ': uncategorised');
      if (account.amountInBank == null) problems.push(label + (isUnsupportedAmountFormat(account.amountInBankText) ? ': amount_format' : ': amount_in_bank'));
      if (account.amountInBooks == null) problems.push(label + (isUnsupportedAmountFormat(account.amountInBooksText) ? ': amount_format' : ': amount_in_books'));
      accounts.push(account);
    });
    return { accounts, problems };
  }

  const api = {
    BOOKS_HOSTS, DEFAULT_BOOKS_HOST, isBooksHost, isZohoSignInHost, isZohoOrgId, bankingUrl, orgIdFromPath,
    isBankingHash, parseZohoAmount, isUnsupportedAmountFormat, parseUncategorised, parseSummaryTotal, splitTable, parseBankingTable, textOf,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AkrioZohoParser = api;
})(typeof self !== 'undefined' ? self : this);
