require('dotenv').config({ quiet: true });

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApiFixture } = require('../test_support/apiFixture');

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('scoped district reads', { skip }, () => {
  let fixture;
  let colomboId;
  let galleId;
  let westernDistrictIds;
  before(async () => {
    fixture = await startApiFixture();
    const ids = async (sql, params) => (await fixture.db.query(sql, params)).rows.map((row) => row.id);
    westernDistrictIds = await ids('SELECT id FROM districts WHERE province_id = $1 ORDER BY id', [fixture.westernId]);
    [colomboId] = await ids("SELECT id FROM districts WHERE name = 'Colombo'");
    [galleId] = await ids("SELECT id FROM districts WHERE name = 'Galle'");
  });
  after(async () => { if (fixture) await fixture.close(); });

  function read(path, token, headers = {}, method = 'GET') {
    return fetch(`${fixture.url}/solar/v1.0${path}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}`, ...headers } : headers,
    });
  }
  const staffToken = (role) => fixture.token('staff', fixture.staff[role]);

  test('national and provincial readers see every district of a visible province', async () => {
    for (const role of ['national', 'provincial']) {
      const res = await read(`/provinces/${fixture.westernId}/districts`, staffToken(role));
      assert.equal(res.status, 200, role);
      const page = await res.json();
      assert.equal(page.count, 3, role);
      assert.deepEqual(page.results.map((item) => item.id), westernDistrictIds, role);
      for (const item of page.results) {
        assert.deepEqual(Object.keys(item), ['id', 'provinceId', 'name']);
        assert.equal(item.provinceId, fixture.westernId);
      }
    }
    const southern = await read(`/provinces/${fixture.southernId}/districts`, staffToken('national'));
    assert.equal((await southern.json()).count, 3);
  });

  test('a district reader sees only their own district, not its siblings', async () => {
    const token = staffToken('district');
    const page = await (await read(`/provinces/${fixture.westernId}/districts`, token)).json();
    assert.equal(page.count, 1);
    assert.deepEqual(page.results.map((item) => item.id), [colomboId]);

    const own = await read(`/districts/${colomboId}`, token);
    assert.equal(own.status, 200);
    assert.deepEqual(await own.json(), { id: colomboId, provinceId: fixture.westernId, name: 'Colombo' });

    const sibling = westernDistrictIds.find((id) => id !== colomboId);
    const hidden = await read(`/districts/${sibling}`, token);
    const missing = await read(`/districts/${MISSING}`, token);
    assert.equal(hidden.status, 404);
    assert.equal(missing.status, 404);
    assert.equal(await hidden.text(), await missing.text());
  });

  test('out-of-scope provinces and districts get the same 404 as missing ones', async () => {
    for (const role of ['provincial', 'district']) {
      const token = staffToken(role);
      const hiddenParent = await read(`/provinces/${fixture.southernId}/districts`, token);
      const missingParent = await read(`/provinces/${MISSING}/districts`, token);
      assert.equal(hiddenParent.status, 404, role);
      assert.equal(missingParent.status, 404, role);
      assert.equal(await hiddenParent.text(), await missingParent.text(), role);
      assert.equal(hiddenParent.headers.get('etag'), null, role);

      const hidden = await read(`/districts/${galleId}`, token, { 'If-None-Match': '*' });
      assert.equal(hidden.status, 404, role);
      assert.equal(hidden.headers.get('etag'), null, role);
    }
    const visible = await read(`/districts/${galleId}`, staffToken('national'));
    assert.equal(visible.status, 200);
  });

  test('a visible province with no districts returns an empty page', async () => {
    await fixture.db.query('SAVEPOINT empty_province');
    try {
      const { id } = (await fixture.db.query(
        "INSERT INTO provinces (name) VALUES ('Empty Test Province') RETURNING id",
      )).rows[0];
      const res = await read(`/provinces/${id}/districts`, staffToken('national'));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { count: 0, next: null, previous: null, results: [] });
    } finally {
      await fixture.db.query('ROLLBACK TO SAVEPOINT empty_province');
    }
  });

  test('pagination keeps the page size and the scoped count', async () => {
    const token = staffToken('national');
    const { id: northernId } = (await fixture.db.query("SELECT id FROM provinces WHERE name = 'Northern'")).rows[0];
    const base = `/solar/v1.0/provinces/${northernId}/districts`;
    const first = await (await read(`/provinces/${northernId}/districts?limit=2`, token)).json();
    assert.equal(first.count, 5);
    assert.equal(first.results.length, 2);
    assert.equal(first.previous, null);
    assert.equal(first.next, `${base}?offset=2&limit=2`);

    const last = await (await read(`/provinces/${northernId}/districts?offset=4&limit=2`, token)).json();
    assert.equal(last.results.length, 1);
    assert.equal(last.next, null);
    assert.equal(last.previous, `${base}?offset=2&limit=2`);

    const all = await (await read(`/provinces/${northernId}/districts`, token)).json();
    assert.deepEqual([...first.results, ...last.results].map((item) => item.id),
      [all.results[0], all.results[1], all.results[4]].map((item) => item.id));

    const beyond = await (await read(`/provinces/${northernId}/districts?offset=50`, token)).json();
    assert.equal(beyond.count, 5);
    assert.deepEqual(beyond.results, []);
  });

  test('authentication and principal type are checked before input', async () => {
    for (const path of ['/provinces/not-a-uuid/districts', '/districts/not-a-uuid']) {
      assert.equal((await read(path)).status, 401, path);
      assert.equal((await read(path, fixture.token('device', fixture.device))).status, 403, path);
      assert.equal((await read(path, fixture.token('provisioner', fixture.provisioner))).status, 403, path);
      const invalid = await read(path, staffToken('national'));
      assert.equal(invalid.status, 400, path);
      assert.equal((await invalid.json()).code, 2001, path);
    }
    for (const path of [
      `/provinces/${fixture.westernId}/districts?limit=0`, `/provinces/${fixture.westernId}/districts?sort=name`,
      `/districts/${colomboId}?offset=0`,
    ]) {
      assert.equal((await read(path, staffToken('national'))).status, 400, path);
    }
  });

  test('district validators: ETag on both, Last-Modified only on the single district', async () => {
    const token = staffToken('provincial');
    const list = await read(`/provinces/${fixture.westernId}/districts`, token);
    const listTag = list.headers.get('etag');
    assert.ok(listTag);
    assert.equal(list.headers.get('last-modified'), null);
    assert.equal(list.headers.get('cache-control'), 'private, no-cache');
    assert.equal(list.headers.get('vary'), 'Authorization');
    const listAgain = await read(`/provinces/${fixture.westernId}/districts`, token, { 'If-None-Match': listTag });
    assert.equal(listAgain.status, 304);
    assert.equal(await listAgain.text(), '');
    const sinceOnly = await read(`/provinces/${fixture.westernId}/districts`, token, {
      'If-Modified-Since': 'Wed, 01 Jan 2100 00:00:00 GMT',
    });
    assert.equal(sinceOnly.status, 200);

    const single = await read(`/districts/${colomboId}`, token);
    const tag = single.headers.get('etag');
    const notModified = await read(`/districts/${colomboId}`, token, { 'If-None-Match': tag });
    assert.equal(notModified.status, 304);
    assert.equal(await notModified.text(), '');
    const lastModified = single.headers.get('last-modified');
    if (lastModified) {
      assert.equal((await read(`/districts/${colomboId}`, token, { 'If-Modified-Since': lastModified })).status, 304);
    }
  });

  test('renaming a district changes its validators', async () => {
    const token = staffToken('national');
    const before = await read(`/districts/${colomboId}`, token);
    const tag = before.headers.get('etag');
    const lastModified = before.headers.get('last-modified');
    await fixture.db.query('SAVEPOINT rename_district');
    try {
      await fixture.db.query("UPDATE districts SET name = 'Colombo Renamed' WHERE id = $1", [colomboId]);
      const changed = await read(`/districts/${colomboId}`, token, { 'If-None-Match': tag });
      assert.equal(changed.status, 200);
      assert.equal((await changed.json()).name, 'Colombo Renamed');
      if (lastModified) {
        const byDate = await read(`/districts/${colomboId}`, token, { 'If-Modified-Since': lastModified });
        assert.equal(byDate.status, 200);
      }
    } finally {
      await fixture.db.query('ROLLBACK TO SAVEPOINT rename_district');
    }
  });

  test('HEAD and unsupported methods behave as documented', async () => {
    const token = staffToken('national');
    const head = await read(`/districts/${colomboId}`, token, {}, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    for (const path of [`/provinces/${fixture.westernId}/districts`, `/districts/${colomboId}`]) {
      const res = await read(path, token, {}, 'POST');
      assert.equal(res.status, 405, path);
      assert.equal(res.headers.get('allow'), 'GET, HEAD', path);
    }
  });
});
