const { listBankLines, eachBankLinePage, bankLineAccountSummary } = require('../db/bankLines');

const PAGE_SIZE = 200;
const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

// Query string -> filter object. Anything unrecognised is dropped rather than passed to SQL.
function parseBankLineFilters(query = {}) {
  const filters = {};
  if (isDay(query.from)) filters.from = query.from;
  if (isDay(query.to)) filters.to = query.to;
  if (typeof query.account === 'string' && query.account.trim()) filters.accountCode = query.account.trim().slice(0, 32);
  if (['yes', 'no'].includes(query.reconciled)) filters.reconciled = query.reconciled;
  if (typeof query.search === 'string' && query.search.trim()) filters.search = query.search.trim().slice(0, 100);
  return filters;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  // Leading = + - @ would be run as a formula by Excel; contact names and descriptions are free text.
  const safe = /^[=+@]/.test(text) || (/^-/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const CSV_HEADER = ['Client', 'Date', 'Type', 'Status', 'Reconciled', 'Contact', 'Reference', 'Bank account',
  'Account code', 'Account name', 'Account type', 'Description', 'Tax type', 'Net', 'Tax', 'Gross', 'Currency',
  'Xero ID'];

async function sendBankLinesCsv(res, filters, filename) {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` });
  res.write('﻿' + CSV_HEADER.join(',') + '\r\n');
  await eachBankLinePage(filters, 2000, rows => {
    res.write(rows.map(r => [
      r.client_name, r.txn_date, r.txn_type, r.status, r.is_reconciled ? 'Yes' : 'No', r.contact_name, r.reference,
      r.bank_account_name, r.account_code, r.account_name || (String(r.txn_type || '').includes('TRANSFER') ? 'Bank transfer' : ''),
      r.account_type, r.description, r.tax_type, r.net, r.tax, r.gross, r.currency, r.bank_transaction_id,
    ].map(csvCell).join(',')).join('\r\n') + '\r\n');
  });
  res.end();
}

async function bankLinesPageData(filters, page) {
  const current = Math.max(1, parseInt(page, 10) || 1);
  const { rows, total } = await listBankLines(filters, { limit: PAGE_SIZE, offset: (current - 1) * PAGE_SIZE });
  const accounts = await bankLineAccountSummary(filters);
  return { rows, total, accounts, page: current, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), pageSize: PAGE_SIZE };
}

module.exports = { parseBankLineFilters, sendBankLinesCsv, bankLinesPageData, csvCell };
