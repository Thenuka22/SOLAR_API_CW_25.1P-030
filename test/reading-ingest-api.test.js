require('dotenv').config({ quiet: true });

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hashSecret, generateDeviceSecret } = require('../src/auth/credentialHash');
const { startApiFixture } = require('../test_support/apiFixture');

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const MISSING = '00000000-0000-4000-8000-000000000000';
const VALID = { timestamp: '2026-09-08T12:00:00+05:30', powerKw: 3.214, energyKwh: 1520.75, voltage: 231.4 };

describe('device reading ingestion', { skip }, () => {
  let fixture;
  let otherDevice;
  before(async () => {
    fixture = await startApiFixture();
    // A second installation with its own device credential, at the same substation.
    const installation = (await fixture.db.query(
      `INSERT INTO solar_installations (substation_id, meter_id, capacity_kw)
       SELECT substation_id, $2, 4 FROM solar_installations WHERE id = $1 RETURNING id`,
      [fixture.device.id, `${fixture.device.meterId}-B`],
    )).rows[0];
    const credential = (await fixture.db.query(
      'INSERT INTO device_credentials (installation_id, secret_hash) VALUES ($1, $2) RETURNING credential_version',
      [installation.id, await hashSecret(generateDeviceSecret())],
    )).rows[0];
    otherDevice = { id: installation.id, credentialVersion: credential.credential_version };
  });
  after(async () => { if (fixture) await fixture.close(); });

  const deviceToken = () => fixture.token('device', fixture.device);
  function submit(body, { token = deviceToken(), installationId = fixture.device.id, headers = {} } = {}) {
    return fetch(`${fixture.url}/solar/v1.0/installations/${installationId}/readings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }
  // A failed INSERT aborts the fixture's shared transaction, so requests expected to hit a
  // constraint run inside a savepoint.
  async function inSavepoint(work) {
    await fixture.db.query('SAVEPOINT attempt');
    try {
      return await work();
    } finally {
      await fixture.db.query('ROLLBACK TO SAVEPOINT attempt');
    }
  }

  test('the owning device stores a reading: 201, Location, UTC timestamp', async () => {
    const res = await submit(VALID);
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.deepEqual(created, {
      id: created.id,
      installationId: fixture.device.id,
      timestamp: '2026-09-08T06:30:00.000Z',
      powerKw: 3.214,
      energyKwh: 1520.75,
      voltage: 231.4,
    });
    assert.equal(res.headers.get('location'),
      `/solar/v1.0/installations/${fixture.device.id}/readings/${created.id}`);

    const stored = (await fixture.db.query(
      `SELECT installation_id, "timestamp", power_kw, energy_kwh, voltage FROM generation_readings WHERE id = $1`,
      [created.id],
    )).rows[0];
    assert.equal(stored.installation_id, fixture.device.id);
    assert.equal(stored.timestamp.toISOString(), '2026-09-08T06:30:00.000Z');
    assert.deepEqual([stored.power_kw, stored.energy_kwh, stored.voltage], ['3.214', '1520.750', '231.40']);
  });

  test('a second reading for the same instant returns 409, whatever the offset', async () => {
    for (const timestamp of ['2026-09-08T12:00:00+05:30', '2026-09-08T06:30:00Z', '2026-09-08T06:30:00.000Z']) {
      const res = await inSavepoint(() => submit({ ...VALID, timestamp, powerKw: 1 }));
      assert.equal(res.status, 409, timestamp);
      const body = await res.json();
      assert.equal(body.code, 4002, timestamp);
      assert.equal(body.details[0].field, 'timestamp', timestamp);
    }
    // A different instant is accepted, and so is the same instant for another installation.
    assert.equal((await submit({ ...VALID, timestamp: '2026-09-08T06:30:00.001Z' })).status, 201);
    const other = await submit(VALID, {
      token: fixture.token('device', otherDevice), installationId: otherDevice.id,
    });
    assert.equal(other.status, 201);
  });

  test('a device cannot submit for another installation, existing or not', async () => {
    for (const installationId of [otherDevice.id, MISSING]) {
      const res = await submit({ ...VALID, timestamp: '2026-09-09T00:00:00Z' }, { installationId });
      assert.equal(res.status, 403, installationId);
      assert.equal((await res.json()).code, 3004, installationId);
    }
    const { rows } = await fixture.db.query(
      "SELECT 1 FROM generation_readings WHERE installation_id = $1 AND \"timestamp\" = '2026-09-09T00:00:00Z'",
      [otherDevice.id],
    );
    assert.equal(rows.length, 0);
  });

  test('staff readers and the provisioner cannot submit readings', async () => {
    assert.equal((await submit(VALID, { token: null })).status, 401);
    for (const token of [
      fixture.token('staff', fixture.staff.national),
      fixture.token('provisioner', fixture.provisioner),
    ]) {
      assert.equal((await submit(VALID, { token })).status, 403);
    }
  });

  test('timestamps must have an offset and name a real instant', async () => {
    for (const timestamp of [
      '2026-09-08T12:00:00', '2026-09-08', '2026-02-30T00:00:00Z', '2026-09-08T12:00:00.123456Z',
      '2016-12-31T23:59:60Z', 1773000000000, null,
    ]) {
      const res = await submit({ ...VALID, timestamp });
      assert.equal(res.status, 400, String(timestamp));
      const body = await res.json();
      assert.deepEqual(body.details.map((item) => item.field), ['timestamp'], String(timestamp));
    }
  });

  test('measurements are non-negative numbers within the stored precision', async () => {
    const accepted = await submit({
      timestamp: '2026-09-10T00:00:00Z', powerKw: 0, energyKwh: 99999999999.999, voltage: 230.12,
    });
    assert.equal(accepted.status, 201);
    assert.deepEqual(await accepted.json().then(({ powerKw, energyKwh, voltage }) => [powerKw, energyKwh, voltage]),
      [0, 99999999999.999, 230.12]);

    for (const [field, value] of [
      ['powerKw', 1.2345], ['powerKw', -0.001], ['powerKw', '3.2'], ['powerKw', null], ['powerKw', 10000000],
      ['energyKwh', 1.0001], ['energyKwh', -1], ['energyKwh', 100000000000],
      ['voltage', 230.123], ['voltage', -1], ['voltage', 100000], ['voltage', true],
    ]) {
      const res = await submit({ ...VALID, timestamp: '2026-09-11T00:00:00Z', [field]: value });
      assert.equal(res.status, 400, `${field}=${value}`);
      assert.deepEqual((await res.json()).details.map((item) => item.field), [field], `${field}=${value}`);
    }
  });

  test('missing and read-only fields are all reported', async () => {
    const res = await submit({ id: MISSING, installationId: fixture.device.id });
    assert.equal(res.status, 400);
    assert.deepEqual((await res.json()).details.map((item) => item.field).sort(),
      ['energyKwh', 'id', 'installationId', 'powerKw', 'timestamp', 'voltage']);
    for (const body of [[], 'null', '{"timestamp":']) {
      assert.equal((await submit(body)).status, 400, String(body));
    }
    assert.equal((await submit(VALID, { installationId: 'not-a-uuid' })).status, 400);
  });

  test('media type and method errors', async () => {
    const url = `${fixture.url}/solar/v1.0/installations/${fixture.device.id}/readings`;
    const auth = { Authorization: `Bearer ${deviceToken()}` };
    const text = await fetch(url, { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(text.status, 415);
    assert.equal((await fetch(url, { method: 'POST', headers: auth })).status, 400);
    assert.equal((await submit(VALID, { headers: { Accept: 'text/csv' } })).status, 406);
    const put = await fetch(url, { method: 'PUT', headers: auth });
    assert.equal(put.status, 405);
  });
});
