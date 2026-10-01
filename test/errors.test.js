const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const app = require('../src/app');
const { ERRORS, ApiError, detail } = require('../src/errors');
const { errorHandler, notFound } = require('../src/middleware/errors');

// Start an app on a free port and return its base URL and a close function.
async function serve(expressApp) {
  const server = await new Promise((resolve) => {
    const s = expressApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function assertError(res, error) {
  assert.equal(res.status, error.status);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ['code', 'message', 'details']);
  assert.equal(body.code, error.code);
  assert.equal(typeof body.message, 'string');
  assert.ok(Array.isArray(body.details));
  for (const item of body.details) {
    assert.deepEqual(Object.keys(item), ['location', 'field', 'issue']);
  }
  return body;
}

describe('application routes', () => {
  let server;
  before(async () => {
    server = await serve(app);
  });
  after(() => server.close());

  test('GET / still returns the status response', async () => {
    const res = await fetch(`${server.url}/`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });

  test('HEAD / is allowed', async () => {
    const res = await fetch(`${server.url}/`, { method: 'HEAD' });
    assert.equal(res.status, 200);
  });

  test('Swagger UI is still served at /api-docs', async () => {
    const page = await fetch(`${server.url}/api-docs/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.match(await page.text(), /swagger-ui/);

    const asset = await fetch(`${server.url}/api-docs/swagger-ui.css`);
    assert.equal(asset.status, 200);
  });

  test('every response says nosniff and does not name the framework', async () => {
    for (const path of ['/', '/api-docs/', '/no-such-route', '/solar/v1.0/provinces']) {
      const res = await fetch(`${server.url}${path}`);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
      assert.equal(res.headers.get('x-powered-by'), null, path);
    }
  });

  test('an unknown route returns 404 in the error format', async () => {
    const res = await fetch(`${server.url}/no-such-route?x=1`);
    const body = await assertError(res, ERRORS.RESOURCE_NOT_FOUND);
    assert.deepEqual(body.details, [detail('path', null, 'No endpoint matches /no-such-route.')]);
  });

  test('an unknown route returns 404 for other methods too', async () => {
    const res = await fetch(`${server.url}/no-such-route`, { method: 'DELETE' });
    await assertError(res, ERRORS.RESOURCE_NOT_FOUND);
  });

  test('an unsupported method on / returns 405 with Allow', async () => {
    const res = await fetch(`${server.url}/`, { method: 'POST' });
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
    const body = await assertError(res, ERRORS.METHOD_NOT_ALLOWED);
    assert.equal(body.details[0].location, 'method');
  });

  test('malformed JSON returns 400', async () => {
    const res = await fetch(`${server.url}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"powerKw": 1.5,',
    });
    const body = await assertError(res, ERRORS.MALFORMED_JSON);
    assert.equal(body.details[0].location, 'body');
    assert.equal(body.details[0].field, null);
  });

  test('a JSON body that is not an object or array returns 400', async () => {
    const res = await fetch(`${server.url}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '"just a string"',
    });
    await assertError(res, ERRORS.MALFORMED_JSON);
  });

  test('malformed JSON is reported before routing, even on an unknown path', async () => {
    const res = await fetch(`${server.url}/no-such-route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    await assertError(res, ERRORS.MALFORMED_JSON);
  });

  test('a body over the size limit returns 413', async () => {
    const res = await fetch(`${server.url}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(200 * 1024) }),
    });
    const body = await assertError(res, ERRORS.BODY_TOO_LARGE);
    assert.equal(body.details[0].issue, 'The body must not exceed 102400 bytes.');
  });

  test('an unsupported JSON charset returns 415', async () => {
    const res = await fetch(`${server.url}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=latin1' },
      body: '{}',
    });
    await assertError(res, ERRORS.UNSUPPORTED_BODY_ENCODING);
  });

  test('an unsupported content encoding returns 415', async () => {
    const res = await fetch(`${server.url}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'br-unknown' },
      body: '{}',
    });
    await assertError(res, ERRORS.UNSUPPORTED_BODY_ENCODING);
  });
});

describe('error handler', () => {
  let server;
  const logged = [];
  const originalConsoleError = console.error;

  before(async () => {
    const testApp = express();
    testApp.get('/api-error', () => {
      throw new ApiError(ERRORS.RESOURCE_NOT_FOUND, {
        message: 'Installation not found.',
        details: [detail('path', 'installation-id', 'No installation has this ID.')],
      });
    });
    testApp.get('/crash', () => {
      throw new Error('connection to postgres://admin:secret@db failed');
    });
    testApp.get('/async-crash', async () => {
      throw new Error('async failure with secret detail');
    });
    testApp.get('/thrown-string', () => {
      throw 'not an Error object';
    });
    testApp.get('/bad-encoding/:id', (req, res) => res.json(req.params));
    testApp.use(notFound);
    testApp.use(errorHandler);
    server = await serve(testApp);
    console.error = (...args) => logged.push(args);
  });

  after(async () => {
    console.error = originalConsoleError;
    await server.close();
  });

  test('an ApiError keeps its status, code, message, and details', async () => {
    const res = await fetch(`${server.url}/api-error`);
    const body = await assertError(res, ERRORS.RESOURCE_NOT_FOUND);
    assert.equal(body.message, 'Installation not found.');
    assert.deepEqual(body.details, [detail('path', 'installation-id', 'No installation has this ID.')]);
  });

  for (const path of ['/crash', '/async-crash', '/thrown-string']) {
    test(`an unexpected error at ${path} returns a generic 500`, async () => {
      const before = logged.length;
      const res = await fetch(`${server.url}${path}`);
      const text = await res.text();
      assert.equal(res.status, 500);
      assert.deepEqual(JSON.parse(text), {
        code: ERRORS.INTERNAL_ERROR.code,
        message: ERRORS.INTERNAL_ERROR.message,
        details: [],
      });
      assert.doesNotMatch(text, /secret|postgres|Error:|at /);
      assert.equal(logged.length, before + 1, 'the real error is logged on the server');
    });
  }

  test('a badly encoded path parameter returns 400', async () => {
    const res = await fetch(`${server.url}/bad-encoding/%E0%A4%A`);
    const body = await assertError(res, ERRORS.INVALID_REQUEST);
    assert.equal(body.details[0].location, 'request');
  });
});
