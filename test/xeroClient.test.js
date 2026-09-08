const test = require('node:test');
const assert = require('node:assert/strict');
const { retryAfterMs, isTransientError } = require('../src/services/xeroClient');

// --- retryAfterMs: honour Xero's Retry-After header on 429, per their rate-limit documentation ---
// Xero states the header is an integer number of seconds; this also tolerates an HTTP-date form
// defensively, and falls through to null (blind exponential backoff) whenever it's absent/invalid —
// a non-Xero transient error, or a 429 with no header, must behave exactly as before this existed.

test('retryAfterMs parses a plain integer-seconds header, the form Xero documents', () => {
  const err = { response: { statusCode: 429, headers: { 'retry-after': '30' } } };
  assert.equal(retryAfterMs(err), 30000);
});

test('retryAfterMs is capitalisation-tolerant (some proxies title-case headers)', () => {
  const err = { response: { statusCode: 429, headers: { 'Retry-After': '5' } } };
  assert.equal(retryAfterMs(err), 5000);
});

test('retryAfterMs returns null when the header is absent — falls through to exponential backoff', () => {
  assert.equal(retryAfterMs({ response: { statusCode: 429, headers: {} } }), null);
  assert.equal(retryAfterMs({ response: { statusCode: 429 } }), null);
  assert.equal(retryAfterMs({}), null);
});

test('retryAfterMs returns null for a header value that parses to neither a number nor a date', () => {
  const err = { response: { statusCode: 429, headers: { 'retry-after': 'not-a-value-at-all' } } };
  assert.equal(retryAfterMs(err), null);
});

test('retryAfterMs treats zero seconds as a real, honoured value — not "missing"', () => {
  const err = { response: { statusCode: 429, headers: { 'retry-after': '0' } } };
  assert.equal(retryAfterMs(err), 0);
});

test('retryAfterMs falls back to an HTTP-date form and returns a non-negative delay', () => {
  const future = new Date(Date.now() + 15000).toUTCString();
  const err = { response: { statusCode: 429, headers: { 'retry-after': future } } };
  const delay = retryAfterMs(err);
  assert.ok(delay != null && delay > 10000 && delay <= 15000, `expected ~15000ms, got ${delay}`);
});

test('retryAfterMs never returns a negative delay for a date already in the past', () => {
  const past = new Date(Date.now() - 15000).toUTCString();
  const err = { response: { statusCode: 429, headers: { 'retry-after': past } } };
  assert.equal(retryAfterMs(err), 0);
});

// --- isTransientError: unaffected by this change, still recognises 429/5xx and network drops ---

test('isTransientError still recognises 429 and 5xx status codes', () => {
  for (const statusCode of [429, 500, 502, 503, 504]) {
    assert.equal(isTransientError({ response: { statusCode } }), true, `statusCode ${statusCode}`);
  }
  assert.equal(isTransientError({ response: { statusCode: 400 } }), false);
});

test('isTransientError still recognises transient network error codes', () => {
  assert.equal(isTransientError({ code: 'ECONNRESET' }), true);
  assert.equal(isTransientError({ code: 'ETIMEDOUT' }), true);
  assert.equal(isTransientError({ code: 'SOME_OTHER_CODE' }), false);
});
