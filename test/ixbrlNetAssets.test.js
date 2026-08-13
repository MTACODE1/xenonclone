const test = require('node:test');
const assert = require('node:assert/strict');
const { extractNetAssetsFromIxbrl, parseFactValue } = require('../src/services/ixbrlNetAssets');

// Minimal but structurally faithful iXBRL: a hidden header carrying contexts and units, then the
// rendered balance sheet facts. Real filings wrap this in a full XHTML document; the extractor
// reads the same elements either way.
function document({ contexts = '', units = '', facts = '' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance">
<body><div style="display:none"><ix:header><ix:resources>
${units}
${contexts}
</ix:resources></ix:header></div>
<table>${facts}</table></body></html>`;
}

const GBP_UNIT = '<xbrli:unit id="GBP"><xbrli:measure>iso4217:GBP</xbrli:measure></xbrli:unit>';
const EUR_UNIT = '<xbrli:unit id="EUR"><xbrli:measure>iso4217:EUR</xbrli:measure></xbrli:unit>';

function instantContext(id, date, { dimension = null } = {}) {
  const segment = dimension
    ? `<xbrli:segment><xbrldi:explicitMember dimension="${dimension}">x</xbrldi:explicitMember></xbrli:segment>`
    : '';
  return `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="s">1</xbrli:identifier>${segment}</xbrli:entity>` +
    `<xbrli:period><xbrli:instant>${date}</xbrli:instant></xbrli:period></xbrli:context>`;
}

function durationContext(id, start, end) {
  return `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="s">1</xbrli:identifier></xbrli:entity>` +
    `<xbrli:period><xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate></xbrli:period></xbrli:context>`;
}

function fact(name, contextRef, value, attributes = '') {
  return `<td><ix:nonFraction name="${name}" contextRef="${contextRef}" unitRef="GBP" decimals="0" ${attributes}>${value}</ix:nonFraction></td>`;
}

test('FRS 102 core taxonomy: the current-year net assets column is selected, not the comparative', () => {
  const html = document({
    units: GBP_UNIT,
    contexts: instantContext('cur', '2024-12-31') + instantContext('prior', '2023-12-31'),
    facts: fact('core:NetAssetsLiabilities', 'cur', '1,234,567') +
      fact('core:NetAssetsLiabilities', 'prior', '999,111'),
  });
  const result = extractNetAssetsFromIxbrl(html, { madeUpTo: '2024-12-31' });
  assert.equal(result.value, 1234567);
  assert.equal(result.concept, 'core:NetAssetsLiabilities');
  assert.equal(result.contextRef, 'cur');
  assert.equal(result.contextDate, '2024-12-31');
  assert.equal(result.confidence, 'high');
  assert.equal(result.reason, null);
});

test('older uk-gaap taxonomy net-asset concepts are recognised by local name', () => {
  for (const concept of [
    'uk-gaap:NetAssetsLiabilitiesIncludingPensionAssetLiability',
    'uk-gaap:NetAssetsLiabilitiesExcludingPensionAssetLiability',
    'ns5:NetAssetsLiabilities',
    'NetAssetsLiabilities',
  ]) {
    const html = document({
      units: GBP_UNIT,
      contexts: instantContext('c', '2022-03-31'),
      facts: fact(concept, 'c', '5000'),
    });
    const result = extractNetAssetsFromIxbrl(html, { madeUpTo: '2022-03-31' });
    assert.equal(result.value, 5000, `failed for ${concept}`);
    assert.equal(result.confidence, 'high');
  }
});

test('total equity is a tier-2 fallback only when no net-assets concept is tagged', () => {
  const equityOnly = document({
    units: GBP_UNIT,
    contexts: instantContext('c', '2024-06-30'),
    facts: fact('core:Equity', 'c', '80,000'),
  });
  const fallback = extractNetAssetsFromIxbrl(equityOnly, { madeUpTo: '2024-06-30' });
  assert.equal(fallback.value, 80000);
  assert.equal(fallback.confidence, 'medium');
  assert.equal(fallback.conceptLabel, 'total equity');

  // With both present the explicit net-assets line wins and equity is ignored, even when they
  // disagree — tiers are never mixed, so an equity figure cannot trigger a false conflict.
  const both = document({
    units: GBP_UNIT,
    contexts: instantContext('c', '2024-06-30'),
    facts: fact('core:NetAssetsLiabilities', 'c', '80,000') + fact('core:Equity', 'c', '79,999'),
  });
  const preferred = extractNetAssetsFromIxbrl(both, { madeUpTo: '2024-06-30' });
  assert.equal(preferred.value, 80000);
  assert.equal(preferred.confidence, 'high');
});

test('net liabilities stay negative whether signalled by sign, parentheses or a minus', () => {
  const cases = [
    ['12,500', 'sign="-"', -12500],
    ['(12,500)', '', -12500],
    ['-12,500', '', -12500],
    ['12,500', '', 12500],
  ];
  for (const [text, attributes, expected] of cases) {
    const html = document({
      units: GBP_UNIT,
      contexts: instantContext('c', '2025-01-31'),
      facts: fact('core:NetAssetsLiabilities', 'c', text, attributes),
    });
    const result = extractNetAssetsFromIxbrl(html, { madeUpTo: '2025-01-31' });
    assert.equal(result.value, expected, `failed for "${text}" ${attributes}`);
  }
});

test('scale is applied so accounts filed in thousands are not understated by 1000x', () => {
  const html = document({
    units: GBP_UNIT,
    contexts: instantContext('c', '2024-12-31'),
    facts: fact('core:NetAssetsLiabilities', 'c', '1,250', 'scale="3"'),
  });
  assert.equal(extractNetAssetsFromIxbrl(html, { madeUpTo: '2024-12-31' }).value, 1250000);
});

test('a dash cell is a filed zero, and a nil fact is not a value at all', () => {
  const dash = document({
    units: GBP_UNIT,
    contexts: instantContext('c', '2024-12-31'),
    facts: fact('core:NetAssetsLiabilities', 'c', '-'),
  });
  assert.equal(extractNetAssetsFromIxbrl(dash, { madeUpTo: '2024-12-31' }).value, 0);

  const nil = document({
    units: GBP_UNIT,
    contexts: instantContext('c', '2024-12-31'),
    facts: fact('core:NetAssetsLiabilities', 'c', '', 'xsi:nil="true"'),
  });
  const result = extractNetAssetsFromIxbrl(nil, { madeUpTo: '2024-12-31' });
  assert.equal(result.value, null);
});

test('a figure is rejected unless it is GBP, an instant, undimensioned and on the exact date', () => {
  const madeUpTo = '2024-12-31';
  const reject = (options, expectedReason) => {
    const result = extractNetAssetsFromIxbrl(document(options), { madeUpTo });
    assert.equal(result.value, null, `expected rejection for ${expectedReason}`);
    assert.match(result.reason, new RegExp(expectedReason));
  };

  // Foreign currency: not comparable with a GBP Xero balance sheet.
  reject({
    units: EUR_UNIT, contexts: instantContext('c', madeUpTo),
    facts: `<ix:nonFraction name="core:NetAssetsLiabilities" contextRef="c" unitRef="EUR">50</ix:nonFraction>`,
  }, 'unit_not_gbp');

  // Duration context: that is a profit-and-loss period, never a balance-sheet position.
  reject({
    units: GBP_UNIT, contexts: durationContext('c', '2024-01-01', madeUpTo),
    facts: fact('core:NetAssetsLiabilities', 'c', '50'),
  }, 'not_instant_context');

  // Dimensioned context: a restatement or a segment, not the entity total.
  reject({
    units: GBP_UNIT,
    contexts: instantContext('c', madeUpTo, { dimension: 'core:RestatementAxis' }),
    facts: fact('core:NetAssetsLiabilities', 'c', '50'),
  }, 'dimensioned_context');

  // Only the comparative year is tagged — never silently accept the wrong year.
  const wrongYear = extractNetAssetsFromIxbrl(document({
    units: GBP_UNIT, contexts: instantContext('c', '2023-12-31'),
    facts: fact('core:NetAssetsLiabilities', 'c', '50'),
  }), { madeUpTo });
  assert.equal(wrongYear.value, null);
  assert.equal(wrongYear.reason, 'no_fact_for_made_up_date');
  assert.deepEqual(wrongYear.availableDates, ['2023-12-31']);
});

test('two different values for the same date and concept are refused, not guessed between', () => {
  const html = document({
    units: GBP_UNIT,
    contexts: instantContext('a', '2024-12-31') + instantContext('b', '2024-12-31'),
    facts: fact('core:NetAssetsLiabilities', 'a', '1,000') +
      fact('core:NetAssetsLiabilities', 'b', '2,000'),
  });
  const result = extractNetAssetsFromIxbrl(html, { madeUpTo: '2024-12-31' });
  assert.equal(result.value, null);
  assert.equal(result.reason, 'conflicting_values_for_same_date');
});

test('the same figure tagged twice (balance sheet and notes) is not treated as a conflict', () => {
  const html = document({
    units: GBP_UNIT,
    contexts: instantContext('a', '2024-12-31') + instantContext('b', '2024-12-31'),
    facts: fact('core:NetAssetsLiabilities', 'a', '1,000') +
      fact('core:NetAssetsLiabilities', 'b', '1,000.00'),
  });
  assert.equal(extractNetAssetsFromIxbrl(html, { madeUpTo: '2024-12-31' }).value, 1000);
});

test('documents with no inline XBRL (image-only or PDF-derived) fail cleanly', () => {
  assert.equal(extractNetAssetsFromIxbrl('%PDF-1.4 binary', { madeUpTo: '2024-12-31' }).reason,
    'no_inline_xbrl_facts');
  assert.equal(extractNetAssetsFromIxbrl('', { madeUpTo: '2024-12-31' }).reason, 'no_document');
  assert.equal(extractNetAssetsFromIxbrl(document({
    units: GBP_UNIT, contexts: instantContext('c', '2024-12-31'),
    facts: fact('core:TurnoverRevenue', 'c', '10'),
  }), { madeUpTo: '2024-12-31' }).reason, 'no_net_assets_concept_found');
});

test('extraction requires a balance-sheet date to compare against', () => {
  const html = document({
    units: GBP_UNIT, contexts: instantContext('c', '2024-12-31'),
    facts: fact('core:NetAssetsLiabilities', 'c', '1,000'),
  });
  assert.equal(extractNetAssetsFromIxbrl(html, {}).reason, 'no_made_up_to_date');
});

test('every rejected candidate is retained as explainable evidence', () => {
  const html = document({
    units: EUR_UNIT,
    contexts: instantContext('c', '2020-01-01'),
    facts: `<ix:nonFraction name="core:NetAssetsLiabilities" contextRef="c" unitRef="EUR">7</ix:nonFraction>`,
  });
  const result = extractNetAssetsFromIxbrl(html, { madeUpTo: '2024-12-31' });
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].rejectedFor.sort(), ['context_date_mismatch', 'unit_not_gbp']);
  assert.equal(result.candidates[0].usable, false);
});

test('unparsable numerals are reported rather than coerced', () => {
  assert.equal(parseFactValue('n/a', '<ix:nonFraction>').reason, 'unparsable_number');
  assert.equal(parseFactValue('', '<ix:nonFraction>').reason, 'empty_fact');
  assert.equal(parseFactValue('1 234', '<ix:nonFraction>').value, 1234);
});
