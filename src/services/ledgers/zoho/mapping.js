// Zoho Books accounting data (chart of accounts, tax rates, manual journals, bank accounts,
// uncategorised bank lines, expenses and the line items of invoices and bills) turned into the
// shapes the Xero checks already read (xero-node's camelCase: accountID, code, type, _class,
// journalLines[].lineAmount, lineItems[].taxType ...), so the checks can reuse the Xero logic for
// Zoho clients. Pure functions only: nothing here calls Zoho. The fields each shape carries are
// listed in docs/zoho-data-contract.md, which the checks are written against.
//
// Field names checked against Zoho's API docs (https://www.zoho.com/books/api/v3/: chart-of-accounts,
// journals, taxes, bank-accounts, bank-transactions, expenses, invoices, bills) and against real
// answers read on 24 Nov 2026.

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

function idOrNull(value) {
  return value == null || value === '' ? null : String(value);
}

function textOrNull(value) {
  const text = value == null ? '' : String(value).trim();
  return text || null;
}

// Zoho times carry an offset ("2026-11-23T13:36:57+0400"); Xero's updatedDateUTC is UTC ISO text.
// The cache dates its rows from updatedDateUTC, and the "changed after filing" checks compare it.
function isoUtc(value) {
  if (!value) return null;
  const text = String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = new Date(text).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// Xero's currencyRate is units of the document's currency per one unit of the organisation's;
// Zoho's exchange_rate is the other way round (see currencyRateFrom in index.js).
function currencyRateFrom(exchangeRate) {
  if (exchangeRate == null || exchangeRate === '') return null;
  const rate = Number(exchangeRate);
  return Number.isFinite(rate) && rate > 0 ? 1 / rate : null;
}

// What decides whether a document's detail must be read again. Zoho's last_modified_time changes on
// every edit, so an unchanged one means the cached lines are still right. A row without it (the docs
// show it on every list, but just in case) falls back to the figures the list does carry: weaker,
// because an edit that only moves a line to another account would not change them.
function changeKey(raw) {
  if (!raw) return null;
  if (raw.last_modified_time) return `t:${raw.last_modified_time}`;
  const parts = [raw.total, raw.bcy_total, raw.date || raw.journal_date, raw.status, raw.currency_code];
  if (parts.every(part => part == null || part === '')) return null;
  return `f:${parts.map(part => (part == null ? '' : String(part))).join('|')}`;
}

// ---------------------------------------------------------------------------------------------
// Chart of accounts.
//
// Zoho account_type -> Xero Type and Class. Xero's types: BANK, CURRENT, FIXED, INVENTORY,
// NONCURRENT, PREPAYMENT (assets); CURRLIAB, LIABILITY, TERMLIAB (liabilities); EQUITY; REVENUE,
// SALES, OTHERINCOME (revenue); EXPENSE, OVERHEADS, DIRECTCOSTS, DEPRECIATN (expenses).
//   Zoho                       Xero type     Class      Why
//   bank                       BANK          ASSET      a bank account
//   cash                       BANK          ASSET      petty cash sits on Zoho's banking page; Xero keeps petty
//                                                      cash as a BANK account too. The system Undeposited Funds
//                                                      account is CURRENT instead (see isUndepositedFunds)
//   credit_card                BANK          ASSET      Xero keeps credit cards as BANK (bankAccountType CREDITCARD)
//   payment_clearing           CURRENT       ASSET      a clearing account, not a bank
//   accounts_receivable        CURRENT       ASSET      systemAccount DEBTORS
//   other_current_asset        CURRENT       ASSET
//   input_tax                  CURRENT       ASSET      VAT reclaimable
//   stock / inventory          INVENTORY     ASSET
//   fixed_asset                FIXED         ASSET
//   other_asset / non_current_asset / intangible_asset / right_to_use_asset / deferred_tax_asset
//                              NONCURRENT    ASSET
//   accounts_payable           CURRLIAB      LIABILITY  systemAccount CREDITORS
//   other_current_liability    CURRLIAB      LIABILITY
//   output_tax / overseas_tax_payable / tax_payable
//                              CURRLIAB      LIABILITY
//   other_liability / non_current_liability / deferred_tax_liability / loans_and_borrowing
//                              LIABILITY     LIABILITY  Xero's LIABILITY is the non-current kind
//   long_term_liability        TERMLIAB      LIABILITY
//   equity                     EQUITY        EQUITY
//   income                     REVENUE       REVENUE
//   other_income               OTHERINCOME   REVENUE
//   cost_of_goods_sold         DIRECTCOSTS   EXPENSE
//   expense / other_expense    EXPENSE       EXPENSE
// A type not in the table is placed by its name (…asset / …liability / …income / …expense) and
// otherwise left with type and _class null; zohoAccountType always keeps Zoho's own value.
const ACCOUNT_TYPE_MAP = Object.freeze({
  bank: { type: 'BANK', _class: 'ASSET', bankAccountType: 'BANK' },
  cash: { type: 'BANK', _class: 'ASSET', bankAccountType: 'BANK' },
  credit_card: { type: 'BANK', _class: 'ASSET', bankAccountType: 'CREDITCARD' },
  payment_clearing: { type: 'CURRENT', _class: 'ASSET' },
  accounts_receivable: { type: 'CURRENT', _class: 'ASSET' },
  other_current_asset: { type: 'CURRENT', _class: 'ASSET' },
  input_tax: { type: 'CURRENT', _class: 'ASSET' },
  stock: { type: 'INVENTORY', _class: 'ASSET' },
  inventory: { type: 'INVENTORY', _class: 'ASSET' },
  fixed_asset: { type: 'FIXED', _class: 'ASSET' },
  other_asset: { type: 'NONCURRENT', _class: 'ASSET' },
  non_current_asset: { type: 'NONCURRENT', _class: 'ASSET' },
  intangible_asset: { type: 'NONCURRENT', _class: 'ASSET' },
  right_to_use_asset: { type: 'NONCURRENT', _class: 'ASSET' },
  deferred_tax_asset: { type: 'NONCURRENT', _class: 'ASSET' },
  accounts_payable: { type: 'CURRLIAB', _class: 'LIABILITY' },
  other_current_liability: { type: 'CURRLIAB', _class: 'LIABILITY' },
  output_tax: { type: 'CURRLIAB', _class: 'LIABILITY' },
  overseas_tax_payable: { type: 'CURRLIAB', _class: 'LIABILITY' },
  tax_payable: { type: 'CURRLIAB', _class: 'LIABILITY' },
  other_liability: { type: 'LIABILITY', _class: 'LIABILITY' },
  non_current_liability: { type: 'LIABILITY', _class: 'LIABILITY' },
  deferred_tax_liability: { type: 'LIABILITY', _class: 'LIABILITY' },
  loans_and_borrowing: { type: 'LIABILITY', _class: 'LIABILITY' },
  long_term_liability: { type: 'TERMLIAB', _class: 'LIABILITY' },
  equity: { type: 'EQUITY', _class: 'EQUITY' },
  income: { type: 'REVENUE', _class: 'REVENUE' },
  other_income: { type: 'OTHERINCOME', _class: 'REVENUE' },
  cost_of_goods_sold: { type: 'DIRECTCOSTS', _class: 'EXPENSE' },
  expense: { type: 'EXPENSE', _class: 'EXPENSE' },
  other_expense: { type: 'EXPENSE', _class: 'EXPENSE' },
});

function accountTypeOf(zohoType) {
  const key = String(zohoType || '').trim().toLowerCase();
  if (ACCOUNT_TYPE_MAP[key]) return ACCOUNT_TYPE_MAP[key];
  if (/liabilit/.test(key)) return { type: 'LIABILITY', _class: 'LIABILITY' };
  if (/asset/.test(key)) return { type: 'CURRENT', _class: 'ASSET' };
  if (/income/.test(key)) return { type: 'OTHERINCOME', _class: 'REVENUE' };
  if (/expense/.test(key)) return { type: 'EXPENSE', _class: 'EXPENSE' };
  return { type: null, _class: null };
}

// Xero's systemAccount marks the control accounts the checks look for. Only the ones Zoho marks
// unambiguously are set: its own (is_system_account) receivable, payable and retained earnings
// accounts. VAT accounts are left to the checks' own name test (journalChecks.isVatControl), because
// Zoho splits VAT over Input VAT, Output VAT and VAT Payable where Xero has one control account.
function systemAccountOf(account, zohoType) {
  if (!account.is_system_account) return null;
  if (zohoType === 'accounts_receivable') return 'DEBTORS';
  if (zohoType === 'accounts_payable') return 'CREDITORS';
  if (zohoType === 'equity' && /retained earnings/i.test(String(account.account_name || ''))) return 'RETAINEDEARNINGS';
  return null;
}

// Zoho files its system "Undeposited Funds" account under the cash type, but it is a clearing account for
// receipts not yet banked, not a bank: Xero keeps the same account as a current asset. Treated as a bank, every
// journal touching it was raised as a journal to a bank account and staff were asked to check it for bank lines.
const isUndepositedFunds = (account, zohoType) => zohoType === 'cash' && Boolean(account.is_system_account)
  && /undeposited funds/i.test(String(account.account_name || ''));

function mapAccount(account) {
  const zohoType = String(account.account_type || '').trim().toLowerCase() || null;
  const mapped = isUndepositedFunds(account, zohoType) ? { type: 'CURRENT', _class: 'ASSET' } : accountTypeOf(zohoType);
  return {
    accountID: String(account.account_id),
    // Zoho account codes are optional and often blank: join on accountID, not code.
    code: textOrNull(account.account_code),
    name: account.account_name || null,
    type: mapped.type,
    _class: mapped._class,
    status: account.is_active === false ? 'ARCHIVED' : 'ACTIVE',
    description: textOrNull(account.description),
    currencyCode: textOrNull(account.currency_code),
    systemAccount: systemAccountOf(account, zohoType),
    bankAccountType: mapped.bankAccountType || null,
    taxType: null, // Zoho's chart of accounts has no default tax rate per account
    hasAttachments: Boolean(account.has_attachment),
    updatedDateUTC: isoUtc(account.last_modified_time),
    zohoAccountType: zohoType,
    isSystemAccount: Boolean(account.is_system_account),
    parentAccountID: idOrNull(account.parent_account_id),
    depth: numberOrNull(account.depth),
    bank: null, // filled in from /bankaccounts by mergeBankAccounts when banking can be read
    // The account's current balance, only when the answer carries one (the chart list read with showbalance=true,
    // or GET /chartofaccounts/{id}); no field at all otherwise, so an account without it reads exactly as before.
    ...balanceField(account),
  };
}

// A money figure as Zoho may send it (a number, "1234.5" or "1,234.50"), or null.
function moneyOrNull(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

// An account's current balance from a chart-of-accounts answer. Zoho's documentation names closing_balance on
// GET /chartofaccounts/{id}; the list read with showbalance=true is not documented field by field, so the usual
// names are tried in turn. ASSUMED (to be confirmed on a live answer): the figure is on the account's normal side,
// as Zoho's Chart of Accounts page shows it, i.e. positive = a debit balance on an asset or expense account and a
// credit balance on a liability, equity or income account; negative = the other side. When Zoho also says which
// side (debit_or_credit / balance_type), that is used instead.
const BALANCE_FIELDS = ['closing_balance', 'current_balance', 'balance', 'account_balance'];
function balanceOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  for (const field of BALANCE_FIELDS) {
    const amount = moneyOrNull(raw[field]);
    if (amount == null) continue;
    const side = String(raw.debit_or_credit || raw.balance_type || '').trim().toLowerCase();
    return { amount: round2(amount), field, side: side === 'debit' || side === 'credit' ? side : null };
  }
  return null;
}
function balanceField(raw) {
  const balance = balanceOf(raw);
  return balance ? { ledgerBalance: { ...balance, source: 'chart_list' } } : {};
}

// One row of GET /bankaccounts. balance is the account's balance in Zoho Books in the account's own
// currency, bcy_balance the same in the organisation's currency, bank_balance the balance the bank
// feed last reported (0 when no feed is connected, so it cannot tell "no feed" from a real zero:
// feedsActive says which, when Zoho gives it).
function mapBankDetails(bank) {
  return {
    accountType: textOrNull(bank.account_type),
    currencyCode: textOrNull(bank.currency_code),
    bookBalance: numberOrNull(bank.balance),
    bookBalanceBase: numberOrNull(bank.bcy_balance),
    bankBalance: numberOrNull(bank.bank_balance),
    uncategorizedCount: numberOrNull(bank.uncategorized_transactions),
    feedsActive: bank.is_feeds_active == null ? null : Boolean(bank.is_feeds_active),
    feedsLastRefreshDate: textOrNull(bank.feeds_last_refresh_date),
    accountNumber: textOrNull(bank.account_number),
    bankName: textOrNull(bank.bank_name),
    isActive: bank.is_active == null ? null : Boolean(bank.is_active),
  };
}

// Puts each bank account's details on its chart-of-accounts row (Xero keeps bank accounts in its
// Accounts list as type BANK, so the checks find them there). A bank account the chart did not give
// (the chart was not readable this time) is added as a row of its own.
function mergeBankAccounts(accounts, bankRows) {
  const byId = new Map(accounts.map(account => [account.accountID, account]));
  const out = accounts.map(account => ({ ...account, bank: null }));
  const outById = new Map(out.map(account => [account.accountID, account]));
  for (const bank of bankRows || []) {
    const id = idOrNull(bank.account_id);
    if (!id) continue;
    const details = mapBankDetails(bank);
    if (byId.has(id)) {
      outById.get(id).bank = details;
      continue;
    }
    const zohoType = String(bank.account_type || 'bank').toLowerCase();
    const mapped = accountTypeOf(zohoType);
    const row = {
      accountID: id, code: textOrNull(bank.account_code), name: bank.account_name || null,
      type: mapped.type, _class: mapped._class,
      status: bank.is_active === false ? 'ARCHIVED' : 'ACTIVE', description: textOrNull(bank.description),
      currencyCode: textOrNull(bank.currency_code), systemAccount: null,
      bankAccountType: mapped.bankAccountType || null, taxType: null, hasAttachments: false,
      updatedDateUTC: null, zohoAccountType: zohoType, isSystemAccount: false, parentAccountID: null, depth: null,
      bank: details,
    };
    out.push(row);
    outById.set(id, row);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tax rates (GET /settings/taxes). Xero keys a tax rate by its taxType; Zoho by tax_id, which is
// also what each line carries, so taxType here IS Zoho's tax_id and a line's taxType matches it.
function mapTaxRate(tax) {
  const percentage = numberOrNull(tax.tax_percentage);
  const inactive = tax.is_inactive === true || (tax.status && String(tax.status).toLowerCase() !== 'active');
  return {
    taxType: String(tax.tax_id),
    name: tax.tax_name || tax.tax_display_name || null,
    effectiveRate: percentage,
    displayTaxRate: percentage,
    status: inactive ? 'ARCHIVED' : 'ACTIVE',
    reportTaxType: null, // Zoho gives no return box per rate
    zohoTaxType: textOrNull(tax.tax_type), // tax, compound_tax or tax_group
    taxSpecificType: textOrNull(tax.tax_specific_type),
    taxAuthorityName: textOrNull(tax.tax_authority_name),
    countryCode: textOrNull(tax.country_code),
    isDefault: Boolean(tax.is_default_tax),
    updatedDateUTC: isoUtc(tax.last_modified_time),
  };
}

// ---------------------------------------------------------------------------------------------
// Line items. Xero's convention: lineAmount is the line's amount as entered (net of tax when the
// document's lineAmountTypes is Exclusive, gross when Inclusive), in the document's currency;
// taxType names the rate ('NONE' for no tax, as Xero writes it); taxAmount is the line's tax.
// Zoho gives the line's tax in line_item_taxes when it has it; otherwise it is worked out from the
// rate and marked taxAmountEstimated, since Zoho may round tax per document instead.
function lineTax(line, inclusive) {
  const taxes = Array.isArray(line.line_item_taxes) ? line.line_item_taxes : [];
  const listed = taxes.filter(tax => tax && tax.tax_amount != null && tax.tax_amount !== '');
  if (listed.length) return { taxAmount: round2(listed.reduce((sum, tax) => sum + number(tax.tax_amount), 0)), estimated: false };
  if (line.tax_amount != null && line.tax_amount !== '') return { taxAmount: round2(number(line.tax_amount)), estimated: false };
  const percentage = numberOrNull(line.tax_percentage);
  const amount = number(line.item_total != null ? line.item_total : line.amount);
  if (!percentage || !idOrNull(line.tax_id)) return { taxAmount: 0, estimated: false };
  const tax = inclusive ? amount * percentage / (100 + percentage) : amount * percentage / 100;
  return { taxAmount: round2(tax), estimated: true };
}

function mapDocumentLine(line, { inclusive = false } = {}) {
  const { taxAmount, estimated } = lineTax(line, inclusive);
  return {
    lineItemID: idOrNull(line.line_item_id),
    description: textOrNull(line.description) || textOrNull(line.name),
    quantity: numberOrNull(line.quantity),
    unitAmount: numberOrNull(line.rate),
    itemCode: textOrNull(line.sku) || textOrNull(line.item_code) || null,
    itemID: idOrNull(line.item_id),
    accountID: idOrNull(line.account_id),
    accountCode: textOrNull(line.account_code),
    accountName: textOrNull(line.account_name),
    taxType: idOrNull(line.tax_id) || 'NONE',
    taxName: textOrNull(line.tax_name),
    taxPercentage: numberOrNull(line.tax_percentage),
    taxAmount,
    taxAmountEstimated: estimated,
    lineAmount: round2(number(line.item_total != null ? line.item_total : line.amount)),
    isReverseCharge: Boolean(idOrNull(line.reverse_charge_tax_id)),
    // UAE VAT: a line with no tax_id may be exempt or out of scope on purpose (tax_exemption_id/code,
    // or the treatment code), which is not the same as a missing VAT rate. itc_eligibility says
    // whether the input VAT on a bill line may be recovered. Null when Zoho does not send them.
    taxExemptionID: idOrNull(line.tax_exemption_id),
    taxExemptionCode: textOrNull(line.tax_exemption_code),
    taxTreatmentCode: textOrNull(line.tax_treatment_code),
    itcEligibility: textOrNull(line.itc_eligibility),
  };
}

// The fields an invoice or bill gets from its one-document read, on top of what the list gives.
// Copied forward from the cache when the document has not changed (DETAIL_FIELDS).
function documentDetail(raw) {
  const inclusive = Boolean(raw.is_inclusive_tax);
  const lines = Array.isArray(raw.line_items) ? raw.line_items : [];
  return {
    lineItems: lines.map(line => mapDocumentLine(line, { inclusive })),
    lineAmountTypes: inclusive ? 'Inclusive' : 'Exclusive',
    subTotal: numberOrNull(raw.sub_total),
    totalTax: numberOrNull(raw.tax_total),
    // Discounts, adjustments and shipping are entered on the document in Zoho, not on a line, so they
    // are not in the lines; the checks that add lines up to the total need them.
    discountTotal: numberOrNull(raw.discount_total),
    adjustment: numberOrNull(raw.adjustment),
    shippingCharge: numberOrNull(raw.shipping_charge),
    isReverseChargeApplied: Boolean(raw.is_reverse_charge_applied),
    // UAE VAT treatment of the whole document (vat_registered, non_gcc, gcc_*, dz_*), the emirate
    // of supply, and the VAT return it was filed in (empty until filed). Read by the UAE checks.
    taxTreatment: textOrNull(raw.tax_treatment),
    placeOfSupply: textOrNull(raw.place_of_supply),
    filedInVatReturnID: idOrNull(raw.filed_in_vat_return_id),
    lineItemsRead: true,
    lineItemsStale: false,
    detailKey: changeKey(raw),
  };
}

const DETAIL_FIELDS = ['lineItems', 'lineAmountTypes', 'subTotal', 'totalTax', 'discountTotal', 'adjustment',
  'shippingCharge', 'isReverseChargeApplied', 'taxTreatment', 'placeOfSupply', 'filedInVatReturnID',
  'lineItemsRead', 'lineItemsStale', 'detailKey'];

// ---------------------------------------------------------------------------------------------
// Manual journals (GET /journals and /journals/{id}). Xero's manual journal lines carry a signed
// lineAmount, debit positive and credit negative, in the organisation's currency (Xero manual
// journals have no other currency). Zoho journals can be in another currency, so lineAmount is
// bcy_amount (the organisation's currency) and amountInCurrency keeps the journal currency's figure.
const JOURNAL_STATUS_MAP = { draft: 'DRAFT', pending_approval: 'DRAFT', approved: 'POSTED', published: 'POSTED', void: 'VOIDED' };

function journalStatus(status) {
  const key = String(status || '').toLowerCase();
  return JOURNAL_STATUS_MAP[key] || (key ? 'POSTED' : null);
}

function mapJournalLine(line) {
  const credit = String(line.debit_or_credit || '').toLowerCase() === 'credit';
  const sign = credit ? -1 : 1;
  const base = line.bcy_amount != null && line.bcy_amount !== '' ? number(line.bcy_amount) : number(line.amount);
  const { taxAmount, estimated } = lineTax({ ...line, item_total: base }, false);
  return {
    lineID: idOrNull(line.line_id),
    accountID: idOrNull(line.account_id),
    accountCode: textOrNull(line.account_code),
    accountName: textOrNull(line.account_name),
    zohoAccountType: textOrNull(line.selected_account?.account_type),
    description: textOrNull(line.description),
    lineAmount: round2(sign * Math.abs(base)),
    amountInCurrency: round2(sign * Math.abs(number(line.amount))),
    debitOrCredit: credit ? 'credit' : 'debit',
    taxType: idOrNull(line.tax_id) || 'NONE',
    taxName: textOrNull(line.tax_name),
    taxPercentage: numberOrNull(line.tax_percentage),
    // The line's tax in the organisation's currency, signed like the line (Xero's convention).
    taxAmount: round2(sign * Math.abs(taxAmount)),
    taxAmountEstimated: estimated,
    taxExemptionID: idOrNull(line.tax_exemption_id), // UAE: exempt or out of scope on purpose
    contact: idOrNull(line.customer_id) ? { contactID: String(line.customer_id), name: line.customer_name || null } : null,
  };
}

// raw: a list row (no lines) or the one-journal answer (with line_items).
function mapManualJournal(raw) {
  const hasLines = Array.isArray(raw.line_items);
  return {
    manualJournalID: String(raw.journal_id),
    entryNumber: textOrNull(raw.entry_number),
    reference: textOrNull(raw.reference_number),
    narration: textOrNull(raw.notes) || textOrNull(raw.reference_number) || textOrNull(raw.entry_number),
    date: dateOnly(raw.journal_date),
    status: journalStatus(raw.status),
    zohoStatus: textOrNull(raw.status),
    journalType: textOrNull(raw.journal_type), // both, cash or accrual
    lineAmountTypes: 'Exclusive',
    currencyCode: textOrNull(raw.currency_code),
    currencyRate: currencyRateFrom(raw.exchange_rate),
    total: numberOrNull(raw.total),
    totalBase: numberOrNull(raw.bcy_total),
    hasAttachments: Array.isArray(raw.documents) ? raw.documents.length > 0 : false,
    updatedDateUTC: isoUtc(raw.last_modified_time),
    createdDateUTC: isoUtc(raw.created_time),
    journalLines: hasLines ? raw.line_items.map(mapJournalLine) : [],
    linesRead: hasLines,
    linesStale: false,
    detailKey: hasLines ? changeKey(raw) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Bank. Zoho's uncategorised transactions are bank statement lines (from a feed or an imported
// statement) not yet matched or categorised: what Xero shows as unreconciled statement lines (which
// Xero's API does not give, hence the browser extension). They go in the bank_transaction cache next
// to the expenses, but with status 'UNCATEGORISED' and isStatementLine true, so any Xero logic that
// keeps status AUTHORISED never mistakes them for recorded transactions.
// Uncategorised lines come as deposit or withdrawal; anything else falls back to debit_or_credit,
// which on a bank line is from the bank account's side (debit = money in), then to the sign.
function bankLineType(raw) {
  const type = String(raw.transaction_type || '').toLowerCase();
  if (type === 'deposit') return 'RECEIVE';
  if (type === 'withdrawal') return 'SPEND';
  const side = String(raw.debit_or_credit || '').toLowerCase();
  if (side === 'debit') return 'RECEIVE';
  if (side === 'credit') return 'SPEND';
  return number(raw.amount) < 0 ? 'SPEND' : 'RECEIVE';
}

function mapUncategorisedLine(raw, account = {}) {
  return {
    bankTransactionID: `zbt-${raw.transaction_id}`,
    zohoTransactionID: String(raw.transaction_id),
    source: 'zoho_uncategorized',
    isStatementLine: true,
    type: bankLineType(raw),
    status: 'UNCATEGORISED',
    zohoStatus: textOrNull(raw.status) || 'uncategorized',
    isReconciled: false,
    date: dateOnly(raw.date),
    reference: textOrNull(raw.reference_number),
    description: textOrNull(raw.description),
    contact: { contactID: idOrNull(raw.customer_id), name: textOrNull(raw.payee) || textOrNull(raw.customer_name) },
    bankAccount: {
      accountID: idOrNull(raw.account_id) || idOrNull(account.account_id),
      name: textOrNull(raw.account_name) || textOrNull(account.account_name),
    },
    total: round2(Math.abs(number(raw.amount))),
    currencyCode: textOrNull(raw.currency_code) || textOrNull(account.currency_code),
    lineItems: [],
    updatedDateUTC: null,
  };
}

// One row of an account's transactions (GET /chartofaccounts/transactions?account_id=..., accountants.READ), for
// Unreconciled Bank. Zoho's documentation lists reconcile_status on each row; its values are not listed, so
// "unreconciled" / "not_reconciled" mean not reconciled, any other value naming "reconciled" means reconciled, and
// anything else (or no field) is "unknown" and never counted. On a bank account a debit is money in.
function reconcileStateOf(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!text) return 'unknown';
  if (/^(un|not_?|non_?)reconciled$/.test(text)) return 'unreconciled';
  if (/reconciled/.test(text)) return 'reconciled';
  return 'unknown';
}
// amountInBaseCurrency: true when the amount came from Zoho's bcy_ (base currency) fields, so a row on a foreign
// currency account is already in the organisation's currency; false when only the account-currency fields were there.
function mapAccountTransaction(raw, account = {}) {
  const debit = moneyOrNull(raw.bcy_debit != null ? raw.bcy_debit : raw.debit_amount) || 0;
  const credit = moneyOrNull(raw.bcy_credit != null ? raw.bcy_credit : raw.credit_amount) || 0;
  let signed = debit - credit;
  let amountInBaseCurrency = raw.bcy_debit != null || raw.bcy_credit != null;
  if (!debit && !credit) {
    const amount = moneyOrNull(raw.bcy_amount != null ? raw.bcy_amount : raw.amount) || 0;
    signed = String(raw.debit_or_credit || '').toLowerCase() === 'credit' ? -Math.abs(amount) : Math.abs(amount);
    amountInBaseCurrency = raw.bcy_amount != null;
  }
  return {
    transactionID: idOrNull(raw.categorized_transaction_id) || idOrNull(raw.transaction_id) || idOrNull(raw.entity_id),
    date: dateOnly(raw.transaction_date || raw.date),
    transactionType: textOrNull(raw.transaction_type),
    reconcileStatus: textOrNull(raw.reconcile_status || raw.reconciliation_status),
    reconcileState: reconcileStateOf(raw.reconcile_status || raw.reconciliation_status),
    reference: textOrNull(raw.reference_number),
    entryNumber: textOrNull(raw.entry_number) || textOrNull(raw.transaction_number),
    description: textOrNull(raw.description),
    payee: textOrNull(raw.payee) || textOrNull(raw.contact_name) || textOrNull(raw.customer_name) || textOrNull(raw.vendor_name),
    offsetAccountName: textOrNull(raw.offset_account_name),
    accountID: idOrNull(raw.account_id) || idOrNull(account.accountID),
    accountName: textOrNull(raw.account_name) || textOrNull(account.name),
    amount: round2(signed),
    amountInBaseCurrency,
    currencyCode: textOrNull(raw.currency_code),
  };
}

// A categorised bank deposit (GET /banktransactions?filter_by=Status.Categorized, banking.READ) of a type that
// puts money straight to income: sales_without_invoices, other_income, or a plain deposit. Kept in the
// bank_transaction cache with Xero's RECEIVE shape, for Invoice or Direct. The income account is given only as
// offset_account_id / offset_account_name when Zoho sends them; otherwise the transaction type says it is income.
const INCOME_RECEIPT_TYPES = new Set(['deposit', 'sales_without_invoices', 'other_income']);
function mapCategorisedReceipt(raw, account = {}) {
  return {
    bankTransactionID: `zrc-${raw.transaction_id}`,
    zohoTransactionID: String(raw.transaction_id),
    source: 'zoho_categorized_receipt',
    isStatementLine: false,
    type: 'RECEIVE',
    status: 'AUTHORISED',
    zohoStatus: textOrNull(raw.status),
    zohoTransactionType: textOrNull(raw.transaction_type),
    isReconciled: null,
    date: dateOnly(raw.date),
    reference: textOrNull(raw.reference_number),
    description: textOrNull(raw.description),
    contact: { contactID: idOrNull(raw.customer_id), name: textOrNull(raw.customer_name) || textOrNull(raw.payee) },
    bankAccount: {
      accountID: idOrNull(raw.account_id) || idOrNull(account.accountID),
      name: textOrNull(raw.account_name) || textOrNull(account.name),
    },
    offsetAccountID: idOrNull(raw.offset_account_id),
    offsetAccountName: textOrNull(raw.offset_account_name),
    // In the account's own currency, as the invoice it may match is in its own (Invoice or Direct compares the two).
    total: round2(Math.abs(number(raw.amount))),
    currencyCode: textOrNull(raw.currency_code) || textOrNull(account.currencyCode),
    lineItems: [],
    updatedDateUTC: null,
  };
}

// Expenses (GET /expenses, /expenses/{id}). Xero's nearest shape is a "spend money" bank transaction:
// money paid out of a bank, card or cash account (paid_through_account) straight to an expense account.
// Zoho does not say whether an expense is matched to a bank statement line, so isReconciled is null.
function expenseLines(raw) {
  const inclusive = Boolean(raw.is_inclusive_tax);
  if (Array.isArray(raw.line_items) && raw.line_items.length) {
    return raw.line_items.map(line => mapDocumentLine({ ...line, item_total: line.item_total != null ? line.item_total : line.amount }, { inclusive }));
  }
  // A one-line expense: the account and tax are on the expense itself.
  return [mapDocumentLine({
    line_item_id: raw.expense_id, description: raw.description, account_id: raw.account_id,
    account_code: raw.account_code, account_name: raw.account_name, tax_id: raw.tax_id, tax_name: raw.tax_name,
    tax_percentage: raw.tax_percentage, tax_amount: raw.tax_amount,
    item_total: raw.amount != null ? raw.amount : (raw.sub_total != null ? raw.sub_total : raw.total),
  }, { inclusive })];
}

// detail: raw is the one-expense answer (account, tax and lines), not a list row.
function mapExpense(raw, { detail = false } = {}) {
  const hasDetail = Boolean(detail);
  const inclusive = Boolean(raw.is_inclusive_tax);
  return {
    bankTransactionID: `exp-${raw.expense_id}`,
    zohoExpenseID: String(raw.expense_id),
    source: 'zoho_expense',
    isStatementLine: false,
    type: 'SPEND',
    // Zoho's expense statuses (unbilled, invoiced, reimbursed, non-billable) are about re-billing a
    // customer, not about whether it is posted: every expense is posted.
    status: 'AUTHORISED',
    zohoStatus: textOrNull(raw.status),
    isReconciled: null,
    date: dateOnly(raw.date),
    reference: textOrNull(raw.reference_number),
    description: textOrNull(raw.description),
    contact: { contactID: idOrNull(raw.vendor_id), name: textOrNull(raw.vendor_name) },
    customer: idOrNull(raw.customer_id) ? { contactID: String(raw.customer_id), name: textOrNull(raw.customer_name) } : null,
    bankAccount: { accountID: idOrNull(raw.paid_through_account_id), name: textOrNull(raw.paid_through_account_name) },
    accountName: textOrNull(raw.account_name), // the expense account, as the list names it
    total: numberOrNull(raw.total),
    totalBase: numberOrNull(raw.bcy_total),
    subTotal: numberOrNull(raw.sub_total != null ? raw.sub_total : raw.total_without_tax),
    totalTax: numberOrNull(raw.tax_amount),
    lineAmountTypes: inclusive ? 'Inclusive' : 'Exclusive',
    currencyCode: textOrNull(raw.currency_code),
    currencyRate: currencyRateFrom(raw.exchange_rate),
    isBillable: Boolean(raw.is_billable),
    hasAttachments: Boolean(raw.has_attachment) || Boolean(textOrNull(raw.expense_receipt_name))
      || (Array.isArray(raw.documents) && raw.documents.length > 0),
    updatedDateUTC: isoUtc(raw.last_modified_time),
    lineItems: hasDetail ? expenseLines(raw) : [],
    lineItemsRead: hasDetail,
    lineItemsStale: false,
    detailKey: hasDetail ? changeKey(raw) : null,
  };
}

const EXPENSE_DETAIL_FIELDS = ['lineItems', 'lineItemsRead', 'lineItemsStale', 'detailKey', 'bankAccount', 'totalTax',
  'subTotal', 'lineAmountTypes', 'hasAttachments'];

// ---------------------------------------------------------------------------------------------
// The organisation's tax profile, from GET /organizations/{id}. Zoho leaves country_code empty on a
// UAE organisation, so the checks tell a UAE client by its currency (AED), its tax rates (country AE,
// authority FTA) or the "TRN" label here. Booleans stay null when Zoho does not say, so "not known" is
// never read as "not registered".
function flagOrNull(value) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}
function taxProfileOf(organization) {
  const org = organization || {};
  const tax = org.tax_settings || {};
  return {
    currencyCode: textOrNull(org.currency_code),
    countryCode: textOrNull(org.country_code),
    isTaxRegistered: flagOrNull(tax.is_tax_registered),
    taxRegNo: textOrNull(tax.tax_reg_no),
    taxRegNoLabel: textOrNull(tax.tax_reg_no_label),
    taxRegisteredDate: dateOnly(tax.tax_registered_date),
    taxReturnStartDate: dateOnly(tax.tax_return_start_date),
    internationalTradeEnabled: flagOrNull(tax.international_trade_enabled),
    isFreeZone: flagOrNull(org.is_free_zone),
    isDesignatedZone: flagOrNull(org.is_designated_zone),
    fiscalYearStartMonth: numberOrNull(org.fiscal_year_start_month),
  };
}

module.exports = {
  taxProfileOf,
  ACCOUNT_TYPE_MAP, JOURNAL_STATUS_MAP, DETAIL_FIELDS, EXPENSE_DETAIL_FIELDS,
  accountTypeOf, mapAccount, mapBankDetails, mergeBankAccounts, mapTaxRate,
  mapDocumentLine, documentDetail, mapJournalLine, mapManualJournal, journalStatus,
  mapUncategorisedLine, mapExpense, changeKey, isoUtc, currencyRateFrom,
  balanceOf, reconcileStateOf, mapAccountTransaction, mapCategorisedReceipt, INCOME_RECEIPT_TYPES,
};
