const jwt = require('jsonwebtoken');
const { ISSUER, AUDIENCE, ALGORITHM, TOKEN_LIFETIMES, getJwtSecret } = require('../config/auth');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// principal: { type, id, credentialVersion }. Returns the token and its lifetime in seconds.
function issueToken(principal) {
  const expiresIn = TOKEN_LIFETIMES[principal.type];
  const accessToken = jwt.sign(
    { principalType: principal.type, credentialVersion: principal.credentialVersion },
    getJwtSecret(),
    { algorithm: ALGORITHM, issuer: ISSUER, audience: AUDIENCE, subject: principal.id, expiresIn },
  );
  return { accessToken, expiresIn };
}

// Returns { type, id, credentialVersion } for a valid token, or null for any invalid one.
// The signature, algorithm (HS256 only), issuer, audience, and expiry are checked by
// jsonwebtoken; the claim shapes and lifetime are checked here, so a token must look exactly
// like one issueToken() produces.
function verifyToken(token) {
  let claims;
  try {
    claims = jwt.verify(token, getJwtSecret(), { algorithms: [ALGORITHM], issuer: ISSUER, audience: AUDIENCE });
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) return null; // includes TokenExpiredError and NotBeforeError
    throw err;
  }

  const { sub, principalType, credentialVersion, iat, exp } = claims;
  if (!Object.hasOwn(TOKEN_LIFETIMES, principalType)) return null;
  if (typeof sub !== 'string' || !UUID.test(sub)) return null;
  if (typeof credentialVersion !== 'string' || !UUID.test(credentialVersion)) return null;
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) return null;
  if (exp - iat > TOKEN_LIFETIMES[principalType]) return null;

  return { type: principalType, id: sub.toLowerCase(), credentialVersion: credentialVersion.toLowerCase() };
}

module.exports = { issueToken, verifyToken };
