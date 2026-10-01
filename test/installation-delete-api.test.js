require('dotenv').config({ quiet: true });

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApiFixture } = require('./helpers/apiFixture');

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('installation deletion', { skip }, () => {
  let fixture;
  let seeded; // a seeded installation with readings
  before(async () => {
    fixture = await startApiFixture();
    seeded = (await fixture.db.query("SELECT id FROM solar_installations WHERE meter_id = 'MTR-0002'")).rows[0];
  });
  after(async () => { if (fixture) await fixture.close(); });

  const provisioner = () => fixture.token('provisioner', fixture.provisioner);
  function remove(id, headers = {}, token = provisioner()) {
    return fetch(`${fixture.url}/solar/v1.0/installations/${id}`, {
      method: 'DELETE',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    });
  }
  function get(id) {
    return fetch(`${fixture.url}/solar/v1.0/installations/${id}`, { headers: { Authorization: `Bearer ${provisioner()}` } });
  }
  const exists = async (id) => (await fixture.db.query('SELECT 1 FROM solar_installations WHERE id = $1', [id])).rowCount === 1;
  // Each test starts from the fixture's original rows; the fixture installation has no readings.
  async function isolated(work) {
    await fixture.db.query('SAVEPOINT delete_test');
    try {
      await work();
    } finally {
      await fixture.db.query('ROLLBACK TO SAVEPOINT delete_test');
    }
  }

  test('deleting returns a receipt, and repeating the request returns 404', () => isolated(async () => {
    const res = await remove(fixture.device.id);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('etag'), null);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ['id', 'meterId', 'deletedAt']);
    assert.equal(body.id, fixture.device.id);
    assert.equal(body.meterId, fixture.device.meterId);
    assert.match(body.deletedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    assert.equal(await exists(fixture.device.id), false);
    assert.equal((await get(fixture.device.id)).status, 404);
    const again = await remove(fixture.device.id);
    assert.equal(again.status, 404);
    assert.equal((await again.json()).code, 1005);
  }));

  test('the device credential goes with the installation, so its token stops working', () => isolated(async () => {
    const deviceToken = fixture.token('device', fixture.device);
    assert.equal((await remove(fixture.device.id)).status, 200);
    const { rowCount } = await fixture.db.query('SELECT 1 FROM device_credentials WHERE installation_id = $1', [fixture.device.id]);
    assert.equal(rowCount, 0);
    const res = await fetch(`${fixture.url}/solar/v1.0/installations/${fixture.device.id}/readings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timestamp: '2026-09-08T00:00:00Z', powerKw: 0, energyKwh: 1, voltage: 230 }),
    });
    assert.equal(res.status, 401);
  }));

  test('an installation with readings is not deleted, and its readings stay', async () => {
    const count = async () => (await fixture.db.query(
      'SELECT count(*)::int AS n FROM generation_readings WHERE installation_id = $1', [seeded.id],
    )).rows[0].n;
    const readingsBefore = await count();
    // A condition that holds does not get around the history rule.
    for (const headers of [{}, { 'If-Match': '*' }]) {
      const res = await remove(seeded.id, headers);
      assert.equal(res.status, 409);
      const error = await res.json();
      assert.equal(error.code, 4003);
      assert.equal(error.details[0].field, 'installation-id');
    }
    assert.equal(await exists(seeded.id), true);
    assert.equal(await count(), readingsBefore);
  });

  test('If-Match: a stale or weak tag gives 412 and deletes nothing; the current tag or * deletes', async () => {
    const tag = (await get(fixture.device.id)).headers.get('etag');
    for (const ifMatch of ['"stale"', `W/${tag}`]) {
      const res = await remove(fixture.device.id, { 'If-Match': ifMatch });
      assert.equal(res.status, 412, ifMatch);
      assert.equal((await res.json()).code, 1010, ifMatch);
    }
    assert.equal(await exists(fixture.device.id), true);

    await isolated(async () => assert.equal((await remove(fixture.device.id, { 'If-Match': `"other", ${tag}` })).status, 200));
    await isolated(async () => assert.equal((await remove(fixture.device.id, { 'If-Match': '*' })).status, 200));
  });

  test('If-Unmodified-Since, and If-Match taking precedence over it', async () => {
    const current = await get(fixture.device.id);
    const tag = current.headers.get('etag');
    const lastModified = current.headers.get('last-modified');
    assert.ok(lastModified);
    const earlier = new Date(Date.parse(lastModified) - 60000).toUTCString();

    assert.equal((await remove(fixture.device.id, { 'If-Unmodified-Since': earlier })).status, 412);
    // If-Match decides when both are sent.
    assert.equal((await remove(fixture.device.id, {
      'If-Match': '"stale"', 'If-Unmodified-Since': 'Wed, 01 Jan 2100 00:00:00 GMT',
    })).status, 412);
    assert.equal(await exists(fixture.device.id), true);

    await isolated(async () => assert.equal((await remove(fixture.device.id, { 'If-Unmodified-Since': lastModified })).status, 200));
    await isolated(async () => assert.equal((await remove(fixture.device.id, { 'If-Unmodified-Since': 'not a date' })).status, 200));
    await isolated(async () => assert.equal((await remove(fixture.device.id, { 'If-Match': tag, 'If-Unmodified-Since': earlier })).status, 200));
  });

  test('a missing installation is 404, with or without conditions', async () => {
    assert.equal((await remove(MISSING)).status, 404);
    assert.equal((await remove(MISSING, { 'If-Match': '*' })).status, 404);
    assert.equal((await remove(MISSING, { 'If-Match': '"stale"' })).status, 404);
  });

  test('only the provisioner may delete, and input is checked', async () => {
    assert.equal((await remove(fixture.device.id, {}, null)).status, 401);
    for (const token of [fixture.token('staff', fixture.staff.national), fixture.token('device', fixture.device)]) {
      assert.equal((await remove(fixture.device.id, {}, token)).status, 403);
    }
    assert.equal((await remove('not-a-uuid')).status, 400);
    const withQuery = await fetch(`${fixture.url}/solar/v1.0/installations/${fixture.device.id}?force=true`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${provisioner()}` },
    });
    assert.equal(withQuery.status, 400);
    assert.equal((await remove(fixture.device.id, { Accept: 'text/html' })).status, 406);
    assert.equal(await exists(fixture.device.id), true);
  });
});
