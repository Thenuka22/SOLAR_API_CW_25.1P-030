require('dotenv').config({ quiet: true });

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApiFixture } = require('./helpers/apiFixture');

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('last-known reading', { skip }, () => {
  let fixture;
  let colomboId;
  let galleId;
  before(async () => {
    fixture = await startApiFixture();
    const seeded = async (district) => (await fixture.db.query(
      `SELECT i.id FROM solar_installations i JOIN grid_substations s ON s.id = i.substation_id
       JOIN districts d ON d.id = s.district_id WHERE d.name = $1 AND i.meter_id LIKE 'MTR-%' ORDER BY i.meter_id LIMIT 1`,
      [district],
    )).rows[0].id;
    colomboId = await seeded('Colombo');
    galleId = await seeded('Galle');
  });
  after(async () => { if (fixture) await fixture.close(); });

  const path = (id) => `/installations/${id}/last-known-reading`;
  function read(id, token = fixture.token('staff', fixture.staff.district), headers = {}) {
    return fetch(`${fixture.url}/solar/v1.0${path(id)}`, {
      headers: token ? { Authorization: `Bearer ${token}`, ...headers } : headers,
    });
  }
  const insertReading = (timestamp, energy) => fixture.db.query(
    `INSERT INTO generation_readings (installation_id, "timestamp", power_kw, energy_kwh, voltage)
     VALUES ($1, $2, 1.5, $3, 230) RETURNING id`,
    [fixture.device.id, timestamp, energy],
  );

  test('returns the seeded reading with the latest measurement timestamp', async () => {
    const res = await read(colomboId);
    assert.equal(res.status, 200);
    const reading = await res.json();
    assert.equal(reading.timestamp, '2026-09-07T18:15:00.000Z');
    assert.equal(reading.installationId, colomboId);
    const newest = (await fixture.db.query(
      'SELECT id FROM generation_readings WHERE installation_id = $1 ORDER BY "timestamp" DESC LIMIT 1', [colomboId],
    )).rows[0];
    assert.equal(reading.id, newest.id);
    // It is the same representation as the reading in the history.
    const fromHistory = await fetch(`${fixture.url}/solar/v1.0/installations/${colomboId}/readings/${reading.id}`, {
      headers: { Authorization: `Bearer ${fixture.token('staff', fixture.staff.district)}` },
    });
    assert.deepEqual(await fromHistory.json(), reading);
  });

  test('404 when the installation has no readings yet', async () => {
    const res = await read(fixture.device.id);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, 1005);
    assert.equal(body.details[0].field, 'installation-id');
  });

  test('selection is by measurement timestamp, not by insertion order', async () => {
    await fixture.db.query('SAVEPOINT order_test');
    try {
      const newest = await insertReading('2026-09-10T06:00:00Z', 30);
      await insertReading('2026-09-09T06:00:00Z', 20); // arrives later, measured earlier
      const res = await read(fixture.device.id);
      assert.equal(res.status, 200);
      const reading = await res.json();
      assert.equal(reading.id, newest.rows[0].id);
      assert.equal(reading.timestamp, '2026-09-10T06:00:00.000Z');
      assert.equal(reading.energyKwh, 30);
    } finally {
      await fixture.db.query('ROLLBACK TO SAVEPOINT order_test');
    }
  });

  test('the ETag changes when a newer reading arrives, and not for an older one', async () => {
    await fixture.db.query('SAVEPOINT etag_test');
    try {
      await insertReading('2026-09-09T06:00:00Z', 20);
      const first = await read(fixture.device.id);
      const tag = first.headers.get('etag');
      assert.equal(first.headers.get('last-modified'), null);
      assert.equal(first.headers.get('cache-control'), 'private, no-cache');
      const same = await read(fixture.device.id, undefined, { 'If-None-Match': tag });
      assert.equal(same.status, 304);
      assert.equal(await same.text(), '');

      await insertReading('2026-09-09T05:00:00Z', 19);
      assert.equal((await read(fixture.device.id, undefined, { 'If-None-Match': tag })).status, 304);

      await insertReading('2026-09-09T06:15:00Z', 21);
      const changed = await read(fixture.device.id, undefined, { 'If-None-Match': tag });
      assert.equal(changed.status, 200);
      assert.equal((await changed.json()).timestamp, '2026-09-09T06:15:00.000Z');
    } finally {
      await fixture.db.query('ROLLBACK TO SAVEPOINT etag_test');
    }
  });

  test('an installation outside the scope gets the same 404 as a missing one', async () => {
    for (const role of ['provincial', 'district']) {
      const token = fixture.token('staff', fixture.staff[role]);
      const hidden = await read(galleId, token, { 'If-None-Match': '*' });
      const missing = await read(MISSING, token);
      assert.equal(hidden.status, 404, role);
      assert.equal(hidden.headers.get('etag'), null, role);
      assert.equal(await hidden.text(), await missing.text(), role);
    }
    assert.equal((await read(galleId, fixture.token('staff', fixture.staff.national))).status, 200);
  });

  test('authentication, principal type, and input checks', async () => {
    assert.equal((await read(colomboId, null)).status, 401);
    assert.equal((await read(colomboId, fixture.token('device', fixture.device))).status, 403);
    assert.equal((await read(colomboId, fixture.token('provisioner', fixture.provisioner))).status, 403);
    assert.equal((await read('not-a-uuid')).status, 400);
    const withQuery = await fetch(`${fixture.url}/solar/v1.0${path(colomboId)}?sort=-timestamp`, {
      headers: { Authorization: `Bearer ${fixture.token('staff', fixture.staff.national)}` },
    });
    assert.equal(withQuery.status, 400);
    const post = await fetch(`${fixture.url}/solar/v1.0${path(colomboId)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${fixture.token('staff', fixture.staff.national)}` },
    });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
  });
});
