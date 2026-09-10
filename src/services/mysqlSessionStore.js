const { Store } = require('express-session');
const { getPool } = require('../db/mysqlPool');

// Backs express-session with the shared MySQL database (akrio_sessions) instead of the default
// in-memory MemoryStore — this app restarts often (deploys, crashes), and MemoryStore would log
// every staff member out on each one. Previously backed by a local SQLite file, which had the
// same restart-survival problem the rest of this migration fixes: that file lived only on the
// container's ephemeral disk, so sessions were wiped right along with everything else.
class MysqlSessionStore extends Store {
  get(sid, callback) {
    getPool()
      .query(`SELECT session_json FROM akrio_sessions WHERE sid = ? AND expires_at > ?`, [sid, Date.now()])
      .then(([rows]) => callback(null, rows.length ? JSON.parse(rows[0].session_json) : null))
      .catch(error => callback(error));
  }

  set(sid, session, callback) {
    const expiresAt = Date.now() + (session.cookie?.maxAge || 24 * 60 * 60 * 1000);
    getPool()
      .query(
        `INSERT INTO akrio_sessions (sid, session_json, expires_at) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE session_json = VALUES(session_json), expires_at = VALUES(expires_at)`,
        [sid, JSON.stringify(session), expiresAt]
      )
      .then(() => callback(null))
      .catch(error => callback(error));
  }

  destroy(sid, callback) {
    getPool()
      .query(`DELETE FROM akrio_sessions WHERE sid = ?`, [sid])
      .then(() => callback(null))
      .catch(error => callback(error));
  }

  touch(sid, session, callback) {
    this.set(sid, session, callback);
  }

  // Sweeps expired rows so the table doesn't grow unbounded — called on an hourly interval
  // from app.js rather than piggybacking on the nightly cron, since that job is unrelated
  // (Xero org syncing) and shouldn't grow a dependency on session housekeeping.
  static async pruneExpired() {
    await getPool().query(`DELETE FROM akrio_sessions WHERE expires_at <= ?`, [Date.now()]);
  }
}

module.exports = MysqlSessionStore;
