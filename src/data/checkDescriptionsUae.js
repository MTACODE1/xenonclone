// Check wording for Zoho Books clients, laid over the Xero wording in checkDescriptions.js (which is left exactly
// as it is, so Xero clients see what they always saw).
//  - Every Zoho client: the checks that read Zoho data say "Zoho Books", not "Xero".
//  - A UAE company (region 'AE'): UAE wording, the FTA instead of HMRC, AED instead of £, and UAE names for the
//    three checks whose UAE version is a different test (VAT thresholds, shareholder balances, blocked VAT).
// Anything not listed here is the Xero wording with "Xero" read as "Zoho Books" (and, for the UAE, HMRC as the FTA
// and £ as AED), as the UAE rules spec asks.
const base = require('./checkDescriptions');

const ZOHO = {
  unreconciled_bank_items: {
    issue: "The following bank and card transactions recorded in Zoho Books in the review period are not reconciled. A transaction that Zoho marks as already matched to a line of an imported bank statement or bank feed is left out, even before the account is reconciled, as Zoho Books' Reconciliation Status report leaves it out of its unmatched transactions. Each row shows the bank account, the customer or vendor, Zoho's description and whether the money came in or went out. The figure shown is money in minus money out for each bank or card account, as that report gives it. The gross amount (money in plus money out) is given under it and is the value used for the score. Cash accounts are not included. Bank lines still waiting to be categorised in Zoho are listed under Unprocessed Bank.",
    soWhat: base.unreconciled_bank_items.soWhat.replace(/Xero/g, 'Zoho Books'),
    solution: "Reconcile each bank account in Zoho Books (Banking, then Reconcile) against the bank statement, and process each item listed.",
  },
  suspense_open_balance: {
    issue: "The following suspense or clearing accounts have a balance in Zoho Books. Zoho gives each account's current balance, not the balance at the end of the period, so the date each balance was read is shown.",
    soWhat: base.suspense_open_balance.soWhat,
    solution: base.suspense_open_balance.solution,
  },
  directors_loan_overdrawn: {
    issue: "The following director's loan accounts are overdrawn, meaning the director owes the company money. Zoho gives each account's current balance, not the balance at the end of the period, so the date each balance was read is shown.",
    soWhat: base.directors_loan_overdrawn.soWhat,
    solution: base.directors_loan_overdrawn.solution,
  },
  invoice_or_direct: {
    issue: "The following bank deposits were categorised in Zoho Books straight to income (sales without invoices, other income or a deposit), whereas it appears that they should have been recorded as a payment against an unpaid invoice instead.",
    soWhat: base.invoice_or_direct.soWhat,
    solution: base.invoice_or_direct.solution,
  },
  unprocessed_bank: {
    issue: "The following bank accounts have transactions in Zoho Books that are still Uncategorized (not yet matched or categorised).",
    soWhat: base.unprocessed_bank.soWhat,
    solution: "Open Banking in Zoho Books and match or categorise each uncategorised transaction.",
  },
  bank_balance: {
    issue: "The following bank accounts have a balance in Zoho Books that does not match the bank feed balance (\"Amount in Bank\"), or are overdrawn in the books.",
    soWhat: base.bank_balance.soWhat,
    solution: "Review the account in Zoho Books' Banking page and process outstanding items. An account with no bank feed cannot be compared and is not listed. An overdrawn bank account usually means a receipt has not been recorded or a payment was posted to the wrong account.",
  },
  bank_statements_review: {
    issue: "A reminder to check Zoho Books' Banking page for each bank, card and cash account. Zoho Books has not given Akrio access to banking data, so this always shows Review unless the bank data or the extension's reading of the Banking page shows no uncategorised transactions.",
    soWhat: "Uncategorised bank transactions mean the books do not yet reflect every bank transaction, which makes profit, VAT and balance sheet figures unreliable.",
    solution: "For each account listed, open Banking in Zoho Books and confirm it shows no Uncategorized transactions. Process any that remain.",
  },
  inactive_contacts: {
    issue: "The following contacts have had no recorded transaction activity in the last 24 months (or have never had any activity).",
    soWhat: "Uncluttering your contact list makes it easier for you to find the correct customer or supplier when carrying out your bookkeeping. Activity is taken from invoices, bills, credit notes, journals and, where Zoho allows it, expenses and bank lines, so a contact used only through banking may be listed until bank access is granted.",
    solution: "Review each of the following contacts. Mark contacts that are no longer likely to be used as Inactive in Zoho Books (rather than deleting them). Dismiss any contacts that you wish to keep.",
  },
  duplicate_contacts: {
    issue: "The following contacts look like they may have been created in Zoho Books more than once.",
    soWhat: base.duplicate_contacts.soWhat,
    solution: "Review each of the following contacts. Merge any contacts that have been created in error and mark the duplicate Inactive. Dismiss any items if you are sure that they have not been duplicated.",
  },
  low_cost_fixed_assets: {
    issue: "The following items have been given an account of type \"Fixed Asset\", but their net value is less than or equal to £2,000.",
    soWhat: base.low_cost_fixed_assets.soWhat,
    solution: base.low_cost_fixed_assets.solution,
  },
};

const UAE = {
  vat_scheme_threshold: {
    issue: "Rolling 12-month taxable supplies are close to, or have passed, a UAE VAT registration limit, or revenue for this or an earlier financial year is close to, or over, the Corporate Tax Small Business Relief limit.",
    soWhat: "A business whose taxable supplies and imports go over AED 375,000 in 12 months must register for VAT within 30 days. A registered business below AED 187,500 may have to deregister. Revenue above AED 3,000,000 in a tax period means Small Business Relief cannot be claimed for that tax period or any later one.",
    solution: "Review the turnover figure and the limit shown, then agree with the client whether a VAT registration, deregistration or Corporate Tax position needs to change.",
  },
  directors_loan_overdrawn: {
    issue: "Shareholder, partner or related-party accounts where the owner owes the company money. Zoho gives each account's current balance, not the balance at the end of the period, so the date each balance was read is shown.",
    soWhat: "Under UAE Corporate Tax, dealings with shareholders, directors and other connected persons must be at market value and on arm's-length terms, and may need to be disclosed with the Corporate Tax return. Unexplained balances can also hide personal spending or undeclared distributions.",
    solution: "Review each shareholder and related-party balance with the client in Zoho Books. Confirm it is a genuine loan on documented terms, clear it, or record the correct treatment before the Corporate Tax return is filed.",
  },
  dividend_status: {
    issue: "Not applicable to a UAE company.",
    soWhat: "The UK check is about drawing profits as dividends rather than through the director's loan account. In the UAE, dividends carry no withholding tax and need no tax filing.",
    solution: "No action needed.",
  },
  journal_vat_control: {
    issue: "The following manual journals post to a VAT account (Input VAT, Output VAT or VAT Payable), either directly or through a tax rate on a journal line.",
    soWhat: "VAT accounts should normally only move through VAT-coded invoices and bills and the VAT return settlement with the FTA. Manual journals can hide errors or put figures on the VAT return (VAT 201) that no tax invoice supports.",
    solution: base.journal_vat_control.solution,
  },
  sales_tax_missing: {
    issue: "The following sales lines have neither a VAT rate nor an exemption applied.",
    soWhat: "Every sale by a VAT-registered business should be standard-rated (5%), zero-rated or marked exempt / out of scope, so that it lands in the right box of the VAT return.",
    solution: "Review each of the following invoices. Apply the standard rate, the zero rate (for example on exports) or the right exemption in Zoho Books. Dismiss any items that do not need a change.",
  },
  purchase_tax_missing: {
    issue: "The following bill and expense lines have been posted to an expense or fixed asset account with neither a VAT rate nor an exemption applied.",
    soWhat: "Every purchase by a VAT-registered business should carry a VAT rate, an exemption or reverse charge, so that it lands in the right box of the VAT return. Without a VAT rate, recoverable input VAT may be missed. Payroll, visa and government fees, fines, depreciation, Corporate Tax, owner and loan movements are ignored.",
    solution: "Review each of the following bills and expenses. Apply the right VAT rate, exemption or reverse charge in Zoho Books. Dismiss any items that do not need a change.",
  },
  sales_tax_on_bills: {
    issue: "Not applicable to a UAE company.",
    soWhat: "Zoho Books UAE uses the same 5% and 0% VAT rates for sales and purchases, so there are no sales-only or purchase-only rates to compare.",
    solution: "No action needed. Purchase Tax Missing and Tax Review by Code cover the VAT on bills.",
  },
  purchase_tax_on_invoices: {
    issue: "Not applicable to a UAE company.",
    soWhat: "Zoho Books UAE uses the same 5% and 0% VAT rates for sales and purchases, so there are no sales-only or purchase-only rates to compare.",
    solution: "No action needed. Sales Tax Missing and Tax Review by Code cover the VAT on invoices.",
  },
  tax_review_by_code: {
    issue: "All transactions in the period grouped by VAT rate, exemption and reverse charge, for sales and purchases separately.",
    soWhat: "Reviewing totals per VAT treatment helps spot standard-rated, zero-rated, exempt or reverse-charge lines that should not have been used before the VAT return is filed with the FTA. Standard-rated sales are also split by emirate, as the VAT return asks.",
    solution: "Review each group and its total, and every group marked for review (no emirate on a 5% sale, zero rate to a UAE VAT-registered customer, reverse charge from a UAE VAT-registered supplier). Correct any wrong treatment in Zoho Books.",
  },
  low_cost_fixed_assets: {
    issue: "The following items have been given an account of type \"Fixed Asset\", but their net value is less than or equal to AED 10,000.",
    soWhat: base.low_cost_fixed_assets.soWhat,
    solution: base.low_cost_fixed_assets.solution,
  },
  motor_vehicle_expenses: {
    issue: "VAT has been claimed on motor vehicle or entertainment costs, or motor costs are posted for a client with no vehicle recorded.",
    soWhat: "In the UAE, input VAT cannot be recovered on a car that is available for personal use, or on entertainment provided to people who are not employees. Claiming it can lead to FTA penalties. Only 50% of client entertainment is deductible for Corporate Tax.",
    solution: "Check each line. Mark blocked VAT as non-recoverable in Zoho Books, or confirm that the vehicle is a truck or van with no personal use or that the cost was for staff.",
  },
  historical_changes: {
    issue: "Items dated in a VAT return period already filed with the FTA, or in a year whose accounts are already approved, but created or changed afterwards. Zoho Books' API does not give the filing or approval date, so this cannot be checked automatically yet.",
    soWhat: "Changing figures in a filed period means the filed return or approved accounts and the bookkeeping no longer agree. Changing a filed VAT period may need a voluntary disclosure to the FTA.",
    solution: "Lock filed periods in Zoho Books (Transaction Locking) and review any change made after a VAT return was filed.",
  },
  opening_balance_differences: {
    issue: "Net assets in the audited or signed financial statements do not match Zoho Books. Zoho Books' API gives no balance sheet, so this cannot be checked automatically yet.",
    soWhat: "The bookkeeping data as at the financial year end does not appear to match the approved financial statements (and the figures used in the Corporate Tax return). This means that the ongoing bookkeeping data may be inaccurate as a result.",
    solution: "Check that the year-end adjustments from the approved financial statements have been posted in Zoho Books, and that nothing was changed in that year after the statements were approved.",
  },
  undocumented_bills: {
    issue: "The following supplier bills, paid or unpaid, have no supporting document attached in Zoho Books.",
    soWhat: "Input VAT can only be recovered with a valid tax invoice, and records must be kept for at least 5 years (VAT) / 7 years (Corporate Tax).",
    solution: "Locate the original tax invoice for each bill and attach it in Zoho Books. Dismiss any items that do not require supporting documentation.",
  },
  inactive_contacts: {
    issue: ZOHO.inactive_contacts.issue,
    soWhat: `${ZOHO.inactive_contacts.soWhat} Keep the records: UAE law requires VAT records for at least 5 years and Corporate Tax records for 7 years, so mark contacts inactive rather than deleting them.`,
    solution: ZOHO.inactive_contacts.solution,
  },
  supplier_payment_accounts: {
    issue: "The following suppliers have been paid from both a bank account and a shareholder or related-party account in this period.",
    soWhat: "Paying the same supplier from different sources can mean business costs are being paid personally by a shareholder, which affects the related-party balance and its Corporate Tax treatment.",
    solution: "Review the payments for each supplier. Confirm whether the payments through the shareholder or related-party account are genuine and correctly recorded, and move any that are not.",
  },
};

// Check names that change for a UAE company (same slot, different test).
const UAE_LABELS = Object.freeze({
  vat_scheme_threshold: 'VAT & Corporate Tax Thresholds',
  directors_loan_overdrawn: 'Shareholder & Related Party Balances',
  motor_vehicle_expenses: 'Motor Vehicle & Entertainment VAT',
});

const asZoho = text => String(text).replace(/\bXero's\b/g, "Zoho Books'").replace(/\bXero\b/g, 'Zoho Books');
const asUae = text => asZoho(text).replace(/\bHMRC\b/g, 'the FTA (Federal Tax Authority)').replace(/£\s?/g, 'AED ');
const mapCopy = (copy, fn) => ({ issue: fn(copy.issue), soWhat: fn(copy.soWhat), solution: fn(copy.solution) });

// The descriptions a client's pages use. Only a Zoho client gets anything other than checkDescriptions.js itself.
function checkDescriptionsFor({ ledger = null, region = null } = {}) {
  if (ledger !== 'zoho') return base;
  const isUae = region === 'AE';
  const out = {};
  for (const [type, copy] of Object.entries(base)) out[type] = mapCopy(copy, isUae ? asUae : asZoho);
  Object.assign(out, ZOHO);
  if (isUae) Object.assign(out, UAE);
  return out;
}

function checkLabelFor(type, { ledger = null, region = null } = {}) {
  return ledger === 'zoho' && region === 'AE' ? UAE_LABELS[type] || null : null;
}

module.exports = { checkDescriptionsFor, checkLabelFor, UAE_LABELS, ZOHO_DESCRIPTIONS: ZOHO, UAE_DESCRIPTIONS: UAE };
