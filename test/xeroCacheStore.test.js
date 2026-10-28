const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const dbPath = path.join(os.tmpdir(), `xerocache-${process.pid}.db`);
process.env.XERO_DASHBOARD_DB_PATH = dbPath;
process.env.AKRIO_DB_USER = 'test-user';

// In-memory stand-in for the akrio_xero_cache table.
const mysql = new Map(); // `${org}|${type}|${id}` -> row
const insertSizes = [];  // rows per INSERT, to prove saves are paged
const exec = async (sql, params = []) => {
  if (/^CREATE TABLE/i.test(sql)) return [[]];
  if (/^INSERT INTO akrio_xero_cache/i.test(sql)) {
    insertSizes.push(params[0].length);
    for (const [org, type, id, modified, fetched, payload] of params[0]) {
      mysql.set(`${org}|${type}|${id}`, { org_id: org, entity_type: type, entity_id: id, modified_at: modified, fetched_at: fetched, payload });
    }
    return [[]];
  }
  if (/^DELETE FROM akrio_xero_cache/i.test(sql)) {
    const [org, type, fetched] = params;
    const byTime = /fetched_at </i.test(sql);   // without the time condition every row of that client and type goes
    for (const [k, r] of mysql) if (r.org_id === org && r.entity_type === type && (!byTime || r.fetched_at < fetched)) mysql.delete(k);
    return [[]];
  }
  if (/^SELECT entity_type/i.test(sql)) {
    const [org, t1, t2, id] = params;
    const rows = [...mysql.values()].filter(r => r.org_id === org && (r.entity_type > t1 || (r.entity_type === t2 && r.entity_id > id)))
      .sort((a, b) => (a.entity_type + a.entity_id).localeCompare(b.entity_type + b.entity_id)).slice(0, 2000);
    return [rows];
  }
  return [[]];
};
const poolPath = require.resolve('../src/db/mysqlPool');
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { getPool: () => ({ query: exec }) } };

const { getDb } = require('../src/db/schema');
const { mergeEntityCache, getCachedEntities, getEntityCacheWatermark } = require('../src/db/queries');
const store = require('../src/db/xeroCacheStore');

test.after(() => { for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(f); } catch (e) { /* none */ } } });
const wipeLocal = () => getDb().prepare('DELETE FROM xero_entity_cache').run();
const inv = (id, extra = {}) => ({ invoiceID: id, status: 'AUTHORISED', total: 10, updatedDateUTC: '2026-10-01T10:00:00', ...extra });

test('cached Xero data is saved to MySQL and restored after the local copy is wiped (a deploy)', async () => {
  getDb().pragma('foreign_keys = OFF');
  mergeEntityCache(1, 'invoice', [inv('a'), inv('b')], { fullRefresh: true });
  await store.drain();
  assert.equal(mysql.size, 2);
  const watermark = getEntityCacheWatermark(1, 'invoice');

  wipeLocal();                                   // new container: empty cache
  assert.equal(getCachedEntities(1, 'invoice').length, 0);
  assert.equal(await store.hydrateOrgIfEmpty(1), 2);
  assert.deepEqual(getCachedEntities(1, 'invoice').map(i => i.invoiceID), ['a', 'b']);
  assert.equal(getEntityCacheWatermark(1, 'invoice'), watermark, 'incremental sync keeps its starting point');
});

test('restoring does nothing when the local cache already has data, and only once per process', async () => {
  mergeEntityCache(2, 'invoice', [inv('x')], {});
  await store.drain();
  assert.equal(await store.hydrateOrgIfEmpty(2), 0);
});

test('an incremental save updates changed rows and keeps the rest', async () => {
  mergeEntityCache(3, 'invoice', [inv('p'), inv('q')], { fullRefresh: true });
  await store.drain();
  mergeEntityCache(3, 'invoice', [inv('q', { total: 99 })], {});     // incremental: only q changed
  await store.drain();
  wipeLocal();
  await store.hydrateOrgIfEmpty(3);
  const rows = getCachedEntities(3, 'invoice');
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.invoiceID === 'q').total, 99);
});

test('a full refresh removes records Xero no longer has, but an empty result never wipes saved data', async () => {
  mergeEntityCache(4, 'invoice', [inv('k'), inv('l')], { fullRefresh: true });
  await store.drain();
  await new Promise(r => setTimeout(r, 5));                           // a later fetch time
  mergeEntityCache(4, 'invoice', [inv('k')], { fullRefresh: true });  // l was deleted in Xero
  await store.drain();
  assert.equal([...mysql.keys()].filter(k => k.startsWith('4|')).length, 1);
  mergeEntityCache(4, 'invoice', [], { fullRefresh: true });          // an empty / failed fetch
  await store.drain();
  assert.equal([...mysql.keys()].filter(k => k.startsWith('4|')).length, 1);
});

test('a big save is written in small pages, so memory stays flat for very large clients', async () => {
  insertSizes.length = 0;
  const many = Array.from({ length: 1500 }, (_, n) => inv('big' + String(n).padStart(5, '0')));
  mergeEntityCache(5, 'invoice', many, { fullRefresh: true });
  await store.drain();
  assert.equal([...mysql.keys()].filter(k => k.startsWith('5|')).length, 1500);
  assert.ok(insertSizes.length >= 4, 'several INSERTs, not one giant one');
  assert.ok(Math.max(...insertSizes) <= 400, 'no INSERT larger than one page');
});

// Batch payments are downloaded in full every sync (reconciling a batch may not change its modified date), so the saved
// copy must follow Xero exactly: a changed reconciled flag replaces the old one, and an empty answer clears the type.
test('batch payments: full refresh replaces the reconciled flag, and an empty answer clears saved batches', async () => {
  const b = (id, isReconciled) => ({ batchPaymentID: id, isReconciled, updatedDateUTC: '2026-10-16T10:00:00' });
  mergeEntityCache(6, 'batch_payment', [b('x', false), b('y', false)], { fullRefresh: true });
  await store.drain();
  await new Promise(r => setTimeout(r, 5));
  mergeEntityCache(6, 'batch_payment', [b('x', true)], { fullRefresh: true });   // reconciled, same modified date; y gone
  await store.drain();
  assert.deepEqual(getCachedEntities(6, 'batch_payment').map(r => [r.batchPaymentID, r.isReconciled]), [['x', true]]);
  assert.deepEqual([...mysql.keys()].filter(k => k.startsWith('6|')), ['6|batch_payment|x']);
  await new Promise(r => setTimeout(r, 5));
  mergeEntityCache(6, 'batch_payment', [], { fullRefresh: true });
  await store.drain();
  assert.equal(getCachedEntities(6, 'batch_payment').length, 0);
  assert.equal([...mysql.keys()].filter(k => k.startsWith('6|')).length, 0, 'a restore cannot bring old batches back');
  mergeEntityCache(6, 'invoice', [inv('m')], { fullRefresh: true });
  await store.drain();
  mergeEntityCache(6, 'invoice', [], { fullRefresh: true });
  await store.drain();
  assert.equal([...mysql.keys()].filter(k => k.startsWith('6|invoice')).length, 1, 'other types keep the empty-answer protection');
});

test('an empty batch refresh clears saved batches even with a same-or-later saved time (F1)', async () => {
  mysql.set('7|batch_payment|z', { org_id: 7, entity_type: 'batch_payment', entity_id: 'z', modified_at: null, fetched_at: '2999-01-01 00:00:00.000', payload: Buffer.from('') });
  mergeEntityCache(7, 'batch_payment', [], { fullRefresh: true });
  await store.drain();
  assert.equal([...mysql.keys()].filter(k => k.startsWith('7|')).length, 0);
});
