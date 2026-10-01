require('dotenv').config({ quiet: true });

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApiFixture } = require('./helpers/apiFixture');

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('district generation summary', { skip }, () => {
  let fixture;
  let colomboId; // holds the fixture installation, which has no readings
  let galleId; // seeded installations only
  let galleInstallations;
  before(async () => {
    fixture = await startApiFixture();
    const one = async (sql, params) => (await fixture.db.query(sql, params)).rows[0];
    ({ id: colomboId } = await one("SELECT id FROM districts WHERE name = 'Colombo'"));
    ({ id: galleId } = await one("SELECT id FROM districts WHERE name = 'Galle'"));
    ({ n: galleInstallations } = await one(
      `SELECT count(*)::int AS n FROM solar_installations i JOIN grid_substations s ON s.id = i.substation_id
       WHERE s.district_id = $1`, [galleId],
    ));
    assert.ok(galleInstallations > 0);
  });
  after(async () => { if (fixture) await fixture.close(); });

  const staff = (role) => fixture.token('staff', fixture.staff[role]);
  function summarize(body, token = staff('national'), headers = {}) {
    return fetch(`${fixture.url}/solar/v1.0/summarize-district-generation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: JSON.stringify(body),
    });
  }
  // The district's energy between two instants, straight from the meter values in SQL.
  async function energyBetween(districtId, from, to) {
    const { rows } = await fixture.db.query(
      `SELECT sum(b.energy_kwh - a.energy_kwh)::float8 AS kwh
       FROM solar_installations i
       JOIN grid_substations s ON s.id = i.substation_id
       JOIN generation_readings a ON a.installation_id = i.id AND a."timestamp" = $2
       JOIN generation_readings b ON b.installation_id = i.id AND b."timestamp" = $3
       WHERE s.district_id = $1`,
      [districtId, from, to],
    );
    return rows[0].kwh;
  }

  test('a seeded day with both midnight samples is complete and matches the meter differences', async () => {
    const res = await summarize({ districtId: galleId, date: '2026-09-06' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('etag'), null);
    const body = await res.json();
    assert.equal(body.districtId, galleId);
    assert.equal(body.date, '2026-09-06');
    assert.equal(body.timeZone, 'Asia/Colombo');
    assert.equal(body.installations, galleInstallations);

    const expected = await energyBetween(galleId, '2026-09-06T00:00:00+05:30', '2026-09-07T00:00:00+05:30');
    assert.ok(expected > 0);
    assert.deepEqual(body.energy, {
      complete: true,
      completeKwh: Number(expected.toFixed(3)),
      partialKwh: null,
      completeInstallations: galleInstallations,
      partialInstallations: 0,
      missingInstallations: 0,
      anomalousInstallations: 0,
      earliestPartialSampleAt: null,
      latestPartialSampleAt: null,
    });
    // The seed ended weeks ago, so no latest reading is fresh.
    assert.deepEqual(body.power, {
      totalKw: null, reportingInstallations: 0, staleInstallations: galleInstallations, latestReadingAt: null,
    });
  });

  test('the last seeded day has no closing sample, so it is partial up to 23:45', async () => {
    const body = await (await summarize({ districtId: galleId, date: '2026-09-07' })).json();
    const expected = await energyBetween(galleId, '2026-09-07T00:00:00+05:30', '2026-09-07T23:45:00+05:30');
    assert.equal(body.energy.complete, false);
    assert.equal(body.energy.completeKwh, null);
    assert.equal(body.energy.partialKwh, Number(expected.toFixed(3)));
    assert.equal(body.energy.partialInstallations, galleInstallations);
    assert.equal(body.energy.earliestPartialSampleAt, '2026-09-07T18:15:00.000Z');
    assert.equal(body.energy.latestPartialSampleAt, '2026-09-07T18:15:00.000Z');
  });

  test('a day with no readings gives nulls, not zeros', async () => {
    const body = await (await summarize({ districtId: galleId, date: '2026-08-15' })).json();
    assert.equal(body.energy.complete, false);
    assert.equal(body.energy.completeKwh, null);
    assert.equal(body.energy.partialKwh, null);
    assert.equal(body.energy.missingInstallations, galleInstallations);
  });

  test('an installation without an opening sample is missing and keeps the district incomplete', async () => {
    // Colombo holds the fixture installation, which has no readings.
    const body = await (await summarize({ districtId: colomboId, date: '2026-09-06' })).json();
    assert.equal(body.energy.complete, false);
    assert.equal(body.energy.missingInstallations, 1);
    assert.equal(body.energy.completeInstallations, body.installations - 1);
    const expected = await energyBetween(colomboId, '2026-09-06T00:00:00+05:30', '2026-09-07T00:00:00+05:30');
    assert.equal(body.energy.completeKwh, Number(expected.toFixed(3)));
  });

  test('a fresh reading counts as current power; the date defaults to today', async () => {
    await fixture.db.query('SAVEPOINT fresh_reading');
    try {
      // A minute ago, so it is not after the database clock.
      const posted = await fetch(`${fixture.url}/solar/v1.0/installations/${fixture.device.id}/readings`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${fixture.token('device', fixture.device)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ timestamp: new Date(Date.now() - 60000).toISOString(), powerKw: 2.75, energyKwh: 10, voltage: 230 }),
      });
      assert.equal(posted.status, 201);
      const reading = await posted.json();

      const res = await summarize({ districtId: colomboId });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.match(body.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.deepEqual(body.power, {
        totalKw: 2.75,
        reportingInstallations: 1,
        staleInstallations: body.installations - 1,
        latestReadingAt: reading.timestamp,
      });
      // One reading cannot make a day's energy.
      assert.equal(body.energy.complete, false);
      assert.equal(body.energy.completeKwh, null);
    } finally {
      await fixture.db.query('ROLLBACK TO SAVEPOINT fresh_reading');
    }
  });

  test('districts outside the jurisdiction get the same 404 as missing ones', async () => {
    assert.equal((await summarize({ districtId: colomboId, date: '2026-09-06' }, staff('district'))).status, 200);
    assert.equal((await summarize({ districtId: colomboId, date: '2026-09-06' }, staff('provincial'))).status, 200);
    const missing = await (await summarize({ districtId: MISSING })).json();
    for (const role of ['district', 'provincial']) {
      const res = await summarize({ districtId: galleId, date: '2026-09-06' }, staff(role));
      assert.equal(res.status, 404, role);
      assert.deepEqual(await res.json(), missing, role);
    }
  });

  test('only staff readers may summarize', async () => {
    assert.equal((await summarize({ districtId: galleId }, null)).status, 401);
    for (const token of [fixture.token('device', fixture.device), fixture.token('provisioner', fixture.provisioner)]) {
      const res = await summarize({ districtId: galleId }, token);
      assert.equal(res.status, 403);
      assert.equal((await res.json()).code, 3004);
    }
  });

  test('invalid input is rejected with every problem listed', async () => {
    const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    for (const [body, fields] of [
      [{}, ['districtId']],
      [{ districtId: 'not-a-uuid', date: '06-09-2026' }, ['date', 'districtId']],
      [{ districtId: galleId, date: '2026-02-30' }, ['date']],
      [{ districtId: galleId, date: tomorrow }, ['date']],
      [{ districtId: galleId, date: 20260906 }, ['date']],
      [{ districtId: galleId, provinceId: galleId }, ['provinceId']],
    ]) {
      const res = await summarize(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      const error = await res.json();
      assert.equal(error.code, 2001);
      assert.deepEqual(error.details.map((item) => item.field).sort(), fields, JSON.stringify(body));
    }
    assert.equal((await summarize([galleId])).status, 400);
  });

  test('media type, Accept, query, and method errors', async () => {
    const url = `${fixture.url}/solar/v1.0/summarize-district-generation`;
    const auth = { Authorization: `Bearer ${staff('national')}` };
    assert.equal((await fetch(url, { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: 'x' })).status, 415);
    assert.equal((await fetch(url, { method: 'POST', headers: auth })).status, 400);
    assert.equal((await summarize({ districtId: galleId }, staff('national'), { Accept: 'text/html' })).status, 406);
    const withQuery = await fetch(`${url}?date=2026-09-06`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ districtId: galleId }),
    });
    assert.equal(withQuery.status, 400);
    // A processing function has no GET alias.
    const get = await fetch(url, { headers: auth });
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
  });
});
