require('dotenv').config({ quiet: true });

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApiFixture } = require('../test_support/apiFixture');

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('installation overview', { skip }, () => {
  let fixture;
  let seeded; // a seeded Colombo installation with readings
  let galleId;
  before(async () => {
    fixture = await startApiFixture();
    const first = async (district) => (await fixture.db.query(
      `SELECT i.id, i.substation_id, s.district_id, d.province_id
       FROM solar_installations i JOIN grid_substations s ON s.id = i.substation_id
       JOIN districts d ON d.id = s.district_id WHERE d.name = $1 AND i.meter_id LIKE 'MTR-%' ORDER BY i.meter_id LIMIT 1`,
      [district],
    )).rows[0];
    seeded = await first('Colombo');
    galleId = (await first('Galle')).id;
  });
  after(async () => { if (fixture) await fixture.close(); });

  const staff = (role = 'district') => fixture.token('staff', fixture.staff[role]);
  function get(path, token = staff(), headers = {}) {
    return fetch(`${fixture.url}/solar/v1.0${path}`, {
      headers: token ? { Authorization: `Bearer ${token}`, ...headers } : headers,
    });
  }
  const overview = (id) => `/installations/${id}/overview`;
  const insertReading = (timestamp) => fixture.db.query(
    `INSERT INTO generation_readings (installation_id, "timestamp", power_kw, energy_kwh, voltage)
     VALUES ($1, $2, 2.5, 40, 231)`,
    [fixture.device.id, timestamp],
  );

  test('embeds the same representations as the individual endpoints', async () => {
    const res = await get(overview(seeded.id));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ['installation', 'gridSubstation', 'district', 'province', 'lastKnownReading']);

    // The individual installation and substation reads also allow the provisioner; the others
    // are staff-only, so read them all as the same district reader.
    const parts = {
      installation: `/installations/${seeded.id}`,
      gridSubstation: `/grid-substations/${seeded.substation_id}`,
      district: `/districts/${seeded.district_id}`,
      province: `/provinces/${seeded.province_id}`,
      lastKnownReading: `/installations/${seeded.id}/last-known-reading`,
    };
    for (const [key, path] of Object.entries(parts)) {
      const part = await get(path);
      assert.equal(part.status, 200, path);
      assert.deepEqual(body[key], await part.json(), key);
    }
    assert.equal(body.lastKnownReading.timestamp, '2026-09-07T18:15:00.000Z');
  });

  test('lastKnownReading is null for an installation without readings', async () => {
    const res = await get(overview(fixture.device.id));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.lastKnownReading, null);
    assert.equal(body.installation.id, fixture.device.id);
    assert.equal(body.installation.meterId, fixture.device.meterId);
  });

  test('the ETag changes when the latest reading changes, not for a late older one', async () => {
    await fixture.db.query('SAVEPOINT overview_reading');
    try {
      const empty = await get(overview(fixture.device.id));
      const emptyTag = empty.headers.get('etag');
      assert.equal(empty.headers.get('last-modified'), null);
      assert.equal(empty.headers.get('cache-control'), 'private, no-cache');
      assert.equal(empty.headers.get('vary'), 'Authorization');
      const unchanged = await get(overview(fixture.device.id), staff(), { 'If-None-Match': emptyTag });
      assert.equal(unchanged.status, 304);
      assert.equal(await unchanged.text(), '');

      await insertReading('2026-09-09T06:00:00Z');
      const first = await get(overview(fixture.device.id), staff(), { 'If-None-Match': emptyTag });
      assert.equal(first.status, 200);
      assert.equal((await first.json()).lastKnownReading.timestamp, '2026-09-09T06:00:00.000Z');
      const tag = first.headers.get('etag');

      await insertReading('2026-09-09T05:45:00Z'); // late, but older than the latest
      assert.equal((await get(overview(fixture.device.id), staff(), { 'If-None-Match': tag })).status, 304);

      await insertReading('2026-09-09T06:15:00Z');
      const newer = await get(overview(fixture.device.id), staff(), { 'If-None-Match': tag });
      assert.equal(newer.status, 200);
      assert.equal((await newer.json()).lastKnownReading.timestamp, '2026-09-09T06:15:00.000Z');
    } finally {
      await fixture.db.query('ROLLBACK TO SAVEPOINT overview_reading');
    }
  });

  test('the ETag changes when an embedded ancestor or the installation changes', async () => {
    const original = await get(overview(seeded.id));
    const tag = original.headers.get('etag');
    for (const [label, sql, id] of [
      ['installation', "UPDATE solar_installations SET address = 'Overview Test Address' WHERE id = $1", seeded.id],
      ['substation', "UPDATE grid_substations SET name = 'Overview Test Substation' WHERE id = $1", seeded.substation_id],
      ['district', "UPDATE districts SET name = 'Overview Test District' WHERE id = $1", seeded.district_id],
      ['province', "UPDATE provinces SET name = 'Overview Test Province' WHERE id = $1", seeded.province_id],
    ]) {
      await fixture.db.query('SAVEPOINT overview_change');
      try {
        await fixture.db.query(sql, [id]);
        const changed = await get(overview(seeded.id), staff(), { 'If-None-Match': tag });
        assert.equal(changed.status, 200, label);
      } finally {
        await fixture.db.query('ROLLBACK TO SAVEPOINT overview_change');
      }
    }
    assert.equal((await get(overview(seeded.id), staff(), { 'If-None-Match': tag })).status, 304);
  });

  test('an installation outside the scope gets the same 404 as a missing one', async () => {
    for (const role of ['provincial', 'district']) {
      const hidden = await get(overview(galleId), staff(role), { 'If-None-Match': '*' });
      const missing = await get(overview(MISSING), staff(role));
      assert.equal(hidden.status, 404, role);
      assert.equal(hidden.headers.get('etag'), null, role);
      assert.equal(await hidden.text(), await missing.text(), role);
    }
    assert.equal((await get(overview(galleId), staff('national'))).status, 200);
  });

  test('only staff readers may read the overview', async () => {
    assert.equal((await get(overview(seeded.id), null)).status, 401);
    assert.equal((await get(overview(seeded.id), fixture.token('device', fixture.device))).status, 403);
    assert.equal((await get(overview(seeded.id), fixture.token('provisioner', fixture.provisioner))).status, 403);
    assert.equal((await get(overview('not-a-uuid'))).status, 400);
    assert.equal((await get(`${overview(seeded.id)}?limit=5`)).status, 400);
    const put = await fetch(`${fixture.url}/solar/v1.0${overview(seeded.id)}`, {
      method: 'PUT', headers: { Authorization: `Bearer ${staff()}` },
    });
    assert.equal(put.status, 405);
    assert.equal(put.headers.get('allow'), 'GET, HEAD');
  });
});
