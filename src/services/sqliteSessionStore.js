const { Store } = require('express-session');
const { getDb } = require('../db/schema');

// Backs express-session with the same better-sqlite3 connection everything else in this app
// uses, instead of the default in-memory MemoryStore — this app restarts often in production
// (deploys, crashes), and MemoryStore would log every staff member out on each one.
// connect-sqlite3 would pull in a second native sqlite binding alongside better-sqlite3; this
// hand-rolled store avoids that by reusing the existing connection.
class SqliteSessionStore extends Store {
  get(sid, callback) {
    try {
      const row = getDb().prepare(
        `SELECT session_json FROM sessions WHERE sid = ? AND expires_at > ?`
      ).get(sid, Date.now());
      callback(null, row ? JSON.parse(row.session_json) : null);
    } catch (error) {
      callback(error);
    }
  }

  set(sid, session, callback) {
    try {
      const expiresAt = Date.now() + (session.cookie?.maxAge || 24 * 60 * 60 * 1000);
      getDb().prepare(`
        INSERT INTO sessions (sid, session_json, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET session_json = excluded.session_json, expires_at = excluded.expires_at
      `).run(sid, JSON.stringify(session), expiresAt);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback) {
    try {
      getDb().prepare(`DELETE FROM sessions WHERE sid = ?`).run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, session, callback) {
    this.set(sid, session, callback);
  }

  // Sweeps expired rows so the table doesn't grow unbounded — called on an hourly interval
  // from app.js rather than piggybacking on the nightly cron, since that job is unrelated
  // (Xero org syncing) and shouldn't grow a dependency on session housekeeping.
  static pruneExpired() {
    getDb().prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(Date.now());
  }
}

module.exports = SqliteSessionStore;
