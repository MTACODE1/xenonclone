const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCompanyNumber, parseCompanyProfile, selectAccountsFiling,
  selectDocumentContentType, isTrustedDocumentUrl, fetchFiledNetAssets,
} = require('../src/services/companiesHouse');

test('company numbers are normalised to the 8-character register format', () => {
  assert.equal(normalizeCompanyNumber('12345678'), '12345678');
  assert.equal(normalizeCompanyNumber('123456'), '00123456');
  assert.equal(normalizeCompanyNumber(' 12 34 56 78 '), '12345678');
  assert.equal(normalizeCompanyNumber('SC123456'), 'SC123456');
  assert.equal(normalizeCompanyNumber('sc1234'), 'SC001234');
  assert.equal(normalizeCompanyNumber(''), null);
  assert.equal(normalizeCompanyNumber(null), null);
});

test('parseCompanyProfile extracts status, filing deadlines, and address', () => {
  const profile = parseCompanyProfile({
    company_name: 'ACME LTD',
    company_number: '12345678',
    company_status: 'active',
    type: 'ltd',
    date_of_creation: '2015-06-01',
    accounts: {
      next_due: '2026-09-30',
      last_accounts: { made_up_to: '2024-12-31' },
      next_accounts: { due_on: '2026-09-30', overdue: false },
    },
    confirmation_statement: {
      next_due: '2026-06-15',
      last_made_up_to: '2025-06-01',
      overdue: false,
    },
    sic_codes: ['62012'],
    registered_office_address: {
      address_line_1: '1 High Street', locality: 'London', postal_code: 'EC1A 1AA',
    },
  });
  assert.equal(profile.companyName, 'ACME LTD');
  assert.equal(profile.status, 'active');
  assert.equal(profile.accountsNextDue, '2026-09-30');
  assert.equal(profile.accountsLastMadeUpTo, '2024-12-31');
  assert.equal(profile.accountsOverdue, false);
  assert.equal(profile.confirmationNextDue, '2026-06-15');
  assert.deepEqual(profile.sicCodes, ['62012']);
  assert.equal(profile.registeredOffice, '1 High Street, London, EC1A 1AA');
});

test('overdue is derived from the due date when Companies House omits the flag', () => {
  const past = parseCompanyProfile({ accounts: { next_due: '2000-01-01' } });
  assert.equal(past.accountsOverdue, true);
  const future = parseCompanyProfile({ accounts: { next_due: '2999-01-01' } });
  assert.equal(future.accountsOverdue, false);
  const explicitBeatsDate = parseCompanyProfile({
    accounts: { next_due: '2000-01-01', overdue: false },
  });
  assert.equal(explicitBeatsDate.accountsOverdue, false);
});

// --- Filed accounts selection and extraction ---

const METADATA_URL = 'https://document-api.company-information.service.gov.uk/document/DOC1';

function accountsFiling(overrides = {}) {
  return {
    category: 'accounts',
    type: 'AA',
    transaction_id: 'txn-1',
    date: '2025-06-01',
    description: 'accounts-with-accounts-type-full',
    description_values: { made_up_date: '2024-12-31' },
    links: { document_metadata: METADATA_URL },
    ...overrides,
  };
}

test('the accounts filing for the exact balance-sheet date is selected', () => {
  const { filing } = selectAccountsFiling([
    accountsFiling({ transaction_id: 'older', description_values: { made_up_date: '2023-12-31' } }),
    accountsFiling({ transaction_id: 'target' }),
  ], '2024-12-31');
  assert.equal(filing.transactionId, 'target');
  assert.equal(filing.madeUpDate, '2024-12-31');
});

test('amended accounts supersede the original filing for the same made-up date', () => {
  const { filing } = selectAccountsFiling([
    accountsFiling({ transaction_id: 'original', date: '2025-06-01' }),
    accountsFiling({ transaction_id: 'amended', date: '2025-11-20' }),
  ], '2024-12-31');
  assert.equal(filing.transactionId, 'amended');
  assert.equal(filing.supersededCount, 1);
});

test('non-accounts filings and unrelated dates never supply a net-assets figure', () => {
  assert.equal(selectAccountsFiling([
    { category: 'confirmation-statement', type: 'CS01', links: {} },
    { category: 'officers', type: 'AP01', links: {} },
  ], '2024-12-31').reason, 'no_accounts_filing');

  const mismatch = selectAccountsFiling([
    accountsFiling({ description_values: { made_up_date: '2023-12-31' } }),
  ], '2024-12-31');
  assert.equal(mismatch.filing, null);
  assert.equal(mismatch.reason, 'no_accounts_filing_for_made_up_date');
  assert.deepEqual(mismatch.availableDates, ['2023-12-31']);

  // AA01 is a change of accounting reference date, not a set of accounts.
  assert.equal(selectAccountsFiling([
    { category: 'accounting-reference-date', type: 'AA01', links: {} },
  ], '2024-12-31').reason, 'no_accounts_filing');
});

test('a paper-filed set of accounts is reported as having no readable document', () => {
  const paper = selectAccountsFiling([
    accountsFiling({ links: {}, paper_filed: true }),
  ], '2024-12-31');
  assert.equal(paper.filing, null);
  assert.equal(paper.reason, 'paper_filed_no_document');
});

test('only machine-readable content types are requested; a PDF-only filing is not', () => {
  assert.equal(selectDocumentContentType({ resources: { 'application/xhtml+xml': {} } }), 'application/xhtml+xml');
  assert.equal(selectDocumentContentType({ resources: { 'application/pdf': {} } }), null);
  assert.equal(selectDocumentContentType({}), null);
});

test('document links are only followed on recognised Companies House hosts', () => {
  assert.equal(isTrustedDocumentUrl(METADATA_URL), true);
  assert.equal(isTrustedDocumentUrl('https://evil.example.com/document/DOC1'), false);
  assert.equal(isTrustedDocumentUrl('http://document-api.company-information.service.gov.uk/x'), false);
});

const IXBRL_FIXTURE = `<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance">
<ix:header><ix:resources>
<xbrli:unit id="GBP"><xbrli:measure>iso4217:GBP</xbrli:measure></xbrli:unit>
<xbrli:context id="c1"><xbrli:entity><xbrli:identifier scheme="s">1</xbrli:identifier></xbrli:entity>
<xbrli:period><xbrli:instant>2024-12-31</xbrli:instant></xbrli:period></xbrli:context>
</ix:resources></ix:header>
<ix:nonFraction name="core:NetAssetsLiabilities" contextRef="c1" unitRef="GBP">42,500</ix:nonFraction>
</html>`;

function stubFetchers(overrides = {}) {
  return {
    fetchFilingHistory: async () => [accountsFiling()],
    fetchDocumentMetadata: async () => ({
      links: { self: METADATA_URL, document: `${METADATA_URL}/content` },
      resources: { 'application/xhtml+xml': { content_length: 100 } },
    }),
    fetchDocumentContent: async () => IXBRL_FIXTURE,
    ...overrides,
  };
}

test('the filed net-assets figure is resolved end to end with its provenance', async () => {
  const result = await fetchFiledNetAssets('12345678', 'key', {
    madeUpTo: '2024-12-31', fetchers: stubFetchers(),
  });
  assert.equal(result.value, 42500);
  assert.equal(result.confidence, 'high');
  assert.equal(result.reason, null);
  assert.equal(result.transactionId, 'txn-1');
  assert.equal(result.documentId, 'DOC1');
  assert.equal(result.contentType, 'application/xhtml+xml');
  assert.equal(result.taxonomyConcept ?? result.concept, 'core:NetAssetsLiabilities');
  assert.equal(result.contextRef, 'c1');
  assert.equal(result.contextDate, '2024-12-31');
  assert.equal(result.filingDate, '2025-06-01');
});

test('a PDF-only filing returns no value and says why, without throwing', async () => {
  const result = await fetchFiledNetAssets('12345678', 'key', {
    madeUpTo: '2024-12-31',
    fetchers: stubFetchers({
      fetchDocumentMetadata: async () => ({
        links: { self: METADATA_URL }, resources: { 'application/pdf': {} },
      }),
    }),
  });
  assert.equal(result.value, null);
  assert.equal(result.reason, 'no_structured_document_available');
  assert.deepEqual(result.availableContentTypes, ['application/pdf']);
});

test('a document whose figures are all for the prior year yields no value', async () => {
  const result = await fetchFiledNetAssets('12345678', 'key', {
    madeUpTo: '2024-12-31',
    fetchers: stubFetchers({
      fetchDocumentContent: async () => IXBRL_FIXTURE.replace(/2024-12-31/g, '2023-12-31'),
    }),
  });
  assert.equal(result.value, null);
  assert.equal(result.reason, 'no_fact_for_made_up_date');
});

test('extraction is skipped without a balance-sheet date and makes no requests', async () => {
  let called = false;
  const result = await fetchFiledNetAssets('12345678', 'key', {
    madeUpTo: null,
    fetchers: stubFetchers({ fetchFilingHistory: async () => { called = true; return []; } }),
  });
  assert.equal(result.reason, 'no_made_up_to_date');
  assert.equal(called, false);
});
