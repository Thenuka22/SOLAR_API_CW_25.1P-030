require('dotenv').config({ quiet: true });

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const Ajv = require('ajv');
const SwaggerParser = require('@apidevtools/swagger-parser');
const app = require('../src/app');
const spec = require('../src/config/swagger');
const { startApiFixture } = require('../test_support/apiFixture');

const OPERATIONS = {
  '/': { get: ['200'] },
  '/solar/v1.0/issue-token': { post: ['200', '400', '406', '413', '415', '429', '500'] },
  '/solar/v1.0/provinces': { get: ['200', '304', '400', '401', '403', '406', '500'] },
  '/solar/v1.0/provinces/{province-id}': {
    get: ['200', '304', '400', '401', '403', '404', '406', '500'],
  },
  '/solar/v1.0/provinces/{province-id}/districts': {
    get: ['200', '304', '400', '401', '403', '404', '406', '500'],
  },
  '/solar/v1.0/districts/{district-id}': {
    get: ['200', '304', '400', '401', '403', '404', '406', '500'],
  },
  '/solar/v1.0/districts/{district-id}/grid-substations': {
    get: ['200', '304', '400', '401', '403', '404', '406', '500'],
  },
  '/solar/v1.0/grid-substations/{substation-id}': {
    get: ['200', '304', '400', '401', '403', '404', '406', '500'],
  },
  '/solar/v1.0/grid-substations/{substation-id}/installations': {
    get: ['200', '304', '400', '401', '403', '404', '406', '500'],
    post: ['201', '400', '401', '403', '404', '406', '409', '413', '415', '500'],
  },
  '/solar/v1.0/installations/{installation-id}': {
    get: ['200', '304', '400', '401', '403', '404', '406', '500'],
  },
};

describe('OpenAPI contract for implemented endpoints', () => {
  let validated;
  before(async () => { validated = await SwaggerParser.validate(spec); });

  test('the full document validates and contains exactly the implemented operations', () => {
    assert.equal(validated.openapi, '3.0.3');
    assert.deepEqual(Object.keys(validated.paths).sort(), Object.keys(OPERATIONS).sort());
    for (const [route, methods] of Object.entries(OPERATIONS)) {
      assert.deepEqual(Object.keys(validated.paths[route]).sort(), Object.keys(methods).sort(), route);
      for (const [method, statuses] of Object.entries(methods)) {
        const responses = validated.paths[route][method].responses;
        for (const status of statuses) assert.ok(responses[status], `${method.toUpperCase()} ${route}: ${status}`);
      }
    }
  });

  test('the route scan works when Node starts outside the repository', () => {
    const modulePath = require.resolve('../src/config/swagger');
    const child = spawnSync(process.execPath, ['-e',
      'const spec = require(process.argv[1]); process.stdout.write(JSON.stringify(Object.keys(spec.paths)));',
      modulePath,
    ], { cwd: os.tmpdir(), encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout).sort(), Object.keys(OPERATIONS).sort());
  });

  test('token request examples satisfy the same one-of schema as valid client requests', () => {
    // Ajv compiles JSON Schema; OpenAPI's discriminator mapping is valid in OpenAPI but not an
    // Ajv keyword. Validation still works through the three distinct principalType enums.
    const schema = structuredClone(validated.components.schemas.TokenRequest);
    delete schema.discriminator;
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(schema);
    const examples = validated.paths['/solar/v1.0/issue-token'].post
      .requestBody.content['application/json'].examples;
    for (const [name, example] of Object.entries(examples)) {
      assert.equal(validate(example.value), true, `${name}: ${JSON.stringify(validate.errors)}`);
    }
    for (const invalid of [
      {},
      { principalType: 'unknown', email: 'reader@example.test', password: 'password' },
      { principalType: 'staff', email: 'reader@example.test' },
      { principalType: 'staff', email: 'reader@example.test', password: 'password', meterId: 'MTR-1' },
      { principalType: 'device', meterId: 'MTR-1', deviceSecret: 'short' },
      { principalType: 'provisioner', username: 'admin', password: '' },
    ]) {
      assert.equal(validate(invalid), false, JSON.stringify(invalid));
    }
  });

  test('protected reads and response validators are described on the correct operations', () => {
    const list = validated.paths['/solar/v1.0/provinces'].get;
    const single = validated.paths['/solar/v1.0/provinces/{province-id}'].get;
    assert.deepEqual(list.security, [{ bearerAuth: [] }]);
    assert.deepEqual(single.security, [{ bearerAuth: [] }]);
    assert.equal(validated.components.securitySchemes.bearerAuth.scheme, 'bearer');
    assert.ok(list.responses['200'].headers.ETag);
    assert.equal(list.responses['200'].headers['Last-Modified'], undefined);
    assert.ok(single.responses['200'].headers['Last-Modified']);
    assert.ok(single.parameters.some((parameter) => parameter.name === 'If-Modified-Since'));
    assert.ok(list.parameters.every((parameter) => parameter.name !== 'If-Modified-Since'));
    assert.equal(validated.paths['/solar/v1.0/issue-token'].post.security, undefined);
    assert.ok(validated.paths['/solar/v1.0/issue-token'].post.responses['200'].headers['Cache-Control']);
  });
});

describe('Swagger UI', () => {
  let server;
  let url;
  before(async () => {
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });

  test('the served Swagger script includes the documented paths', async () => {
    const page = await fetch(`${url}/api-docs/`);
    assert.equal(page.status, 200);
    const init = await fetch(`${url}/api-docs/swagger-ui-init.js`);
    assert.equal(init.status, 200);
    const script = await init.text();
    for (const route of Object.keys(OPERATIONS)) {
      if (route !== '/') assert.ok(script.includes(route), route);
    }
  });
});

describe('live responses match their documented operation', {
  skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is not set',
}, () => {
  let fixture;
  let document;
  before(async () => {
    fixture = await startApiFixture();
    document = await SwaggerParser.validate(spec);
  });
  after(async () => { if (fixture) await fixture.close(); });

  test('success, client-error, and conditional responses have documented shapes and headers', async () => {
    const national = fixture.token('staff', fixture.staff.national);
    const provincial = fixture.token('staff', fixture.staff.provincial);
    const device = fixture.token('device', fixture.device);
    const base = `${fixture.url}/solar/v1.0`;
    const post = (body) => fetch(`${base}/issue-token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const read = (route, token, headers = {}) => fetch(`${base}${route}`, {
      headers: token ? { Authorization: `Bearer ${token}`, ...headers } : headers,
    });
    const send = (method, route, token, body) => fetch(`${base}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const list = await read('/provinces', national);
    const tag = list.headers.get('etag');
    const districts = await read(`/provinces/${fixture.westernId}/districts`, provincial);
    const districtsTag = districts.headers.get('etag');
    const { id: colomboId } = (await fixture.db.query("SELECT id FROM districts WHERE name = 'Colombo'")).rows[0];
    const { id: galleSubstationId } = (await fixture.db.query(
      "SELECT s.id FROM grid_substations s JOIN districts d ON d.id = s.district_id WHERE d.name = 'Galle' LIMIT 1",
    )).rows[0];
    const provisioner = fixture.token('provisioner', fixture.provisioner);
    const cases = [
      ['/', 'get', await fetch(`${fixture.url}/`)],
      ['/solar/v1.0/issue-token', 'post', await post({
        principalType: 'staff', email: fixture.staff.national.email, password: fixture.password,
      })],
      ['/solar/v1.0/issue-token', 'post', await post({
        principalType: 'staff', email: fixture.staff.national.email, password: 'wrong password value',
      })],
      ['/solar/v1.0/issue-token', 'post', await post({ principalType: 'unknown' })],
      ['/solar/v1.0/provinces', 'get', list],
      ['/solar/v1.0/provinces', 'get', await read('/provinces', national, { 'If-None-Match': tag })],
      ['/solar/v1.0/provinces', 'get', await read('/provinces')],
      ['/solar/v1.0/provinces', 'get', await read('/provinces', device)],
      ['/solar/v1.0/provinces', 'get', await read('/provinces?limit=0', national)],
      ['/solar/v1.0/provinces/{province-id}', 'get', await read(`/provinces/${fixture.westernId}`, provincial)],
      ['/solar/v1.0/provinces/{province-id}', 'get', await read(`/provinces/${fixture.southernId}`, provincial)],
      ['/solar/v1.0/provinces/{province-id}', 'get', await read('/provinces/not-a-uuid', provincial)],
      ['/solar/v1.0/provinces/{province-id}/districts', 'get', districts],
      ['/solar/v1.0/provinces/{province-id}/districts', 'get',
        await read(`/provinces/${fixture.westernId}/districts`, provincial, { 'If-None-Match': districtsTag })],
      ['/solar/v1.0/provinces/{province-id}/districts', 'get', await read(`/provinces/${fixture.southernId}/districts`, provincial)],
      ['/solar/v1.0/districts/{district-id}', 'get', await read(`/districts/${colomboId}`, provincial)],
      ['/solar/v1.0/districts/{district-id}', 'get', await read(`/districts/${colomboId}`, device)],
      ['/solar/v1.0/districts/{district-id}/grid-substations', 'get', await read(`/districts/${colomboId}/grid-substations`, provincial)],
      ['/solar/v1.0/districts/{district-id}/grid-substations', 'get', await read(`/districts/${colomboId}/grid-substations?limit=x`, provincial)],
      ['/solar/v1.0/grid-substations/{substation-id}', 'get', await read(`/grid-substations/${galleSubstationId}`, provisioner)],
      ['/solar/v1.0/grid-substations/{substation-id}', 'get', await read(`/grid-substations/${galleSubstationId}`, provincial)],
      ['/solar/v1.0/grid-substations/{substation-id}', 'get', await read(`/grid-substations/${galleSubstationId}`)],
      ['/solar/v1.0/grid-substations/{substation-id}/installations', 'get',
        await read(`/grid-substations/${galleSubstationId}/installations`, provisioner)],
      ['/solar/v1.0/grid-substations/{substation-id}/installations', 'get',
        await read(`/grid-substations/${galleSubstationId}/installations`, provincial)],
      ['/solar/v1.0/installations/{installation-id}', 'get', await read(`/installations/${fixture.device.id}`, provincial)],
      ['/solar/v1.0/installations/{installation-id}', 'get', await read(`/installations/${fixture.device.id}`, device)],
      ['/solar/v1.0/grid-substations/{substation-id}/installations', 'post',
        await send('POST', `/grid-substations/${galleSubstationId}/installations`, provisioner, { meterId: 'OPENAPI-TEST-1', capacityKw: 4.4 })],
      ['/solar/v1.0/grid-substations/{substation-id}/installations', 'post',
        await send('POST', `/grid-substations/${galleSubstationId}/installations`, provisioner, { meterId: 'OPENAPI-TEST-2' })],
      ['/solar/v1.0/grid-substations/{substation-id}/installations', 'post',
        await send('POST', `/grid-substations/${galleSubstationId}/installations`, national, { meterId: 'OPENAPI-TEST-3', capacityKw: 1 })],
    ];

    const ajv = new Ajv({ strict: false, validateFormats: false });
    for (const [route, method, response] of cases) {
      const documented = document.paths[route][method].responses[String(response.status)];
      assert.ok(documented, `${method.toUpperCase()} ${route} returned undocumented ${response.status}`);
      for (const name of Object.keys(documented.headers ?? {})) {
        if (name === 'Last-Modified' && !response.headers.has(name)) continue; // may be ahead of clock
        assert.ok(response.headers.has(name), `${method.toUpperCase()} ${route} ${response.status}: ${name}`);
      }
      const content = documented.content?.['application/json'];
      if (!content) {
        assert.equal(await response.text(), '', `${method.toUpperCase()} ${route}: expected no body`);
      } else {
        assert.match(response.headers.get('content-type'), /^application\/json/);
        const body = await response.json();
        const valid = ajv.compile(content.schema);
        assert.equal(valid(body), true,
          `${method.toUpperCase()} ${route} ${response.status}: ${JSON.stringify(valid.errors)}`);
      }
    }
  });
});
