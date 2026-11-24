// Reads a Zoho Books client's accounting data for the checks: chart of accounts, tax rates, manual
// journals with their lines, bank accounts with their balances, uncategorised bank lines, expenses,
// and the line items of invoices and bills. Shapes: mapping.js; contract: docs/zoho-data-contract.md.
//
// Called by ledgerSync.js after fetchDocuments (whose lists stay compulsory): fetchAccounting first,
// then fetchLineItems with what is left of the same read budget.
//
// Zoho caps calls per organisation per day (1,000 on Free up to 10,000 on Premium and above) and has
// no report endpoints, so lines can only come from one call per journal, invoice, bill or expense.
// To keep within the cap:
//   - a document's detail is read only when it is new or its last_modified_time changed since the
//     copy in the cache; otherwise the cached lines are carried forward (no call);
//   - detail reads per sync are capped (ZOHO_MAX_DETAIL_READS, default 400), newest first; what is
//     not reached keeps its cached lines (marked stale) and is read on a later sync. Hitting the cap
//     is logged and shown in the sync progress, never silent;
//   - Zoho's daily limit stops every further optional read, and everything not read keeps its cached copy.
// Everything here is optional to the sync: a section that cannot be read keeps its cached rows and
// says so in the read status, except a refused sign-in, a throttled token refresh or a configuration
// fault, which still stop the sync as everywhere else in the Zoho provider.
// Banking and expenses need scopes clients connected before 25 Nov 2026 did not grant. Zoho answers
// those lists with 401 code 57; that is recorded as permissions.banking / permissions.expenses = false
// (the checks then ask for a reconnect) and the sync carries on.
const client = require('./client');
const mapping = require('./mapping');

const PER_PAGE = 200;
const MAX_PAGES = 1000;
const DEFAULT_MAX_DETAIL_READS = 400;

function isFatal(error) {
  return Boolean(error && (error.authFailure || error.retryLater || error.configurationError));
}

function isNotAuthorized(error) {
  return Boolean(error && (error.notAuthorized || (Number(error.status) === 401 && Number(error.zohoCode) === 57)));
}

function pageContext(body) {
  const context = body?.page_context;
  return Array.isArray(context) ? context[0] || {} : context || {};
}

// The daily allowance the detail reads keep within. Zoho does not say which plan a client is on, so the default is
// the smallest daily limit (1,000 calls, Free plan); ZOHO_DAILY_CALL_ALLOWANCE raises it when every client is on a
// bigger plan. A reserve of the day's calls is never spent on detail reads, so the compulsory lists of later syncs
// the same day (nightly, a manual sync, Sync All) still have room: those lists fail the whole sync on the daily
// limit, the detail reads do not.
const DEFAULT_DAILY_CALL_ALLOWANCE = 1000;
const DEFAULT_DAILY_RESERVE = 200;
const envCount = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
};

// The read budget one sync shares between journals, expenses, invoices and bills: at most `limit` detail reads
// this sync, and never more than what is left of the organisation's daily allowance after the reserve (once
// externalId is set; client.callsToday counts every call this server made to that organisation today).
function createReadBudget(limit, { externalId = null } = {}) {
  const chosen = limit != null ? Number(limit) : envCount('ZOHO_MAX_DETAIL_READS', DEFAULT_MAX_DETAIL_READS);
  return {
    limit: chosen,
    externalId,
    dailyAllowance: envCount('ZOHO_DAILY_CALL_ALLOWANCE', DEFAULT_DAILY_CALL_ALLOWANCE),
    dailyReserve: envCount('ZOHO_DAILY_CALL_RESERVE', DEFAULT_DAILY_RESERVE),
    used: 0, // detail calls made
    listCalls: 0, // list pages read by this module
    capReached: false, // the per-sync cap (or the daily allowance) stopped some detail reads
    allowanceReached: false, // it was the daily allowance that stopped them
    notRead: 0, // details wanted (new or changed) but not read this sync, all sections together
    dailyLimit: false, // Zoho's daily limit was reached: no more optional reads this sync
    todayLeft() {
      if (this.externalId == null) return Infinity;
      return Math.max(0, this.dailyAllowance - this.dailyReserve - client.callsToday(this.externalId));
    },
    left() {
      if (this.dailyLimit) return 0;
      const perSync = Math.max(0, this.limit - this.used);
      const today = this.todayLeft();
      if (today < perSync && today <= 0) this.allowanceReached = true;
      return Math.min(perSync, today);
    },
  };
}

// Every page of one list, through client.apiGet. Never returns a short list: a failure part-way throws,
// so the caller keeps its cached copy instead of a partial one.
async function readAllPages(externalId, path, listKey, params, budget, options = {}) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    budget.listCalls++;
    const body = await client.apiGet(externalId, path, { ...params, page, per_page: PER_PAGE }, options);
    const items = body[listKey];
    if (!Array.isArray(items)) throw new Error(`Zoho Books ${path}: the answer has no ${listKey} list`);
    rows.push(...items);
    if (!pageContext(body).has_more_page) return rows;
  }
  throw new Error(`Zoho Books ${path}: more than ${MAX_PAGES} pages; stopped rather than return a partial list`);
}

// Runs one optional read. Returns { ok, value } or { ok: false, reason } and records why.
async function optionalRead(budget, what, externalId, read, { permission = null } = {}) {
  if (budget.dailyLimit) return { ok: false, reason: 'daily_limit' };
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    if (isFatal(error)) throw error;
    if (error.dailyLimit) {
      budget.dailyLimit = true;
      console.log(`Zoho Books organisation ${externalId}: daily API limit reached while reading ${what}; the rest is kept from the last sync.`);
      return { ok: false, reason: 'daily_limit' };
    }
    if (permission && isNotAuthorized(error)) {
      console.log(`Zoho Books organisation ${externalId}: ${what} not allowed by the connection (reconnect to grant ${permission} access).`);
      return { ok: false, reason: 'not_authorized' };
    }
    console.log(`Zoho Books organisation ${externalId}: ${what} not read: ${error.message}`);
    return { ok: false, reason: 'error', error: error.message };
  }
}

function sortNewestFirst(items, dateOf) {
  return items.slice().sort((a, b) => String(dateOf(b) || '').localeCompare(String(dateOf(a) || '')));
}

// Reads the detail of each queued item, in queue order (newest first), within the budget. read(item)
// does the call and applies it. An item not reached (cap or daily limit) or whose read failed is left
// to the caller's fallback (its cached copy). Returns the items that were read.
async function readDetails(externalId, queue, budget, what, read, { emit = () => {}, permission = null } = {}) {
  const done = new Set();
  for (let index = 0; index < queue.length; index++) {
    if (budget.dailyLimit) break;
    if (budget.left() <= 0) { budget.capReached = true; break; }
    budget.used++;
    const result = await optionalRead(budget, `${what} detail`, externalId, () => read(queue[index]), { permission });
    if (result.ok) done.add(queue[index]);
    if (result.reason === 'not_authorized') break;
    if (result.ok && done.size % 50 === 0) emit({ step: 'fetch_documents', message: `Read the detail of ${done.size} ${what} from Zoho Books so far...` });
  }
  budget.notRead += queue.length - done.size;
  return { done };
}

// Copies the detail fields of a cached row onto a freshly listed one.
function carryDetail(target, cached, fields, { stale = false } = {}) {
  for (const field of fields) if (cached[field] !== undefined) target[field] = cached[field];
  if (stale) {
    if ('lineItemsStale' in target || fields.includes('lineItemsStale')) target.lineItemsStale = true;
    if ('linesStale' in target) target.linesStale = true;
  }
  return target;
}

function byId(rows, field) {
  const map = new Map();
  for (const row of rows || []) if (row && row[field] != null) map.set(String(row[field]), row);
  return map;
}

// ---------------------------------------------------------------------------------------------

async function readAccounts(externalId, budget) {
  // AccountType.All: inactive accounts too (Zoho lists only active ones by default), as Xero's list does.
  const rows = await readAllPages(externalId, '/chartofaccounts', 'chartofaccounts', { filter_by: 'AccountType.All' }, budget);
  return rows.map(mapping.mapAccount);
}

async function readTaxRates(externalId, budget) {
  const rows = await readAllPages(externalId, '/settings/taxes', 'taxes', {}, budget);
  return rows.map(mapping.mapTaxRate);
}

// Manual journals: the list every sync (so a deleted journal leaves the cache), the detail only for
// journals new or changed since the cached copy.
async function readManualJournals(externalId, budget, cachedRows, { emit }) {
  const listed = await readAllPages(externalId, '/journals', 'journals', { filter_by: 'JournalDate.All' }, budget);
  const cached = byId(cachedRows, 'manualJournalID');
  const journals = [];
  const queue = [];
  for (const raw of listed) {
    if (raw?.journal_id == null || raw.journal_id === '') continue;
    const journal = mapping.mapManualJournal(raw);
    const key = mapping.changeKey(raw);
    const old = cached.get(journal.manualJournalID);
    if (old && old.linesRead && key && old.detailKey === key) {
      journal.journalLines = old.journalLines || [];
      journal.linesRead = true;
      journal.detailKey = key;
    } else {
      queue.push({ journal, raw, old });
    }
    journals.push(journal);
  }
  const ordered = sortNewestFirst(queue, item => item.journal.date);
  const { done } = await readDetails(externalId, ordered, budget, 'manual journals', async item => {
    const body = await client.apiGet(externalId, `/journals/${encodeURIComponent(item.raw.journal_id)}`);
    if (!body?.journal) throw new Error('the answer has no journal');
    Object.assign(item.journal, mapping.mapManualJournal({ ...item.raw, ...body.journal }));
  }, { emit });
  let notRead = 0;
  for (const item of ordered) {
    if (done.has(item)) continue;
    notRead++;
    if (item.old && item.old.linesRead) {
      item.journal.journalLines = item.old.journalLines || [];
      item.journal.linesRead = true;
      item.journal.linesStale = true;
      item.journal.detailKey = item.old.detailKey || null; // still out of date: read again next sync
    }
  }
  return { rows: journals, detailRead: done.size, detailNotRead: notRead };
}

// Bank accounts, and the uncategorised lines of each account Zoho says has some.
async function readBanking(externalId, budget) {
  const banks = await readAllPages(externalId, '/bankaccounts', 'bankaccounts', { filter_by: 'Status.All' }, budget, { optionalScope: true });
  const lines = [];
  for (const bank of banks) {
    if (!(Number(bank.uncategorized_transactions) > 0) || bank.account_id == null) continue;
    // filter_by and status both name the uncategorised lines in Zoho's docs; the status is checked again
    // here in case Zoho ignores one of them.
    const rows = await readAllPages(externalId, '/banktransactions', 'banktransactions',
      { account_id: bank.account_id, filter_by: 'Status.Uncategorized', status: 'uncategorized' }, budget, { optionalScope: true });
    for (const raw of rows) {
      if (raw?.transaction_id == null) continue;
      if (raw.status && String(raw.status).toLowerCase() !== 'uncategorized') continue;
      lines.push(mapping.mapUncategorisedLine(raw, bank));
    }
  }
  return { banks, lines };
}

async function readExpenses(externalId, budget, cachedRows, { emit }) {
  const listed = await readAllPages(externalId, '/expenses', 'expenses', { filter_by: 'Status.All' }, budget, { optionalScope: true });
  const cached = byId(cachedRows.filter(row => row && row.source === 'zoho_expense'), 'bankTransactionID');
  const expenses = [];
  const queue = [];
  for (const raw of listed) {
    if (raw?.expense_id == null || raw.expense_id === '') continue;
    const expense = mapping.mapExpense(raw);
    const key = mapping.changeKey(raw);
    const old = cached.get(expense.bankTransactionID);
    if (old && old.lineItemsRead && key && old.detailKey === key) {
      carryDetail(expense, old, mapping.EXPENSE_DETAIL_FIELDS);
    } else {
      queue.push({ expense, raw, old });
    }
    expenses.push(expense);
  }
  const ordered = sortNewestFirst(queue, item => item.expense.date);
  const { done } = await readDetails(externalId, ordered, budget, 'expenses', async item => {
    const body = await client.apiGet(externalId, `/expenses/${encodeURIComponent(item.raw.expense_id)}`, {}, { optionalScope: true });
    if (!body?.expense) throw new Error('the answer has no expense');
    const detailed = mapping.mapExpense({ ...item.raw, ...body.expense }, { detail: true });
    carryDetail(item.expense, detailed, mapping.EXPENSE_DETAIL_FIELDS);
  }, { emit, permission: 'expenses' });
  let notRead = 0;
  for (const item of ordered) {
    if (done.has(item)) continue;
    notRead++;
    if (item.old && item.old.lineItemsRead) {
      carryDetail(item.expense, item.old, mapping.EXPENSE_DETAIL_FIELDS, { stale: true });
      item.expense.lineItemsStale = true;
    }
  }
  return { rows: expenses, detailRead: done.size, detailNotRead: notRead };
}

// cached(entityType): the rows the cache holds for this organisation (account, tax_rate,
// manual_journal, bank_transaction, organisation). Returns, per entity type, the full set to store
// and whether it was read this time (fresh false: keep the cache as it is), plus the read status.
async function fetchAccounting(externalId, { emit = () => {}, cached = async () => [], readBudget = null } = {}) {
  const budget = readBudget || createReadBudget();
  if (budget.externalId == null) budget.externalId = externalId;
  const load = async type => { try { return (await cached(type)) || []; } catch (error) { return []; } };
  const status = {
    permissions: { banking: null, expenses: null },
    sections: {},
  };
  const note = (name, result, extra = {}) => {
    status.sections[name] = { read: result.ok, ...(result.ok ? {} : { reason: result.reason }), ...(result.error ? { error: result.error } : {}), ...extra };
  };

  emit({ step: 'fetch_accounting', message: 'Reading the chart of accounts from Zoho Books...' });
  const accounts = await optionalRead(budget, 'chart of accounts', externalId, () => readAccounts(externalId, budget));
  note('accounts', accounts);

  emit({ step: 'fetch_accounting', message: 'Reading tax rates from Zoho Books...' });
  const taxRates = await optionalRead(budget, 'tax rates', externalId, () => readTaxRates(externalId, budget));
  note('taxRates', taxRates);

  emit({ step: 'fetch_accounting', message: 'Reading manual journals from Zoho Books...' });
  const cachedJournals = await load('manual_journal');
  const journals = await optionalRead(budget, 'manual journals', externalId,
    () => readManualJournals(externalId, budget, cachedJournals, { emit }));
  note('manualJournals', journals, journals.ok ? { detailRead: journals.value.detailRead, detailNotRead: journals.value.detailNotRead } : {});

  emit({ step: 'fetch_accounting', message: 'Reading bank accounts from Zoho Books...' });
  const banking = await optionalRead(budget, 'bank accounts', externalId, () => readBanking(externalId, budget), { permission: 'banking' });
  status.permissions.banking = banking.ok ? true : (banking.reason === 'not_authorized' ? false : null);
  note('banking', banking, banking.ok ? { accounts: banking.value.banks.length, uncategorizedLines: banking.value.lines.length } : {});

  emit({ step: 'fetch_accounting', message: 'Reading expenses from Zoho Books...' });
  const cachedBankTransactions = await load('bank_transaction');
  const expenses = await optionalRead(budget, 'expenses', externalId,
    () => readExpenses(externalId, budget, cachedBankTransactions, { emit }), { permission: 'expenses' });
  status.permissions.expenses = expenses.ok ? true : (expenses.reason === 'not_authorized' ? false : null);
  note('expenses', expenses, expenses.ok ? { detailRead: expenses.value.detailRead, detailNotRead: expenses.value.detailNotRead } : {});

  // Accounts: the chart read now, or the cached one; bank details from this read, or carried from the
  // cache when banking failed for a reason other than permission (no permission: no bank details,
  // so nothing stale is shown as current).
  const cachedAccounts = accounts.ok ? null : await load('account');
  let accountRows = accounts.ok ? accounts.value : cachedAccounts;
  let accountsFresh = accounts.ok;
  if (banking.ok) {
    accountRows = mapping.mergeBankAccounts(accountRows, banking.value.banks);
    accountsFresh = true;
  } else if (accounts.ok) {
    const previous = byId(await load('account'), 'accountID');
    accountRows = accountRows.map(account => {
      const old = previous.get(account.accountID);
      if (banking.reason === 'not_authorized' || !old || !old.bank) return account;
      return { ...account, bank: { ...old.bank, stale: true } };
    });
  } else if (Array.isArray(accountRows)) {
    // Neither the chart nor banking was read: the cached chart is used, and its bank details are old. Refused
    // banking clears them (and the cache is rewritten without them); any other failure marks them stale.
    const refused = banking.reason === 'not_authorized';
    accountRows = accountRows.map(account => (account && account.bank
      ? { ...account, bank: refused ? null : { ...account.bank, stale: true } } : account));
    if (refused && accountRows.length) accountsFresh = true;
  }

  // bank_transaction holds the uncategorised lines (zbt-) and the expenses (exp-). One side that was
  // not read keeps its cached rows, unless the connection refused it (then it is emptied).
  let bankRows = [];
  let bankFresh = banking.ok || expenses.ok || banking.reason === 'not_authorized' || expenses.reason === 'not_authorized';
  const keepCached = source => cachedBankTransactions.filter(row => row && row.source === source);
  bankRows.push(...(banking.ok ? banking.value.lines : banking.reason === 'not_authorized' ? [] : keepCached('zoho_uncategorized')));
  bankRows.push(...(expenses.ok ? expenses.value.rows : expenses.reason === 'not_authorized' ? [] : keepCached('zoho_expense')));
  if (!bankFresh) bankRows = cachedBankTransactions;

  return {
    accounts: { rows: accountRows, fresh: accountsFresh },
    taxRates: { rows: taxRates.ok ? taxRates.value : await load('tax_rate'), fresh: taxRates.ok },
    manualJournals: { rows: journals.ok ? journals.value.rows : cachedJournals, fresh: journals.ok },
    bankTransactions: { rows: bankRows, fresh: bankFresh },
    status,
    budget,
  };
}

// ---------------------------------------------------------------------------------------------
// Line items of invoices and bills (GET /invoices/{id}, /bills/{id}). docs: what fetchDocuments
// returned. Each document new or changed since its cached copy is read, newest first, within the
// budget; an unchanged one gets its cached lines (no call). Opening-balance documents were already
// read one at a time by fetchDocuments and carry their lines. Voided documents are not read: no check
// counts their lines, and the calls are better spent elsewhere. Changes docs in place.
async function fetchLineItems(externalId, docs, { emit = () => {}, cachedDocuments = async () => [], readBudget = null } = {}) {
  const budget = readBudget || createReadBudget();
  if (budget.externalId == null) budget.externalId = externalId;
  let cachedRows = [];
  try { cachedRows = (await cachedDocuments()) || []; } catch (error) { cachedRows = []; }
  const cached = byId(cachedRows, 'invoiceID');
  const queue = [];
  let carried = 0;
  for (const doc of [...(docs.invoices || []), ...(docs.bills || [])]) {
    // Opening balances were read one at a time by fetchDocuments and carry their lines already.
    if (!doc || doc.lineItemsRead || doc.isOpeningBalance) continue;
    const old = cached.get(String(doc.invoiceID));
    if (old && old.lineItemsRead && doc.detailKey && old.detailKey === doc.detailKey) {
      carryDetail(doc, old, mapping.DETAIL_FIELDS);
      doc.lineItemsStale = false;
      carried++;
      continue;
    }
    if (doc.status === 'VOIDED') continue;
    queue.push({ doc, old });
  }
  const ordered = sortNewestFirst(queue, item => item.doc.date);
  if (ordered.length) {
    emit({ step: 'fetch_documents', message: `Reading the line items of ${Math.min(ordered.length, budget.left())} new or changed invoices and bills from Zoho Books...` });
  }
  const { done } = await readDetails(externalId, ordered, budget, 'invoices and bills', async item => {
    const isBill = item.doc.type === 'ACCPAY';
    const id = isBill ? String(item.doc.invoiceID).replace(/^bill-/, '') : String(item.doc.invoiceID);
    const body = await client.apiGet(externalId, `/${isBill ? 'bills' : 'invoices'}/${encodeURIComponent(id)}`);
    const raw = isBill ? body?.bill : body?.invoice;
    if (!raw) throw new Error(`the answer has no ${isBill ? 'bill' : 'invoice'}`);
    const detail = mapping.documentDetail(raw);
    // The list's change key is kept: it is what the next sync compares against.
    carryDetail(item.doc, { ...detail, detailKey: item.doc.detailKey || detail.detailKey }, mapping.DETAIL_FIELDS);
  }, { emit });
  let notRead = 0;
  for (const item of ordered) {
    if (done.has(item)) continue;
    notRead++;
    if (item.old && item.old.lineItemsRead) {
      carryDetail(item.doc, { ...item.old, detailKey: item.old.detailKey || null }, mapping.DETAIL_FIELDS);
      item.doc.lineItemsStale = true;
    }
  }
  const result = {
    read: done.size, carried, notRead, limit: budget.limit, used: budget.used,
    capReached: budget.capReached, dailyLimit: budget.dailyLimit, notReadAllSections: budget.notRead,
  };
  if (budget.capReached || budget.dailyLimit) {
    const reason = budget.dailyLimit ? "Zoho's daily API limit was reached"
      : budget.allowanceReached ? `the day's allowance of Zoho calls for detail reads was used (${budget.dailyAllowance} a day, ${budget.dailyReserve} kept for the document lists)`
        : `the limit of ${budget.limit} detail reads per sync was reached`;
    const message = `The lines of ${budget.notRead} new or changed journals, expenses, invoices or bills were not read this sync (${reason}). `
      + 'They keep the lines from the last sync, or have none yet, and are read on the next syncs; checks that use line items may be incomplete until then.';
    console.log(`Zoho Books organisation ${externalId}: ${message}`);
    emit({ step: 'fetch_documents', message });
    result.message = message;
  }
  return result;
}

module.exports = {
  DEFAULT_MAX_DETAIL_READS, DEFAULT_DAILY_CALL_ALLOWANCE, DEFAULT_DAILY_RESERVE, createReadBudget, fetchAccounting, fetchLineItems, readAllPages,
  isNotAuthorized,
};
