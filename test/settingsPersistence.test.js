const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Settings must survive a deploy: every saved setting is mirrored to MySQL and reloaded at start-up.
const dbPath = path.join(os.tmpdir(), `settings-persist-${process.pid}.db`);
process.env.XERO_DASHBOARD_DB_PATH = dbPath;
process.env.AKRIO_DB_USER = 'test-user';

const calls = [];
let storedRows = [];
const poolPath = require.resolve('../src/db/mysqlPool');
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true,
  exports: { getPool: () => ({ query: async (sql, params) => {
    calls.push({ sql, params });
    if (/^SELECT/i.test(sql)) return [storedRows];
    return [[]];
  } }) },
};
const queries = require('../src/db/queries');

test.after(() => { for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(f); } catch (e) { /* none */ } } });

test('setSetting saves locally and mirrors the value to MySQL', async () => {
  queries.setSetting('companies_house_api_key', 'abc123');
  assert.equal(queries.getSetting('companies_house_api_key'), 'abc123');
  await new Promise(r => setImmediate(r));
  const mirror = calls.find(c => /INSERT INTO akrio_settings/.test(c.sql));
  assert.ok(mirror, 'expected an INSERT into akrio_settings');
  assert.deepEqual(mirror.params, ['companies_house_api_key', 'abc123']);
});

test('restoreSettingsFromMysql reloads saved settings after the local file has been wiped', async () => {
  storedRows = [{ key: 'companies_house_api_key', value: 'abc123' }, { key: 'practice_name', value: 'MTA' }];
  const restored = await queries.restoreSettingsFromMysql();
  assert.equal(restored, 2);
  assert.equal(queries.getSetting('practice_name'), 'MTA');
  assert.equal(queries.getSetting('companies_house_api_key'), 'abc123');
});
