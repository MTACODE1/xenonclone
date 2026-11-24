// QuickBooks Online provider for Akrio Verify (key 'quickbooks', clients stored as "qbo-<realmId>").
// Reads a company's invoices, bills, credit memos, vendor credits, customers and vendors and turns
// them into the Xero shapes ledgerChecks.js and checkRules.js already read, so QuickBooks clients
// run exactly the same checks as FreeAgent and Zoho clients. Read only: nothing is ever written to
// QuickBooks.
//
// Field names and meanings checked against Intuit's Accounting API reference (24 Nov 2026):
// developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/<invoice|bill|creditmemo|
// vendorcredit|attachable|companyinfo|preferences>, and the query page for STARTPOSITION/MAXRESULTS.
const client = require('./client');

// QuickBooks has supplier credits (VendorCredit) but no draft invoices or bills: a QuickBooks
// invoice or bill exists only once it is saved, so the two "unapproved" checks are not applicable.
// exchangeRates: a foreign document carries currencyRate (Xero's convention), so the checks convert.
const ledger = { key: 'quickbooks', purchaseCredits: true, drafts: false, exchangeRates: true };

const PAGE_SIZE = 1000; // Intuit's documented maximum per query (the default is 100)
const MAX_PAGES = 1000;

const num = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const round2 = value => Math.round(value * 100) / 100;
const dateOnly = value => (value ? String(value).slice(0, 10) : null);

// ---------------------------------------------------------------------------------------------
// Reading every row of one entity
// ---------------------------------------------------------------------------------------------

function faultMessage(body) {
  const fault = body?.Fault || body?.fault || body?.QueryResponse?.Fault;
  if (!fault) return null;
  const errors = fault.Error || fault.error || [];
  return errors.map(e => e.Message || e.message || e.Detail || e.detail || e.code).filter(Boolean).join('; ') || 'QuickBooks query fault';
}

async function runQuery(externalId, statement) {
  const body = await client.apiGet(externalId, '/query', { query: statement });
  const fault = faultMessage(body);
  if (fault) throw Object.assign(new Error(`QuickBooks query failed (${statement.split(' STARTPOSITION')[0]}): ${fault}`), { status: 400 });
  return body?.QueryResponse || {};
}

// Every row of one entity, page by page (STARTPOSITION is 1-based) until a short page. A query
// gives no ordering promise, so the rows are also counted first (SELECT COUNT(*)) and the list is
// refused if fewer distinct rows came back than were counted: a partial list would make the checks
// report a client as cleaner than it is.
async function queryAll(externalId, entity, where = '') {
  const filter = where ? ` WHERE ${where}` : '';
  const counted = await runQuery(externalId, `SELECT COUNT(*) FROM ${entity}${filter}`);
  const expected = Number(counted.totalCount);

  const byId = new Map();
  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * PAGE_SIZE + 1;
    const response = await runQuery(externalId, `SELECT * FROM ${entity}${filter} STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`);
    const rows = response[entity] || []; // an empty result has no entity key at all
    for (const row of rows) byId.set(String(row.Id), row);
    if (rows.length < PAGE_SIZE) {
      if (Number.isFinite(expected) && byId.size < expected) {
        throw new Error(`QuickBooks ${entity}: read ${byId.size} of ${expected} rows; stopped rather than use a partial list`);
      }
      return [...byId.values()];
    }
  }
  throw new Error(`QuickBooks ${entity}: more than ${MAX_PAGES} pages; stopped rather than use a partial list`);
}

// ---------------------------------------------------------------------------------------------
// Mapping to the Xero shapes
// ---------------------------------------------------------------------------------------------

// Customer 5 and vendor 5 are different people in QuickBooks; Xero has one contact list, so each
// side gets its own prefix, and invoices/bills point at the same prefixed ids.
const customerId = ref => (ref?.value != null ? `c-${ref.value}` : null);
const vendorId = ref => (ref?.value != null ? `v-${ref.value}` : null);

function mapContact(row, prefix) {
  return {
    contactID: `${prefix}${row.Id}`,
    name: row.DisplayName || row.CompanyName || [row.GivenName, row.FamilyName].filter(Boolean).join(' ') || 'Unknown contact',
    emailAddress: row.PrimaryEmailAddr?.Address || null,
    // Which list it came from: checkRules' duplicate-contact rules treat customer-only contacts more
    // strictly (retail clients have thousands of one-off customers), as Xero's flags do.
    isCustomer: prefix === 'c-',
    isSupplier: prefix === 'v-',
    // QuickBooks has no "archived": a contact made inactive (or "deleted", which only makes it
    // inactive) is the same thing for the checks.
    contactStatus: row.Active === false || row.Active === 'false' ? 'ARCHIVED' : 'ACTIVE',
  };
}

function contactFor(ref, idOf, names) {
  const id = idOf(ref);
  if (!id) return { contactID: null, name: null };
  return { contactID: id, name: names.get(id) || ref.name || null };
}

// Xero keeps a foreign-currency document in its own currency with a rate in "foreign units per £1"
// (checkRules.amountInBase divides by it). QuickBooks' ExchangeRate is the other way round: home
// currency units for one unit of the document's currency. So currencyRate = 1 / ExchangeRate.
function currencyFields(row) {
  const rate = num(row.ExchangeRate);
  return {
    currencyCode: row.CurrencyRef?.value || null,
    ...(rate > 0 && rate !== 1 ? { currencyRate: 1 / rate } : {}),
  };
}

// Lines that are not a sale or a cost are left out: the sub-total line repeats the sum of the
// others, and a discount line is not a line item in Xero's sense. A group (bundle) line carries its
// real lines inside it.
function lineItems(lines) {
  const out = [];
  for (const line of lines || []) {
    if (!line || line.DetailType === 'SubTotalLineDetail' || line.DetailType === 'DiscountLineDetail') continue;
    if (line.DetailType === 'GroupLineDetail') {
      out.push(...lineItems(line.GroupLineDetail?.Line));
      continue;
    }
    const detail = line[line.DetailType] || {};
    out.push({
      description: line.Description || null,
      quantity: detail.Qty != null ? num(detail.Qty) : 1,
      unitAmount: detail.UnitPrice != null ? num(detail.UnitPrice) : num(line.Amount),
      lineAmount: num(line.Amount),
      accountCode: detail.AccountRef?.value || detail.ItemAccountRef?.value || null,
      taxType: detail.TaxCodeRef?.value || null,
    });
  }
  return out;
}

// Invoice and bill status. Voiding in QuickBooks keeps the document but zeroes every amount and
// puts "Voided" at the start of PrivateNote, so a nil total is treated as void. A nil balance on a
// real total is paid; anything still owed is approved and unpaid.
function documentStatus(row) {
  const total = num(row.TotalAmt);
  const balance = num(row.Balance);
  if (total === 0 && (/^\s*voided/i.test(row.PrivateNote || '') || balance === 0)) return 'VOIDED';
  if (balance === 0 && total > 0) return 'PAID';
  return 'AUTHORISED';
}

function mapDocument(row, { type, id, contact, hasAttachments }) {
  const status = documentStatus(row);
  const total = num(row.TotalAmt);
  const totalTax = num(row.TxnTaxDetail?.TotalTax);
  const amountDue = status === 'VOIDED' ? 0 : num(row.Balance);
  return {
    invoiceID: id,
    invoiceNumber: row.DocNumber || null,
    reference: row.DocNumber || null,
    type,
    status,
    contact,
    date: dateOnly(row.TxnDate),
    dueDate: dateOnly(row.DueDate) || dateOnly(row.TxnDate),
    total,
    subTotal: round2(total - totalTax),
    totalTax,
    amountDue,
    amountPaid: status === 'VOIDED' ? 0 : round2(Math.max(0, total - amountDue)),
    ...currencyFields(row),
    ...(hasAttachments === undefined ? {} : { hasAttachments }),
    lineItems: lineItems(row.Line),
  };
}

function mapInvoice(row, names) {
  return mapDocument(row, { type: 'ACCREC', id: String(row.Id), contact: contactFor(row.CustomerRef, customerId, names) });
}

// Invoices and bills share one cache table keyed by invoiceID and QuickBooks numbers them
// separately, so bills carry a prefix (the same as FreeAgent bills).
function mapBill(row, names, billsWithFiles) {
  return mapDocument(row, {
    type: 'ACCPAY', id: `bill-${row.Id}`, contact: contactFor(row.VendorRef, vendorId, names),
    hasAttachments: billsWithFiles.has(String(row.Id)),
  });
}

// Credit status: void (nil total), still has credit to use (approved), or fully used (paid).
// selectOldCredits only looks at AUTHORISED credits with something left, as for Xero.
function creditStatus(total, remaining) {
  if (total === 0) return 'VOIDED';
  return remaining > 0 ? 'AUTHORISED' : 'PAID';
}

function mapCredit(row, { type, id, contact, remaining }) {
  const total = Math.abs(num(row.TotalAmt));
  const totalTax = Math.abs(num(row.TxnTaxDetail?.TotalTax));
  const remainingCredit = Math.abs(remaining);
  return {
    creditNoteID: id,
    creditNoteNumber: row.DocNumber || null,
    type,
    status: creditStatus(total, remainingCredit),
    contact,
    date: dateOnly(row.TxnDate),
    total,
    subTotal: round2(total - totalTax),
    remainingCredit,
    ...currencyFields(row),
  };
}

// CreditMemo.RemainingCredit is "the credit amount still available to apply" (Intuit's words).
function mapCreditMemo(row, names) {
  return mapCredit(row, {
    type: 'ACCRECCREDIT', id: String(row.Id), contact: contactFor(row.CustomerRef, customerId, names),
    remaining: num(row.RemainingCredit != null ? row.RemainingCredit : row.Balance),
  });
}

// VendorCredit.Balance is the credit left; Intuit says it starts at TotalAmt, so when an older
// response leaves it out the credit has not been used.
function mapVendorCredit(row, names) {
  return mapCredit(row, {
    type: 'ACCPAYCREDIT', id: `vc-${row.Id}`, contact: contactFor(row.VendorRef, vendorId, names),
    remaining: num(row.Balance != null ? row.Balance : row.TotalAmt),
  });
}

// The ids of bills that have a file attached (a note-only Attachable is not a document). One paged
// query for all of them, not one per bill. Intuit documents filtering on AttachableRef.EntityRef.Type;
// if a company ever refuses that filter, every attachment is read and filtered here instead.
async function fetchBillIdsWithFiles(externalId) {
  let rows;
  try {
    rows = await queryAll(externalId, 'Attachable', "AttachableRef.EntityRef.Type = 'Bill'");
  } catch (error) {
    if (error.status !== 400) throw error;
    rows = await queryAll(externalId, 'Attachable');
  }
  const ids = new Set();
  for (const row of rows) {
    if (!row.FileName) continue;
    for (const ref of [].concat(row.AttachableRef || [])) {
      const entity = ref?.EntityRef;
      if (entity && String(entity.type || entity.Type || '').toLowerCase() === 'bill' && entity.value != null) {
        ids.add(String(entity.value));
      }
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------------------------

function isConfigured() {
  return client.isConfigured();
}

function buildConsentUrl(state) {
  return client.buildConsentUrl(state);
}

// The company's name for a token that is not saved yet (the route saves it after this returns).
// Required, not best effort: the realmId comes from the browser's callback URL, so reading the
// company with the new token is what proves the token belongs to that company. Without it, a
// changed realmId could attach someone's token to another client's row.
async function lookUpCompanyName(realmId, accessToken) {
  const url = `${client.apiBase()}/v3/company/${encodeURIComponent(realmId)}/companyinfo/${encodeURIComponent(realmId)}?minorversion=${client.MINOR_VERSION}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(`QuickBooks did not confirm the company that was connected (${response.status}); nothing was saved. Please try connecting again.`);
  }
  const body = await response.json();
  if (!body?.CompanyInfo) throw new Error('QuickBooks did not confirm the company that was connected; nothing was saved.');
  return body.CompanyInfo.CompanyName || null;
}

// Intuit sends code, state and realmId back to the redirect URI; one sign-in is one company.
async function completeConnection(query = {}) {
  const code = query.code;
  const realmId = query.realmId != null ? String(query.realmId) : '';
  if (!code) throw new Error('QuickBooks did not send a sign-in code');
  if (!/^\d+$/.test(realmId)) throw new Error('QuickBooks did not say which company was connected');
  const token = await client.exchangeCode(code);
  const name = await lookUpCompanyName(realmId, token.access_token);
  return [{ externalId: realmId, name, token }];
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// February is given as 29: periodResolver clamps the day to the month, so it lands on the 28th or
// the 29th as the year has it.
const LAST_DAY = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

async function fetchCompanyInfo(externalId) {
  const realm = encodeURIComponent(String(externalId));
  const [infoBody, prefsBody] = [
    await client.apiGet(externalId, `/companyinfo/${realm}`),
    await client.apiGet(externalId, '/preferences'),
  ];
  const info = infoBody?.CompanyInfo || {};
  const prefs = prefsBody?.Preferences || {};

  // QuickBooks stores the first month of the financial year; the year ends on the last day of the
  // month before it (starts January -> ends 31 December).
  let financialYearEndDay;
  let financialYearEndMonth;
  const startIndex = MONTHS.indexOf(String(info.FiscalYearStartMonth || '').trim().toLowerCase());
  if (startIndex >= 0) {
    const endIndex = (startIndex + 11) % 12;
    financialYearEndMonth = endIndex + 1;
    financialYearEndDay = LAST_DAY[endIndex];
  }

  // The closing date ("close the books") is QuickBooks' lock date.
  const bookClose = dateOnly(prefs.AccountingInfoPrefs?.BookCloseDate);
  return {
    name: info.CompanyName || info.LegalName || null,
    lockDate: bookClose && /^\d{4}-\d{2}-\d{2}$/.test(bookClose) ? bookClose : null,
    financialYearEndDay,
    financialYearEndMonth,
    baseCurrency: prefs.CurrencyPrefs?.HomeCurrency?.value || null,
  };
}

// Every document, every status, all dates. Read one entity at a time (Intuit allows only a few
// requests at once per company).
async function fetchDocuments(externalId, { emit = () => {} } = {}) {
  emit({ step: 'fetch_contacts', message: 'Reading QuickBooks customers and suppliers...' });
  const customers = await queryAll(externalId, 'Customer', 'Active IN (true, false)');
  const vendors = await queryAll(externalId, 'Vendor', 'Active IN (true, false)');
  const contacts = [...customers.map(row => mapContact(row, 'c-')), ...vendors.map(row => mapContact(row, 'v-'))];
  const names = new Map(contacts.map(c => [c.contactID, c.name]));

  emit({ step: 'fetch_invoices', message: 'Reading QuickBooks invoices...' });
  const invoices = (await queryAll(externalId, 'Invoice')).map(row => mapInvoice(row, names));

  emit({ step: 'fetch_bills', message: 'Reading QuickBooks bills and their attachments...' });
  const billRows = await queryAll(externalId, 'Bill');
  const billsWithFiles = await fetchBillIdsWithFiles(externalId);
  const bills = billRows.map(row => mapBill(row, names, billsWithFiles));

  emit({ step: 'fetch_credits', message: 'Reading QuickBooks credit notes and supplier credits...' });
  const creditMemos = (await queryAll(externalId, 'CreditMemo')).map(row => mapCreditMemo(row, names));
  const vendorCredits = (await queryAll(externalId, 'VendorCredit')).map(row => mapVendorCredit(row, names));

  return { invoices, bills, credits: [...creditMemos, ...vendorCredits], contacts };
}

module.exports = {
  ledger, isConfigured, buildConsentUrl, completeConnection, fetchCompanyInfo, fetchDocuments,
  // for tests
  queryAll, mapInvoice, mapBill, mapCreditMemo, mapVendorCredit, mapContact, documentStatus,
};
