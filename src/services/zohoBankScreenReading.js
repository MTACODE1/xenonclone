// Validation and the display rules for readings of Zoho Books' Banking page, taken by the Akrio Verify browser
// extension for Zoho Books clients. Zoho's API refuses Verify the bank endpoints and has no reports, so the
// figures Zoho shows per bank account (uncategorised transactions, Amount in Bank, Amount in Zoho Books) can only
// be read from the screen. Kept apart from bankScreenReading.js so the Xero readings are not changed in any way.
// Everything here is pure.
const { isZohoOrgId, isBooksHost } = require('../../extension/zoho-parser');
const { ReadingError, readingFreshness, STALE_AFTER_DAYS, MAX_ACCOUNTS } = require('./bankScreenReading');

const MAX_AMOUNT = 1e12;
const MAX_ITEMS = 1000000;
// The currency as Zoho prefixes it: a code ("AED", "US$") or a symbol ("$", "£", "€", "₹", "¥").
const CURRENCY = /^(?:[A-Za-z]{1,4}\$?|[$£€₹¥])$/;

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

// Both amounts are required: the extension refuses a page where either could not be read, so a missing one
// here means the request did not come from it. Three decimals are kept for currencies that have them (BHD, KWD).
function amount(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_AMOUNT) {
    throw new ReadingError(`${name} must be an amount`);
  }
  const rounded = Math.sign(value) * Math.round(Math.abs(value) * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}

// Returns a clean copy with only the known fields, or throws ReadingError.
function validateZohoReading(body) {
  if (!isPlainObject(body)) throw new ReadingError('The reading is missing');
  if (!isZohoOrgId(body.orgId)) throw new ReadingError('The Zoho Books organisation id is not valid');
  if (body.booksHost != null && !isBooksHost(body.booksHost)) throw new ReadingError('The Zoho Books address is not valid');
  if (!Array.isArray(body.accounts)) throw new ReadingError('accounts must be a list');
  // The extension only sends a reading once the accounts table has been drawn with at least one account; an
  // empty one could be a page that had not finished loading, and Zoho's API cannot tell Verify otherwise.
  if (!body.accounts.length) throw new ReadingError('No bank accounts were read');
  if (body.accounts.length > MAX_ACCOUNTS) throw new ReadingError('Too many bank accounts in one reading');
  let summaryTotal = body.summaryTotal;
  if (summaryTotal != null && (!Number.isInteger(summaryTotal) || summaryTotal < 0 || summaryTotal > MAX_ITEMS)) {
    throw new ReadingError('The uncategorised total is not valid');
  }
  if (summaryTotal == null) summaryTotal = null;
  const accounts = body.accounts.map((raw, index) => {
    const at = `Bank account ${index + 1}`;
    if (!isPlainObject(raw)) throw new ReadingError(`${at} is not valid`);
    const count = raw.uncategorised;
    if (!Number.isInteger(count) || count < 0 || count > MAX_ITEMS) throw new ReadingError(`${at}: uncategorised must be a whole number`);
    const currency = text(raw.currency, `${at}: currency`, 6);
    if (currency != null && !CURRENCY.test(currency)) throw new ReadingError(`${at}: currency is not valid`);
    return {
      accountName: text(raw.accountName, `${at}: name`, 255, { required: true }),
      accountNumber: text(raw.accountNumber, `${at}: number`, 64),
      uncategorised: count,
      currency,
      amountInBank: amount(raw.amountInBank, `${at}: amount in bank`),
      amountInBooks: amount(raw.amountInBooks, `${at}: amount in Zoho Books`),
    };
  });
  return {
    orgId: body.orgId,
    booksHost: body.booksHost == null ? null : String(body.booksHost).toLowerCase(),
    pageTitle: text(body.pageTitle, 'Page title', 200),
    summaryTotal,
    accounts,
  };
}

// ---- display rules ----
// Zoho shows "Amount in Bank" as 0.00 on every account that has no bank feed (seen live on a client with no feeds:
// every account, cash and petty cash included, showed 0.00), and the row does not say whether a feed is connected.
// So a bank amount of exactly zero is shown as "no bank feed / statement balance not available" and no difference
// is worked out for it: comparing a ledger balance with a zero that only means "no feed" would report a false
// difference. The cost: a connected feed whose balance really is 0.00 is shown the same way. Any other bank amount
// is the feed's balance, and the difference is Amount in Zoho Books minus Amount in Bank.
function bankFeedOf(account) {
  if (Number(account.amountInBank) === 0) return { state: 'not_available', difference: null };
  const difference = Math.round((Number(account.amountInBooks) - Number(account.amountInBank)) * 1000) / 1000;
  return { state: 'shown', difference: difference === 0 ? 0 : difference };
}

// What the client page shows: freshness of the whole reading (stale after STALE_AFTER_DAYS, the same rule as the
// Xero readings; a stale reading is still shown, marked as stale, never treated as current), each account's feed
// state and difference, and whether the rows add up to Zoho's own uncategorised total.
function presentZohoReading(reading, now = new Date()) {
  if (!reading) return null;
  const accounts = reading.accounts.map(account => {
    const feed = bankFeedOf(account);
    return { ...account, bankFeed: feed.state, difference: feed.difference };
  });
  const uncategorisedTotal = accounts.reduce((sum, account) => sum + (Number(account.uncategorised) || 0), 0);
  return {
    ...reading,
    accounts,
    freshness: readingFreshness(reading.readAt, now),
    uncategorisedTotal,
    // Zoho's summary counts every account of the organisation; the table shows active accounts only.
    summaryDiffers: reading.summaryTotal != null && reading.summaryTotal !== uncategorisedTotal,
  };
}

// Verify keeps each Zoho client's API domain (from Zoho's sign-in answer). The Books web app of the same data centre
// is on the matching books domain; Canada's is books.zohocloud.ca. Anything else is null (the extension then uses
// books.zoho.com).
function booksHostFromApiDomain(apiDomain) {
  const match = String(apiDomain || '').trim().match(/^https:\/\/(?:www\.)?zohoapis\.(com|eu|in|com\.au|jp|ca|sa|uk|ae|com\.cn)\/?$/i);
  if (!match) return null;
  const dc = match[1].toLowerCase();
  const host = dc === 'ca' ? 'books.zohocloud.ca' : 'books.zoho.' + dc;
  return isBooksHost(host) ? host : null;
}

module.exports = {
  validateZohoReading, presentZohoReading, bankFeedOf, booksHostFromApiDomain, STALE_AFTER_DAYS,
};
