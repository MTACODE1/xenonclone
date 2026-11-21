// The extension refuses a reading when Xero's page looks different from what it knows, instead of saving a wrong
// figure. Card texts below are shaped exactly like Xero's live page on 21 Nov 2026 (names and figures made up).
const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../extension/parser');

const card = (lines, extra = {}) => ({ headerText: lines[0], hasHeader: true, text: lines.join('\n'), ...extra });
const problemsOf = raw => parser.widgetProblems(raw, parser.parseWidget(raw));

const KNOWN_CARDS = {
  toReconcile: card(['Main Account', '00-00-00-00000000', 'Reconcile 48 items', 'Balance in Xero', 'Balance in Xero\t(1,234.56)',
    'Statement balance (Oct 12)', 'Statement balance (Oct 12)\t9,876.54']),
  reconciled: card(['Closed Wallet', '00-00-00-11111111', 'Reconciled', 'Statement balance (Jun 4)', 'Statement balance (Jun 4)\t0.00',
    'Skip graph', 'Oct 25', 'Nov 1']),
  nothingImported: card(['Wise AUD', '210000000', 'No transactions imported', 'Import a bank statement']),
  feedProblemNothingImported: card(['Supplementary Card', 'XXXX-XXXX-XXXX-0000', '', 'There is a problem with this bank feed', '',
    'Details...', 'No transactions imported', 'Import a bank statement'], { feedProblem: true }),
  nothingImportedWithBalances: card(['Dummy USD Account', '10000003', 'No transactions imported', 'Import a bank statement',
    'Balance in Xero', 'Balance in Xero\t(1,657.62)', '', 'Statement balance', 'Statement balance\t0.00']),
  balancesDiffer: card(['Card Account', 'XXXX-XXXX-XXXX-0000', 'Why is this different?', 'Balance in Xero', 'Balance in Xero\t0.00',
    'Statement balance (Apr 30)', 'Statement balance (Apr 30)\t(2,000.00)', 'Automatic bank feeds are available', 'Get bank feeds']),
  noFeedNothingImported: card(['PayPal CAD', 'GBP', 'Get bank feedsManually import a statement'], { noFeed: true }),
  accountCalledReconciled: card(['Reconcile Holdings', '123', 'Reconciled', 'Statement balance (Jul 5)', 'Statement balance (Jul 5)\t2.94']),
};

test('every card state Xero is known to show passes the check', () => {
  for (const [name, raw] of Object.entries(KNOWN_CARDS)) assert.deepEqual(problemsOf(raw), [], name);
  const widgets = Object.values(KNOWN_CARDS);
  assert.deepEqual(parser.bankPageProblems({ widgets, accounts: widgets.map(parser.parseWidget), cardsTextOnPage: true }), []);
});

test('a label whose value cannot be read is a changed page, never a missing figure', () => {
  assert.deepEqual(problemsOf(card(['A', '1', 'Reconcile many items', 'Balance in Xero', 'Balance in Xero\t1.00'])), ['reconcile_count']);
  assert.deepEqual(problemsOf(card(['A', '1', 'Reconciled', 'Balance in Xero', 'Balance in Xero\tGBP 1.00'])), ['balance_in_xero']);
  assert.deepEqual(problemsOf(card(['A', '1', 'Reconciled', 'Statement balance (Jun 4)', 'Statement balance (Jun 4): 0.00'])), ['statement_balance']);
  // Xero moves the value off the label's line: both labels are there, neither value is readable.
  assert.deepEqual(problemsOf(card(['A', '1', 'Reconcile 3 items', 'Balance in Xero', '1.00', 'Statement balance', '2.00'])),
    ['balance_in_xero', 'statement_balance']);
});

test('a card in no known state, or without its header, is reported', () => {
  assert.deepEqual(problemsOf(card(['A', '1', 'Bank feed paused'])), ['unrecognised_card']);
  assert.deepEqual(problemsOf({ headerText: '', hasHeader: false, text: 'A\n1\nReconciled' }), ['card_header']);
  assert.deepEqual(problemsOf({ headerText: '', hasHeader: false, text: '' }), ['card_header', 'account_name', 'unrecognised_card']);
});

test('the page check names the account and spots cards that are no longer found', () => {
  const widgets = [KNOWN_CARDS.reconciled, card(['Broken Account', '1', 'Bank feed paused'])];
  assert.deepEqual(parser.bankPageProblems({ widgets, accounts: widgets.map(parser.parseWidget) }), ['Broken Account: unrecognised_card']);
  assert.deepEqual(parser.bankPageProblems({ widgets: [], accounts: [], cardsTextOnPage: true }), ['cards_not_found']);
  // A client with no bank accounts at all is fine.
  assert.deepEqual(parser.bankPageProblems({ widgets: [], accounts: [], cardsTextOnPage: false }), []);
});

const COLUMNS = ['', 'Date', 'Type', 'Payee', 'Particulars', 'Code', 'Reference', 'Analysis Code', 'Spent', 'Received', 'Balance', 'Source', 'Status'];
const row = (date, spent, received, status = 'Unreconciled') => ['', date, 'Debit', '', 'X', '', '', '', spent, received, '', 'Bank Feed', status];

test('statement lines: a good read passes, every sign of a changed table is reported', () => {
  const good = [row('12 Oct 2026', '10.99', ''), row('15 Jun 2026', '', '1,150.00'), row('9 Oct 2026', '5.00', '', 'Reconciled')];
  const lines = parser.parseStatementRows(COLUMNS, good);
  assert.deepEqual(parser.statementProblems(COLUMNS, good, lines, 2, false), []);
  // Xero's own total is ignored when the list was cut short on purpose.
  assert.deepEqual(parser.statementProblems(COLUMNS, good, lines, 5000, true), []);
  assert.deepEqual(parser.statementProblems(COLUMNS, good, lines, 3, false), ['line_count']);
  const badDate = [row('Oct 12', '10.99', '')];
  assert.deepEqual(parser.statementProblems(COLUMNS, badDate, parser.parseStatementRows(COLUMNS, badDate), 1, false), ['line_date', 'line_count']);
  const badAmount = [row('12 Oct 2026', '£10.99', '')];
  assert.deepEqual(parser.statementProblems(COLUMNS, badAmount, parser.parseStatementRows(COLUMNS, badAmount), 1, false), ['line_amount']);
  assert.deepEqual(parser.statementProblems(['Date', 'Amount', 'Status'], [], null, 0, false), ['line_columns']);
});
