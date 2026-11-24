// How an amount is written on screen in the client's own currency. Amounts are never converted:
// a Zoho Books client in the UAE keeps its books in AED, so its figures are AED and must say so.
// GBP keeps the "£" every page has always shown, written exactly as before, so Xero and FreeAgent
// pages do not change by a single character. Any other currency is shown by its code ("AED 1,234"),
// which reads clearly for currencies whose symbols are ambiguous or unfamiliar.

const DEFAULT_CURRENCY = 'GBP';

function currencyCode(code) {
  const text = String(code == null ? '' : code).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(text) ? text : DEFAULT_CURRENCY;
}

// What goes in front of an amount: "£" for GBP (and when the currency is missing or not a valid
// code), otherwise the code and a space, e.g. "AED ".
function currencyPrefix(code) {
  const clean = currencyCode(code);
  return clean === DEFAULT_CURRENCY ? '£' : `${clean} `;
}

// The amount with its currency, grouped the UK way ("£181,990.37", "AED 163,290.00"). A negative
// figure reads "-£50.00", not "£-50.00", and one that rounds to nothing has no minus sign.
// opts.decimals sets the decimal places (2 by default).
function formatMoney(amount, code, opts = {}) {
  const decimals = Number.isInteger(opts.decimals) ? opts.decimals : 2;
  const number = Number(amount);
  const value = Number.isFinite(number) ? number : 0;
  const text = Math.abs(value).toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${value < 0 && Number(text.replace(/,/g, '')) !== 0 ? '-' : ''}${currencyPrefix(code)}${text}`;
}

module.exports = { currencyPrefix, formatMoney, currencyCode, DEFAULT_CURRENCY };
