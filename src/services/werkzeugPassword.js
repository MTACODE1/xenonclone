const crypto = require('crypto');

// Reimplements werkzeug.security.check_password_hash (the exact algorithm MTAKPI's Flask
// backend uses to hash UserDataMatch.password_hash) so Akrio Verify can verify a staff
// member's real password without ever storing a copy of it. Every parameter (scrypt's N/r/p,
// pbkdf2's digest/iterations) is parsed from the hash string itself — werkzeug's format is
// self-describing ("method:params$salt$hex"), so nothing here is hardcoded or assumed; a hash
// generated under any werkzeug version/config verifies correctly as long as the method is one
// of the two below (both are all werkzeug has ever supported since 2.3, per its own source).
function checkPasswordHash(pwhash, password) {
  const parts = String(pwhash || '').split('$');
  if (parts.length !== 3) return false;
  const [methodSpec, salt, expectedHex] = parts;
  const [method, ...args] = methodSpec.split(':');

  let actualHex;
  if (method === 'scrypt') {
    const [n, r, p] = args.length ? args.map(Number) : [32768, 8, 1];
    const maxmem = 132 * n * r * p;
    actualHex = crypto.scryptSync(password, salt, 64, { N: n, r, p, maxmem }).toString('hex');
  } else if (method === 'pbkdf2') {
    const digest = args[0] || 'sha256';
    const iterations = args[1] ? Number(args[1]) : 600000;
    const keylen = digest === 'sha256' ? 32 : crypto.createHash(digest).digest().length;
    actualHex = crypto.pbkdf2Sync(password, salt, iterations, keylen, digest).toString('hex');
  } else {
    return false;
  }

  const actual = Buffer.from(actualHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = { checkPasswordHash };
