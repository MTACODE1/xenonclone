// Dates on screen are DD/MM/YYYY (UK), as Xero and Xenon show them. These four places still showed
// YYYY-MM-DD or a period code until 24 Nov 2026: the PDF report's basis table, the typed closing balance's
// "entered" date, the period on the Validation page and the Transactions page heading. Made-up data.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ejs = require('ejs');
const { ukDate } = require('../src/services/displayDate');
const { periodKeyLabel } = require('../src/services/periodResolver');

const VIEWS = path.join(__dirname, '../src/views');
const shared = { ukDate, periodKeyLabel, basePath: '/akrio-verify', csrfToken: 't', practiceName: 'P', cssVersion: 't',
  staffName: null, staffRole: null, isStaffManager: false, canAccessSettings: false };
const ISO = /\b20\d\d-\d\d-\d\d\b/;

function snippet(file, startMarker, endMarker) {
  const source = require('fs').readFileSync(path.join(VIEWS, file), 'utf8');
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${file}: markers not found`);
  return source.slice(start, end + endMarker.length);
}

test('PDF report: every date in the basis table is DD/MM/YYYY', () => {
  const html = ejs.render(snippet('report.ejs', '<h2>Basis and evidence</h2>', '</table>'), {
    ...shared,
    selectedPeriod: { start: '2025-09-30', end: '2026-11-21', key: 'since_lock_date:2025-09-30:2026-11-21', label: 'Since Xero Lock Date (30/09/2025)' },
    org: { last_synced_at: '2026-11-21T02:14:00Z', calculated_at: new Date('2026-11-21T02:15:00Z'),
      most_recent_transaction: '2026-11-20', lock_date: new Date('2025-09-30T00:00:00Z') },
    statementImports: [{ bank_account_name: 'Current', statement_end_date: '2026-10-31' }],
  });
  assert.doesNotMatch(html, ISO);
  for (const shown of ['30/09/2025 to 21/11/2026', '21/11/2026 02:14', '21/11/2026 02:15', '20/11/2026', 'Current: 31/10/2026']) {
    assert.ok(html.includes(shown), `shows ${shown}`);
  }
  assert.ok(html.includes('<td>30/09/2025</td>'), 'lock date');
  assert.ok(html.includes('Since Xero Lock Date (30/09/2025)'), 'period in words, not its code');
  const empty = ejs.render(snippet('report.ejs', '<h2>Basis and evidence</h2>', '</table>'), {
    ...shared, selectedPeriod: { start: '2025-09-30', end: '2026-11-21', label: 'x' }, org: {}, statementImports: [],
  });
  for (const word of ['Not synced', 'Not calculated', 'Unavailable', 'Not set']) assert.ok(empty.includes(word));
});

test('client page: a typed closing balance shows the date it was entered as DD/MM/YYYY', () => {
  const html = ejs.render(snippet('client.ejs', '<% if (acc.statement_balance_updated_at) { %>', '<% } %>'), {
    ...shared, acc: { statement_balance_updated_at: '2026-11-21 14:03:09' },
  });
  assert.equal(html.trim(), 'entered 21/11/2026');
});

test('validation page: the period is in words with UK dates, not the stored code', () => {
  const html = ejs.render('<%= periodKeyLabel(key) %>', { ...shared, key: 'since_lock_date:2025-09-30:2026-11-21' });
  assert.equal(html, '30/09/2025 to 21/11/2026');
  const source = require('fs').readFileSync(path.join(VIEWS, 'validation.ejs'), 'utf8');
  assert.ok(source.includes('periodKeyLabel(comparison.periodKey)'));
  assert.ok(!source.includes('<%= comparison.periodKey %>'));
  // app.js hands the helper to every view.
  assert.match(require('fs').readFileSync(path.join(__dirname, '../app.js'), 'utf8'), /app\.locals\.periodKeyLabel = /);
});

test('transactions page heading names the period, not its code', () => {
  const heading = snippet('transactions.ejs', '<p><%=', '</p>');
  const periodOptions = [{ value: 'since_lock_date', label: 'Since Xero Lock Date' }, { value: 'previous_fy', label: 'Previous Financial Year' }];
  assert.match(ejs.render(heading, { ...shared, periodOptions, query: {} }), /^<p>Since Xero Lock Date: worked out/);
  assert.match(ejs.render(heading, { ...shared, periodOptions, query: { period: 'previous_fy' } }), /^<p>Previous Financial Year: worked out/);
  assert.match(ejs.render(heading, { ...shared, periodOptions: [], query: { period: 'odd_one' } }), /^<p>odd one: worked out/);
});

test('PDF report findings: dates inside each finding are DD/MM/YYYY', () => {
  const source = require('fs').readFileSync(path.join(VIEWS, 'report.ejs'), 'utf8');
  const line = source.split('\n').find(l => l.includes('hiddenFindingFields.includes(key)'));
  const cell = line.trim();
  const html = ejs.render(cell, { ...shared, hiddenFindingFields: ['id'],
    row: { id: 'x', contact: 'Made Up Ltd', date: '2026-08-05', dueDate: '2026-09-04', amount: 10, dates: ['2026-01-02', '2026-01-03'], note: null } });
  assert.doesNotMatch(html, ISO);
  assert.ok(html.includes('date: 05/08/2026') && html.includes('dueDate: 04/09/2026'));
  assert.ok(html.includes('dates: 02/01/2026, 03/01/2026') && html.includes('amount: 10') && html.includes('note: —'));
  assert.ok(!html.includes('id: x'));
});

test('check pages: dates inside a sentence are DD/MM/YYYY; references are left alone', () => {
  const source = require('fs').readFileSync(path.join(VIEWS, 'checkDetail.ejs'), 'utf8');
  const start = source.indexOf('const ISO_DATE_RE');
  const end = source.indexOf('\n}\n', source.indexOf('function fmtDisplayDate')) + 2;
  const fmtDisplayDate = new Function(source.slice(start, end) + '; return fmtDisplayDate;')();
  assert.equal(fmtDisplayDate('2026-11-24'), '24/11/2026');
  assert.equal(fmtDisplayDate('No dividend postings found between 2026-11-01 and 2026-11-24 although'), 'No dividend postings found between 01/11/2026 and 24/11/2026 although');
  assert.equal(fmtDisplayDate('INV-2026-11-01'), 'INV-2026-11-01');
  assert.equal(fmtDisplayDate(12.5), 12.5);
});

test('dividend check message names its dates as DD/MM/YYYY', () => {
  const journalChecks = require('../src/services/journalChecks');
  const name = Object.keys(journalChecks).find(k => /dividend/i.test(k) && typeof journalChecks[k] === 'function');
  assert.ok(name, 'dividend check exported');
  const source = require('fs').readFileSync(path.join(__dirname, '../src/services/journalChecks.js'), 'utf8');
  assert.match(source, /between \$\{ukDate\(fyStart\)\} and \$\{ukDate\(fyEnd\)\}/);
  assert.doesNotMatch(source, /between \$\{fyStart\} and \$\{fyEnd\}/);
});

test('Xero\'s statement date label is shown day first, never with a guessed year (James\'s meeting, 23 Nov 2026)', () => {
  const { ukStatementLabel } = require('../src/services/displayDate');
  assert.equal(ukStatementLabel('Nov 17'), '17 Nov');
  assert.equal(ukStatementLabel('Nov 17, 2025'), '17 Nov 2025');
  assert.equal(ukStatementLabel('17 Nov'), '17 Nov');
  assert.equal(ukStatementLabel(null), null);
  assert.match(require('fs').readFileSync(path.join(__dirname, '../src/db/bankScreenReadings.js'), 'utf8'), /statementDateLabel: ukStatementLabel\(row\.statement_date_label\)/);
});

test('the browser extension writes its "last Xero read" time in UK order', () => {
  const source = require('fs').readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8')
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(source, /toLocaleString\(\)/);
  assert.match(source, /toLocaleString\('en-GB'/);
});
