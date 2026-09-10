const mysql = require('mysql2/promise');

// Write-capable connection to the app's own akrio_* tables, living in the same shared MySQL
// database as MTAKPI (the mysqlAuth.js pool is a separate, deliberately read-only connection to
// MTAKPI's own tables — this one is Akrio Verify's own data). Defaults host/port/database to the
// MTAKPI_DB_* values since it's the same database server, but the user/password must be set
// separately (AKRIO_DB_USER/AKRIO_DB_PASSWORD) — they must be a write-capable account, unlike
// MTAKPI_DB_USER which is the read-only akrio_readonly grant.
let pool = null;
function getPool() {
  if (!pool) {
    const user = process.env.AKRIO_DB_USER;
    const password = process.env.AKRIO_DB_PASSWORD;
    if (!user || !password) {
      throw new Error(
        'AKRIO_DB_USER / AKRIO_DB_PASSWORD are not set — these need to be write-capable ' +
        'MySQL credentials for the akrio_* tables (see scripts/mysql-schema.sql).'
      );
    }
    pool = mysql.createPool({
      host: process.env.AKRIO_DB_HOST || process.env.MTAKPI_DB_HOST,
      port: process.env.AKRIO_DB_PORT || process.env.MTAKPI_DB_PORT || 3306,
      user,
      password,
      database: process.env.AKRIO_DB_NAME || process.env.MTAKPI_DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
    });
  }
  return pool;
}

module.exports = { getPool };
