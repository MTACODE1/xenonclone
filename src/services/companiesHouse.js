// Companies House public-register lookup. Free REST API (register an app at
// https://developer.company-information.service.gov.uk to get a key). Basic auth: the API key is
// the username and the password is blank.
//
// Two distinct uses live here:
//  1. Company profile — status and filing deadlines. Informational only; never feeds the health
//     score or the Xenon parity gate.
//  2. Filed accounts net assets — the external half of the opening_balance_differences check.
//     Xero cannot know what was filed at Companies House, but the filed accounts themselves are
//     public and, for iXBRL filings, machine-readable. See fetchFiledNetAssets below.
const CH_BASE_URL = 'https://api.company-information.service.gov.uk';

const { extractNetAssetsFromIxbrl } = require('./ixbrlNetAssets');

// Document links arrive inside API responses. Those responses are observed data, so the host is
// validated against the known Companies House document hosts before we send an authenticated
// request to it — an API response must never be able to redirect our API key to a third party.
const CH_DOCUMENT_HOSTS = Object.freeze([
  'document-api.company-information.service.gov.uk',
  'document-api.companieshouse.gov.uk',
  'frontend-doc-api.company-information.service.gov.uk',
]);

function isTrustedDocumentUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && CH_DOCUMENT_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

function authHeader(apiKey) {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
}

function describeHttpFailure(status, context) {
  if (status === 401) return `Companies House rejected the API key (401) while fetching ${context}`;
  if (status === 403) return `Companies House denied access to ${context} (403)`;
  if (status === 404) return `Companies House has no ${context}`;
  if (status === 429) return 'Companies House rate limit hit — try again shortly';
  return `Companies House request for ${context} failed (${status})`;
}

// UK company numbers are 8 characters: either 8 digits (zero-padded) or a 2-letter prefix + 6
// digits (e.g. SC123456, NI012345, OC123456). Xero stores them with spaces or short of leading
// zeros, so normalise before use.
function normalizeCompanyNumber(value) {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!raw) return null;
  const prefixMatch = raw.match(/^([A-Z]{2})(\d{1,6})$/);
  if (prefixMatch) return prefixMatch[1] + prefixMatch[2].padStart(6, '0');
  if (/^\d{1,8}$/.test(raw)) return raw.padStart(8, '0');
  return raw.slice(0, 8);
}

function firstDate(...values) {
  for (const value of values) {
    if (value && /^\d{4}-\d{2}-\d{2}/.test(String(value))) return String(value).slice(0, 10);
  }
  return null;
}

function isOverdue(explicit, nextDue, today = new Date().toISOString().slice(0, 10)) {
  if (typeof explicit === 'boolean') return explicit;
  return !!(nextDue && nextDue < today);
}

function oneLineAddress(address) {
  if (!address || typeof address !== 'object') return null;
  const parts = [
    address.premises, address.address_line_1, address.address_line_2,
    address.locality, address.region, address.postal_code, address.country,
  ].map(part => String(part || '').trim()).filter(Boolean);
  return parts.length ? [...new Set(parts)].join(', ') : null;
}

// Pure transform of a Companies House company-profile response into the fields we store/show.
function parseCompanyProfile(raw) {
  const body = raw || {};
  const accounts = body.accounts || {};
  const confirmation = body.confirmation_statement || {};
  const accountsNextDue = firstDate(accounts.next_due, accounts.next_accounts?.due_on);
  const confirmationNextDue = firstDate(confirmation.next_due);
  return {
    companyNumber: body.company_number || null,
    companyName: body.company_name || null,
    status: body.company_status || null,
    statusDetail: body.company_status_detail || null,
    type: body.type || null,
    incorporationDate: firstDate(body.date_of_creation),
    accountsNextDue,
    accountsLastMadeUpTo: firstDate(accounts.last_accounts?.made_up_to),
    accountsOverdue: isOverdue(accounts.overdue ?? accounts.next_accounts?.overdue, accountsNextDue),
    confirmationNextDue,
    confirmationLastMadeUpTo: firstDate(confirmation.last_made_up_to),
    confirmationOverdue: isOverdue(confirmation.overdue, confirmationNextDue),
    sicCodes: Array.isArray(body.sic_codes) ? body.sic_codes : [],
    registeredOffice: oneLineAddress(body.registered_office_address),
  };
}

async function fetchCompanyProfile(companyNumber, apiKey) {
  const number = normalizeCompanyNumber(companyNumber);
  if (!number) throw new Error('Enter a company number');
  if (!apiKey) throw new Error('Set a Companies House API key in Settings first');
  const auth = Buffer.from(`${apiKey}:`).toString('base64');
  const response = await fetch(`${CH_BASE_URL}/company/${encodeURIComponent(number)}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (response.status === 401) throw new Error('Companies House rejected the API key (401)');
  if (response.status === 404) throw new Error(`No company found for number ${number}`);
  if (response.status === 429) throw new Error('Companies House rate limit hit — try again shortly');
  if (!response.ok) throw new Error(`Companies House request failed (${response.status})`);
  const raw = await response.json();
  return { profile: parseCompanyProfile(raw), raw };
}

// --- Filed accounts (opening_balance_differences evidence) ---

// The register exposes the balance-sheet date of a filing in more than one place depending on the
// filing route, so read them in order of reliability. `made_up_date` is the authoritative one.
function filingMadeUpDate(item) {
  return firstDate(
    item?.description_values?.made_up_date,
    item?.action_date,
  );
}

function isAccountsFiling(item) {
  if (!item) return false;
  if (String(item.category || '').toLowerCase() === 'accounts') return true;
  // 'AA' is annual accounts; 'AA01' is a change of accounting reference date, not accounts.
  return /^AA$/i.test(String(item.type || '').trim());
}

/**
 * Choose which accounts filing to read for a given balance-sheet date.
 *
 * Amended accounts are filed as an additional 'accounts' item with the SAME made-up date and a
 * later filing date, so the newest filing for the date wins — reading the superseded original
 * would compare Xero against figures that have since been corrected.
 */
function selectAccountsFiling(items, madeUpTo) {
  const target = firstDate(madeUpTo);
  if (!target) return { filing: null, reason: 'no_made_up_to_date' };
  const accounts = (Array.isArray(items) ? items : []).filter(isAccountsFiling);
  if (!accounts.length) return { filing: null, reason: 'no_accounts_filing' };

  const forDate = accounts.filter(item => filingMadeUpDate(item) === target);
  if (!forDate.length) {
    return {
      filing: null,
      reason: 'no_accounts_filing_for_made_up_date',
      availableDates: [...new Set(accounts.map(filingMadeUpDate).filter(Boolean))].sort(),
    };
  }

  const ranked = [...forDate].sort((a, b) => {
    const dateA = firstDate(a.date) || '';
    const dateB = firstDate(b.date) || '';
    if (dateA !== dateB) return dateB.localeCompare(dateA);
    // Stable tie-break so a re-run picks the same filing and stored evidence stays comparable.
    return String(b.transaction_id || '').localeCompare(String(a.transaction_id || ''));
  });
  const chosen = ranked[0];
  const documentMetadataUrl = chosen?.links?.document_metadata || null;
  if (!documentMetadataUrl) {
    return {
      filing: null,
      reason: chosen?.paper_filed ? 'paper_filed_no_document' : 'no_document_metadata_link',
    };
  }
  return {
    filing: {
      transactionId: chosen.transaction_id || null,
      documentMetadataUrl,
      madeUpDate: target,
      filingDate: firstDate(chosen.date),
      description: chosen.description || null,
      type: chosen.type || null,
      paperFiled: !!chosen.paper_filed,
      supersededCount: forDate.length - 1,
    },
    reason: null,
  };
}

// Accounts filings are available as iXBRL only when they were filed electronically. Micro-entity
// and dormant accounts filed on paper (or via routes that produce an image only) expose a PDF and
// nothing machine-readable — those must fall back to accountant entry, not to guesswork.
const IXBRL_CONTENT_TYPES = Object.freeze([
  'application/xhtml+xml',
  'text/html',
  'application/xml',
]);

function selectDocumentContentType(metadata) {
  const resources = metadata?.resources || {};
  const available = Object.keys(resources).map(key => key.toLowerCase());
  for (const contentType of IXBRL_CONTENT_TYPES) {
    if (available.includes(contentType)) return contentType;
  }
  return null;
}

async function fetchFilingHistory(companyNumber, apiKey, { category = 'accounts', itemsPerPage = 100 } = {}) {
  const number = normalizeCompanyNumber(companyNumber);
  if (!number) throw new Error('Enter a company number');
  if (!apiKey) throw new Error('Set a Companies House API key in Settings first');
  const url = new URL(`${CH_BASE_URL}/company/${encodeURIComponent(number)}/filing-history`);
  if (category) url.searchParams.set('category', category);
  url.searchParams.set('items_per_page', String(itemsPerPage));
  const response = await fetch(url, {
    headers: { Authorization: authHeader(apiKey), Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(describeHttpFailure(response.status, `filing history for ${number}`));
  const body = await response.json();
  return Array.isArray(body?.items) ? body.items : [];
}

async function fetchDocumentMetadata(documentMetadataUrl, apiKey) {
  if (!isTrustedDocumentUrl(documentMetadataUrl)) {
    throw new Error('Filing document link is not a recognised Companies House document URL');
  }
  const response = await fetch(documentMetadataUrl, {
    headers: { Authorization: authHeader(apiKey), Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(describeHttpFailure(response.status, 'filing document metadata'));
  return response.json();
}

// The content endpoint answers with a 302 to a pre-signed storage URL. That URL carries its own
// signature and rejects requests that also present an Authorization header, so the redirect is
// followed manually and unauthenticated.
async function fetchDocumentContent(documentUrl, apiKey, accept) {
  if (!isTrustedDocumentUrl(documentUrl)) {
    throw new Error('Filing document link is not a recognised Companies House document URL');
  }
  const response = await fetch(documentUrl, {
    headers: { Authorization: authHeader(apiKey), Accept: accept },
    redirect: 'manual',
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) throw new Error('Companies House document redirect had no location');
    const followed = await fetch(location, { headers: { Accept: accept } });
    if (!followed.ok) throw new Error(describeHttpFailure(followed.status, 'filing document content'));
    return followed.text();
  }
  if (!response.ok) throw new Error(describeHttpFailure(response.status, 'filing document content'));
  return response.text();
}

/**
 * Resolve the filed net-assets figure for a company's most recently filed accounts.
 *
 * Returns a result object in every case — including every failure — so the caller can persist
 * the attempt as evidence. `value` is null unless a figure was positively identified for the
 * exact balance-sheet date, in GBP, from an undimensioned instant context.
 */
async function fetchFiledNetAssets(companyNumber, apiKey, { madeUpTo, fetchers = {} } = {}) {
  const getFilingHistory = fetchers.fetchFilingHistory || fetchFilingHistory;
  const getMetadata = fetchers.fetchDocumentMetadata || fetchDocumentMetadata;
  const getContent = fetchers.fetchDocumentContent || fetchDocumentContent;

  const base = {
    value: null, madeUpTo: firstDate(madeUpTo), transactionId: null, documentId: null,
    filingDate: null, filingDescription: null, contentType: null, concept: null,
    contextRef: null, contextDate: null, method: null, confidence: null,
    reason: null, availableDates: [], candidates: [],
  };
  if (!base.madeUpTo) return { ...base, reason: 'no_made_up_to_date' };

  const items = await getFilingHistory(companyNumber, apiKey);
  const selection = selectAccountsFiling(items, base.madeUpTo);
  if (!selection.filing) {
    return { ...base, reason: selection.reason, availableDates: selection.availableDates || [] };
  }
  const filing = selection.filing;
  const withFiling = {
    ...base,
    transactionId: filing.transactionId,
    filingDate: filing.filingDate,
    filingDescription: filing.description,
  };

  const metadata = await getMetadata(filing.documentMetadataUrl, apiKey);
  const contentType = selectDocumentContentType(metadata);
  const documentId = metadata?.links?.self
    ? String(metadata.links.self).split('/').filter(Boolean).pop()
    : null;
  if (!contentType) {
    return {
      ...withFiling,
      documentId,
      reason: 'no_structured_document_available',
      availableContentTypes: Object.keys(metadata?.resources || {}),
    };
  }
  const documentUrl = metadata?.links?.document ||
    (metadata?.links?.self ? `${metadata.links.self}/content` : null);
  if (!documentUrl) return { ...withFiling, documentId, reason: 'no_document_content_link' };

  const html = await getContent(documentUrl, apiKey, contentType);
  const extraction = extractNetAssetsFromIxbrl(html, { madeUpTo: base.madeUpTo });
  return {
    ...withFiling,
    documentId,
    contentType,
    value: extraction.value,
    concept: extraction.concept,
    contextRef: extraction.contextRef,
    contextDate: extraction.contextDate,
    method: extraction.method,
    confidence: extraction.confidence,
    conceptLabel: extraction.conceptLabel || null,
    reason: extraction.reason,
    availableDates: extraction.availableDates || [],
    candidates: extraction.candidates || [],
  };
}

module.exports = {
  CH_BASE_URL, CH_DOCUMENT_HOSTS,
  normalizeCompanyNumber, parseCompanyProfile, fetchCompanyProfile,
  fetchFilingHistory, fetchDocumentMetadata, fetchDocumentContent,
  fetchFiledNetAssets, selectAccountsFiling, selectDocumentContentType,
  isTrustedDocumentUrl, filingMadeUpDate,
};
