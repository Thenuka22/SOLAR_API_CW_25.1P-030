require('dotenv').config({ quiet: true });

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { hashSecret } = require('../src/auth/credentialHash');
const { startApiFixture } = require('./helpers/apiFixture');

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
// The scope claim each principal type is granted, written out here independently of the code.
const SCOPES = {
  staff: 'hierarchy:read installations:read readings:read',
  device: 'readings:write',
  provisioner: 'installations:read installations:write',
};

describe('token issuance and bearer authentication', { skip }, () => {
  let fixture;
  before(async () => { fixture = await startApiFixture(); });
  after(async () => { if (fixture) await fixture.close(); });

  const tokenRequest = (body, headers = {}) => fetch(`${fixture.url}/solar/v1.0/issue-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const provinces = (token, headers = {}) => fetch(`${fixture.url}/solar/v1.0/provinces`, {
    headers: { Authorization: `Bearer ${token}`, ...headers },
  });

  test('all three principals receive the documented token claims and lifetimes', async () => {
    const cases = [
      ['staff', { email: () => fixture.staff.national.email, password: () => fixture.password }, 3600, () => fixture.staff.national],
      ['device', { meterId: () => fixture.device.meterId, deviceSecret: () => fixture.device.deviceSecret }, 3600, () => fixture.device],
      ['provisioner', { username: () => fixture.provisioner.username, password: () => fixture.password }, 900, () => fixture.provisioner],
    ];
    for (const [principalType, fields, lifetime, getPrincipal] of cases) {
      const body = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value()]));
      const res = await tokenRequest({ principalType, ...body });
      assert.equal(res.status, 200, principalType);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('pragma'), 'no-cache');
      const response = await res.json();
      assert.deepEqual(Object.keys(response).sort(), ['accessToken', 'expiresIn', 'scope', 'tokenType']);
      assert.equal(response.tokenType, 'Bearer');
      assert.equal(response.expiresIn, lifetime);
      assert.equal(response.scope, SCOPES[principalType]);
      const decoded = jwt.decode(response.accessToken, { complete: true });
      assert.equal(decoded.header.alg, 'HS256');
      assert.deepEqual(Object.keys(decoded.payload).sort(),
        ['aud', 'credentialVersion', 'exp', 'iat', 'iss', 'principalType', 'scope', 'sub']);
      assert.equal(decoded.payload.scope, SCOPES[principalType]);
      assert.equal(decoded.payload.principalType, principalType);
      assert.equal(decoded.payload.sub, getPrincipal().id);
      assert.equal(decoded.payload.credentialVersion, getPrincipal().credentialVersion);
      assert.equal(decoded.payload.exp - decoded.payload.iat, lifetime);
    }
  });

  test('wrong secret, unknown identifier, and missing credential have the same failure body', async () => {
    const unknown = await tokenRequest({
      principalType: 'staff', email: 'unknown-reader@example.test', password: fixture.password,
    });
    const wrong = await tokenRequest({
      principalType: 'staff', email: fixture.staff.national.email, password: 'incorrect password value',
    });
    await fixture.db.query('SAVEPOINT missing_credential');
    let noCredential;
    try {
      const row = (await fixture.db.query(
        "INSERT INTO users (name, email, role) VALUES ('No Credential', $1, 'national') RETURNING email",
        [`no-credential-${fixture.staff.national.id}@example.test`],
      )).rows[0];
      noCredential = await tokenRequest({
        principalType: 'staff', email: row.email, password: fixture.password,
      });
    } finally {
      await fixture.db.query('ROLLBACK TO SAVEPOINT missing_credential');
    }
    assert.equal(unknown.status, 400);
    assert.equal(wrong.status, 400);
    assert.equal(noCredential.status, 400);
    assert.equal(unknown.headers.get('www-authenticate'), null);
    const body = await unknown.text();
    assert.equal(body, await wrong.text());
    assert.equal(body, await noCredential.text());
  });

  test('token request validates shape, media type, and method', async () => {
    const invalid = await tokenRequest({
      principalType: 'staff', email: ' ', password: '', deviceSecret: 'not allowed',
    });
    assert.equal(invalid.status, 400);
    const fields = (await invalid.json()).details.map((item) => item.field);
    assert.deepEqual(fields.sort(), ['deviceSecret', 'email', 'password']);

    const unsupported = await fetch(`${fixture.url}/solar/v1.0/issue-token`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello',
    });
    assert.equal(unsupported.status, 415);
    const unacceptable = await tokenRequest({ principalType: 'staff' }, { Accept: 'text/plain' });
    assert.equal(unacceptable.status, 406);
    const method = await fetch(`${fixture.url}/solar/v1.0/issue-token`);
    assert.equal(method.status, 405);
    assert.equal(method.headers.get('allow'), 'POST');
  });

  test('missing, malformed, and tampered bearer tokens receive 401', async () => {
    const missing = await fetch(`${fixture.url}/solar/v1.0/provinces`);
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).code, 3002);
    assert.match(missing.headers.get('www-authenticate'), /^Bearer realm=/);

    const malformed = await provinces('not-a-jwt');
    assert.equal(malformed.status, 401);
    assert.equal((await malformed.json()).code, 3003);
    assert.match(malformed.headers.get('www-authenticate'), /invalid_token/);

    const valid = fixture.token('staff', fixture.staff.national);
    const tampered = `${valid.slice(0, -1)}${valid.endsWith('a') ? 'b' : 'a'}`;
    const rejected = await provinces(tampered);
    assert.equal(rejected.status, 401);
  });

  test('signature algorithm, issuer, audience, expiry, and claim types are enforced', async () => {
    const sign = (claims, options = {}) => jwt.sign(claims, fixture.jwtSecret, {
      algorithm: 'HS256', issuer: 'solar-generation-api', audience: 'solar-generation-api',
      subject: fixture.staff.national.id, expiresIn: 3600, ...options,
    });
    const base = {
      principalType: 'staff', credentialVersion: fixture.staff.national.credentialVersion, scope: SCOPES.staff,
    };
    // The hand-signed token is accepted, so each one below fails only for the reason named.
    assert.equal((await provinces(sign(base))).status, 200);
    const badTokens = [
      sign(base, { algorithm: 'HS512' }),
      sign(base, { issuer: 'other-issuer' }),
      sign(base, { audience: 'other-audience' }),
      sign(base, { expiresIn: -1 }),
      sign({ principalType: 'staff', scope: SCOPES.staff }),
      sign({ ...base, principalType: 'constructor' }),
      sign({ ...base, credentialVersion: 'not-a-uuid' }),
      sign(base, { expiresIn: 7200 }),
    ];
    for (const token of badTokens) {
      const res = await provinces(token);
      assert.equal(res.status, 401);
    }
  });

  test('a token must carry exactly the scopes its principal type is granted', async () => {
    const sign = (claims, subject) => jwt.sign(claims, fixture.jwtSecret, {
      algorithm: 'HS256', issuer: 'solar-generation-api', audience: 'solar-generation-api', subject, expiresIn: 3600,
    });
    const device = { principalType: 'device', credentialVersion: fixture.device.credentialVersion };
    for (const scope of [
      undefined, // no scope claim
      '',
      `${SCOPES.device} readings:read`, // a device granting itself read access
      SCOPES.staff,
      ['readings:write'], // not a string
    ]) {
      const res = await provinces(sign({ ...device, scope }, fixture.device.id));
      assert.equal(res.status, 401, JSON.stringify(scope));
      assert.equal((await res.json()).code, 3003);
    }
    // A staff token with fewer scopes than granted is rejected too, not treated as narrower.
    const staff = { principalType: 'staff', credentialVersion: fixture.staff.national.credentialVersion };
    assert.equal((await provinces(sign({ ...staff, scope: 'hierarchy:read' }, fixture.staff.national.id))).status, 401);
  });

  test('a missing scope gives 403 with an insufficient_scope challenge naming the scope', async () => {
    const call = (method, path, token) => fetch(`${fixture.url}/solar/v1.0${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}',
    });
    const staff = fixture.token('staff', fixture.staff.national);
    const device = fixture.token('device', fixture.device);
    const provisioner = fixture.token('provisioner', fixture.provisioner);
    const installation = `/installations/${fixture.device.id}`;
    for (const [method, path, token, scope] of [
      ['GET', '/provinces', device, 'hierarchy:read'],
      ['GET', '/provinces', provisioner, 'hierarchy:read'],
      ['GET', installation, device, 'installations:read'],
      ['PUT', installation, staff, 'installations:write'],
      ['DELETE', installation, device, 'installations:write'],
      ['GET', `${installation}/readings`, provisioner, 'readings:read'],
      ['GET', `${installation}/overview`, provisioner, 'readings:read'],
      ['POST', `${installation}/readings`, staff, 'readings:write'],
      ['POST', `${installation}/readings`, provisioner, 'readings:write'],
      ['POST', '/summarize-district-generation', device, 'readings:read'],
    ]) {
      const res = await call(method, path, token);
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal((await res.json()).code, 3004, `${method} ${path}`);
      assert.equal(res.headers.get('www-authenticate'),
        `Bearer realm="solar-generation-api", error="insufficient_scope", scope="${scope}"`, `${method} ${path}`);
    }
  });

  test('principal type is checked independently of the token signature', async () => {
    for (const [type, principal] of [
      ['device', fixture.device], ['provisioner', fixture.provisioner],
    ]) {
      const res = await provinces(fixture.token(type, principal));
      assert.equal(res.status, 403);
    }
    const confused = jwt.sign(
      { principalType: 'staff', credentialVersion: fixture.device.credentialVersion, scope: SCOPES.staff },
      fixture.jwtSecret,
      { algorithm: 'HS256', issuer: 'solar-generation-api', audience: 'solar-generation-api',
        subject: fixture.device.id, expiresIn: 3600 },
    );
    assert.equal((await provinces(confused)).status, 401);
  });

  test('changing a credential revokes a token issued in the same second', async () => {
    const oldToken = fixture.token('staff', fixture.staff.national);
    assert.equal((await provinces(oldToken)).status, 200);
    await fixture.db.query('SAVEPOINT rotate_credential');
    try {
      await fixture.db.query(
        'UPDATE user_credentials SET password_hash = $2 WHERE user_id = $1',
        [fixture.staff.national.id, await hashSecret('new long test password value')],
      );
      const rejected = await provinces(oldToken);
      assert.equal(rejected.status, 401);
      assert.equal((await rejected.json()).code, 3003);
    } finally {
      await fixture.db.query('ROLLBACK TO SAVEPOINT rotate_credential');
    }
  });

  test('five failed sign-ins limit an identifier without limiting another', async () => {
    const email = fixture.staff.provincial.email;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await tokenRequest({
        principalType: 'staff', email, password: 'incorrect password value',
      });
      assert.equal(res.status, 400);
    }
    const locked = await tokenRequest({
      principalType: 'staff', email: email.toUpperCase(), password: fixture.password,
    });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    assert.ok(locked.headers.get('ratelimit'));

    const other = await tokenRequest({
      principalType: 'staff', email: fixture.staff.district.email, password: fixture.password,
    });
    assert.equal(other.status, 200);
  });
});
