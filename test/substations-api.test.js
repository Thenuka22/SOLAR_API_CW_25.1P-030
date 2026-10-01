require('dotenv').config({ quiet: true });

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApiFixture } = require('../test_support/apiFixture');

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('scoped substation reads', { skip }, () => {
  let fixture;
  let colomboId;
  let gampahaId;
  let galleId;
  let colomboSubstationIds;
  let gampahaSubstationId;
  let galleSubstationId;
  before(async () => {
    fixture = await startApiFixture();
    const ids = async (sql, params) => (await fixture.db.query(sql, params)).rows.map((row) => row.id);
    [colomboId] = await ids("SELECT id FROM districts WHERE name = 'Colombo'");
    [gampahaId] = await ids("SELECT id FROM districts WHERE name = 'Gampaha'");
    [galleId] = await ids("SELECT id FROM districts WHERE name = 'Galle'");
    colomboSubstationIds = await ids('SELECT id FROM grid_substations WHERE district_id = $1 ORDER BY id', [colomboId]);
    [gampahaSubstationId] = await ids('SELECT id FROM grid_substations WHERE district_id = $1 LIMIT 1', [gampahaId]);
    [galleSubstationId] = await ids('SELECT id FROM grid_substations WHERE district_id = $1 LIMIT 1', [galleId]);
  });
  after(async () => { if (fixture) await fixture.close(); });

  function read(path, token, headers = {}, method = 'GET') {
    return fetch(`${fixture.url}/solar/v1.0${path}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}`, ...headers } : headers,
    });
  }
  const staffToken = (role) => fixture.token('staff', fixture.staff[role]);
  const provisionerToken = () => fixture.token('provisioner', fixture.provisioner);

  test('every staff role lists the substations of a district in its scope', async () => {
    assert.ok(colomboSubstationIds.length > 1);
    for (const role of ['national', 'provincial', 'district']) {
      const res = await read(`/districts/${colomboId}/grid-substations`, staffToken(role));
      assert.equal(res.status, 200, role);
      const page = await res.json();
      assert.equal(page.count, colomboSubstationIds.length, role);
      assert.deepEqual(page.results.map((item) => item.id), colomboSubstationIds, role);
      for (const item of page.results) {
        assert.deepEqual(Object.keys(item), ['id', 'districtId', 'name']);
        assert.equal(item.districtId, colomboId);
      }
    }
  });

  test('districts and substations outside the scope get the same 404 as missing ones', async () => {
    const cases = [
      // [role, hidden district, hidden substation]
      ['provincial', galleId, galleSubstationId],
      ['district', gampahaId, gampahaSubstationId],
    ];
    for (const [role, hiddenDistrict, hiddenSubstation] of cases) {
      const token = staffToken(role);
      const hiddenList = await read(`/districts/${hiddenDistrict}/grid-substations`, token);
      const missingList = await read(`/districts/${MISSING}/grid-substations`, token);
      assert.equal(hiddenList.status, 404, role);
      assert.equal(missingList.status, 404, role);
      assert.equal(await hiddenList.text(), await missingList.text(), role);

      const hidden = await read(`/grid-substations/${hiddenSubstation}`, token, { 'If-None-Match': '*' });
      const missing = await read(`/grid-substations/${MISSING}`, token);
      assert.equal(hidden.status, 404, role);
      assert.equal(missing.status, 404, role);
      assert.equal(hidden.headers.get('etag'), null, role);
      assert.equal(await hidden.text(), await missing.text(), role);
    }
    // The provincial reader still sees a sibling district's substation in their province.
    assert.equal((await read(`/grid-substations/${gampahaSubstationId}`, staffToken('provincial'))).status, 200);
    assert.equal((await read(`/grid-substations/${galleSubstationId}`, staffToken('national'))).status, 200);
  });

  test('a district reader reads their own substation', async () => {
    const res = await read(`/grid-substations/${colomboSubstationIds[0]}`, staffToken('district'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ['id', 'districtId', 'name']);
    assert.equal(body.id, colomboSubstationIds[0]);
    assert.equal(body.districtId, colomboId);
  });

  test('a provisioner may read any individual substation but not the district collection', async () => {
    const token = provisionerToken();
    for (const id of [galleSubstationId, colomboSubstationIds[0]]) {
      const res = await read(`/grid-substations/${id}`, token);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).id, id);
    }
    assert.equal((await read(`/grid-substations/${MISSING}`, token)).status, 404);
    assert.equal((await read(`/districts/${colomboId}/grid-substations`, token)).status, 403);
  });

  test('a device may read neither', async () => {
    const token = fixture.token('device', fixture.device);
    assert.equal((await read(`/grid-substations/${colomboSubstationIds[0]}`, token)).status, 403);
    assert.equal((await read(`/districts/${colomboId}/grid-substations`, token)).status, 403);
  });

  test('a visible district with no substations returns an empty page', async () => {
    await fixture.db.query('SAVEPOINT empty_district');
    try {
      const { id } = (await fixture.db.query(
        "INSERT INTO districts (province_id, name) VALUES ($1, 'Empty Test District') RETURNING id",
        [fixture.westernId],
      )).rows[0];
      for (const role of ['national', 'provincial']) {
        const res = await read(`/districts/${id}/grid-substations`, staffToken(role));
        assert.equal(res.status, 200, role);
        assert.deepEqual(await res.json(), { count: 0, next: null, previous: null, results: [] }, role);
      }
      // A district reader cannot see this sibling district at all.
      assert.equal((await read(`/districts/${id}/grid-substations`, staffToken('district'))).status, 404);
    } finally {
      await fixture.db.query('ROLLBACK TO SAVEPOINT empty_district');
    }
  });

  test('pagination keeps the page size and the count', async () => {
    const token = staffToken('national');
    const base = `/solar/v1.0/districts/${colomboId}/grid-substations`;
    const first = await (await read(`/districts/${colomboId}/grid-substations?limit=1`, token)).json();
    assert.equal(first.count, colomboSubstationIds.length);
    assert.deepEqual(first.results.map((item) => item.id), [colomboSubstationIds[0]]);
    assert.equal(first.previous, null);
    assert.equal(first.next, `${base}?offset=1&limit=1`);
    const lastOffset = colomboSubstationIds.length - 1;
    const last = await (await read(`/districts/${colomboId}/grid-substations?offset=${lastOffset}&limit=1`, token)).json();
    assert.deepEqual(last.results.map((item) => item.id), [colomboSubstationIds[lastOffset]]);
    assert.equal(last.next, null);
    assert.equal(last.previous, `${base}?offset=${lastOffset - 1}&limit=1`);
  });

  test('authentication and principal type are checked before input', async () => {
    const list = '/districts/not-a-uuid/grid-substations';
    const single = '/grid-substations/not-a-uuid';
    for (const path of [list, single]) assert.equal((await read(path)).status, 401, path);
    assert.equal((await read(list, provisionerToken())).status, 403);
    assert.equal((await read(single, fixture.token('device', fixture.device))).status, 403);
    for (const [path, token] of [[list, staffToken('national')], [single, provisionerToken()]]) {
      const res = await read(path, token);
      assert.equal(res.status, 400, path);
      assert.equal((await res.json()).code, 2001, path);
    }
    assert.equal((await read(`/grid-substations/${galleSubstationId}?limit=1`, staffToken('national'))).status, 400);
  });

  test('validators: ETag on both, Last-Modified only on the single substation', async () => {
    const token = staffToken('district');
    const list = await read(`/districts/${colomboId}/grid-substations`, token);
    assert.equal(list.headers.get('last-modified'), null);
    assert.equal(list.headers.get('cache-control'), 'private, no-cache');
    assert.equal(list.headers.get('vary'), 'Authorization');
    const listAgain = await read(`/districts/${colomboId}/grid-substations`, token, {
      'If-None-Match': list.headers.get('etag'),
    });
    assert.equal(listAgain.status, 304);

    const id = colomboSubstationIds[0];
    const single = await read(`/grid-substations/${id}`, token);
    const tag = single.headers.get('etag');
    assert.equal((await read(`/grid-substations/${id}`, token, { 'If-None-Match': tag })).status, 304);
    const lastModified = single.headers.get('last-modified');
    if (lastModified) {
      assert.equal((await read(`/grid-substations/${id}`, token, { 'If-Modified-Since': lastModified })).status, 304);
    }

    await fixture.db.query('SAVEPOINT rename_substation');
    try {
      await fixture.db.query("UPDATE grid_substations SET name = 'Renamed Test Substation' WHERE id = $1", [id]);
      const changed = await read(`/grid-substations/${id}`, token, { 'If-None-Match': tag });
      assert.equal(changed.status, 200);
      assert.equal((await changed.json()).name, 'Renamed Test Substation');
      if (lastModified) {
        assert.equal((await read(`/grid-substations/${id}`, token, { 'If-Modified-Since': lastModified })).status, 200);
      }
    } finally {
      await fixture.db.query('ROLLBACK TO SAVEPOINT rename_substation');
    }
  });

  test('HEAD and unsupported methods behave as documented', async () => {
    const token = staffToken('national');
    const head = await read(`/grid-substations/${galleSubstationId}`, token, {}, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    for (const path of [`/districts/${colomboId}/grid-substations`, `/grid-substations/${galleSubstationId}`]) {
      const res = await read(path, token, {}, 'DELETE');
      assert.equal(res.status, 405, path);
      assert.equal(res.headers.get('allow'), 'GET, HEAD', path);
    }
  });
});
