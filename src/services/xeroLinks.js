// "Open in Xero" links for a finding. Kept out of the route file so it can be tested on its own.
//
// A bill and a sales invoice open on different Xero pages (AccountsPayable / AccountsReceivable); opening one on the
// wrong page gives "transaction not available". Checks such as Misallocated Items mix bills, invoices and bank
// transactions, so the direction cannot come from the check name alone. It is taken from, in order: what the item says
// it is (source), its Xero type, and only then the check name.
const enc = encodeURIComponent;

function directionOf(item) {
  if (item.source === 'bill') return 'payable';
  if (item.source === 'invoice') return 'receivable';
  if (item.type === 'ACCPAY' || item.type === 'ACCPAYCREDIT') return 'payable';
  if (item.type === 'ACCREC' || item.type === 'ACCRECCREDIT') return 'receivable';
  return null;
}

// Items whose generic `id` is not an invoice id.
const NOT_AN_INVOICE_SOURCE = new Set(['payment', 'manual_journal', 'credit_note']);

const isCreditType = type => type === 'ACCPAYCREDIT' || type === 'ACCRECCREDIT';

function xeroLinks(checkType, item) {
  const links = [];
  const add = (label, url) => { if (url && !links.some(link => link.url === url)) links.push({ label, url }); };
  const direction = directionOf(item);
  const bankSource = /^bank/.test(item.source || '');
  // A bare `id` is only an invoice/bill id when nothing says it is something else: not a bank, payment, journal or
  // credit note item, and the item carries no explicit payment / bank transaction / credit note id of its own.
  const explicitOtherId = item.paymentId || item.paymentID || item.bankTransactionId || item.bankTransactionID
    || item.creditNoteId || item.creditNoteID;
  const knownDocument = item.source === 'bill' || item.source === 'invoice' || item.type === 'ACCPAY' || item.type === 'ACCREC';
  const genericIdIsInvoice = !bankSource && !NOT_AN_INVOICE_SOURCE.has(item.source) && !explicitOtherId && !isCreditType(item.type)
    && (knownDocument || /(invoice|bill|undocumented)/.test(checkType));
  const invoiceId = (!bankSource && (item.invoiceId || item.invoiceID)) || (genericIdIsInvoice ? item.id : null);
  if (invoiceId) {
    const payable = direction ? direction === 'payable' : /(bill|purchase|supplier|sales_tax_on_bills)/.test(checkType);
    add(payable ? 'Open bill' : 'Open invoice',
      `https://go.xero.com/${payable ? 'AccountsPayable' : 'AccountsReceivable'}/View.aspx?InvoiceID=${enc(invoiceId)}`);
  }
  if (/duplicate_(invoices|bills)/.test(checkType)) {
    const payable = checkType === 'duplicate_bills';
    for (const id of [item.id1, item.id2].filter(Boolean)) {
      add(payable ? 'Open bill' : 'Open invoice',
        `https://go.xero.com/${payable ? 'AccountsPayable' : 'AccountsReceivable'}/View.aspx?InvoiceID=${enc(id)}`);
    }
  }
  const bankId = item.bankTransactionId || item.bankTransactionID || (bankSource ? (item.invoiceId || item.id) : null);
  if (bankId) add('Open bank transaction', `https://go.xero.com/Bank/ViewTransaction.aspx?bankTransactionID=${enc(bankId)}`);
  const paymentId = item.paymentId || item.paymentID || (item.source === 'payment' ? item.id : null);
  if (paymentId) add('Find payment', `https://go.xero.com/Search/Default.aspx?searchTerm=${enc(paymentId)}`);
  const creditId = item.creditNoteId || item.creditNoteID
    || ((/credits/.test(checkType) || isCreditType(item.type) || item.source === 'credit_note') ? item.id : null);
  if (creditId) {
    const payable = direction ? direction === 'payable' : /purchase/.test(checkType);
    add('Open credit note',
      `https://go.xero.com/${payable ? 'AccountsPayable' : 'AccountsReceivable'}/ViewCreditNote.aspx?creditNoteID=${enc(creditId)}`);
  }
  const contactIds = [item.contactId, item.contactID];
  if (/duplicate_contacts/.test(checkType)) contactIds.push(item.id1, item.id2);
  for (const contactId of contactIds.filter(Boolean)) {
    add('Open contact', `https://go.xero.com/Contacts/View/${enc(contactId)}`);
  }
  if (!links.length) {
    const term = item.number || item.invoiceNumber || item.contact || item.name || item.finding_key;
    if (term) add('Search in Xero', `https://go.xero.com/Search/Default.aspx?searchTerm=${enc(term)}`);
  }
  return links;
}

module.exports = { xeroLinks, directionOf };
