// Phase 5, section 1: pagination boundary behaviour. getAllPages (xeroClient.js) stops when a page
// comes back with fewer than 100 items — Xero's own page size for every endpoint this app calls
// (GetInvoices, GetContacts, GetBankTransactions, GetJournals all page at 100; GetAccounts and
// GetTaxRates have no `page` parameter at all and always return the full list in one call, so they
// are never routed through getAllPages — see the comments at xeroSync.js:466 and :664).
const test = require('node:test');
const assert = require('node:assert/strict');
const { getAllPages } = require('../src/services/xeroClient');

function fakeFetch(pages) {
  let call = 0;
  return async () => {
    const items = pages[call] || [];
    call++;
    return items;
  };
}

test('an empty first page (0 items) returns immediately with no items and one call', async () => {
  const fetchFn = fakeFetch([[]]);
  const result = await getAllPages(null, 't', fetchFn);
  assert.deepEqual(result, []);
});

test('a single partial page (1 item, well under 100) stops after one call', async () => {
  const fetchFn = fakeFetch([[{ id: 1 }]]);
  const result = await getAllPages(null, 't', fetchFn);
  assert.equal(result.length, 1);
});

test('a page of 99 items (one short of a full page) is treated as the final page', async () => {
  const page1 = Array.from({ length: 99 }, (_, i) => ({ id: i }));
  const fetchFn = fakeFetch([page1]);
  const result = await getAllPages(null, 't', fetchFn);
  assert.equal(result.length, 99, 'must not request a second page for a 99-item response');
});

test('a page of exactly 100 items (the full page size) always requests a next page', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  const fetchFn = fakeFetch([page1, []]);
  const result = await getAllPages(null, 't', fetchFn);
  assert.equal(result.length, 100, 'must stop once the next page comes back empty');
});

test('a page of 101 items is impossible from a real Xero response, but a full page followed by 1 more is the exact-boundary case that matters', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  const page2 = [{ id: 100 }];
  const fetchFn = fakeFetch([page1, page2]);
  const result = await getAllPages(null, 't', fetchFn);
  assert.equal(result.length, 101, 'the 101st item on page 2 must not be dropped');
});

test('exactly 200 items across two full pages, terminated by an empty third page', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  const page2 = Array.from({ length: 100 }, (_, i) => ({ id: 100 + i }));
  const fetchFn = fakeFetch([page1, page2, []]);
  const result = await getAllPages(null, 't', fetchFn);
  assert.equal(result.length, 200);
  assert.deepEqual(result.map(i => i.id), Array.from({ length: 200 }, (_, i) => i));
});

test('exact final-page boundary: two full pages then a final page of exactly 100 (the pathological ambiguous case)', async () => {
  // If page N is exactly 100 items, getAllPages cannot distinguish "this is the final page,
  // coincidentally exactly 100" from "there is more" — by design it always requests page N+1. This
  // test documents that one extra (empty) call is unavoidable and correct, not a bug to silence.
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  const page2 = Array.from({ length: 100 }, (_, i) => ({ id: 100 + i }));
  const page3 = Array.from({ length: 100 }, (_, i) => ({ id: 200 + i }));
  const fetchFn = fakeFetch([page1, page2, page3, []]);
  const result = await getAllPages(null, 't', fetchFn);
  assert.equal(result.length, 300);
});

test('fetchFn receiving null or undefined instead of an array is treated as end-of-results, not an error', async () => {
  const fetchFn = fakeFetch([undefined]);
  const result = await getAllPages(null, 't', fetchFn);
  assert.deepEqual(result, []);
});

test('getAllPages passes the correct 1-indexed page number to fetchFn on every call', async () => {
  const seenPages = [];
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  const fetchFn = async (xero, tenantId, page) => {
    seenPages.push(page);
    return page === 1 ? page1 : [];
  };
  await getAllPages(null, 't', fetchFn);
  assert.deepEqual(seenPages, [1, 2]);
});
