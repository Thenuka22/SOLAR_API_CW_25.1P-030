require('dotenv').config({ quiet: true });

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApiFixture } = require('./helpers/apiFixture');

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const MISSING = '00000000-0000-4000-8000-000000000000';
// Seeded window: 2026-09-01 00:00 to 2026-09-08 00:00 Sri Lanka time, every 15 minutes.
const FIRST = '2026-08-31T18:30:00.000Z';
const LAST = '2026-09-07T18:15:00.000Z';
const q = encodeURIComponent;

describe('installation reading history', { skip }, () => {
  let fixture;
  let colombo; // a seeded installation in the Colombo district, visible to every staff fixture
  let neighbour; // another seeded Colombo installation
  let galle; // a seeded installation in Galle, outside the provincial and district scopes
  before(async () => {
    fixture = await startApiFixture();
    const seeded = async (district) => (await fixture.db.query(
      `SELECT i.id FROM solar_installations i JOIN grid_substations s ON s.id = i.substation_id
       JOIN districts d ON d.id = s.district_id WHERE d.name = $1 AND i.meter_id LIKE 'MTR-%' ORDER BY i.meter_id LIMIT 2`,
      [district],
    )).rows;
    [colombo, neighbour] = await seeded('Colombo');
    [galle] = await seeded('Galle');
  });
  after(async () => { if (fixture) await fixture.close(); });

  function read(path, token = fixture.token('staff', fixture.staff.district), headers = {}) {
    return fetch(`${fixture.url}/solar/v1.0${path}`, {
      headers: token ? { Authorization: `Bearer ${token}`, ...headers } : headers,
    });
  }
  const history = (id, query = '') => `/installations/${id}/readings${query}`;

  test('the full seeded week is counted and returned in ascending timestamp order by default', async () => {
    const res = await read(history(colombo.id));
    assert.equal(res.status, 200);
    const page = await res.json();
    assert.equal(page.count, 672);
    assert.equal(page.results.length, 50);
    assert.equal(page.results[0].timestamp, FIRST);
    assert.equal(page.results[1].timestamp, '2026-08-31T18:45:00.000Z');
    for (const reading of page.results) {
      assert.deepEqual(Object.keys(reading), ['id', 'installationId', 'timestamp', 'powerKw', 'energyKwh', 'voltage']);
      assert.equal(reading.installationId, colombo.id);
    }
    const timestamps = page.results.map((reading) => reading.timestamp);
    assert.deepEqual(timestamps, [...timestamps].sort());
  });

  test('sort=-timestamp returns the newest first', async () => {
    const page = await (await read(history(colombo.id, '?sort=-timestamp&limit=3'))).json();
    assert.deepEqual(page.results.map((reading) => reading.timestamp),
      [LAST, '2026-09-07T18:00:00.000Z', '2026-09-07T17:45:00.000Z']);
    assert.equal(page.next, `/solar/v1.0${history(colombo.id)}?sort=-timestamp&offset=3&limit=3`);
  });

  test('from is inclusive and to is exclusive, in any offset', async () => {
    const from = q('2026-09-01T00:00:00+05:30');
    const to = q('2026-09-01T01:00:00+05:30');
    const page = await (await read(history(colombo.id, `?from=${from}&to=${to}`))).json();
    assert.equal(page.count, 4);
    assert.deepEqual(page.results.map((reading) => reading.timestamp), [
      '2026-08-31T18:30:00.000Z', '2026-08-31T18:45:00.000Z', '2026-08-31T19:00:00.000Z', '2026-08-31T19:15:00.000Z',
    ]);
    // The same window written in UTC.
    const utc = await (await read(history(colombo.id, '?from=2026-08-31T18:30:00Z&to=2026-08-31T19:30:00Z'))).json();
    assert.deepEqual(utc.results, page.results);
    // One day: 96 readings; only from or only to also filter.
    const day = await (await read(history(colombo.id, `?from=${from}&to=${q('2026-09-02T00:00:00+05:30')}`))).json();
    assert.equal(day.count, 96);
    assert.equal((await (await read(history(colombo.id, `?from=${q('2026-09-07T00:00:00+05:30')}`))).json()).count, 96);
    assert.equal((await (await read(history(colombo.id, `?to=${q('2026-09-02T00:00:00+05:30')}`))).json()).count, 96);
  });

  test('page links keep the window and sort, and pages tile the result without gaps or repeats', async () => {
    const from = '2026-09-03T00:00:00+05:30';
    const to = '2026-09-03T06:00:00+05:30';
    const first = await (await read(history(colombo.id, `?from=${q(from)}&to=${q(to)}&sort=-timestamp&limit=10`))).json();
    assert.equal(first.count, 24);
    const expectedNext = `/solar/v1.0${history(colombo.id)}?from=${q(from)}&to=${q(to)}&sort=-timestamp&offset=10&limit=10`;
    assert.equal(first.next, expectedNext);
    assert.equal(first.previous, null);

    const seen = [...first.results];
    let link = first.next;
    while (link) {
      const page = await (await read(link.slice('/solar/v1.0'.length))).json();
      assert.equal(page.count, 24);
      seen.push(...page.results);
      link = page.next;
      if (!link) assert.equal(page.previous, `/solar/v1.0${history(colombo.id)}?from=${q(from)}&to=${q(to)}&sort=-timestamp&offset=10&limit=10`);
    }
    assert.equal(seen.length, 24);
    assert.equal(new Set(seen.map((reading) => reading.id)).size, 24);
    const timestamps = seen.map((reading) => reading.timestamp);
    assert.deepEqual(timestamps, [...timestamps].sort().reverse());
    // The same request twice gives the same order.
    const again = await (await read(history(colombo.id, `?from=${q(from)}&to=${q(to)}&sort=-timestamp&limit=10`))).json();
    assert.deepEqual(again.results, first.results);
  });

  test('empty windows and installations without readings return empty pages', async () => {
    const empty = await (await read(history(colombo.id, '?from=2026-10-01T00:00:00Z'))).json();
    assert.deepEqual(empty, { count: 0, next: null, previous: null, results: [] });
    const none = await read(history(fixture.device.id));
    assert.equal(none.status, 200);
    assert.deepEqual(await none.json(), { count: 0, next: null, previous: null, results: [] });
  });

  test('invalid filters and sorting are rejected', async () => {
    for (const query of [
      '?from=2026-09-01T00:00:00', // no offset
      '?from=2026-09-01T00:00:00+05:30', // unencoded + becomes a space
      '?from=2026-02-30T00:00:00Z',
      '?to=yesterday',
      '?from=2026-09-02T00:00:00Z&to=2026-09-01T00:00:00Z',
      '?from=2026-09-01T00:00:00Z&to=2026-09-01T00:00:00Z',
      '?sort=timestamp,id', '?sort=powerKw', '?sort=-timestamp&sort=timestamp',
      '?district-id=' + MISSING, '?limit=201', '?offset=-1',
    ]) {
      const res = await read(history(colombo.id, query));
      assert.equal(res.status, 400, query);
      assert.equal((await res.json()).code, 2001, query);
    }
  });

  test('installations outside the scope, and missing ones, give the same 404', async () => {
    for (const role of ['provincial', 'district']) {
      const token = fixture.token('staff', fixture.staff[role]);
      const hidden = await read(history(galle.id), token, { 'If-None-Match': '*' });
      const missing = await read(history(MISSING), token);
      assert.equal(hidden.status, 404, role);
      assert.equal(hidden.headers.get('etag'), null, role);
      assert.equal(await hidden.text(), await missing.text(), role);
    }
    assert.equal((await read(history(galle.id), fixture.token('staff', fixture.staff.national))).status, 200);
  });

  test('devices and the provisioner cannot read measurements', async () => {
    assert.equal((await read(history(colombo.id), null)).status, 401);
    for (const token of [fixture.token('device', fixture.device), fixture.token('provisioner', fixture.provisioner)]) {
      assert.equal((await read(history(fixture.device.id), token)).status, 403);
      assert.equal((await read(history(colombo.id), token)).status, 403);
    }
  });

  test('an individual reading is found only under its own installation', async () => {
    const [first] = (await (await read(history(colombo.id, '?limit=1'))).json()).results;
    const res = await read(`${history(colombo.id)}/${first.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), first);

    const wrongParent = await read(`${history(neighbour.id)}/${first.id}`);
    const missing = await read(`${history(colombo.id)}/${MISSING}`);
    assert.equal(wrongParent.status, 404);
    assert.equal(missing.status, 404);
    assert.equal(await wrongParent.text(), await missing.text());

    const [hiddenReading] = (await (await read(history(galle.id, '?limit=1'), fixture.token('staff', fixture.staff.national))).json()).results;
    const hidden = await read(`${history(galle.id)}/${hiddenReading.id}`);
    assert.equal(hidden.status, 404);
    assert.equal((await read(`${history(colombo.id)}/not-a-uuid`)).status, 400);
    assert.equal((await read(`${history(colombo.id)}/${first.id}?sort=timestamp`)).status, 400);
    assert.equal((await read(`${history(colombo.id)}/${first.id}`, fixture.token('provisioner', fixture.provisioner))).status, 403);
  });

  test('a reading created by the device can be read at its Location', async () => {
    const created = await fetch(`${fixture.url}/solar/v1.0${history(fixture.device.id)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token('device', fixture.device)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timestamp: '2026-09-08T00:00:00+05:30', powerKw: 0, energyKwh: 12.5, voltage: 229.9 }),
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    const res = await fetch(`${fixture.url}${created.headers.get('location')}`, {
      headers: { Authorization: `Bearer ${fixture.token('staff', fixture.staff.district)}` },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), body);
  });

  test('validators: ETag only, and a new reading changes the collection', async () => {
    const list = await read(history(fixture.device.id));
    const tag = list.headers.get('etag');
    const { count } = await list.json();
    assert.equal(list.headers.get('last-modified'), null);
    assert.equal(list.headers.get('cache-control'), 'private, no-cache');
    assert.equal((await read(history(fixture.device.id), undefined, { 'If-None-Match': tag })).status, 304);

    await fixture.db.query('SAVEPOINT new_reading');
    try {
      await fixture.db.query(
        `INSERT INTO generation_readings (installation_id, "timestamp", power_kw, energy_kwh, voltage)
         VALUES ($1, '2026-09-09T00:00:00Z', 0, 20, 230)`,
        [fixture.device.id],
      );
      const changed = await read(history(fixture.device.id), undefined, { 'If-None-Match': tag });
      assert.equal(changed.status, 200);
      assert.equal((await changed.json()).count, count + 1);
    } finally {
      await fixture.db.query('ROLLBACK TO SAVEPOINT new_reading');
    }

    const [first] = (await (await read(history(colombo.id, '?limit=1'))).json()).results;
    const single = await read(`${history(colombo.id)}/${first.id}`);
    assert.equal(single.headers.get('last-modified'), null);
    const singleAgain = await read(`${history(colombo.id)}/${first.id}`, undefined, { 'If-None-Match': single.headers.get('etag') });
    assert.equal(singleAgain.status, 304);
    assert.equal(await singleAgain.text(), '');
  });
});
