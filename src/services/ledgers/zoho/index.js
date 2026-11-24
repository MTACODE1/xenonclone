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

const ledger = { key: 'zoho', purchaseCredits: true, drafts: true };

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
// currencyRate is left out on purpose: Zoho's exchange_rate is base currency per foreign unit, the
// opposite way round from Xero's, and the checks would divide by it.
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

// Every document in every status and date: filter_by=Status.All is the documented "all" filter
// for bills, credit notes, vendor credits and contacts, and the invoice list example shows it as
// the applied filter.
async function fetchDocuments(externalId, { emit = () => {} } = {}) {
  const all = { filter_by: 'Status.All' };
  emit({ step: 'fetch_documents', message: 'Reading contacts from Zoho Books...' });
  const contacts = (await fetchAllPages(externalId, '/contacts', 'contacts', all, emit)).map(mapContact);
  emit({ step: 'fetch_documents', message: 'Reading invoices from Zoho Books...' });
  const invoices = (await fetchAllPages(externalId, '/invoices', 'invoices', all, emit)).map(mapInvoice);
  emit({ step: 'fetch_documents', message: 'Reading bills from Zoho Books...' });
  const bills = (await fetchAllPages(externalId, '/bills', 'bills', all, emit)).map(mapBill);
  emit({ step: 'fetch_documents', message: 'Reading credit notes from Zoho Books...' });
  const salesCredits = (await fetchAllPages(externalId, '/creditnotes', 'creditnotes', all, emit)).map(mapSalesCredit);
  emit({ step: 'fetch_documents', message: 'Reading vendor credits from Zoho Books...' });
  const vendorCredits = (await fetchAllPages(externalId, '/vendorcredits', 'vendor_credits', all, emit)).map(mapVendorCredit);
  return { invoices, bills, credits: [...salesCredits, ...vendorCredits], contacts };
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
};
