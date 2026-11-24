const { apiCall } = require('./freeagentClient');

// Translates FreeAgent's API responses into objects shaped exactly like what xero-node's SDK
// would have produced (see src/services/xeroSync.js's fetchAllInvoices/fetchAllContacts) — so
// checkRules.js and the rest of the scoring engine run completely unchanged against either
// provider. This is Stage 1 of the FreeAgent integration: invoices + bills + contacts only,
// enough to prove the adapter pattern against one real check (duplicate_invoices/duplicate_bills)
// before expanding to bank transactions, tax rates, and the rest in a later stage.

// FreeAgent's own status vocabulary ("Open", "Overdue", "Written-off", ...) has no exact Xero
// equivalent, so this maps each one to whichever of Xero's three statuses
// (AUTHORISED/PAID/VOIDED) the existing checks already filter on and treat the same way. Reviewed
// against FreeAgent's documented status list (dev.freeagent.com/docs/invoices, /bills,
// /credit_notes, read 24 Nov 2026).
const INVOICE_STATUS_MAP = {
  'Draft': 'DRAFT',
  'Scheduled To Email': 'DRAFT',
  'Open': 'AUTHORISED',
  'Zero Value': 'AUTHORISED',
  'Overdue': 'AUTHORISED',
  'Paid': 'PAID',
  'Overpaid': 'PAID',
  'Refunded': 'VOIDED',
  'Written-off': 'VOIDED',
  'Part written-off': 'AUTHORISED',
};

// FreeAgent bills have no draft state (documented statuses: Zero Value, Open, Paid, Overdue,
// Refunded), so Unapproved Bills is always 0 for a FreeAgent client, correctly.
const BILL_STATUS_MAP = {
  'Zero Value': 'AUTHORISED',
  'Open': 'AUTHORISED',
  'Paid': 'PAID',
  'Overdue': 'AUTHORISED',
  'Refunded': 'VOIDED',
};

// FreeAgent's /v2/credit_notes is a single resource issued TO contacts (sales-side only — there is
// no purchase/supplier credit note concept), so every one always maps to Xero's ACCRECCREDIT type.
const CREDIT_NOTE_STATUS_MAP = {
  'Draft': 'DRAFT',
  'Open': 'AUTHORISED',
  'Overdue': 'AUTHORISED',
  'Refunded': 'PAID',
  'Written-off': 'VOIDED',
};

const PER_PAGE = 100; // FreeAgent's maximum; its default is 25
const MAX_PAGES = 2000;

// FreeAgent references are URLs (e.g. ".../invoices/123"); Xero's ids are short numeric strings.
// The numeric tail is stable and unique enough to use as the xero-node-shaped id field.
function idFromUrl(url) {
  if (!url) return null;
  const match = String(url).match(/(\d+)$/);
  return match ? match[1] : url;
}

// Invoices and bills share one cache table keyed by invoiceID, and FreeAgent numbers them
// separately, so invoice 123 and bill 123 overwrote each other. Bills carry a prefix.
function billId(url) {
  const id = idFromUrl(url);
  return id == null ? null : `bill-${id}`;
}

// FreeAgent's updated_since is ISO 8601 with a time (2017-05-22T09:00:00.000Z).
function isoSince(value) {
  if (value == null || value === '') return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// Reads every page of one FreeAgent list. The options must sit under `params` (that is what
// apiCall reads); until 24 Nov 2026 they were passed bare, so FreeAgent never saw page/per_page,
// answered with its default 25 rows, and the "fewer than 100 means last page" test stopped after
// page one: only the first 25 invoices, bills, credit notes and contacts of a client were read.
async function fetchAllPages(companyId, path, listKey, params = {}) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await apiCall(companyId, path, { params: { ...params, page, per_page: PER_PAGE } });
    const items = (body && body[listKey]) || [];
    rows.push(...items);
    if (items.length < PER_PAGE) return rows;
  }
  throw new Error(`FreeAgent ${path}: more than ${MAX_PAGES} pages; stopped rather than return a partial list`);
}

function contactName(contact) {
  return contact.organisation_name ||
    [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Unknown contact';
}

// Every contact, hidden ones too (FreeAgent's default view is active only), so an invoice for a
// hidden contact still carries the contact's name.
async function fetchContactsById(companyId) {
  const byUrl = new Map();
  for (const contact of await fetchAllPages(companyId, '/v2/contacts', 'contacts', { view: 'all' })) {
    byUrl.set(contact.url, { contactID: idFromUrl(contact.url), name: contactName(contact) });
  }
  return byUrl;
}

async function fetchAllInvoices(companyId, ifModifiedSince = undefined, contactsByUrl = null) {
  const contacts = contactsByUrl || await fetchContactsById(companyId);
  const invoices = await fetchAllPages(companyId, '/v2/invoices', 'invoices', {
    view: 'all', nested_invoice_items: true, updated_since: isoSince(ifModifiedSince),
  });
  return invoices.map(invoice => ({
    invoiceID: idFromUrl(invoice.url),
    invoiceNumber: invoice.reference,
    reference: invoice.reference,
    type: 'ACCREC',
    status: INVOICE_STATUS_MAP[invoice.status] || 'AUTHORISED',
    contact: contacts.get(invoice.contact) || { contactID: null, name: null },
    date: invoice.dated_on,
    dueDate: invoice.due_on,
    total: Number(invoice.total_value) || 0,
    subTotal: Number(invoice.net_value) || 0,
    totalTax: Number(invoice.sales_tax_value) || 0,
    amountDue: Number(invoice.due_value) || 0,
    amountPaid: Number(invoice.paid_value) || 0,
    currencyCode: invoice.currency,
    lineItems: (invoice.invoice_items || []).map(item => ({
      description: item.description,
      quantity: Number(item.quantity) || 0,
      unitAmount: Number(item.price) || 0,
      accountCode: idFromUrl(item.category),
      taxType: item.sales_tax_status,
    })),
  }));
}

async function fetchAllBills(companyId, ifModifiedSince = undefined, contactsByUrl = null) {
  const contacts = contactsByUrl || await fetchContactsById(companyId);
  const bills = await fetchAllPages(companyId, '/v2/bills', 'bills', {
    view: 'all', nested_bill_items: true, updated_since: isoSince(ifModifiedSince),
  });
  return bills.map(bill => ({
    invoiceID: billId(bill.url),
    invoiceNumber: bill.reference || null,
    reference: bill.reference || null,
    type: 'ACCPAY',
    status: BILL_STATUS_MAP[bill.status] || 'AUTHORISED',
    contact: contacts.get(bill.contact) || { contactID: null, name: null },
    date: bill.dated_on,
    dueDate: bill.due_on,
    total: Number(bill.total_value) || 0,
    subTotal: Number(bill.net_value) || 0,
    totalTax: Number(bill.sales_tax_value) || 0,
    amountDue: Number(bill.due_value) || 0,
    currencyCode: bill.currency,
    hasAttachments: !!bill.attachment,
    lineItems: (bill.bill_items || []).map(item => ({
      description: item.description,
      quantity: Number(item.quantity) || 0,
      unitAmount: Number(item.price) || 0,
      accountCode: idFromUrl(item.category),
    })),
  }));
}

async function fetchAllContacts(companyId, ifModifiedSince = undefined) {
  const contacts = await fetchAllPages(companyId, '/v2/contacts', 'contacts', {
    view: 'all', updated_since: isoSince(ifModifiedSince),
  });
  return contacts.map(contact => ({
    contactID: idFromUrl(contact.url),
    name: contactName(contact),
    emailAddress: contact.email,
    // FreeAgent's contact status is "Active"/"Hidden" — normalised to Xero's ACTIVE/ARCHIVED
    // vocabulary so checkRules.js's contactStatus === 'ACTIVE' filters work unchanged.
    contactStatus: contact.status === 'Active' ? 'ACTIVE' : 'ARCHIVED',
  }));
}

async function fetchAllCreditNotes(companyId, ifModifiedSince = undefined, contactsByUrl = null) {
  const contacts = contactsByUrl || await fetchContactsById(companyId);
  const creditNotes = await fetchAllPages(companyId, '/v2/credit_notes', 'credit_notes', {
    view: 'all', updated_since: isoSince(ifModifiedSince),
  });
  return creditNotes.map(creditNote => ({
    creditNoteID: idFromUrl(creditNote.url),
    creditNoteNumber: creditNote.reference || null,
    type: 'ACCRECCREDIT',
    status: CREDIT_NOTE_STATUS_MAP[creditNote.status] || 'AUTHORISED',
    contact: contacts.get(creditNote.contact) || { contactID: null, name: null },
    date: creditNote.dated_on,
    // FreeAgent's own examples show credit note values both as -120.0 and as 200.0; Xero's credit
    // notes are positive amounts, which the credit checks rely on.
    total: Math.abs(Number(creditNote.total_value) || 0),
    subTotal: Math.abs(Number(creditNote.net_value) || 0),
    remainingCredit: Math.abs(Number(creditNote.due_value) || 0),
  }));
}

module.exports = {
  fetchAllInvoices, fetchAllBills, fetchAllContacts, fetchAllCreditNotes, fetchContactsById,
  idFromUrl, billId, isoSince,
};
