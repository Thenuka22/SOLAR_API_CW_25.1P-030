require('dotenv').config({ quiet: true });

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApiFixture } = require('./helpers/apiFixture');
const { hashSecret, generateDeviceSecret } = require('../src/auth/credentialHash');

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

// One installation's life through the public API, signing in with real credentials each time:
// registered by the provisioner, written to by its device, read by a district reader.
describe('end-to-end flow', { skip }, () => {
  let fixture;
  let base;
  before(async () => {
    fixture = await startApiFixture();
    base = `${fixture.url}/solar/v1.0`;
  });
  after(async () => { if (fixture) await fixture.close(); });

  async function signIn(credentials) {
    const res = await fetch(`${base}/issue-token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials),
    });
    assert.equal(res.status, 200, JSON.stringify(credentials.principalType));
    return (await res.json()).accessToken;
  }
  const call = (method, path, token, body) => fetch(path.startsWith('/solar') ? `${fixture.url}${path}` : `${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

  test('register, set a device secret, ingest, read, summarize, and keep the history', async () => {
    const { id: colomboId } = (await fixture.db.query("SELECT id FROM districts WHERE name = 'Colombo'")).rows[0];
    const { id: substationId } = (await fixture.db.query(
      'SELECT id FROM grid_substations WHERE district_id = $1 ORDER BY id LIMIT 1', [colomboId],
    )).rows[0];

    // 1. The provisioner registers the installation.
    const provisioner = await signIn({ principalType: 'provisioner', username: fixture.provisioner.username, password: fixture.password });
    const created = await call('POST', `/grid-substations/${substationId}/installations`, provisioner, {
      meterId: 'E2E-METER-1', address: 'No. 1, Test Lane', capacityKw: 4.5,
    });
    assert.equal(created.status, 201);
    const installationUrl = created.headers.get('location');
    const installation = await created.json();
    assert.equal(installationUrl, `/solar/v1.0/installations/${installation.id}`);

    // 2. The operator command stores a hash of a generated device secret (src/cli/credentials.js).
    const deviceSecret = generateDeviceSecret();
    await fixture.db.query(
      'INSERT INTO device_credentials (installation_id, secret_hash) VALUES ($1, $2)',
      [installation.id, await hashSecret(deviceSecret)],
    );

    // 3. The device signs in as its installation and pushes a reading.
    const device = await signIn({ principalType: 'device', meterId: 'E2E-METER-1', deviceSecret });
    const pushed = await call('POST', `${installationUrl}/readings`, device, {
      timestamp: new Date(Date.now() - 60000).toISOString(), powerKw: 3.125, energyKwh: 1520.75, voltage: 231.4,
    });
    assert.equal(pushed.status, 201);
    const reading = await pushed.json();
    const readingUrl = pushed.headers.get('location');
    // It can write nothing else and read nothing back.
    assert.equal((await call('GET', `${installationUrl}/readings`, device)).status, 403);
    assert.equal((await call('GET', installationUrl, device)).status, 403);

    // 4. A district reader sees the reading in every read resource.
    const reader = await signIn({ principalType: 'staff', email: fixture.staff.district.email, password: fixture.password });
    assert.deepEqual(await (await call('GET', readingUrl, reader)).json(), reading);
    const history = await (await call('GET', `${installationUrl}/readings`, reader)).json();
    assert.equal(history.count, 1);
    assert.deepEqual(history.results, [reading]);
    assert.deepEqual(await (await call('GET', `${installationUrl}/last-known-reading`, reader)).json(), reading);
    const overview = await (await call('GET', `${installationUrl}/overview`, reader)).json();
    assert.deepEqual(overview.installation, installation);
    assert.deepEqual(overview.lastKnownReading, reading);
    assert.equal(overview.district.id, colomboId);

    // 5. The summary counts it as current power. One reading cannot make a day's energy.
    const summary = await (await call('POST', '/summarize-district-generation', reader, { districtId: colomboId })).json();
    assert.equal(summary.power.totalKw, 3.125);
    assert.equal(summary.power.reportingInstallations, 1);
    assert.equal(summary.power.latestReadingAt, reading.timestamp);
    assert.equal(summary.energy.complete, false);
    assert.equal(summary.energy.completeKwh, null);

    // 6. The reader cannot write, and the history can no longer be removed or moved.
    assert.equal((await call('DELETE', installationUrl, reader)).status, 403);
    const refused = await call('DELETE', installationUrl, provisioner);
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, 4003);
    assert.deepEqual(await (await call('GET', readingUrl, reader)).json(), reading);
  });
});
