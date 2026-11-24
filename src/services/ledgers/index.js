// Which accounting system a client's books are in, and the sync for each.
//
// Xero clients carry xero_tenant_id. Every other ledger shares the nullable, unique
// akrio_organisations.freeagent_company_id column (added for FreeAgent in Sept 2026), so the
// existing look-ups, routes, Sync All, the nightly sync and staff access work for them unchanged
// and no column had to be added to the live table:
//   FreeAgent   "35963"              (FreeAgent's company id, as before)
//   QuickBooks  "qbo-9130354851"     (Intuit realm id)
//   Zoho Books  "zoho-60012345678"   (Zoho organization_id)
// Use ledgerOf(org) to tell them apart; never test freeagent_company_id on its own.

const LEDGERS = {
  xero: { key: 'xero', label: 'Xero', prefix: null },
  freeagent: { key: 'freeagent', label: 'FreeAgent', prefix: null },
  quickbooks: { key: 'quickbooks', label: 'QuickBooks', prefix: 'qbo-' },
  zoho: { key: 'zoho', label: 'Zoho Books', prefix: 'zoho-' },
};

function ledgerOfIdentifier(identifier) {
  const id = String(identifier || '');
  if (id.startsWith(LEDGERS.quickbooks.prefix)) return 'quickbooks';
  if (id.startsWith(LEDGERS.zoho.prefix)) return 'zoho';
  return null; // Xero or FreeAgent: tell them apart from the organisation row
}

function ledgerOf(org) {
  if (!org) return null;
  if (org.xero_tenant_id) return 'xero';
  if (!org.freeagent_company_id) return null;
  return ledgerOfIdentifier(org.freeagent_company_id) || 'freeagent';
}

function ledgerLabel(orgOrKey) {
  const key = typeof orgOrKey === 'string' ? orgOrKey : ledgerOf(orgOrKey);
  return LEDGERS[key]?.label || 'Xero';
}

// The provider module for QuickBooks or Zoho (loaded only when used).
function provider(key) {
  if (key === 'quickbooks') return require('./quickbooks');
  if (key === 'zoho') return require('./zoho');
  throw new Error(`No ledger provider for "${key}"`);
}

// True once a ledger's app keys are in the environment (its connect button is shown live).
function ledgerReady(key) {
  try { return Boolean(provider(key).isConfigured()); } catch (error) { return false; }
}

// Xero and FreeAgent have no prefix: their id is stored as it is (the template used to give "null35963").
function identifierFor(key, externalId) {
  return `${LEDGERS[key].prefix || ''}${externalId}`;
}

function externalIdOf(identifier) {
  const key = ledgerOfIdentifier(identifier);
  return key ? String(identifier).slice(LEDGERS[key].prefix.length) : String(identifier);
}

// The sync for any client that is not on Xero (the four places that used to call the FreeAgent
// sync for every non-Xero client call this instead).
function syncNonXeroOrganisation(identifier, progress, options = {}) {
  if (ledgerOfIdentifier(identifier)) {
    return require('../ledgerSync').syncLedgerOrganisation(identifier, progress, options);
  }
  return require('../freeagentSync').syncFreeAgentOrganisation(identifier, progress, options);
}

module.exports = {
  LEDGERS, ledgerOf, ledgerOfIdentifier, ledgerLabel, provider, ledgerReady, identifierFor, externalIdOf,
  syncNonXeroOrganisation,
};
