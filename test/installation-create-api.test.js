require('dotenv').config({ quiet: true });

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApiFixture } = require('../test_support/apiFixture');

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('installation creation', { skip }, () => {
  let fixture;
  let substationId;
  before(async () => {
    fixture = await startApiFixture();
    ({ substation_id: substationId } = (await fixture.db.query(
      'SELECT substation_id FROM solar_installations WHERE id = $1', [fixture.device.id],
    )).rows[0]);
  });
  after(async () => { if (fixture) await fixture.close(); });

  const provisionerToken = () => fixture.token('provisioner', fixture.provisioner);
  function create(body, { token = provisionerToken(), parent = substationId, headers = {} } = {}) {
    return fetch(`${fixture.url}/solar/v1.0/grid-substations/${parent}/installations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }
  // A failed INSERT aborts the fixture's shared transaction, so requests that are expected to
  // hit a constraint run inside a savepoint.
  async function inSavepoint(work) {
    await fixture.db.query('SAVEPOINT attempt');
    try {
      return await work();
    } finally {
      await fixture.db.query('ROLLBACK TO SAVEPOINT attempt');
    }
  }

  test('the provisioner creates an installation: 201, Location, server-generated ID', async () => {
    const res = await create({ meterId: '  CREATE-TEST-001  ', address: 'No. 1, Test Road', capacityKw: 7.125 });
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.match(created.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual(created, {
      id: created.id, substationId, meterId: 'CREATE-TEST-001', address: 'No. 1, Test Road', capacityKw: 7.125,
    });
    assert.equal(res.headers.get('location'), `/solar/v1.0/installations/${created.id}`);

    const fetched = await fetch(`${fixture.url}${res.headers.get('location')}`, {
      headers: { Authorization: `Bearer ${provisionerToken()}` },
    });
    assert.equal(fetched.status, 200);
    assert.deepEqual(await fetched.json(), created);
  });

  test('an omitted or null address is stored as null', async () => {
    for (const [meterId, extra] of [['CREATE-TEST-002', {}], ['CREATE-TEST-003', { address: null }]]) {
      const res = await create({ meterId, capacityKw: 3, ...extra });
      assert.equal(res.status, 201, meterId);
      assert.equal((await res.json()).address, null, meterId);
    }
  });

  test('a meter ID already registered returns 409, ignoring case and surrounding spaces', async () => {
    for (const meterId of [fixture.device.meterId, ` ${fixture.device.meterId.toLowerCase()} `, 'MTR-0001']) {
      const res = await inSavepoint(() => create({ meterId, capacityKw: 4 }));
      assert.equal(res.status, 409, meterId);
      const body = await res.json();
      assert.equal(body.code, 4001, meterId);
      assert.equal(body.details[0].field, 'meterId', meterId);
    }
  });

  test('a missing parent returns 404 and nothing is created', async () => {
    const res = await create({ meterId: 'CREATE-TEST-404', capacityKw: 4 }, { parent: MISSING });
    assert.equal(res.status, 404);
    const { rows } = await fixture.db.query("SELECT 1 FROM solar_installations WHERE meter_id = 'CREATE-TEST-404'");
    assert.equal(rows.length, 0);
  });

  test('only the provisioner may create installations', async () => {
    const body = { meterId: 'CREATE-TEST-AUTH', capacityKw: 4 };
    assert.equal((await create(body, { token: null })).status, 401);
    for (const token of [
      fixture.token('staff', fixture.staff.national),
      fixture.token('device', fixture.device),
    ]) {
      const res = await create(body, { token });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).code, 3004);
    }
  });

  test('invalid bodies are rejected with every problem listed', async () => {
    const res = await create({ id: MISSING, substationId, meterId: ' ', address: '', capacityKw: 0 });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 2001);
    assert.deepEqual(body.details.map((item) => item.field).sort(),
      ['address', 'capacityKw', 'id', 'meterId', 'substationId']);

    for (const invalid of [
      {},
      { capacityKw: 4 },
      { meterId: 'CREATE-TEST-X', capacityKw: '4' },
      { meterId: 'CREATE-TEST-X', capacityKw: -1 },
      { meterId: 'CREATE-TEST-X', capacityKw: 1.2345 },
      { meterId: 'CREATE-TEST-X', capacityKw: 10000000 },
      { meterId: 'CREATE-TEST-X', capacityKw: null },
      { meterId: 'CREATE-TEST-X', capacityKw: 4, address: 5 },
      { meterId: 42, capacityKw: 4 },
      { meterId: 'M'.repeat(255), capacityKw: 4 },
      [],
      'null',
    ]) {
      const response = await create(invalid);
      assert.equal(response.status, 400, JSON.stringify(invalid));
    }
    assert.equal((await create('{"meterId":')).status, 400);
    assert.equal((await create({ meterId: 'CREATE-TEST-X', capacityKw: 4 }, { parent: 'not-a-uuid' })).status, 400);
  });

  test('media type, missing body, and Accept errors', async () => {
    const base = `${fixture.url}/solar/v1.0/grid-substations/${substationId}/installations`;
    const auth = { Authorization: `Bearer ${provisionerToken()}` };
    const text = await fetch(base, { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(text.status, 415);
    const empty = await fetch(base, { method: 'POST', headers: auth });
    assert.equal(empty.status, 400);
    const accept = await create({ meterId: 'CREATE-TEST-ACCEPT', capacityKw: 4 }, { headers: { Accept: 'text/html' } });
    assert.equal(accept.status, 406);
    const put = await fetch(base, { method: 'PUT', headers: auth });
    assert.equal(put.status, 405);
    assert.equal(put.headers.get('allow'), 'GET, HEAD, POST');
  });
});
