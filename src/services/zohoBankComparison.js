// Zoho Books clients only: compares, bank account by bank account, what the browser extension read from Zoho Books'
// Banking page (akrio_zoho_bank_screen_* tables) with what Zoho's API returned at the last sync (cached 'account'
// rows with a `bank` block, and the 'organisation' read status; see docs/zoho-data-contract.md). Pure: no database,
// no API calls. Nothing here is used for Xero clients.
//
// Columns compared: Amount in Zoho Books (screen amountInBooks vs API bank.bookBalance, both in the account's own
// currency), Amount in Bank (screen amountInBank vs API bank.bankBalance) and Uncategorised (screen uncategorised vs
// API bank.uncategorizedCount). Amounts agree when they are within half a cent; counts must be equal.

const TOLERANCE = 0.005;

// Name as Zoho shows it, made comparable: trimmed, runs of spaces collapsed, case ignored.
const normaliseName = name => String(name == null ? '' : name).trim().replace(/\s+/g, ' ').toLowerCase();
// Masked numbers ("xxxx0001", "****0001") are compared on their last four digits; null when there are none.
function numberTail(number) {
  const digits = String(number == null ? '' : number).replace(/\D/g, '');
  return digits ? digits.slice(-4) : null;
}

const finite = value => (value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
const round3 = value => { const r = Math.round(value * 1000) / 1000; return r === 0 ? 0 : r; };

// The API side: one entry per cached account that has bank details.
function apiBankAccounts(accounts) {
  return (accounts || []).filter(a => a && a.bank && typeof a.bank === 'object').map(a => ({
    accountId: a.accountID == null ? null : String(a.accountID),
    accountName: a.name || null,
    accountNumber: a.bank.accountNumber || null,
    currencyCode: a.bank.currencyCode || a.currencyCode || null,
    bookBalance: finite(a.bank.bookBalance),
    bookBalanceBase: finite(a.bank.bookBalanceBase),
    bankBalance: finite(a.bank.bankBalance),
    uncategorizedCount: finite(a.bank.uncategorizedCount),
    feedsActive: a.bank.feedsActive == null ? null : Boolean(a.bank.feedsActive),
    isActive: a.bank.isActive == null ? (a.status === 'ARCHIVED' ? false : null) : Boolean(a.bank.isActive),
    stale: a.bank.stale === true,
  }));
}

// Pairs screen accounts with API accounts. First by Zoho account id (when the screen reading carries one), then by
// normalised name; when both sides have a masked number, the last four digits must agree too. A name shared by
// several accounts is only paired where the numbers settle it. Returns { pairs, onlyScreen, onlyApi } in screen order.
function matchAccounts(screenAccounts, apiAccounts) {
  const screen = (screenAccounts || []).map((account, index) => ({ account, index }));
  const api = (apiAccounts || []).map((account, index) => ({ account, index, used: false }));
  const paired = new Map(); // screen index -> api entry
  const byId = new Map(api.filter(e => e.account.accountId).map(e => [e.account.accountId, e]));
  for (const s of screen) {
    const id = s.account.accountId == null ? null : String(s.account.accountId);
    const hit = id ? byId.get(id) : null;
    if (hit && !hit.used) { hit.used = true; paired.set(s.index, hit); }
  }
  const numbersAgree = (a, b) => {
    const x = numberTail(a.accountNumber), y = numberTail(b.accountNumber);
    return x == null || y == null || x === y;
  };
  // Two passes: pairs where both numbers are present and equal first, so a same-named account without a number
  // cannot take another's partner.
  for (const strict of [true, false]) {
    for (const s of screen) {
      if (paired.has(s.index)) continue;
      const name = normaliseName(s.account.accountName);
      const candidates = api.filter(e => !e.used && normaliseName(e.account.accountName) === name && numbersAgree(s.account, e.account)
        && (!strict || (numberTail(s.account.accountNumber) != null && numberTail(e.account.accountNumber) != null)));
      // Not strict: a second unpaired screen account of the same name that the numbers cannot tell apart from this
      // one makes the pairing a guess, so neither is paired.
      const rivals = strict || candidates.length !== 1 ? 0 : screen.filter(o => o !== s && !paired.has(o.index)
        && normaliseName(o.account.accountName) === name && numbersAgree(o.account, candidates[0].account)).length;
      if ((candidates.length === 1 && rivals === 0) || (strict && candidates.length > 0)) {
        candidates[0].used = true; paired.set(s.index, candidates[0]);
      }
    }
  }
  const pairs = [];
  const onlyScreen = [];
  for (const s of screen) {
    const hit = paired.get(s.index);
    if (hit) pairs.push({ screen: s.account, api: hit.account }); else onlyScreen.push(s.account);
  }
  const onlyApi = api.filter(e => !e.used).map(e => e.account);
  return { pairs, onlyScreen, onlyApi };
}

// One compared cell. status: 'equal' | 'differ' | 'missing' | 'no_feed'. difference = screen - API.
function compareAmount(screenValue, apiValue) {
  const s = finite(screenValue), a = finite(apiValue);
  if (s == null || a == null) return { status: 'missing', screen: s, api: a, difference: null };
  // Compared in thousandths (integers), so half a cent is a difference and float noise (0.1 + 0.2) is not.
  const milli = Math.round(s * 1000) - Math.round(a * 1000);
  const equal = Math.abs(milli) < TOLERANCE * 1000;
  return { status: equal ? 'equal' : 'differ', screen: s, api: a, difference: equal ? 0 : round3(milli / 1000) };
}
function compareCount(screenValue, apiValue) {
  const s = finite(screenValue), a = finite(apiValue);
  if (s == null || a == null) return { status: 'missing', screen: s, api: a, difference: null };
  return { status: s === a ? 'equal' : 'differ', screen: s, api: a, difference: s - a };
}
// Amount in Bank: Zoho shows 0.00 when no feed is connected. When the screen shows 0.00 and the API also says
// 0 (or nothing) with no active feed, there is no bank balance on either side: "no bank feed", counted as agreeing.
function compareBankAmount(screen, api) {
  const s = finite(screen.amountInBank), a = finite(api.bankBalance);
  if (s === 0 && (a == null || a === 0) && api.feedsActive !== true) {
    return { status: 'no_feed', screen: s, api: a, difference: null };
  }
  return compareAmount(s, a);
}

const MISSING_REASONS = {
  no_reading: 'No extension reading yet',
  not_authorized: 'Reconnect Zoho Books to allow bank access',
  not_synced: 'Not synced from Zoho Books yet',
  not_read: 'Zoho\'s API bank figures were not read at the last sync',
  not_in_api: 'Only on screen',
  not_on_screen: 'Only in API',
};

function missingCell(reason, screen = null, api = null) {
  return { status: 'missing', reason, reasonText: MISSING_REASONS[reason] || reason, screen, api, difference: null };
}

// What each side's time says: the reading and the sync were taken at different times when the reading is older than
// the sync (Zoho may have changed since). Returns { readAt, syncedAt, newer: 'screen'|'api'|'same'|null, differentTimes }.
// apiFiguresEarlier: banking was not read at that sync, so the API bank figures come from an earlier sync whose time
// is unknown; the screen is then only called newer when it was read after the sync, and the times always differ.
function timesOf(readAt, syncedAt, { apiFiguresEarlier = false } = {}) {
  const r = readAt ? new Date(readAt) : null, s = syncedAt ? new Date(syncedAt) : null;
  const valid = d => d && !Number.isNaN(d.getTime());
  const read = valid(r) ? r : null, sync = valid(s) ? s : null;
  let newer = null;
  if (read && sync) newer = read > sync ? 'screen' : read < sync ? 'api' : 'same';
  if (apiFiguresEarlier && newer !== 'screen') newer = null;
  return {
    readAt: read ? read.toISOString() : null,
    syncedAt: sync ? sync.toISOString() : null,
    newer,
    apiFiguresEarlier: !!apiFiguresEarlier,
    differentTimes: apiFiguresEarlier ? !!read : newer === 'api',
  };
}

// Builds the whole comparison the client page shows.
//   reading:    getLatestZohoReading(...) (or null)
//   accounts:   cached 'account' rows
//   readStatus: the cached 'organisation' read status for this client (or null)
function buildZohoBankComparison({ reading, accounts, readStatus }) {
  const banking = readStatus && readStatus.permissions ? readStatus.permissions.banking : null;
  // Banking not read at the last sync for a reason other than permission (daily limit, error): any bank figures in
  // the cache were carried from an earlier sync.
  const bankingSection = readStatus && readStatus.sections ? readStatus.sections.banking : null;
  const notReadReason = banking !== false && bankingSection && bankingSection.read === false ? (bankingSection.reason || 'error') : null;
  const apiAll = apiBankAccounts(accounts).map(a => (notReadReason ? { ...a, stale: true } : a));
  const apiState = !readStatus && !apiAll.length ? 'not_synced'
    : banking === false ? 'not_authorized'
      : notReadReason && !apiAll.length ? 'not_read'
        : 'ok';
  const notReadWhy = notReadReason === 'daily_limit' ? 'Zoho\'s daily API limit was reached' : 'Zoho returned an error';
  const screenAccounts = reading && Array.isArray(reading.accounts) ? reading.accounts : [];
  const times = timesOf(reading ? reading.readAt : null, readStatus ? readStatus.readAt : null,
    { apiFiguresEarlier: !!notReadReason && apiState === 'ok' });
  const apiAvailable = apiState === 'ok';
  const { pairs, onlyScreen, onlyApi } = matchAccounts(screenAccounts, apiAvailable ? apiAll : []);

  const rows = [];
  const addRow = (screen, api, kind) => {
    const name = (screen && screen.accountName) || (api && api.accountName) || '';
    const number = (screen && screen.accountNumber) || (api && api.accountNumber) || null;
    const row = {
      kind, accountName: name, accountNumber: number,
      accountId: (api && api.accountId) || (screen && screen.accountId) || null,
      screenCurrency: screen ? screen.currency || null : null,
      apiCurrency: api ? api.currencyCode : null,
      apiBookBalanceBase: api ? api.bookBalanceBase : null,
      apiStale: api ? api.stale : false,
      apiInactive: api ? api.isActive === false : false,
    };
    if (kind === 'matched') {
      row.books = compareAmount(screen.amountInBooks, api.bookBalance);
      row.bank = compareBankAmount(screen, api);
      row.uncategorised = compareCount(screen.uncategorised, api.uncategorizedCount);
      for (const cell of [row.books, row.bank, row.uncategorised]) {
        if (cell.status === 'missing') { cell.reason = 'api_value_missing'; cell.reasonText = 'Zoho\'s API gave no figure'; }
      }
      const screenCode = String(row.screenCurrency || '').toUpperCase();
      row.currencyDiffers = /^[A-Z]{3}$/.test(screenCode) && !!row.apiCurrency && screenCode !== String(row.apiCurrency).toUpperCase();
    } else if (kind === 'only_screen') {
      const reason = !reading ? 'no_reading' : apiAvailable ? 'not_in_api' : apiState;
      row.books = missingCell(reason, finite(screen.amountInBooks));
      row.bank = missingCell(reason, finite(screen.amountInBank));
      row.uncategorised = missingCell(reason, finite(screen.uncategorised));
      if (reason === 'not_read') for (const cell of [row.books, row.bank, row.uncategorised]) cell.reasonText += ' (' + notReadWhy + ')';
    } else {
      const reason = reading ? 'not_on_screen' : 'no_reading';
      row.books = missingCell(reason, null, api.bookBalance);
      row.bank = missingCell(reason, null, api.bankBalance);
      row.uncategorised = missingCell(reason, null, api.uncategorizedCount);
    }
    row.differentTimes = kind === 'matched' && times.differentTimes;
    const cells = [row.books, row.bank, row.uncategorised];
    row.agrees = kind === 'matched' && cells.every(c => c.status === 'equal' || c.status === 'no_feed');
    rows.push(row);
  };
  // Screen order first (the order Zoho's Banking page shows), then accounts only the API knows.
  const pairedBy = new Map(pairs.map(p => [p.screen, p.api]));
  for (const screen of screenAccounts) {
    if (pairedBy.has(screen)) addRow(screen, pairedBy.get(screen), 'matched');
    else addRow(screen, null, 'only_screen');
  }
  for (const api of onlyApi) addRow(null, api, 'only_api');

  // The overall line. Only worked out when both sides are there; otherwise it says what is missing.
  let overall;
  if (!reading) {
    overall = { state: 'no_reading', text: 'No extension reading yet: click "Update from Zoho Books" to compare with Zoho\'s API.' };
  } else if (apiState === 'not_authorized') {
    overall = { state: 'not_authorized', text: 'Reconnect Zoho Books to allow bank access, then sync, to compare with Zoho\'s API.' };
  } else if (apiState === 'not_read') {
    overall = { state: 'not_read', reason: notReadReason, text: 'Zoho\'s API bank figures were not read at the last sync (' + notReadWhy
      + '), so there is nothing from Zoho\'s API to compare with. Sync again to compare.' };
  } else if (apiState === 'not_synced') {
    overall = { state: 'not_synced', text: 'Zoho Books has not been synced yet, so there is nothing from Zoho\'s API to compare with.' };
  } else {
    // An account Zoho marks inactive that the Banking page (active accounts only) does not show is not a difference.
    const counted = rows.filter(row => !(row.kind === 'only_api' && row.apiInactive));
    const total = counted.length;
    const differ = counted.filter(row => !row.agrees).length;
    overall = differ === 0
      ? { state: 'agree', total, differ, text: 'All ' + total + ' account' + (total === 1 ? '' : 's') + ' agree ✓' }
      : { state: 'differ', total, differ, text: differ + ' of ' + total + ' account' + (total === 1 ? '' : 's') + ' differ' };
  }

  return {
    apiState,
    hasReading: !!reading,
    times,
    differentTimes: times.differentTimes,
    rows,
    onlyScreenCount: rows.filter(r => r.kind === 'only_screen').length,
    onlyApiCount: rows.filter(r => r.kind === 'only_api').length,
    overall,
  };
}

module.exports = {
  buildZohoBankComparison, matchAccounts, apiBankAccounts, compareAmount, compareCount, compareBankAmount,
  normaliseName, numberTail, timesOf, TOLERANCE,
};
