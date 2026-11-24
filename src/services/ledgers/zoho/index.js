// Zoho Books provider: reads a client's invoices, bills, credit notes, vendor credits and contacts
// and hands them to ledgerSync.js in the Xero shapes checkRules/ledgerChecks already read, so
// Zoho clients run the same checks as FreeAgent and QuickBooks clients.
//
// The list endpoints are read, not one document at a time: Zoho caps API calls per
// organisation per day (1,000 on Free up to 10,000 on Premium and above), and a call per invoice
// would use that up on a mid-sized client. The only single-document reads are the exchange rate
// of open foreign vendor credits and the opening-balance documents of contacts whose unpaid total
// the lists do not explain (see fetchOpeningBalances). The lists carry no line items and no net/tax split, so
// those fields are empty here (see the notes on mapInvoice).
// Field names and status values checked against https://www.zoho.com/books/api/v3/ (invoices,
// bills, credit-notes, vendor-credits, contacts, organizations, transaction-locking), 24 Nov 2026.
const client = require('./client');
const { amountInBase } = require('../../checkRules');
const mapping = require('./mapping');
const accounting = require('./accounting');

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
    ...lineFields(invoice),
  };
}

// Line items. The list rows have none: accounting.fetchLineItems reads them one document at a time,
// only for documents new or changed since the cached copy (detailKey, from last_modified_time). A
// one-document answer (opening balances) already has them, so they are mapped straight away.
function lineFields(raw) {
  if (Array.isArray(raw.line_items)) return mapping.documentDetail(raw);
  return { lineItemsRead: false, lineItemsStale: false, detailKey: mapping.changeKey(raw) };
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
    ...lineFields(bill),
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

// Opening balances. A client that started in Zoho with balances brought forward has, per customer and
// per supplier, a hidden opening-balance document ("Customer opening balance" / "Vendor opening
// balance") that the invoice and bill lists never return. Each contact row on the contact list carries
// its total unpaid in the organisation's currency (outstanding_receivable_amount_bcy,
// outstanding_payable_amount_bcy), opening balances included, so a contact whose total is more than
// its open listed invoices (or bills) add up to, converted the same way the checks convert them
// (checkRules.amountInBase with currencyRate, rounded per document), is the only one worth a call.
// For each such contact: GET /contacts/{id} gives opening_balances[].ob_invoice_id; the customer side
// is read with GET /invoices/{id}, the supplier side with GET /bills/{id}. The documents are mapped
// with mapInvoice/mapBill and marked isOpeningBalance, so Old Unpaid Invoices/Bills count them while
// duplicates, unapproved, undocumented bills, turnover and the transaction counts leave them out
// (ledgerChecks.js). Reads are one at a time through client.apiGet, with the vendor credit rule for
// errors: a refused sign-in, a throttled refresh or a configuration fault stops the sync, Zoho's daily
// limit stops further reads, anything else is logged and that read skipped; a contact whose opening balances
// were not all read keeps its cached copies (see fetchDocuments).
const GAP_TOLERANCE = 0.01;

function roundMoney(value) {
  const number = Number(value) || 0;
  const sign = number < 0 ? -1 : 1;
  return sign * Number(`${Math.round(Number(`${Math.abs(number).toFixed(8)}e2`))}e-2`);
}

function hasUsableRate(doc) {
  const rate = Number(doc?.currencyRate);
  return Number.isFinite(rate) && rate > 0;
}

// What a contact's open listed documents (approved, something still due) add up to in the
// organisation's currency, and whether any of them could not be converted (a foreign document with
// no rate). A document in the organisation's own currency, or with no currency, is taken as it stands.
function openTotalsByContact(docs, base) {
  const totals = new Map();
  for (const doc of docs) {
    const id = doc.contact?.contactID;
    if (!id || doc.status !== 'AUTHORISED' || !(Number(doc.amountDue) > 0)) continue;
    const entry = totals.get(id) || { total: 0, unconvertible: false };
    const code = currencyCodeOf(doc.currencyCode);
    // With the organisation's currency unknown, a document is taken as foreign only when its rate says so.
    const foreign = base ? Boolean(code) && code !== base : hasUsableRate(doc) && Number(doc.currencyRate) !== 1;
    if (foreign && !hasUsableRate(doc)) entry.unconvertible = true;
    else entry.total += roundMoney(amountInBase(doc.amountDue, doc));
    totals.set(id, entry);
  }
  return totals;
}

// The contacts (raw list rows) whose unpaid total is more than their listed open documents explain,
// per side. A contact with an open document that cannot be converted is a candidate on that side
// whenever Zoho says it is owed anything (the gap cannot be worked out, so it is read rather than missed).
function openingBalanceCandidates(contactRows, invoices, bills, { baseCurrency = null } = {}) {
  const base = currencyCodeOf(baseCurrency);
  const invoiceTotals = openTotalsByContact(invoices, base);
  const billTotals = openTotalsByContact(bills, base);
  const candidates = [];
  for (const row of contactRows) {
    const id = row?.contact_id == null || row.contact_id === '' ? null : String(row.contact_id);
    if (!id) continue;
    const side = (outstanding, totals) => {
      const owed = numberOrNull(outstanding);
      if (owed == null || !(owed > GAP_TOLERANCE)) return false;
      const entry = totals.get(id) || { total: 0, unconvertible: false };
      return entry.unconvertible || owed - roundMoney(entry.total) > GAP_TOLERANCE;
    };
    const customer = side(row.outstanding_receivable_amount_bcy, invoiceTotals);
    const supplier = side(row.outstanding_payable_amount_bcy, billTotals);
    if (customer || supplier) candidates.push({ contactId: id, name: contactName(row), customer, supplier });
  }
  return candidates;
}

function isFatal(error) {
  return Boolean(error && (error.authFailure || error.retryLater || error.configurationError));
}

// Zoho's own marks for the two kinds of opening-balance document. The customer one is checked by its type
// (customer_ob_invoice) or, with no type given, by its number; a bill body marked as the customer one is
// refused. The ids share one field (opening_balances[].ob_invoice_id), so a body one endpoint answers with for
// the other side's id must not be taken: a vendor opening balance mapped as a customer invoice would swap the
// sides of a real debt.
const CUSTOMER_OB_NUMBER = 'customer opening balance';
const lowerText = value => String(value == null ? '' : value).trim().toLowerCase();

function isCustomerOpeningBalance(raw) {
  const type = lowerText(raw?.type);
  if (type) return type === 'customer_ob_invoice';
  return lowerText(raw?.invoice_number) === CUSTOMER_OB_NUMBER;
}

function isVendorOpeningBalance(raw) {
  if (lowerText(raw?.type).includes('customer')) return false;
  return lowerText(raw?.bill_number) !== CUSTOMER_OB_NUMBER;
}

// "Not found" on one side's endpoint means the id is the other side's document, not a failed read.
const isNotFound = error => Number(error?.status) === 404;

// Reads and maps the opening-balance documents of the candidate contacts. knownIds: the invoiceIDs
// already returned by the lists (and filled in as documents are added), so nothing is added twice.
// notRead: the candidate contacts whose opening balances could not all be read (a failed read, or
// never reached after Zoho's daily limit), so fetchDocuments can keep their cached copies.
async function fetchOpeningBalances(externalId, candidates, knownIds, { emit = () => {} } = {}) {
  const invoices = [];
  const bills = [];
  const notRead = new Set();
  let stopped = false;
  let calls = 0;
  // failed: set when a read threw anything but "not found" (or was skipped after the daily limit).
  let failed = false;
  const read = async (pathName, what) => {
    if (stopped) { failed = true; return null; }
    try {
      calls++;
      return await client.apiGet(externalId, pathName);
    } catch (error) {
      if (isFatal(error)) throw error;
      console.log(`Zoho Books ${what}: not read for organisation ${externalId}: ${error.message}`);
      if (error.dailyLimit) stopped = true;
      if (!isNotFound(error)) failed = true;
      return null;
    }
  };
  const addInvoice = (raw, contact) => {
    if (!raw || raw.invoice_id == null || raw.invoice_id === '') return false;
    if (!isCustomerOpeningBalance(raw)) return false;
    const doc = { ...mapInvoice(raw), isOpeningBalance: true };
    if (!doc.contact.contactID) doc.contact = documentContact(contact.contactId, contact.name);
    if (!doc.contact.name) doc.contact.name = contact.name;
    if (knownIds.has(doc.invoiceID)) return true;
    knownIds.add(doc.invoiceID);
    invoices.push(doc);
    return true;
  };
  const addBill = (raw, contact) => {
    if (!raw || raw.bill_id == null || raw.bill_id === '') return false;
    if (!isVendorOpeningBalance(raw)) return false;
    const doc = { ...mapBill(raw), isOpeningBalance: true };
    if (!doc.contact.contactID) doc.contact = documentContact(contact.contactId, contact.name);
    if (!doc.contact.name) doc.contact.name = contact.name;
    if (knownIds.has(doc.invoiceID)) return true;
    knownIds.add(doc.invoiceID);
    bills.push(doc);
    return true;
  };

  for (const candidate of candidates) {
    if (stopped) { notRead.add(candidate.contactId); continue; }
    failed = false;
    const body = await read(`/contacts/${encodeURIComponent(candidate.contactId)}`, `contact ${candidate.contactId} opening balances`);
    const contact = body?.contact;
    if (!contact) {
      if (failed) notRead.add(candidate.contactId);
      continue;
    }
    // Only the sides that are short on the list and that Zoho says still have an opening balance owed
    // (when it says so at all).
    const obOwed = field => {
      const value = numberOrNull(contact[field]);
      return value == null ? null : value > 0;
    };
    const customerOwed = obOwed('outstanding_ob_receivable_amount');
    const supplierOwed = obOwed('outstanding_ob_payable_amount');
    const customer = candidate.customer && customerOwed !== false;
    const supplier = candidate.supplier && supplierOwed !== false;
    if (!customer && !supplier) continue;
    const ids = [...new Set((Array.isArray(contact.opening_balances) ? contact.opening_balances : [])
      .map(entry => entry?.ob_invoice_id)
      .filter(id => id != null && id !== '')
      .map(String))];
    let contactIncomplete = false;
    for (const id of ids) {
      if (knownIds.has(id) || knownIds.has(`bill-${id}`)) continue;
      failed = false;
      let found = false;
      if (customer) {
        const answer = await read(`/invoices/${encodeURIComponent(id)}`, `opening balance ${id} (customer)`);
        found = addInvoice(answer?.invoice, candidate);
      }
      if (!found && supplier) {
        const answer = await read(`/bills/${encodeURIComponent(id)}`, `opening balance ${id} (supplier)`);
        found = addBill(answer?.bill, candidate);
      }
      if (!found && failed) contactIncomplete = true;
    }
    if (contactIncomplete) notRead.add(candidate.contactId);
  }
  if (invoices.length || bills.length) {
    emit({ step: 'fetch_documents', message: `Read ${invoices.length + bills.length} opening balances from Zoho Books.` });
  }
  return { invoices, bills, calls, stopped, notRead };
}

// Every document in every status and date: filter_by=Status.All is the documented "all" filter
// for bills, credit notes, vendor credits and contacts, and the invoice list example shows it as
// the applied filter. baseCurrency is the organisation's currency (fetchCompanyInfo), used to tell
// which vendor credits need their rate read.
async function fetchDocuments(externalId, { emit = () => {}, baseCurrency = null, cachedOpeningBalances = null } = {}) {
  const all = { filter_by: 'Status.All' };
  emit({ step: 'fetch_documents', message: 'Reading contacts from Zoho Books...' });
  // The raw rows are kept: their outstanding_*_bcy totals pick out the contacts with opening balances.
  const contactRows = await fetchAllPages(externalId, '/contacts', 'contacts', all, emit);
  const contacts = contactRows.map(mapContact);
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
  const invoices = invoiceRows.map(mapInvoice);
  const bills = billRows.map(mapBill);
  const candidates = openingBalanceCandidates(contactRows, invoices, bills, { baseCurrency });
  let openingBalances = { invoices: [], bills: [], calls: 0, stopped: false, notRead: new Set() };
  if (candidates.length) {
    emit({ step: 'fetch_documents', message: `Reading opening balances of ${candidates.length} contacts from Zoho Books...` });
    const knownIds = new Set([...invoices, ...bills].map(doc => doc.invoiceID));
    openingBalances = await fetchOpeningBalances(externalId, candidates, knownIds, { emit });
  }
  // A contact whose opening balances could not all be read keeps the copies the last good sync cached:
  // ledgerSync refreshes the cache in full, so leaving them out would delete them and Old Unpaid
  // Invoices/Bills would drop by that amount with nothing to say why (the lists themselves are never
  // returned short, see fetchAllPages). A cached copy whose id this run already has is not added again.
  const carried = { invoices: [], bills: [] };
  if (openingBalances.notRead.size && typeof cachedOpeningBalances === 'function') {
    const seen = new Set([...invoices, ...bills, ...openingBalances.invoices, ...openingBalances.bills].map(doc => doc.invoiceID));
    for (const doc of (await cachedOpeningBalances()) || []) {
      if (!doc || !doc.isOpeningBalance || doc.invoiceID == null || seen.has(doc.invoiceID)) continue;
      if (!openingBalances.notRead.has(String(doc.contact?.contactID))) continue;
      seen.add(doc.invoiceID);
      (doc.type === 'ACCPAY' ? carried.bills : carried.invoices).push(doc);
    }
  }
  const carriedForward = carried.invoices.length + carried.bills.length;
  if (openingBalances.notRead.size) {
    const message = `Not all opening balances could be read from Zoho Books (${openingBalances.notRead.size} contacts`
      + `${openingBalances.stopped ? ', daily API limit reached' : ''}); `
      + `${carriedForward} kept from the last sync. Old Unpaid Invoices/Bills may be incomplete.`;
    console.log(`Zoho Books organisation ${externalId}: ${message}`);
    emit({ step: 'fetch_documents', message });
  }
  return {
    invoices: [...invoices, ...openingBalances.invoices, ...carried.invoices],
    bills: [...bills, ...openingBalances.bills, ...carried.bills],
    credits: [...creditRows.map(mapSalesCredit), ...vendorCredits],
    contacts,
    openingBalances: {
      complete: openingBalances.notRead.size === 0,
      stopped: openingBalances.stopped,
      contactsNotRead: openingBalances.notRead.size,
      carriedForward,
      calls: openingBalances.calls,
    },
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
    // The organisation's VAT registration and zone flags (UAE: TRN, free zone), for the UAE checks
    // and the UAE Tax Registration card. Read from the same answer, so it costs no call.
    taxProfile: mapping.taxProfileOf(organization),
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
  // Accounting data and line items for the checks (accounting.js; called by ledgerSync after fetchDocuments).
  createReadBudget: accounting.createReadBudget,
  fetchAccounting: accounting.fetchAccounting,
  fetchLineItems: accounting.fetchLineItems,
  // For tests and support scripts.
  mapInvoice, mapBill, mapSalesCredit, mapVendorCredit, mapContact, financialYearEnd, fetchAllPages,
  currencyRateFrom, vendorCreditRates, openingBalanceCandidates, fetchOpeningBalances,
};
