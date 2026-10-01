const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { hashSecret, verifySecret, generateDeviceSecret } = require('../src/auth/credentialHash');

// Same pattern as the scrypt_hash domain in migration 007.
const DB_FORMAT = /^\$scrypt\$ln=[0-9]{1,2},r=[0-9]{1,3},p=[0-9]{1,3}\$[A-Za-z0-9+/]{22,}\$[A-Za-z0-9+/]{43,}$/;

test('hashSecret produces the documented PHC format', async () => {
  const hash = await hashSecret('correct horse battery staple');
  assert.match(hash, /^\$scrypt\$ln=15,r=8,p=3\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  assert.match(hash, DB_FORMAT);
  assert.ok(!hash.includes('correct horse'));
});

test('the same secret gets a different salt each time', async () => {
  const [a, b] = await Promise.all([hashSecret('same secret value'), hashSecret('same secret value')]);
  assert.notEqual(a, b);
});

test('verifySecret accepts the right secret and rejects others', async () => {
  const hash = await hashSecret('correct horse battery staple');
  assert.equal(await verifySecret('correct horse battery staple', hash), true);
  assert.equal(await verifySecret('correct horse battery stapl', hash), false);
  assert.equal(await verifySecret('Correct horse battery staple', hash), false);
});

test('verifySecret reads the parameters stored in the hash', async () => {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync('older parameters', salt, 32, { N: 2 ** 14, r: 8, p: 1 });
  const b64 = (buf) => buf.toString('base64').replace(/=+$/, '');
  const hash = `$scrypt$ln=14,r=8,p=1$${b64(salt)}$${b64(key)}`;
  assert.equal(await verifySecret('older parameters', hash), true);
  assert.equal(await verifySecret('other secret', hash), false);
});

test('equivalent Unicode forms of a secret verify the same', async () => {
  const hash = await hashSecret('café au lait 2026');
  assert.equal(await verifySecret('café au lait 2026', hash), true);
});

test('verifySecret throws on a malformed or out-of-range stored hash', async () => {
  await assert.rejects(verifySecret('secret', 'plaintext password'), /expected scrypt format/);
  const salt = 'A'.repeat(22);
  const key = 'B'.repeat(43);
  await assert.rejects(verifySecret('secret', `$scrypt$ln=30,r=8,p=1$${salt}$${key}`), /out-of-range/);
  await assert.rejects(verifySecret('secret', `$scrypt$ln=15,r=0,p=1$${salt}$${key}`), /out-of-range/);
  await assert.rejects(verifySecret('secret', `$scrypt$ln=17,r=8,p=1$${salt}$${key}`), /out-of-range/);
  await assert.rejects(verifySecret('secret', `$scrypt$ln=11,r=1,p=999$${salt}$${key}`), /out-of-range/);
});

test('empty, non-string, and oversized secrets are rejected', async () => {
  await assert.rejects(hashSecret(''), TypeError);
  await assert.rejects(hashSecret(undefined), TypeError);
  await assert.rejects(hashSecret('x'.repeat(1025)), TypeError);
});

test('generateDeviceSecret returns 32 random bytes as base64url', () => {
  const a = generateDeviceSecret();
  const b = generateDeviceSecret();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(a, 'base64url').length, 32);
  assert.notEqual(a, b);
});
