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

// Scopes: what each kind of principal may do. They are granted here, on the server, from the
// principal type; a client never chooses them. A scope names an operation, not a region: which
// rows a staff reader may see comes from their jurisdiction, loaded on each request
// (src/auth/scope.js).
//   hierarchy:read       provinces, districts, and a district's substation collection
//   installations:read   a substation, its installations, and installation metadata
//   installations:write  register, replace, and delete installations
//   readings:read        reading history, last-known reading, overview, and district summary
//   readings:write       submit readings for the device's own installation
const SCOPES = {
  staff: ['hierarchy:read', 'installations:read', 'readings:read'],
  device: ['readings:write'],
  provisioner: ['installations:read', 'installations:write'],
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

module.exports = { ISSUER, AUDIENCE, ALGORITHM, TOKEN_LIFETIMES, SCOPES, getJwtSecret };
