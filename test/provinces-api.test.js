require('dotenv').config({ quiet: true });

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApiFixture } = require('./helpers/apiFixture');

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

describe('scoped province reads and conditional requests', { skip }, () => {
  let fixture;
  before(async () => { fixture = await startApiFixture(); });
  after(async () => { if (fixture) await fixture.close(); });

  function read(path, token, headers = {}, method = 'GET') {
    return fetch(`${fixture.url}/solar/v1.0${path}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}`, ...headers } : headers,
    });
  }
  const staffToken = (role) => fixture.token('staff', fixture.staff[role]);

  test('national, provincial, and district readers see only their jurisdictions', async () => {
    const national = await read('/provinces', staffToken('national'));
    assert.equal(national.status, 200);
    const all = await national.json();
    assert.equal(all.count, 9);
    assert.equal(all.results.length, 9);
    assert.deepEqual(all.results.map((item) => item.id),
      [...all.results.map((item) => item.id)].sort());

    for (const role of ['provincial', 'district']) {
      const res = await read('/provinces', staffToken(role));
      assert.equal(res.status, 200);
      const page = await res.json();
      assert.equal(page.count, 1);
      assert.deepEqual(page.results.map((item) => item.id), [fixture.westernId]);

      const hidden = await read(`/provinces/${fixture.southernId}`, staffToken(role));
      const missing = await read('/provinces/00000000-0000-4000-8000-000000000000', staffToken(role));
      assert.equal(hidden.status, 404);
      assert.equal(missing.status, 404);
      assert.equal(await hidden.text(), await missing.text());
      assert.equal(hidden.headers.get('etag'), null);
    }
  });

  test('pagination preserves the page size and reports the full scoped count', async () => {
    const token = staffToken('national');
    const first = await read('/provinces?offset=0&limit=4', token);
    const firstPage = await first.json();
    assert.equal(firstPage.count, 9);
    assert.equal(firstPage.results.length, 4);
    assert.equal(firstPage.previous, null);
    assert.equal(firstPage.next, '/solar/v1.0/provinces?offset=4&limit=4');

    const secondPage = await (await read(firstPage.next.slice('/solar/v1.0'.length), token)).json();
    assert.equal(secondPage.results.length, 4);
    assert.equal(secondPage.previous, '/solar/v1.0/provinces?offset=0&limit=4');
    assert.equal(secondPage.next, '/solar/v1.0/provinces?offset=8&limit=4');

    const lastPage = await (await read(secondPage.next.slice('/solar/v1.0'.length), token)).json();
    assert.equal(lastPage.results.length, 1);
    assert.equal(lastPage.next, null);

    const beyond = await (await read('/provinces?offset=100&limit=4', token)).json();
    assert.equal(beyond.count, 9);
    assert.deepEqual(beyond.results, []);
    assert.equal(beyond.next, null);
  });

  test('authentication and principal checks happen before input validation', async () => {
    const path = '/provinces?limit=invalid';
    assert.equal((await read(path)).status, 401);
    assert.equal((await read(path, fixture.token('device', fixture.device))).status, 403);
    assert.equal((await read(path, fixture.token('provisioner', fixture.provisioner))).status, 403);
    assert.equal((await read(path, staffToken('national'))).status, 400);
  });

  test('invalid queries and path IDs are rejected', async () => {
    const token = staffToken('national');
    for (const path of [
      '/provinces?offset=-1', '/provinces?offset=1.5', '/provinces?offset=01',
      '/provinces?limit=0', '/provinces?limit=201', '/provinces?limit=1&limit=2',
      '/provinces?unknown=1', `/provinces/${fixture.westernId}?limit=1`,
      '/provinces/not-a-uuid',
    ]) {
      const res = await read(path, token);
      assert.equal(res.status, 400, path);
      const body = await res.json();
      assert.equal(body.code, 2001, path);
    }
  });

  test('collection ETag handles conditional requests without an unsafe Last-Modified', async () => {
    const token = staffToken('national');
    const original = await read('/provinces', token);
    const etag = original.headers.get('etag');
    assert.match(etag, /^"[A-Za-z0-9_-]+"$/);
    assert.equal(original.headers.get('last-modified'), null);
    assert.equal(original.headers.get('cache-control'), 'private, no-cache');
    assert.equal(original.headers.get('vary'), 'Authorization');

    for (const tag of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const res = await read('/provinces', token, { 'If-None-Match': tag });
      assert.equal(res.status, 304);
      assert.equal(await res.text(), '');
      assert.equal(res.headers.get('etag'), etag);
    }
    const stale = await read('/provinces', token, { 'If-None-Match': '"stale"' });
    assert.equal(stale.status, 200);
    const sinceOnly = await read('/provinces', token, { 'If-Modified-Since': 'Wed, 01 Jan 2100 00:00:00 GMT' });
    assert.equal(sinceOnly.status, 200);
    const precedence = await read('/provinces', token, {
      'If-None-Match': '"stale"', 'If-Modified-Since': 'Wed, 01 Jan 2100 00:00:00 GMT',
    });
    assert.equal(precedence.status, 200);
  });

  test('a scope change immediately changes the collection for the same valid token', async () => {
    const token = staffToken('national');
    const beforeScopeChange = await read('/provinces', token);
    const oldTag = beforeScopeChange.headers.get('etag');
    await fixture.db.query('SAVEPOINT scope_change');
    try {
      await fixture.db.query(
        "UPDATE users SET role = 'provincial', province_id = $2 WHERE id = $1",
        [fixture.staff.national.id, fixture.westernId],
      );
      const changed = await read('/provinces', token, { 'If-None-Match': oldTag });
      assert.equal(changed.status, 200);
      const page = await changed.json();
      assert.equal(page.count, 1);
      assert.equal(page.results[0].id, fixture.westernId);
      assert.notEqual(changed.headers.get('etag'), oldTag);

      const sinceOnly = await read('/provinces', token, {
        'If-Modified-Since': 'Wed, 01 Jan 2100 00:00:00 GMT',
      });
      assert.equal(sinceOnly.status, 200);
    } finally {
      await fixture.db.query('ROLLBACK TO SAVEPOINT scope_change');
    }
  });

  test('single-province validators are checked only after the scoped query', async () => {
    const token = staffToken('provincial');
    const current = await read(`/provinces/${fixture.westernId}`, token);
    assert.equal(current.status, 200);
    assert.deepEqual(await current.json(), { id: fixture.westernId, name: 'Western' });
    const tag = current.headers.get('etag');
    assert.ok(tag);

    const notModified = await read(`/provinces/${fixture.westernId}`, token, { 'If-None-Match': tag });
    assert.equal(notModified.status, 304);
    assert.equal(await notModified.text(), '');

    const lastModified = current.headers.get('last-modified');
    if (lastModified) {
      const byDate = await read(`/provinces/${fixture.westernId}`, token, { 'If-Modified-Since': lastModified });
      assert.equal(byDate.status, 304);
      const earlier = new Date(Date.parse(lastModified) - 1000).toUTCString();
      assert.equal((await read(`/provinces/${fixture.westernId}`, token, { 'If-Modified-Since': earlier })).status, 200);
    }

    const hidden = await read(`/provinces/${fixture.southernId}`, token, { 'If-None-Match': tag });
    assert.equal(hidden.status, 404);
    assert.equal(hidden.headers.get('etag'), null);
  });

  test('HEAD, unsupported methods, and unacceptable media types behave as documented', async () => {
    const token = staffToken('national');
    const head = await read('/provinces', token, {}, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const unsupported = await read('/provinces', token, {}, 'DELETE');
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.get('allow'), 'GET, HEAD');
    assert.equal((await read('/provinces', token, { Accept: 'text/plain' })).status, 406);
  });
});
