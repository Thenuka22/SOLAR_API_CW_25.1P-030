const pool = require('../config/db');
const { ERRORS, ApiError } = require('../errors');
const { verifyToken } = require('../auth/tokens');

const REALM = 'Bearer realm="solar-generation-api"';
// RFC 6750 section 2.1: "Bearer" followed by a b64token.
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i;

// Current state of each principal type, loaded on every request. A token is accepted only if
// the principal still exists and its credential version matches the token's.
const LOADERS = {
  staff: `
    SELECT u.id, c.credential_version, u.role, u.province_id, u.district_id,
           d.province_id AS district_province_id
    FROM users u
    JOIN user_credentials c ON c.user_id = u.id
    LEFT JOIN districts d ON d.id = u.district_id
    WHERE u.id = $1`,
  device: `
    SELECT i.id, c.credential_version
    FROM solar_installations i JOIN device_credentials c ON c.installation_id = i.id
    WHERE i.id = $1`,
  provisioner: 'SELECT id, credential_version FROM provisioners WHERE id = $1',
};

function toPrincipal(type, row) {
  if (type !== 'staff') return { type, id: row.id };
  // provinceId is the province the user may read: their own, or their district's. districtId is
  // set only for district users.
  return {
    type,
    id: row.id,
    role: row.role,
    provinceId: row.role === 'district' ? row.district_province_id : row.province_id,
    districtId: row.district_id,
  };
}

function invalidToken() {
  return new ApiError(ERRORS.INVALID_TOKEN, {
    headers: { 'WWW-Authenticate': `${REALM}, error="invalid_token"` },
  });
}

// Sets req.principal from a valid bearer token, or responds 401.
async function authenticate(req, res, next) {
  const header = req.get('Authorization');
  if (header === undefined) {
    throw new ApiError(ERRORS.AUTHENTICATION_REQUIRED, { headers: { 'WWW-Authenticate': REALM } });
  }

  const match = BEARER.exec(header);
  if (!match) throw invalidToken();

  const claims = verifyToken(match[1]);
  if (!claims) throw invalidToken();

  const row = (await pool.query(LOADERS[claims.type], [claims.id])).rows[0];
  if (!row || row.credential_version !== claims.credentialVersion) throw invalidToken();

  req.principal = toPrincipal(claims.type, row);
  next();
}

// 403 unless the authenticated principal is one of the given types.
function requirePrincipal(...types) {
  return (req, res, next) => {
    if (types.includes(req.principal.type)) return next();
    next(new ApiError(ERRORS.FORBIDDEN));
  };
}

module.exports = { authenticate, requirePrincipal };
