const jwt = require('jsonwebtoken');
const { ISSUER, AUDIENCE, ALGORITHM, TOKEN_LIFETIMES, getJwtSecret } = require('../config/auth');

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

module.exports = { issueToken };
