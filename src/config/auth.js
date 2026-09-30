// Token settings from docs/authentication.md#jwt-claims.
const ISSUER = 'solar-generation-api';
const AUDIENCE = 'solar-generation-api';
const ALGORITHM = 'HS256';
const MIN_SECRET_BYTES = 32;

// Lifetimes in seconds.
const TOKEN_LIFETIMES = {
  staff: 60 * 60,
  device: 60 * 60,
  provisioner: 15 * 60,
};

// Read on use rather than at startup, so the app (and its tests) can load without a secret.
// A missing or short secret is a server fault and surfaces as a 500.
function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
    throw new Error(`JWT_SECRET must be set to at least ${MIN_SECRET_BYTES} bytes.`);
  }
  return secret;
}

module.exports = { ISSUER, AUDIENCE, ALGORITHM, TOKEN_LIFETIMES, getJwtSecret };
