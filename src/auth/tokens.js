const jwt = require('jsonwebtoken');
const { ISSUER, AUDIENCE, ALGORITHM, TOKEN_LIFETIMES, SCOPES, getJwtSecret } = require('../config/auth');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The scope claim for a principal type: a space-delimited list (RFC 6749 section 3.3).
const scopeClaim = (type) => SCOPES[type].join(' ');

// principal: { type, id, credentialVersion }. Returns the token, its lifetime in seconds, and
// the scopes it carries.
function issueToken(principal) {
  const expiresIn = TOKEN_LIFETIMES[principal.type];
  const scope = scopeClaim(principal.type);
  const accessToken = jwt.sign(
    { principalType: principal.type, credentialVersion: principal.credentialVersion, scope },
    getJwtSecret(),
    { algorithm: ALGORITHM, issuer: ISSUER, audience: AUDIENCE, subject: principal.id, expiresIn },
  );
  return { accessToken, expiresIn, scope };
}

// Returns { type, id, credentialVersion, scopes } for a valid token, or null for any invalid one.
// The signature, algorithm (HS256 only), issuer, audience, and expiry are checked by
// jsonwebtoken; the claim shapes and lifetime are checked here, so a token must look exactly
// like one issueToken() produces. That includes the scope: a token whose scopes are not the
// ones its principal type is granted is rejected.
function verifyToken(token) {
  let claims;
  try {
    claims = jwt.verify(token, getJwtSecret(), { algorithms: [ALGORITHM], issuer: ISSUER, audience: AUDIENCE });
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) return null; // includes TokenExpiredError and NotBeforeError
    throw err;
  }

  const { sub, principalType, credentialVersion, scope, iat, exp } = claims;
  if (!Object.hasOwn(TOKEN_LIFETIMES, principalType)) return null;
  if (typeof sub !== 'string' || !UUID.test(sub)) return null;
  if (typeof credentialVersion !== 'string' || !UUID.test(credentialVersion)) return null;
  if (scope !== scopeClaim(principalType)) return null;
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) return null;
  if (exp - iat > TOKEN_LIFETIMES[principalType]) return null;

  return {
    type: principalType,
    id: sub.toLowerCase(),
    credentialVersion: credentialVersion.toLowerCase(),
    scopes: scope.split(' '),
  };
}

module.exports = { issueToken, verifyToken };
