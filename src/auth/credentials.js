const pool = require('../config/db');
const { hashSecret, verifySecret } = require('./credentialHash');

// How each principal type is found by its sign-in identifier. Identifiers are matched the same
// way as their unique indexes: ignoring case and surrounding spaces.
const LOOKUPS = {
  staff: `
    SELECT u.id, c.password_hash AS hash, c.credential_version
    FROM users u JOIN user_credentials c ON c.user_id = u.id
    WHERE lower(u.email) = lower(btrim($1))`,
  device: `
    SELECT i.id, c.secret_hash AS hash, c.credential_version
    FROM solar_installations i JOIN device_credentials c ON c.installation_id = i.id
    WHERE lower(btrim(i.meter_id)) = lower(btrim($1))`,
  provisioner: `
    SELECT id, password_hash AS hash, credential_version
    FROM provisioners
    WHERE lower(btrim(username)) = lower(btrim($1))`,
};

// Verified against when the identifier is unknown or has no credential, so that case costs the
// same scrypt work as a wrong secret and response time does not reveal which identifiers exist.
let dummyHash;
async function getDummyHash() {
  dummyHash ??= hashSecret('dummy secret for unknown principals');
  return dummyHash;
}

// Returns { type, id, credentialVersion } when the secret matches, otherwise null.
async function authenticateCredentials(type, identifier, secret) {
  const row = (await pool.query(LOOKUPS[type], [identifier])).rows[0];
  if (!row) {
    await verifySecret(secret, await getDummyHash());
    return null;
  }
  if (!(await verifySecret(secret, row.hash))) return null;
  return { type, id: row.id, credentialVersion: row.credential_version };
}

module.exports = { authenticateCredentials };
