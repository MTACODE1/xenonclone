const test = require('node:test');
const assert = require('node:assert/strict');
const { parseIdList, accessChanges } = require('../src/services/staffAccess');

test('parseIdList keeps only whole positive numbers, once each, in order', () => {
  assert.deepEqual(parseIdList('3, 7,x,7,-2,0,4.5,12'), [3, 7, 12]);
  assert.deepEqual(parseIdList(''), []);
  assert.deepEqual(parseIdList(undefined), []);
  assert.deepEqual(parseIdList('1;2'), []);
});

test('accessChanges ignores unknown people and never grants and revokes the same person', () => {
  const active = [1, 2, 3, 4];
  assert.deepEqual(accessChanges('1,2,99', '3,4', active), { grant: [1, 2], revoke: [3, 4] });
  assert.deepEqual(accessChanges('1,2', '2,3', active), { grant: [1, 2], revoke: [3] }, 'granted wins over revoked');
  assert.deepEqual(accessChanges('', '', active), { grant: [], revoke: [] });
  assert.deepEqual(accessChanges('5', '6', active), { grant: [], revoke: [] }, 'an inactive or forged id does nothing');
});
