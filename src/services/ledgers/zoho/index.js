// Zoho Books provider: reads a client's invoices, bills, credit notes, vendor credits and contacts
// and hands them to ledgerSync.js in the Xero shapes checkRules/ledgerChecks already read, so
// Zoho clients run the same checks as FreeAgent and QuickBooks clients.
//
// Only list endpoints are read, never one document at a time: Zoho caps API calls per
// organisation per day (1,000 on Free up to 10,000 on Premium and above), and a call per invoice
// would use that up on a mid-sized client. The lists carry no line items and no net/tax split, so
// those fields are empty here (see the notes on mapInvoice).
// Field names and status values checked against https://www.zoho.com/books/api/v3/ (invoices,
// bills, credit-notes, vendor-credits, contacts, organizations, transaction-locking), 24 Nov 2026.
const client = require('./client');

// exchangeRates: every document carries currencyRate (Xero's convention), so the checks convert.
const ledger = { key: 'zoho', purchaseCredits: true, drafts: true, exchangeRates: true };

const PER_PAGE = 200; // Zoho's maximum page size
const MAX_PAGES = 1000;

// Zoho status -> Xero status. AUTHORISED = approved and not fully paid, PAID = fully paid,
// VOIDED = void, DRAFT = draft, SUBMITTED = waiting for approval (Xero's "Awaiting Approval").
// Documented invoice statuses: sent, draft, overdue, paid, void, unpaid, partially_paid, viewed;
// pending_approval and approved appear when the organisation turns on invoice approval.
const INVOICE_STATUS_MAP = {
  draft: 'DRAFT',
  pending_approval: 'SUBMITTED',
  approved: 'AUTHORISED',
  sent: 'AUTHORISED',
  viewed: 'AUTHORISED',
  overdue: 'AUTHORISED',
  unpaid: 'AUTHORISED',
  partially_paid: 'AUTHORISED',
  paid: 'PAID',
  void: 'VOIDED',
};

// Documented bill statuses: paid, open, overdue, void, partially_paid; draft, pending_approval and
// approved exist when bill approval is on.
const BILL_STATUS_MAP = {
  draft: 'DRAFT',
  pending_approval: 'SUBMITTED',
  approved: 'AUTHORISED',
  open: 'AUTHORISED',
  overdue: 'AUTHORISED',
  partially_paid: 'AUTHORISED',
  paid: 'PAID',
  void: 'VOIDED',
};

// Credit notes and vendor credits: open (credit left to use), closed (all used or refunded),
// void, draft; pending_approval when approval is on.
const CREDIT_STATUS_MAP = {
  draft: 'DRAFT',
  pending_approval: 'SUBMITTED',
  open: 'AUTHORISED',
  closed: 'PAID',
  void: 'VOIDED',
};

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function dateOnly(value) {
  if (!value) return null;
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

// A status Zoho adds later is read from the balance rather than guessed as unpaid.
function mapStatus(map, status, balance) {
  const key = String(status || '').toLowerCase();
  if (map[key]) return map[key];
  return number(balance) > 0 ? 'AUTHORISED' : 'PAID';
}

// The docs show page_context as an object in some examples and a one-item array in others.
function pageContext(body) {
  const context = body?.page_context;
  return Array.isArray(context) ? context[0] || {} : context || {};
}

// Reads every page of one Zoho list. A short list is never returned: if Zoho stops answering
// part-way the error is thrown, so the cache is not refreshed with half a ledger.
async function fetchAllPages(externalId, path, listKey, params = {}, emit = () => {}) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await client.apiGet(externalId, path, { ...params, page, per_page: PER_PAGE });
    const items = body[listKey];
    if (!Array.isArray(items)) throw new Error(`Zoho Books ${path}: the answer has no ${listKey} list`);
    rows.push(...items);
    if (!pageContext(body).has_more_page) return rows;
    if (page % 10 === 0) emit({ step: 'fetch_documents', message: `Read ${rows.length} ${listKey} from Zoho Books so far...` });
  }
  throw new Error(`Zoho Books ${path}: more than ${MAX_PAGES} pages; stopped rather than return a partial list`);
}

function contactName(contact) {
  return contact.contact_name || contact.company_name ||
    [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Unknown contact';
}

function mapContact(contact) {
  return {
    contactID: String(contact.contact_id),
    name: contactName(contact),
    emailAddress: contact.email || null,
    // Zoho: active / inactive. Xero's vocabulary is ACTIVE / ARCHIVED (checkRules filters on ACTIVE).
    contactStatus: String(contact.status || '').toLowerCase() === 'active' ? 'ACTIVE' : 'ARCHIVED',
    isCustomer: contact.contact_type === 'customer',
    isSupplier: contact.contact_type === 'vendor',
  };
}

function documentContact(id, name) {
  return { contactID: id == null || id === '' ? null : String(id), name: name || null };
}

// The invoice list has total and balance but no sub_total, tax_total or line items (those are
// only on the one-invoice call). subTotal/totalTax are read if Zoho ever includes them, else null.
// amountPaid is total less balance, so it also counts credits applied and write-offs.
// currencyRate is in Xero's convention, which the checks divide by (checkRules.amountInBase): units of
// the document's currency per one unit of the organisation's currency. Zoho's exchange_rate is the other
// way round (organisation currency per one unit of the document's: 3.6725 for a USD invoice in an AED
// organisation, 1 for one in the organisation's own currency), so it is turned round here, the same as
// the QuickBooks adapter does. No usable rate gives null; the checks never treat that as 1:1.
function currencyRateFrom(exchangeRate) {
  if (exchangeRate == null || exchangeRate === '') return null;
  const rate = Number(exchangeRate);
  return Number.isFinite(rate) && rate > 0 ? 1 / rate : null;
}

function mapInvoice(invoice) {
  const status = mapStatus(INVOICE_STATUS_MAP, invoice.status, invoice.balance);
  const total = number(invoice.total);
  const balance = status === 'VOIDED' ? 0 : number(invoice.balance);
  return {
    invoiceID: String(invoice.invoice_id),
    invoiceNumber: invoice.invoice_number || null,
    reference: invoice.reference_number || null,
    type: 'ACCREC',
    status,
    contact: documentContact(invoice.customer_id, invoice.customer_name),
    date: dateOnly(invoice.date),
    dueDate: dateOnly(invoice.due_date),
    total,
    subTotal: numberOrNull(invoice.sub_total),
    totalTax: numberOrNull(invoice.tax_total),
    amountDue: balance,
    amountPaid: status === 'VOIDED' ? 0 : round2(total - balance),
    currencyCode: invoice.currency_code || null,
    currencyRate: currencyRateFrom(invoice.exchange_rate),
    hasAttachments: Boolean(invoice.has_attachment),
    lineItems: [],
  };
}

// Bills and invoices share one cache table keyed by invoiceID, so bills carry a prefix (as for
// FreeAgent) in case Zoho ever reuses a number across the two.
function mapBill(bill) {
  const status = mapStatus(BILL_STATUS_MAP, bill.status, bill.balance);
  const total = number(bill.total);
  const balance = status === 'VOIDED' ? 0 : number(bill.balance);
  return {
    invoiceID: `bill-${bill.bill_id}`,
    invoiceNumber: bill.bill_number || null,
    reference: bill.reference_number || null,
    type: 'ACCPAY',
    status,
    contact: documentContact(bill.vendor_id, bill.vendor_name),
    date: dateOnly(bill.date),
    dueDate: dateOnly(bill.due_date),
    total,
    subTotal: numberOrNull(bill.sub_total),
    totalTax: numberOrNull(bill.tax_total),
    amountDue: balance,
    amountPaid: status === 'VOIDED' ? 0 : round2(total - balance),
    currencyCode: bill.currency_code || null,
    currencyRate: currencyRateFrom(bill.exchange_rate),
    // The bill list carries has_attachment, so Undocumented Bills works without a call per bill.
    hasAttachments: Boolean(bill.has_attachment),
    lineItems: [],
  };
}

// Xero credit notes are positive amounts and the credit checks rely on that. remainingCredit is
// Zoho's balance: the part of the credit not yet applied or refunded.
function mapCredit(credit, { id, number: creditNumber, type, contact }) {
  const status = mapStatus(CREDIT_STATUS_MAP, credit.status, credit.balance);
  const total = Math.abs(number(credit.total));
  return {
    creditNoteID: id,
    creditNoteNumber: creditNumber || null,
    reference: credit.reference_number || null,
    type,
    status,
    contact,
    date: dateOnly(credit.date),
    total,
    // No net figure on the list; sub_total is read if present, else null, the same as invoices.
    // (A gross credit figure netted against invoices with no net figure would make turnover
    // negative.)
    subTotal: numberOrNull(credit.sub_total) == null ? null : Math.abs(numberOrNull(credit.sub_total)),
    remainingCredit: status === 'VOIDED' ? 0 : Math.abs(number(credit.balance)),
    currencyCode: credit.currency_code || null,
    // Credit notes carry exchange_rate on the list. The vendor credit list does not: fetchDocuments
    // fills it in from the one-credit call (see vendorCreditRates).
    currencyRate: currencyRateFrom(credit.exchange_rate),
  };
}

function mapSalesCredit(credit) {
  return mapCredit(credit, {
    id: String(credit.creditnote_id), number: credit.creditnote_number, type: 'ACCRECCREDIT',
    contact: documentContact(credit.customer_id, credit.customer_name),
  });
}

function mapVendorCredit(credit) {
  return mapCredit(credit, {
    id: `vc-${credit.vendor_credit_id}`, number: credit.vendor_credit_number, type: 'ACCPAYCREDIT',
    contact: documentContact(credit.vendor_id, credit.vendor_name),
  });
}

function currencyCodeOf(value) {
  const text = String(value == null ? '' : value).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(text) ? text : null;
}

// The vendor credit list has currency_code but no exchange_rate, so the rate of a vendor credit in
// another currency that is open with a balance left is read from GET /vendorcredits/{id}
// (vendor_credit.exchange_rate), one at a time
// through client.apiGet (its retries and back-off), never in parallel. One in the organisation's own
// currency is rate 1 and costs no call. When the organisation's currency is not known, the currencies
// seen with exchange_rate 1 on the invoice, bill and credit note lists are taken as it (Zoho gives 1
// only for the organisation's own currency); a vendor credit in any other currency, or with no such
// hint at all, has its rate read. A failed read leaves that credit with no rate (the checks list it
// but leave it out of the totals) and does not fail the sync, except a refused sign-in or a
// configuration fault, which must still disconnect or stop the sync as everywhere else in this file.
// After Zoho's daily call limit the remaining reads are skipped rather than each failing in turn.
async function vendorCreditRates(externalId, rawCredits, mapped, { baseCurrency = null, sameCurrencyHints = new Set(), emit = () => {} } = {}) {
  const base = currencyCodeOf(baseCurrency);
  const isBase = code => (base ? code === base : sameCurrencyHints.has(code));
  let read = 0;
  let stopped = false;
  for (let index = 0; index < rawCredits.length; index++) {
    const raw = rawCredits[index];
    const credit = mapped[index];
    const code = currencyCodeOf(raw.currency_code);
    if (credit.currencyRate != null) continue; // a rate on the list after all
    if (!code) continue; // no currency given: the organisation's own, as before
    if (isBase(code)) { credit.currencyRate = 1; continue; }
    // Only a credit that can reach a money total is worth a call: Old Purchase Credits sums approved
    // (AUTHORISED) credits with something left to use. A closed, voided, draft or used-up credit is only
    // ever counted, never summed, so it keeps no rate and costs nothing against Zoho's daily call limit.
    if (credit.status !== 'AUTHORISED' || !(Number(credit.remainingCredit) > 0)) continue;
    if (stopped) continue;
    try {
      const body = await client.apiGet(externalId, `/vendorcredits/${encodeURIComponent(raw.vendor_credit_id)}`);
      credit.currencyRate = currencyRateFrom(body?.vendor_credit?.exchange_rate);
      read++;
      if (read % 25 === 0) emit({ step: 'fetch_documents', message: `Read the exchange rate of ${read} vendor credits from Zoho Books so far...` });
    } catch (error) {
      if (error.authFailure || error.retryLater || error.configurationError) throw error;
      console.log(`Zoho Books vendor credit ${raw.vendor_credit_id}: exchange rate not read for organisation ${externalId}: ${error.message}`);
      credit.currencyRate = null;
      if (error.dailyLimit) stopped = true;
    }
  }
  return mapped;
}

// Every document in every status and date: filter_by=Status.All is the documented "all" filter
// for bills, credit notes, vendor credits and contacts, and the invoice list example shows it as
// the applied filter. baseCurrency is the organisation's currency (fetchCompanyInfo), used to tell
// which vendor credits need their rate read.
async function fetchDocuments(externalId, { emit = () => {}, baseCurrency = null } = {}) {
  const all = { filter_by: 'Status.All' };
  emit({ step: 'fetch_documents', message: 'Reading contacts from Zoho Books...' });
  const contacts = (await fetchAllPages(externalId, '/contacts', 'contacts', all, emit)).map(mapContact);
  emit({ step: 'fetch_documents', message: 'Reading invoices from Zoho Books...' });
  const invoiceRows = await fetchAllPages(externalId, '/invoices', 'invoices', all, emit);
  emit({ step: 'fetch_documents', message: 'Reading bills from Zoho Books...' });
  const billRows = await fetchAllPages(externalId, '/bills', 'bills', all, emit);
  emit({ step: 'fetch_documents', message: 'Reading credit notes from Zoho Books...' });
  const creditRows = await fetchAllPages(externalId, '/creditnotes', 'creditnotes', all, emit);
  emit({ step: 'fetch_documents', message: 'Reading vendor credits from Zoho Books...' });
  const vendorCreditRows = await fetchAllPages(externalId, '/vendorcredits', 'vendor_credits', all, emit);
  const sameCurrencyHints = new Set([...invoiceRows, ...billRows, ...creditRows]
    .filter(row => row.exchange_rate != null && row.exchange_rate !== '' && Number(row.exchange_rate) === 1)
    .map(row => currencyCodeOf(row.currency_code))
    .filter(Boolean));
  const vendorCredits = await vendorCreditRates(externalId, vendorCreditRows, vendorCreditRows.map(mapVendorCredit),
    { baseCurrency, sameCurrencyHints, emit });
  return {
    invoices: invoiceRows.map(mapInvoice),
    bills: billRows.map(mapBill),
    credits: [...creditRows.map(mapSalesCredit), ...vendorCredits],
    contacts,
  };
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];

// fiscal_year_start_month: the docs' examples show 0 for a January start (the US default), so
// the number is read as 0 = January ... 11 = December. A month name (the update call's format) is
// accepted too. The year ends on the last day of the month before (day 31 is clamped to the
// month's end by periodResolver).
function financialYearEnd(startMonth) {
  let index = null;
  if (typeof startMonth === 'string' && MONTHS.includes(startMonth.trim().toLowerCase())) {
    index = MONTHS.indexOf(startMonth.trim().toLowerCase());
  } else if (startMonth != null && startMonth !== '' && Number.isInteger(Number(startMonth))) {
    const value = Number(startMonth);
    if (value >= 0 && value <= 11) index = value;
  }
  if (index == null) return {};
  return { financialYearEndMonth: index === 0 ? 12 : index, financialYearEndDay: 31 };
}

// The organisation's transaction lock (GET /transactionlock, scope ZohoBooks.accountants.READ).
// A lock that is off, or an organisation whose plan has no locking, gives null. A refused sign-in
// is not swallowed: that must still disconnect the client.
async function fetchLockDate(externalId) {
  try {
    const body = await client.apiGet(externalId, '/transactionlock');
    const lock = Array.isArray(body.transaction_lock) ? body.transaction_lock[0] : body.transaction_lock;
    if (!lock) return null;
    const status = String(lock.transaction_lock_status || lock.lock_status || '').toLowerCase();
    if (!status || status === 'disabled' || status === 'unlocked') return null;
    return dateOnly(lock.transaction_lock_date);
  } catch (error) {
    if (error.authFailure || error.retryLater || error.configurationError) throw error;
    console.log(`Zoho Books transaction lock not read for organisation ${externalId}: ${error.message}`);
    return null;
  }
}

async function fetchCompanyInfo(externalId) {
  const body = await client.apiGet(externalId, `/organizations/${encodeURIComponent(externalId)}`);
  const organization = body.organization || {};
  return {
    name: organization.name || null,
    lockDate: await fetchLockDate(externalId),
    ...financialYearEnd(organization.fiscal_year_start_month),
    baseCurrency: organization.currency_code || null,
  };
}

// The Zoho callback: swap the code for tokens at the customer's own data centre, then list the
// organisations the sign-in can see. Nothing is stored here; ledgerAuth saves the chosen ones.
async function completeConnection(query = {}) {
  if (!query.code) throw new Error('Zoho did not send a sign-in code back');
  const sentServer = query['accounts-server'];
  const accountsServer = sentServer ? client.safeAccountsServer(sentServer) : client.defaultAccountsUrl();
  if (!accountsServer) throw new Error('Zoho sent back an accounts server that is not a Zoho address');

  const answer = await client.exchangeCode(query.code, accountsServer);
  if (!answer.refresh_token) {
    throw new Error('Zoho did not return a refresh token, so the connection could not stay signed in. Please connect again.');
  }
  const apiDomain = client.safeApiDomain(answer.api_domain);
  if (!apiDomain) throw new Error('Zoho sent back an API domain that is not a Zoho address');
  const token = client.tokenFromAnswer(answer, { refreshToken: answer.refresh_token, accountsServer, apiDomain });

  const organizations = await client.fetchOrganizations(apiDomain, token.access_token);
  return organizations
    .filter(org => org.organization_id != null && org.organization_id !== '')
    .map(org => ({ externalId: String(org.organization_id), name: org.name || null, token: { ...token } }));
}

module.exports = {
  ledger,
  isConfigured: client.isConfigured,
  buildConsentUrl: client.buildConsentUrl,
  completeConnection,
  fetchCompanyInfo,
  fetchDocuments,
  // For tests and support scripts.
  mapInvoice, mapBill, mapSalesCredit, mapVendorCredit, mapContact, financialYearEnd, fetchAllPages,
  currencyRateFrom, vendorCreditRates,
};
