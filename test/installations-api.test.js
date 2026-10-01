require('dotenv').config({ quiet: true });

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApiFixture } = require('../test_support/apiFixture');

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const MISSING = '00000000-0000-4000-8000-000000000000';
const FIELDS = ['id', 'substationId', 'meterId', 'address', 'capacityKw'];

describe('installation metadata reads', { skip }, () => {
  let fixture;
  let colomboSubstationId;
  let colomboInstallationIds;
  let gampahaInstallation;
  let galleSubstationId;
  let galleInstallationId;
  before(async () => {
    fixture = await startApiFixture();
    const one = async (sql, params) => (await fixture.db.query(sql, params)).rows[0];
    // The fixture's own installation (no readings) is at a Colombo substation.
    ({ substation_id: colomboSubstationId } = await one(
      'SELECT substation_id FROM solar_installations WHERE id = $1', [fixture.device.id],
    ));
    colomboInstallationIds = (await fixture.db.query(
      'SELECT id FROM solar_installations WHERE substation_id = $1 ORDER BY id', [colomboSubstationId],
    )).rows.map((row) => row.id);
    gampahaInstallation = await one(
      `SELECT i.id FROM solar_installations i JOIN grid_substations s ON s.id = i.substation_id
       JOIN districts d ON d.id = s.district_id WHERE d.name = 'Gampaha' LIMIT 1`,
    );
    ({ id: galleInstallationId, substation_id: galleSubstationId } = await one(
      `SELECT i.id, i.substation_id FROM solar_installations i JOIN grid_substations s ON s.id = i.substation_id
       JOIN districts d ON d.id = s.district_id WHERE d.name = 'Galle' LIMIT 1`,
    ));
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

  test('staff in scope and the provisioner list a substation\'s installations as metadata only', async () => {
    for (const token of [staffToken('national'), staffToken('provincial'), staffToken('district'), provisionerToken()]) {
      const res = await read(`/grid-substations/${colomboSubstationId}/installations`, token);
      assert.equal(res.status, 200);
      const page = await res.json();
      assert.equal(page.count, colomboInstallationIds.length);
      assert.deepEqual(page.results.map((item) => item.id), colomboInstallationIds);
      for (const item of page.results) {
        assert.deepEqual(Object.keys(item), FIELDS);
        assert.equal(item.substationId, colomboSubstationId);
        assert.equal(typeof item.capacityKw, 'number');
      }
    }
  });

  test('a single installation returns its stored metadata and no measurements', async () => {
    const seeded = (await fixture.db.query(
      "SELECT id, substation_id, meter_id, address, capacity_kw FROM solar_installations WHERE meter_id = 'MTR-0010'",
    )).rows[0];
    const res = await read(`/installations/${seeded.id}`, staffToken('national'));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      id: seeded.id,
      substationId: seeded.substation_id,
      meterId: 'MTR-0010',
      address: null, // every tenth seeded installation has no address
      capacityKw: Number(seeded.capacity_kw),
    });

    const own = await (await read(`/installations/${fixture.device.id}`, staffToken('district'))).json();
    assert.deepEqual(own, {
      id: fixture.device.id, substationId: colomboSubstationId, meterId: fixture.device.meterId, address: null, capacityKw: 5,
    });
  });

  test('installations and substations outside the scope get the same 404 as missing ones', async () => {
    const cases = [
      ['provincial', galleSubstationId, galleInstallationId],
      ['district', galleSubstationId, gampahaInstallation.id],
    ];
    for (const [role, hiddenSubstation, hiddenInstallation] of cases) {
      const token = staffToken(role);
      const hiddenList = await read(`/grid-substations/${hiddenSubstation}/installations`, token);
      const missingList = await read(`/grid-substations/${MISSING}/installations`, token);
      assert.equal(hiddenList.status, 404, role);
      assert.equal(await hiddenList.text(), await missingList.text(), role);

      const hidden = await read(`/installations/${hiddenInstallation}`, token, { 'If-None-Match': '*' });
      const missing = await read(`/installations/${MISSING}`, token);
      assert.equal(hidden.status, 404, role);
      assert.equal(hidden.headers.get('etag'), null, role);
      assert.equal(await hidden.text(), await missing.text(), role);
    }
    assert.equal((await read(`/installations/${gampahaInstallation.id}`, staffToken('provincial'))).status, 200);
    assert.equal((await read(`/installations/${galleInstallationId}`, provisionerToken())).status, 200);
    assert.equal((await read(`/installations/${MISSING}`, provisionerToken())).status, 404);
  });

  test('a device may not read installation metadata, even its own', async () => {
    const token = fixture.token('device', fixture.device);
    assert.equal((await read(`/installations/${fixture.device.id}`, token)).status, 403);
    assert.equal((await read(`/grid-substations/${colomboSubstationId}/installations`, token)).status, 403);
  });

  test('a visible substation with no installations returns an empty page', async () => {
    await fixture.db.query('SAVEPOINT empty_substation');
    try {
      const { id } = (await fixture.db.query(
        "INSERT INTO grid_substations (district_id, name) VALUES ((SELECT id FROM districts WHERE name = 'Colombo'), 'Empty Test Substation') RETURNING id",
      )).rows[0];
      for (const token of [staffToken('district'), provisionerToken()]) {
        const res = await read(`/grid-substations/${id}/installations`, token);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { count: 0, next: null, previous: null, results: [] });
      }
    } finally {
      await fixture.db.query('ROLLBACK TO SAVEPOINT empty_substation');
    }
  });

  test('pagination keeps the page size and the count', async () => {
    const token = provisionerToken();
    const path = `/grid-substations/${colomboSubstationId}/installations`;
    const first = await (await read(`${path}?limit=2`, token)).json();
    assert.equal(first.count, colomboInstallationIds.length);
    assert.deepEqual(first.results.map((item) => item.id), colomboInstallationIds.slice(0, 2));
    assert.equal(first.previous, null);
    assert.equal(first.next, `/solar/v1.0${path}?offset=2&limit=2`);
    const second = await (await read(`${path}?offset=2&limit=2`, token)).json();
    assert.deepEqual(second.results.map((item) => item.id), colomboInstallationIds.slice(2, 4));
    assert.equal(second.previous, `/solar/v1.0${path}?offset=0&limit=2`);
  });

  test('authentication, principal type, and input checks', async () => {
    for (const path of ['/grid-substations/not-a-uuid/installations', '/installations/not-a-uuid']) {
      assert.equal((await read(path)).status, 401, path);
      assert.equal((await read(path, fixture.token('device', fixture.device))).status, 403, path);
      const invalid = await read(path, provisionerToken());
      assert.equal(invalid.status, 400, path);
      assert.equal((await invalid.json()).code, 2001, path);
    }
    assert.equal((await read(`/installations/${fixture.device.id}?limit=1`, staffToken('national'))).status, 400);
    assert.equal((await read(`/grid-substations/${colomboSubstationId}/installations?from=2026-09-01`, staffToken('national'))).status, 400);
  });

  test('validators: ETag on both, Last-Modified only on the single installation', async () => {
    const token = staffToken('provincial');
    const list = await read(`/grid-substations/${colomboSubstationId}/installations`, token);
    assert.equal(list.headers.get('last-modified'), null);
    assert.equal(list.headers.get('vary'), 'Authorization');
    const listAgain = await read(`/grid-substations/${colomboSubstationId}/installations`, token, {
      'If-None-Match': list.headers.get('etag'),
    });
    assert.equal(listAgain.status, 304);
    assert.equal(await listAgain.text(), '');

    const id = fixture.device.id;
    const single = await read(`/installations/${id}`, token);
    const tag = single.headers.get('etag');
    const lastModified = single.headers.get('last-modified');
    assert.equal((await read(`/installations/${id}`, token, { 'If-None-Match': tag })).status, 304);
    if (lastModified) {
      assert.equal((await read(`/installations/${id}`, token, { 'If-Modified-Since': lastModified })).status, 304);
    }

    await fixture.db.query('SAVEPOINT change_address');
    try {
      await fixture.db.query("UPDATE solar_installations SET address = 'New Test Address' WHERE id = $1", [id]);
      const changed = await read(`/installations/${id}`, token, { 'If-None-Match': tag });
      assert.equal(changed.status, 200);
      assert.equal((await changed.json()).address, 'New Test Address');
      if (lastModified) {
        assert.equal((await read(`/installations/${id}`, token, { 'If-Modified-Since': lastModified })).status, 200);
      }
      const listChanged = await read(`/grid-substations/${colomboSubstationId}/installations`, token, {
        'If-None-Match': list.headers.get('etag'),
      });
      assert.equal(listChanged.status, 200);
    } finally {
      await fixture.db.query('ROLLBACK TO SAVEPOINT change_address');
    }
  });

  test('HEAD and unsupported methods', async () => {
    const token = staffToken('national');
    const head = await read(`/installations/${fixture.device.id}`, token, {}, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    for (const [path, allow] of [
      [`/grid-substations/${colomboSubstationId}/installations`, 'GET, HEAD, POST'],
      [`/installations/${fixture.device.id}`, 'GET, HEAD, PUT, DELETE'],
    ]) {
      const res = await read(path, token, {}, 'PATCH');
      assert.equal(res.status, 405, path);
      assert.equal(res.headers.get('allow'), allow, path);
    }
  });
});
