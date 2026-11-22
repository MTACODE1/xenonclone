const test = require('node:test');
const assert = require('node:assert/strict');
const { noteActivity, describeActivity, startEventLoopWatch, stopEventLoopWatch } = require('../src/services/eventLoopWatch');

test('event-loop watch names what was running when the server was blocked', async () => {
  const lines = [];
  stopEventLoopWatch();
  startEventLoopWatch({ log: line => lines.push(line) });
  const end = noteActivity('tenant-1', 'org 42: after duplicate_contacts');
  assert.equal(describeActivity(), 'org 42: after duplicate_contacts');
  const until = Date.now() + 4200;
  while (Date.now() < until) { /* hold the thread, as a slow check would */ }
  await new Promise(resolve => setTimeout(resolve, 1100));
  stopEventLoopWatch();
  end();
  assert.equal(describeActivity(), 'no sync running');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[event-loop\] blocked for \d+\.\d s while org 42: after duplicate_contacts$/);
});
