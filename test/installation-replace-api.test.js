require('dotenv').config({ quiet: true });

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApiFixture } = require('./helpers/apiFixture');

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('installation replacement', { skip }, () => {
  let fixture;
  let ownSubstationId; // the fixture installation's substation (it has no readings)
  let otherSubstationId;
  let seeded; // a seeded installation with readings
  before(async () => {
    fixture = await startApiFixture();
    const one = async (sql, params) => (await fixture.db.query(sql, params)).rows[0];
    ({ substation_id: ownSubstationId } = await one('SELECT substation_id FROM solar_installations WHERE id = $1', [fixture.device.id]));
    ({ id: otherSubstationId } = await one('SELECT id FROM grid_substations WHERE id <> $1 ORDER BY id LIMIT 1', [ownSubstationId]));
    seeded = await one("SELECT id, substation_id, meter_id, capacity_kw FROM solar_installations WHERE meter_id = 'MTR-0002'");
  });
  after(async () => { if (fixture) await fixture.close(); });

  const provisioner = () => fixture.token('provisioner', fixture.provisioner);
  function put(id, body, headers = {}, token = provisioner()) {
    return fetch(`${fixture.url}/solar/v1.0/installations/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: JSON.stringify(body),
    });
  }
  function get(id) {
    return fetch(`${fixture.url}/solar/v1.0/installations/${id}`, { headers: { Authorization: `Bearer ${provisioner()}` } });
  }
  const own = (extra = {}) => ({ substationId: ownSubstationId, meterId: fixture.device.meterId, capacityKw: 5, ...extra });
  // Each test starts from the fixture's original rows.
  async function isolated(work) {
    await fixture.db.query('SAVEPOINT replace_test');
    try {
      await work();
    } finally {
      await fixture.db.query('ROLLBACK TO SAVEPOINT replace_test');
    }
  }

  test('a full replacement returns the new representation and the validators a GET would send', () => isolated(async () => {
    const res = await put(fixture.device.id, own({ meterId: 'REPLACED-METER', address: 'No. 9, New Road', capacityKw: 6.6 }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      id: fixture.device.id, substationId: ownSubstationId, meterId: 'REPLACED-METER', address: 'No. 9, New Road', capacityKw: 6.6,
    });
    const fetched = await get(fixture.device.id);
    assert.deepEqual(await fetched.json(), body);
    assert.equal(res.headers.get('etag'), fetched.headers.get('etag'));
  }));

  test('an omitted address is cleared to null; it is not a partial update', () => isolated(async () => {
    assert.equal((await put(fixture.device.id, own({ address: 'Somewhere' }))).status, 200);
    const res = await put(fixture.device.id, own());
    assert.equal(res.status, 200);
    assert.equal((await res.json()).address, null);
  }));

  test('partial bodies and read-only fields are rejected and change nothing', () => isolated(async () => {
    const before = await (await get(fixture.device.id)).json();
    for (const [body, fields] of [
      [{ meterId: 'X-PARTIAL' }, ['capacityKw', 'substationId']],
      [{ substationId: ownSubstationId, capacityKw: 5 }, ['meterId']],
      [{ ...own(), id: fixture.device.id }, ['id']],
      [{ ...own(), substationId: 'not-a-uuid' }, ['substationId']],
      [{ ...own(), capacityKw: 0 }, ['capacityKw']],
    ]) {
      const res = await put(fixture.device.id, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual((await res.json()).details.map((item) => item.field).sort(), fields, JSON.stringify(body));
    }
    assert.deepEqual(await (await get(fixture.device.id)).json(), before);
  }));

  test('If-Match: the current ETag or * succeeds; a stale or weak tag gives 412 and no change', () => isolated(async () => {
    const current = await get(fixture.device.id);
    const tag = current.headers.get('etag');
    const before = await current.json();
    for (const ifMatch of ['"stale"', `W/${tag}`]) {
      const res = await put(fixture.device.id, own({ capacityKw: 9 }), { 'If-Match': ifMatch });
      assert.equal(res.status, 412, ifMatch);
      assert.equal((await res.json()).code, 1010, ifMatch);
    }
    assert.deepEqual(await (await get(fixture.device.id)).json(), before);

    const ok = await put(fixture.device.id, own({ capacityKw: 9 }), { 'If-Match': `"other", ${tag}` });
    assert.equal(ok.status, 200);
    // The old tag is now stale, so the same conditional request fails.
    assert.equal((await put(fixture.device.id, own({ capacityKw: 10 }), { 'If-Match': tag })).status, 412);
    assert.equal((await put(fixture.device.id, own({ capacityKw: 10 }), { 'If-Match': '*' })).status, 200);
    assert.equal((await (await get(fixture.device.id)).json()).capacityKw, 10);
  }));

  test('If-Unmodified-Since, and If-Match taking precedence over it', () => isolated(async () => {
    const current = await get(fixture.device.id);
    const tag = current.headers.get('etag');
    const lastModified = current.headers.get('last-modified');
    assert.ok(lastModified);
    const earlier = new Date(Date.parse(lastModified) - 60000).toUTCString();

    assert.equal((await put(fixture.device.id, own(), { 'If-Unmodified-Since': earlier })).status, 412);
    assert.equal((await put(fixture.device.id, own(), { 'If-Unmodified-Since': 'not a date' })).status, 200);
    // If-Match wins in both directions.
    assert.equal((await put(fixture.device.id, own(), { 'If-Match': tag, 'If-Unmodified-Since': earlier })).status, 200);
    assert.equal((await put(fixture.device.id, own(), {
      'If-Match': '"stale"', 'If-Unmodified-Since': 'Wed, 01 Jan 2100 00:00:00 GMT',
    })).status, 412);

    // A real change moves updated_at to a later second, so the earlier Last-Modified fails.
    assert.equal((await put(fixture.device.id, own({ address: 'Changed' }), { 'If-Unmodified-Since': lastModified })).status, 200);
    assert.equal((await put(fixture.device.id, own({ address: 'Again' }), { 'If-Unmodified-Since': lastModified })).status, 412);
    assert.equal((await (await get(fixture.device.id)).json()).address, 'Changed');
  }));

  test('an installation without readings can move; one with readings cannot', () => isolated(async () => {
    const moved = await put(fixture.device.id, own({ substationId: otherSubstationId }));
    assert.equal(moved.status, 200);
    assert.equal((await moved.json()).substationId, otherSubstationId);

    const seededBody = { substationId: otherSubstationId, meterId: seeded.meter_id, capacityKw: Number(seeded.capacity_kw) };
    const blocked = await put(seeded.id, seededBody);
    assert.equal(blocked.status, 409);
    const error = await blocked.json();
    assert.equal(error.code, 4003);
    assert.equal(error.details[0].field, 'substationId');
    assert.equal((await (await get(seeded.id)).json()).substationId, seeded.substation_id);

    // Descriptive changes are allowed and leave the history untouched.
    const count = async () => (await fixture.db.query(
      'SELECT count(*)::int AS n FROM generation_readings WHERE installation_id = $1', [seeded.id],
    )).rows[0].n;
    const readingsBefore = await count();
    const described = await put(seeded.id, { ...seededBody, substationId: seeded.substation_id, address: 'Updated Address' });
    assert.equal(described.status, 200);
    assert.equal((await described.json()).address, 'Updated Address');
    assert.equal(await count(), readingsBefore);
  }));

  test('a missing target substation is a 400; a meter ID in use is a 409', () => isolated(async () => {
    const noSubstation = await put(fixture.device.id, own({ substationId: MISSING }));
    assert.equal(noSubstation.status, 400);
    assert.equal((await noSubstation.json()).details[0].field, 'substationId');

    for (const meterId of [seeded.meter_id, ` ${seeded.meter_id.toLowerCase()} `]) {
      const taken = await put(fixture.device.id, own({ meterId }));
      assert.equal(taken.status, 409, meterId);
      assert.equal((await taken.json()).code, 4001, meterId);
    }
    // The failed update was rolled back, and the shared transaction still works.
    assert.equal((await (await get(fixture.device.id)).json()).meterId, fixture.device.meterId);
  }));

  test('PUT never creates: a missing installation is 404, with or without conditions', async () => {
    assert.equal((await put(MISSING, own())).status, 404);
    assert.equal((await put(MISSING, own(), { 'If-Match': '*' })).status, 404);
    const { rows } = await fixture.db.query('SELECT 1 FROM solar_installations WHERE id = $1', [MISSING]);
    assert.equal(rows.length, 0);
  });

  test('only the provisioner may replace, with a JSON body', async () => {
    assert.equal((await put(fixture.device.id, own(), {}, null)).status, 401);
    for (const token of [fixture.token('staff', fixture.staff.national), fixture.token('device', fixture.device)]) {
      assert.equal((await put(fixture.device.id, own(), {}, token)).status, 403);
    }
    const url = `${fixture.url}/solar/v1.0/installations/${fixture.device.id}`;
    const auth = { Authorization: `Bearer ${provisioner()}` };
    assert.equal((await fetch(url, { method: 'PUT', headers: { ...auth, 'Content-Type': 'text/plain' }, body: 'x' })).status, 415);
    assert.equal((await fetch(url, { method: 'PUT', headers: auth })).status, 400);
    assert.equal((await put('not-a-uuid', own())).status, 400);
    const patch = await fetch(url, { method: 'PATCH', headers: auth });
    assert.equal(patch.status, 405);
    assert.equal(patch.headers.get('allow'), 'GET, HEAD, PUT, DELETE');
  });
});
