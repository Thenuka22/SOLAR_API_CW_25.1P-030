const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

// OWASP minimum setting N = 2^15, r = 8, p = 3 (about 32 MiB per hash). See docs/authentication.md.
const PARAMS = { ln: 15, r: 8, p: 3 };
const SALT_BYTES = 16;
const KEY_BYTES = 32;
// Limits for parameters read back from a stored hash, so a bad row cannot make one sign-in
// use more memory or CPU than the server can afford. scrypt needs about 128 * N * r bytes and
// does work proportional to N * r * p. The current setting uses 32 MiB and 2^19.6 work; the
// limits allow up to twice the memory and slightly more work, which covers every OWASP
// setting from N = 2^16 down (N = 2^17 with r = 8 needs 128 MiB and is rejected).
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;
const MAX_WORK = 2 ** 20;
const MAX_SALT_BYTES = 64;
const MAX_KEY_BYTES = 64;
const MAX_SECRET_LENGTH = 1024;

const HASH_FORMAT = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]{22,})\$([A-Za-z0-9+/]{43,})$/;

function toBase64(buffer) {
  return buffer.toString('base64').replace(/=+$/, '');
}

function checkSecret(secret) {
  if (typeof secret !== 'string' || secret.length === 0 || secret.length > MAX_SECRET_LENGTH) {
    throw new TypeError(`A secret must be a non-empty string of at most ${MAX_SECRET_LENGTH} characters.`);
  }
}

function derive(secret, salt, { ln, r, p }, keyBytes) {
  const N = 2 ** ln;
  // Node rejects scrypt calls needing more than maxmem (default 32 MiB, which the current
  // setting just exceeds); allow what these parameters need plus headroom.
  return scrypt(secret.normalize('NFC'), salt, keyBytes, { N, r, p, maxmem: 256 * N * r });
}

// Returns a PHC string: $scrypt$ln=15,r=8,p=3$<salt>$<hash>
async function hashSecret(secret) {
  checkSecret(secret);
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await derive(secret, salt, PARAMS, KEY_BYTES);
  return `$scrypt$ln=${PARAMS.ln},r=${PARAMS.r},p=${PARAMS.p}$${toBase64(salt)}$${toBase64(key)}`;
}

// True when `secret` matches `storedHash`. A malformed or out-of-range stored hash throws,
// because that is a data fault rather than a wrong secret.
async function verifySecret(secret, storedHash) {
  checkSecret(secret);
  const match = HASH_FORMAT.exec(storedHash);
  if (!match) throw new Error('Stored credential hash is not in the expected scrypt format.');

  const [ln, r, p] = match.slice(1, 4).map(Number);
  const N = 2 ** ln;
  if (ln < 1 || r < 1 || p < 1 || 128 * N * r > MAX_MEMORY_BYTES || N * r * p > MAX_WORK) {
    throw new Error('Stored credential hash has out-of-range scrypt parameters.');
  }

  const salt = Buffer.from(match[4], 'base64');
  const expected = Buffer.from(match[5], 'base64');
  if (salt.length > MAX_SALT_BYTES || expected.length > MAX_KEY_BYTES) {
    throw new Error('Stored credential hash has an out-of-range salt or key length.');
  }
  const actual = await derive(secret, salt, { ln, r, p }, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// A new device secret: 32 random bytes, base64url. Shown once; only its hash is stored.
function generateDeviceSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

module.exports = { hashSecret, verifySecret, generateDeviceSecret };
