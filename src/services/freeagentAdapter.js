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
// against FreeAgent's documented status list as of Stage 1 — revisit if FreeAgent adds new
// statuses or real sandbox data reveals a case this doesn't handle sensibly.
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

const BILL_STATUS_MAP = {
  'Zero Value': 'AUTHORISED',
  'Open': 'AUTHORISED',
  'Paid': 'PAID',
  'Overdue': 'AUTHORISED',
  'Refunded': 'VOIDED',
};

// FreeAgent references are URLs (e.g. ".../invoices/123"); Xero's ids are short numeric strings.
// The numeric tail is stable and unique enough to use as the xero-node-shaped id field.
function idFromUrl(url) {
  if (!url) return null;
  const match = String(url).match(/(\d+)$/);
  return match ? match[1] : url;
}

async function fetchContactsById(companyId) {
  const byUrl = new Map();
  let page = 1;
  while (true) {
    const body = await apiCall(companyId, '/v2/contacts', { page, per_page: 100 });
    const contacts = body.contacts || [];
    for (const contact of contacts) {
      const name = contact.organisation_name ||
        [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Unknown contact';
      byUrl.set(contact.url, { contactID: idFromUrl(contact.url), name });
    }
    if (contacts.length < 100) break;
    page++;
  }
  return byUrl;
}

async function fetchAllInvoices(companyId, ifModifiedSince = undefined) {
  const contactsByUrl = await fetchContactsById(companyId);
  const allInvoices = [];
  let page = 1;
  while (true) {
    const body = await apiCall(companyId, '/v2/invoices', {
      page, per_page: 100, updated_since: ifModifiedSince,
    });
    const invoices = body.invoices || [];
    for (const invoice of invoices) {
      allInvoices.push({
        invoiceID: idFromUrl(invoice.url),
        invoiceNumber: invoice.reference,
        reference: invoice.reference,
        type: 'ACCREC',
        status: INVOICE_STATUS_MAP[invoice.status] || 'AUTHORISED',
        contact: contactsByUrl.get(invoice.contact) || { contactID: null, name: null },
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
      });
    }
    if (invoices.length < 100) break;
    page++;
  }
  return allInvoices;
}

async function fetchAllBills(companyId, ifModifiedSince = undefined) {
  const contactsByUrl = await fetchContactsById(companyId);
  const allBills = [];
  let page = 1;
  while (true) {
    const body = await apiCall(companyId, '/v2/bills', {
      page, per_page: 100, updated_since: ifModifiedSince,
    });
    const bills = body.bills || [];
    for (const bill of bills) {
      allBills.push({
        invoiceID: idFromUrl(bill.url),
        invoiceNumber: bill.reference || null,
        reference: bill.reference || null,
        type: 'ACCPAY',
        status: BILL_STATUS_MAP[bill.status] || 'AUTHORISED',
        contact: contactsByUrl.get(bill.contact) || { contactID: null, name: null },
        date: bill.dated_on,
        dueDate: bill.due_on,
        total: Number(bill.total_value) || 0,
        subTotal: Number(bill.net_value) || 0,
        totalTax: Number(bill.sales_tax_value) || 0,
        amountDue: Number(bill.due_value) || 0,
        currencyCode: bill.currency,
        lineItems: (bill.bill_items || []).map(item => ({
          description: item.description,
          quantity: Number(item.quantity) || 0,
          unitAmount: Number(item.price) || 0,
          accountCode: idFromUrl(item.category),
        })),
      });
    }
    if (bills.length < 100) break;
    page++;
  }
  return allBills;
}

async function fetchAllContacts(companyId, ifModifiedSince = undefined) {
  const allContacts = [];
  let page = 1;
  while (true) {
    const body = await apiCall(companyId, '/v2/contacts', {
      page, per_page: 100, updated_since: ifModifiedSince,
    });
    const contacts = body.contacts || [];
    for (const contact of contacts) {
      allContacts.push({
        contactID: idFromUrl(contact.url),
        name: contact.organisation_name ||
          [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Unknown contact',
        emailAddress: contact.email,
      });
    }
    if (contacts.length < 100) break;
    page++;
  }
  return allContacts;
}

module.exports = { fetchAllInvoices, fetchAllBills, fetchAllContacts, idFromUrl };
