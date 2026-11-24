# Zoho Books data contract (what the checks get)

For Zoho clients (`akrio_organisations.freeagent_company_id = 'zoho-<organization_id>'`) the sync
(`src/services/ledgerSync.js`) reads Zoho's data through `src/services/ledgers/zoho/` and hands it to
`runLedgerChecks` in the Xero shapes (xero-node camelCase), so Xero check logic can be reused.
Mapping code: `zoho/mapping.js`; reading: `zoho/accounting.js` and `zoho/index.js`.

`runLedgerChecks` receives, as well as `invoices`, `contacts`, `credits` (unchanged):

```
accounting: {
  accounts:         [Account]          // cache type 'account'
  taxRates:         [TaxRate]          // cache type 'tax_rate'
  manualJournals:   [ManualJournal]    // cache type 'manual_journal'
  bankTransactions: [BankLine | Expense]  // cache type 'bank_transaction'
  readStatus:       ReadStatus | null  // cache type 'organisation', organisationID 'zoho-<id>'
}
```
`accounting` is `null` for QuickBooks. A cache-only run gives the same data from the cache.
A section Zoho could not read this time keeps its last cached copy (see `readStatus.sections`).

## General rules

- **Join on `accountID`, not `code`.** Zoho account codes are optional and usually blank (`code: null`).
  Lines carry `accountID` (and `accountCode` only when Zoho gives one). Xero helpers that index by
  `code` (e.g. `journalChecks.indexAccounts`) need an index by `accountID` instead.
- **Tax rate key:** a line's `taxType` is Zoho's `tax_id` (`'NONE'` for no tax, Xero's word), and it
  matches `TaxRate.taxType`. There is no `reportTaxType` (Zoho gives no return box per rate).
- **Currency:** documents (invoices, bills, expenses) keep amounts in the document's currency with
  `currencyCode` and `currencyRate` in Xero's convention (document units per one base unit; convert with
  `checkRules.amountInBase`). Manual journal `lineAmount` is already in the organisation's currency.
- **Dates:** `date` is `YYYY-MM-DD`; `updatedDateUTC` is UTC ISO text (from Zoho's `last_modified_time`).
- **Lines may be missing or stale:** detail reads are capped per sync (`ZOHO_MAX_DETAIL_READS`, default 400) and
  per day: they never use more than the organisation's daily allowance (`ZOHO_DAILY_CALL_ALLOWANCE`, default 1,000,
  Zoho's Free plan) less a reserve kept for the compulsory document lists (`ZOHO_DAILY_CALL_RESERVE`, default 200),
  counted in memory by `client.callsToday` (a restart forgets the day's count). Check `lineItemsRead` /
  `linesRead` (false = no lines yet) and `lineItemsStale` / `linesStale` (true = lines from an earlier
  version of the document; read again next sync).

## Account (`account`, id `accountID`)

| field | meaning |
|---|---|
| accountID | Zoho account_id |
| code | account_code, or null when blank |
| name | account_name |
| type | Xero type (table below); null if unknown |
| _class | ASSET, LIABILITY, EQUITY, REVENUE, EXPENSE; null if unknown |
| status | ACTIVE / ARCHIVED (inactive in Zoho) |
| systemAccount | DEBTORS (Zoho's own receivable), CREDITORS (own payable), RETAINEDEARNINGS, else null. VAT accounts are NOT marked (Zoho has Input VAT, Output VAT and VAT Payable; use names) |
| bankAccountType | BANK or CREDITCARD for type BANK, else null |
| currencyCode, description, hasAttachments, updatedDateUTC | as named |
| taxType | always null (Zoho accounts have no default tax) |
| zohoAccountType | Zoho's own account_type, always kept |
| isSystemAccount, parentAccountID, depth | from Zoho |
| bank | null, or bank details from `/bankaccounts` (below) |
| ledgerBalance | only when Zoho gave one: `{ amount, field, side (debit/credit/null), source ('chart_list' from showbalance=true, or 'account_detail' from GET /chartofaccounts/{id}), readAt, stale? }`. ASSUMED: amount is on the account's normal side (positive = debit on an asset, credit on a liability/equity), unless `side` says. Read for every account when the list carries it, else only for suspense/clearing/director/shareholder/related-party accounts (uaeRules.isBalanceCheckAccount) |
| reconciliation | bank and card accounts only (not cash), from GET /chartofaccounts/transactions (else /chartofaccounts/accounttransactions) for the review period: `{ readAt, from, to, complete, rows, reconciled, unknown, matched, unreconciled: [{ transactionID, date, transactionType, reconcileStatus, reconcileState, reference, entryNumber, description, payee, offsetAccountName (kept for reference, never shown: on an expense with VAT it is the tax account), accountID, accountName, amount (signed, debit = money in), direction ('in' / 'out', from the sign), contactID (customer_id, else vendor_id, else contact_id: the contact's name is looked up when there is no payee), statementLinked (ASSUMED, not yet seen live: imported_transaction_id not blank or 0, or transaction_status / status "matched"; such rows are left out of Unreconciled Bank), transactionStatus, amountInBaseCurrency, currencyCode }], stale? }`. `matched` counts the unreconciled rows with statementLinked. Rows cached before these fields have no direction, contactID or statementLinked: direction comes from the sign and the row counts as unmatched. The read status's `reconciliation` section carries the same `matched` total over all accounts. |

`bank`: `{ accountType ('bank'|'credit_card'|...), currencyCode, bookBalance (balance in Zoho Books,
account currency), bookBalanceBase (bcy_balance), bankBalance (feed balance; 0 when no feed, so check
feedsActive), uncategorizedCount, feedsActive (null if Zoho does not say), feedsLastRefreshDate,
accountNumber, bankName, isActive, stale? }`. `stale: true` = carried from the last sync because banking
could not be read this time. When the connection does not allow banking, `bank` is null.

Zoho -> Xero type table:

| Zoho account_type | type | _class |
|---|---|---|
| bank, cash (except the system Undeposited Funds account, which is CURRENT: a clearing account, as in Xero) | BANK | ASSET |
| credit_card | BANK (bankAccountType CREDITCARD) | ASSET |
| accounts_receivable, other_current_asset, payment_clearing, input_tax | CURRENT | ASSET |
| stock, inventory | INVENTORY | ASSET |
| fixed_asset | FIXED | ASSET |
| other_asset, non_current_asset, intangible_asset, right_to_use_asset, deferred_tax_asset | NONCURRENT | ASSET |
| accounts_payable, other_current_liability, output_tax, overseas_tax_payable, tax_payable | CURRLIAB | LIABILITY |
| other_liability, non_current_liability, deferred_tax_liability, loans_and_borrowing | LIABILITY | LIABILITY |
| long_term_liability | TERMLIAB | LIABILITY |
| equity | EQUITY | EQUITY |
| income | REVENUE | REVENUE |
| other_income | OTHERINCOME | REVENUE |
| cost_of_goods_sold | DIRECTCOSTS | EXPENSE |
| expense, other_expense | EXPENSE | EXPENSE |
| anything else | by name (…liability -> LIABILITY, …asset -> CURRENT, …income -> OTHERINCOME, …expense -> EXPENSE), else null |

## TaxRate (`tax_rate`, id `taxType`)

`{ taxType (= Zoho tax_id), name, effectiveRate (percent, number), displayTaxRate, status (ACTIVE /
ARCHIVED), reportTaxType: null, zohoTaxType ('tax' | 'compound_tax' | 'tax_group'), taxSpecificType,
taxAuthorityName, countryCode, isDefault, updatedDateUTC }`

## ManualJournal (`manual_journal`, id `manualJournalID`)

`{ manualJournalID, entryNumber, reference, narration (notes, else reference, else entry number), date,
status (POSTED / DRAFT / VOIDED), zohoStatus, journalType ('both' | 'cash' | 'accrual'),
lineAmountTypes: 'Exclusive', currencyCode, currencyRate, total, totalBase, hasAttachments,
updatedDateUTC, createdDateUTC, journalLines: [JournalLine], linesRead, linesStale, detailKey }`

JournalLine: `{ lineID, accountID, accountCode (often null), accountName, zohoAccountType, description,
lineAmount (signed, organisation currency: debit +, credit -), amountInCurrency (signed, journal
currency), debitOrCredit, taxType ('NONE' if none), taxName, taxPercentage, taxAmount (signed like the
line, organisation currency), taxAmountEstimated (true = worked out from the rate, not given by Zoho),
contact ({contactID, name} | null) }`

## Invoice / bill line items (on the existing `invoice` rows)

Every invoice and bill row now also has:
`lineItems: [Line]`, `lineItemsRead`, `lineItemsStale`, `detailKey`, and, once read, `lineAmountTypes`
('Inclusive' | 'Exclusive'), `subTotal`, `totalTax`, `discountTotal`, `adjustment`, `shippingCharge`,
`isReverseChargeApplied`. Voided documents are never read (lineItems stays []). Opening-balance
documents (`isOpeningBalance`) carry the lines of their one-document read.

Line (also used for expenses): `{ lineItemID, description, quantity, unitAmount, itemCode, itemID,
accountID, accountCode (bills only, often null), accountName, taxType ('NONE' if none), taxName,
taxPercentage, taxAmount, taxAmountEstimated, lineAmount (as entered: gross if Inclusive, document
currency), isReverseCharge, taxExemptionID, taxExemptionCode, taxTreatmentCode, itcEligibility }`
(the last four are null when Zoho does not send them; UAE: exempt / out of scope on purpose, and whether input VAT
may be recovered). Documents also carry `taxTreatment` (vat_registered, non_gcc, gcc_*...), `placeOfSupply` (emirate)
and `filedInVatReturnID` once their detail is read. Document-level discounts, adjustments and shipping are not spread over the lines.

## Bank transactions (`bank_transaction`, id `bankTransactionID`)

Two kinds, told apart by `source`:

**BankLine** (`source: 'zoho_uncategorized'`, id `zbt-<transaction_id>`): a bank statement line not yet
categorised or matched in Zoho (Xero's "unreconciled statement line"). Only status uncategorised lines are
read. `{ zohoTransactionID, isStatementLine: true, type (RECEIVE | SPEND), status: 'UNCATEGORISED',
zohoStatus, isReconciled: false, date, reference, description, contact {contactID|null, name = payee},
bankAccount {accountID, name}, total (positive), currencyCode, lineItems: [] }`.
Status is deliberately not AUTHORISED so Xero logic filtering on AUTHORISED never takes these as posted.

**Expense** (`source: 'zoho_expense'`, id `exp-<expense_id>`): money paid out of a bank/card/cash account
straight to an expense account (Xero "spend money"). `{ zohoExpenseID, isStatementLine: false, type:
'SPEND', status: 'AUTHORISED', zohoStatus (unbilled/invoiced/reimbursed/nonbillable...), isReconciled:
null (Zoho does not say), date, reference, description, contact {vendor}, customer|null, bankAccount
{accountID (paid through; null until the detail is read), name}, accountName, total, totalBase, subTotal,
totalTax, lineAmountTypes, currencyCode, currencyRate, isBillable, hasAttachments, updatedDateUTC,
lineItems: [Line], lineItemsRead, lineItemsStale, detailKey }`.

**CategorisedReceipt** (`source: 'zoho_categorized_receipt'`, id `zrc-<transaction_id>`): a bank deposit
categorised straight to income (transaction_type sales_without_invoices, other_income or deposit), from
GET /banktransactions?filter_by=Status.Categorized (banking.READ), for the review period and the 3 months before
it. For Invoice or Direct. `{ zohoTransactionID, type: 'RECEIVE', status: 'AUTHORISED', zohoTransactionType, date,
reference, description, contact {customer}, bankAccount, offsetAccountID|null, offsetAccountName|null, total
(account currency), currencyCode, lineItems: [] }`.

## ReadStatus (`organisation`, id `organisationID` = `'zoho-<organization_id>'`)

```
{ organisationID, ledger: 'zoho', readAt,
  permissions: { banking: true|false|null, expenses: true|false|null },
  sections: { accounts, taxRates, manualJournals, banking, expenses: { read, reason?, error?, ... },
    balances: { read, source, candidates, withBalance, detailRead, stale },
    reconciliation: { read, from, to, accounts, complete, rows, unreconciled, unknown, path },
    categorisedReceipts: { read, from, to, accounts, rows, reason? } },
  lineItems: { read, carried, notRead, limit, used, capReached, dailyLimit, notReadAllSections, message? },
  detailReads: { limit, used, listCalls, capReached, dailyLimit, notRead } }
```
- `permissions.banking === false` / `permissions.expenses === false`: the connection was made before
  those scopes were asked for. Show "Reconnect Zoho to allow bank/expense access". Bank lines and
  expenses are then empty and `Account.bank` is null (nothing stale is kept).
- `null`: not tried this sync (daily limit reached earlier) — use the cached data, it may be old.
- `reason`: 'not_authorized', 'daily_limit' or 'error' (with `error` text).

## Not available from Zoho's API

- Trial balance, balance sheet, P&L, bank summary and other reports (Zoho has no report endpoints). Account
  balances are only the CURRENT ones (`Account.ledgerBalance`), never at a past date.
- The general ledger journal list (Xero's `journal` type) — only manual journals.
- Fixed asset register (scope not in Zoho's published list; not requested).
- Bank statement date (Zoho's banking page has none either).

## Tax profile (from `/organizations/{id}`, no extra call)

`fetchCompanyInfo` also returns `taxProfile: { currencyCode, countryCode, isTaxRegistered, taxRegNo, taxRegNoLabel,
taxRegisteredDate, taxReturnStartDate, internationalTradeEnabled, isFreeZone, isDesignatedZone, fiscalYearStartMonth }`
(flags null when Zoho does not say). ledgerSync passes it to `runLedgerChecks` as `taxProfile`; ledgerChecks keeps the
last copy and the client's region in `akrio_zoho_tax_profile` (created on first use, `src/db/zohoTaxProfile.js`) for
cache-only runs and the client page. The checks themselves are in `src/services/zohoChecks.js` (UAE rules:
`src/services/uaeRules.js`).
