// Validation and small pure helpers for "bank screen readings": the figures Xero shows on its Bank
// accounts page (items to reconcile, balance in Xero, statement balance), read by the Akrio Verify
// browser extension because Xero's API does not provide them. Everything here is pure.
const { isShortCode } = require('../../extension/parser');

const MAX_ACCOUNTS = 60;
const MAX_AMOUNT = 1e12;
const MAX_ITEMS = 1000000;
const STALE_AFTER_DAYS = 7;
const DATE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ,.]{0,19}$/;

class ReadingError extends Error {}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function text(value, name, max, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw new ReadingError(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new ReadingError(`${name} must be text`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new ReadingError(`${name} is required`);
    return null;
  }
  if (trimmed.length > max) throw new ReadingError(`${name} is too long`);
  return trimmed;
}

function amount(value, name) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_AMOUNT) {
    throw new ReadingError(`${name} must be an amount`);
  }
  const rounded = Math.sign(value) * Math.round(Math.abs(value) * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

function flag(value, name) {
  if (typeof value !== 'boolean') throw new ReadingError(`${name} must be true or false`);
  return value;
}

// Returns a clean copy with only the known fields, or throws ReadingError. Nothing is defaulted: a
// missing count stays null ("Xero did not show a number"), it never becomes 0.
function validateReading(body) {
  if (!isPlainObject(body)) throw new ReadingError('The reading is missing');
  if (!isShortCode(body.shortCode)) throw new ReadingError('The Xero short code is not valid');
  if (!Array.isArray(body.accounts)) throw new ReadingError('accounts must be a list');
  if (body.accounts.length > MAX_ACCOUNTS) throw new ReadingError('Too many bank accounts in one reading');
  const accounts = body.accounts.map((raw, index) => {
    const at = `Bank account ${index + 1}`;
    if (!isPlainObject(raw)) throw new ReadingError(`${at} is not valid`);
    let items = raw.itemsToReconcile;
    if (items != null && (!Number.isInteger(items) || items < 0 || items > MAX_ITEMS)) {
      throw new ReadingError(`${at}: items to reconcile must be a whole number`);
    }
    if (items == null) items = null;
    const label = text(raw.statementDateLabel, `${at}: statement date`, 20);
    if (label != null && !DATE_LABEL.test(label)) throw new ReadingError(`${at}: statement date is not valid`);
    return {
      accountName: text(raw.accountName, `${at}: name`, 255, { required: true }),
      accountNumber: text(raw.accountNumber, `${at}: number`, 64),
      itemsToReconcile: items,
      reconciled: flag(raw.reconciled, `${at}: reconciled`),
      balancesDiffer: flag(raw.balancesDiffer, `${at}: balancesDiffer`),
      balanceInXero: amount(raw.balanceInXero, `${at}: balance in Xero`),
      statementBalance: amount(raw.statementBalance, `${at}: statement balance`),
      statementDateLabel: label,
      feedProblem: flag(raw.feedProblem, `${at}: feedProblem`),
      stoppedImporting: flag(raw.stoppedImporting, `${at}: stoppedImporting`),
      noFeed: flag(raw.noFeed, `${at}: noFeed`),
    };
  });
  return { shortCode: body.shortCode, pageTitle: text(body.pageTitle, 'Page title', 200), accounts };
}

// One bank account's unreconciled statement lines, as read from Xero's "Bank statements" tab by the extension
// (the "items to reconcile" list). Same rule as readings: a clean copy of known fields or a ReadingError.
const MAX_LINES = 1000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function validateLines(body) {
  if (!isPlainObject(body)) throw new ReadingError('The lines are missing');
  if (!isShortCode(body.shortCode)) throw new ReadingError('The Xero short code is not valid');
  if (!Array.isArray(body.lines)) throw new ReadingError('lines must be a list');
  if (body.lines.length > MAX_LINES) throw new ReadingError('Too many lines for one bank account');
  const lines = body.lines.map((raw, index) => {
    const at = `Line ${index + 1}`;
    if (!isPlainObject(raw)) throw new ReadingError(`${at} is not valid`);
    if (typeof raw.date !== 'string' || !ISO_DAY.test(raw.date) || Number.isNaN(Date.parse(raw.date + 'T00:00:00Z'))
      || new Date(raw.date + 'T00:00:00Z').toISOString().slice(0, 10) !== raw.date) {
      throw new ReadingError(`${at}: the date is not valid`);
    }
    const spent = amount(raw.spent, `${at}: spent`);
    const received = amount(raw.received, `${at}: received`);
    return {
      date: raw.date, type: text(raw.type, `${at}: type`, 40), payee: text(raw.payee, `${at}: payee`, 255),
      particulars: text(raw.particulars, `${at}: particulars`, 500), code: text(raw.code, `${at}: code`, 100),
      reference: text(raw.reference, `${at}: reference`, 255), spent, received, source: text(raw.source, `${at}: source`, 60),
    };
  });
  let total = body.totalShownByXero;
  if (total != null && (!Number.isInteger(total) || total < 0 || total > MAX_ITEMS)) throw new ReadingError('The total shown by Xero is not valid');
  if (total == null) total = null;
  return {
    shortCode: body.shortCode, accountName: text(body.accountName, 'Bank account name', 255, { required: true }),
    lines, truncated: body.truncated === true, totalShownByXero: total,
  };
}

// Figures for the Unprocessed Bank check from one account's stored lines: how much money, and how old.
function summariseLines(lines) {
  let value = 0, oldest = null;
  for (const line of lines || []) {
    value += Math.abs(Number(line.spent) || 0) + Math.abs(Number(line.received) || 0);
    if (line.date && (oldest == null || line.date < oldest)) oldest = line.date;
  }
  return { value: Math.round(value * 100) / 100, oldest };
}

// rows: [{ orgId, shortCode }] from the cached Xero organisation records. A short code that appears
// for more than one organisation is left out altogether, so a reading can never land on the wrong client.
function buildShortCodeIndex(rows) {
  const byCode = new Map();
  const ambiguous = new Set();
  for (const row of rows || []) {
    if (!row || !isShortCode(row.shortCode) || !Number.isInteger(row.orgId)) continue;
    if (byCode.has(row.shortCode) && byCode.get(row.shortCode) !== row.orgId) ambiguous.add(row.shortCode);
    else byCode.set(row.shortCode, row.orgId);
  }
  for (const code of ambiguous) byCode.delete(code);
  const byOrg = new Map();
  for (const [code, orgId] of byCode) {
    if (byOrg.has(orgId)) byOrg.set(orgId, null); // one organisation with two codes: not trusted either
    else byOrg.set(orgId, code);
  }
  for (const [orgId, code] of byOrg) {
    if (code === null) { byOrg.delete(orgId); for (const [c, o] of byCode) if (o === orgId) byCode.delete(c); }
  }
  return { byCode, byOrg };
}

function readingFreshness(readAt, now = new Date()) {
  const time = readAt instanceof Date ? readAt.getTime() : Date.parse(readAt);
  if (!Number.isFinite(time)) return 'unknown';
  return now.getTime() - time > STALE_AFTER_DAYS * 86400000 ? 'stale' : 'current';
}

module.exports = {
  ReadingError, validateReading, buildShortCodeIndex, readingFreshness,
  MAX_ACCOUNTS, STALE_AFTER_DAYS, validateLines, summariseLines, MAX_LINES,
};
