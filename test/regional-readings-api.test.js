require('dotenv').config({ quiet: true });

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApiFixture } = require('./helpers/apiFixture');

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';
const MISSING = '00000000-0000-4000-8000-000000000000';
const q = encodeURIComponent;
const DAY = `from=${q('2026-09-03T00:00:00+05:30')}&to=${q('2026-09-04T00:00:00+05:30')}`;

describe('regional reading history', { skip }, () => {
  let fixture;
  let ids; // seeded installations per district, substation, and province
  let colomboSubstationId;
  before(async () => {
    fixture = await startApiFixture();
    const { rows } = await fixture.db.query(
      `SELECT i.id, s.id AS substation_id, d.name AS district, d.id AS district_id, p.name AS province, p.id AS province_id
       FROM solar_installations i JOIN grid_substations s ON s.id = i.substation_id
       JOIN districts d ON d.id = s.district_id JOIN provinces p ON p.id = d.province_id
       WHERE i.meter_id LIKE 'MTR-%'`,
    );
    const where = (predicate) => rows.filter(predicate);
    ids = {
      all: rows,
      western: where((row) => row.province === 'Western'),
      colombo: where((row) => row.district === 'Colombo'),
      gampahaDistrictId: where((row) => row.district === 'Gampaha')[0].district_id,
      galleDistrictId: where((row) => row.district === 'Galle')[0].district_id,
    };
    colomboSubstationId = ids.colombo[0].substation_id;
  });
  after(async () => { if (fixture) await fixture.close(); });

  const staff = (role) => fixture.token('staff', fixture.staff[role]);
  async function page(query, role = 'national', headers = {}) {
    const res = await fetch(`${fixture.url}/solar/v1.0/readings${query}`, {
      headers: { Authorization: `Bearer ${staff(role)}`, ...headers },
    });
    return { res, body: res.status === 200 ? await res.json() : null };
  }

  test('each role counts only readings within its jurisdiction', async () => {
    // 96 readings per installation per day in the seed.
    const expected = { national: ids.all.length, provincial: ids.western.length, district: ids.colombo.length };
    for (const [role, installations] of Object.entries(expected)) {
      const { res, body } = await page(`?${DAY}&limit=200`, role);
      assert.equal(res.status, 200, role);
      assert.equal(body.count, installations * 96, role);
    }
    const { body } = await page(`?${DAY}&limit=200`, 'district');
    const allowed = new Set(ids.colombo.map((row) => row.id));
    assert.ok(body.results.every((reading) => allowed.has(reading.installationId)));
  });

  test('province, district, and substation filters narrow the result and combine with AND', async () => {
    const western = ids.all.find((row) => row.province === 'Western').province_id;
    const colomboDistrict = ids.colombo[0].district_id;
    const atSubstation = ids.colombo.filter((row) => row.substation_id === colomboSubstationId).length;
    const cases = [
      [`province-id=${western}`, ids.western.length],
      [`district-id=${colomboDistrict}`, ids.colombo.length],
      [`substation-id=${colomboSubstationId}`, atSubstation],
      [`province-id=${western}&district-id=${colomboDistrict}`, ids.colombo.length],
      [`province-id=${western}&district-id=${ids.galleDistrictId}`, 0], // contradictory filters
      [`district-id=${ids.gampahaDistrictId}&substation-id=${colomboSubstationId}`, 0],
    ];
    for (const [filter, installations] of cases) {
      const { body } = await page(`?${DAY}&${filter}`);
      assert.equal(body.count, installations * 96, filter);
    }
  });

  test('filters outside the jurisdiction or naming nothing return an empty page, not 404', async () => {
    for (const [role, filter] of [
      ['provincial', `district-id=${ids.galleDistrictId}`],
      ['district', `district-id=${ids.gampahaDistrictId}`],
      ['district', `province-id=${ids.all.find((row) => row.province === 'Southern').province_id}`],
      ['national', `substation-id=${MISSING}`],
    ]) {
      const { res, body } = await page(`?${filter}`, role);
      assert.equal(res.status, 200, `${role} ${filter}`);
      assert.deepEqual(body, { count: 0, next: null, previous: null, results: [] }, `${role} ${filter}`);
    }
  });

  test('authorization comes before counts, page links, and conditional responses', async () => {
    // The national reader's page for a Galle filter has readings, links, and an ETag.
    const filter = `?district-id=${ids.galleDistrictId}&limit=5`;
    const national = await page(filter, 'national');
    assert.ok(national.body.count > 0);
    assert.ok(national.body.next);
    const nationalTag = national.res.headers.get('etag');

    // The same URL for a provincial reader of Western: nothing counted, no links, and the
    // national ETag does not produce a 304.
    const provincial = await page(filter, 'provincial', { 'If-None-Match': nationalTag });
    assert.equal(provincial.res.status, 200);
    assert.deepEqual(provincial.body, { count: 0, next: null, previous: null, results: [] });
    assert.notEqual(provincial.res.headers.get('etag'), nationalTag);

    // Unauthenticated and non-staff requests stop before any validator is computed.
    const url = `${fixture.url}/solar/v1.0/readings${filter}`;
    const anonymous = await fetch(url, { headers: { 'If-None-Match': '*' } });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('etag'), null);
    for (const token of [fixture.token('device', fixture.device), fixture.token('provisioner', fixture.provisioner)]) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'If-None-Match': '*' } });
      assert.equal(res.status, 403);
      assert.equal(res.headers.get('etag'), null);
    }
    // Invalid input is rejected before the query, even with a validator.
    assert.equal((await page('?district-id=nope', 'national', { 'If-None-Match': '*' })).res.status, 400);
  });

  test('pages keep every filter and the sort, with a stable order across installations', async () => {
    const colomboDistrict = ids.colombo[0].district_id;
    const window = `from=${q('2026-09-03T12:00:00+05:30')}&to=${q('2026-09-03T12:30:00+05:30')}`;
    const first = await page(`?district-id=${colomboDistrict}&${window}&sort=-timestamp&limit=7`, 'provincial');
    const total = ids.colombo.length * 2; // two readings per installation in the half hour
    assert.equal(first.body.count, total);
    assert.equal(first.body.next,
      `/solar/v1.0/readings?district-id=${colomboDistrict}&${window}&sort=-timestamp&offset=7&limit=7`);

    const seen = [...first.body.results];
    let link = first.body.next;
    while (link) {
      const next = await page(link.slice('/solar/v1.0/readings'.length), 'provincial');
      assert.equal(next.body.count, total);
      seen.push(...next.body.results);
      link = next.body.next;
    }
    assert.equal(seen.length, total);
    assert.equal(new Set(seen.map((reading) => reading.id)).size, total);
    // Several installations share each timestamp; ties are broken by reading ID, descending.
    for (let i = 1; i < seen.length; i += 1) {
      const [a, b] = [seen[i - 1], seen[i]];
      assert.ok(a.timestamp > b.timestamp || (a.timestamp === b.timestamp && a.id > b.id), `${i}`);
    }
  });

  test('ascending order is the default, and time filters are inclusive then exclusive', async () => {
    const window = `from=${q('2026-09-03T12:00:00+05:30')}&to=${q('2026-09-03T12:15:00+05:30')}`;
    const { body } = await page(`?district-id=${ids.colombo[0].district_id}&${window}`);
    assert.equal(body.count, ids.colombo.length);
    assert.ok(body.results.every((reading) => reading.timestamp === '2026-09-03T06:30:00.000Z'));
    const ordered = body.results.map((reading) => reading.id);
    assert.deepEqual(ordered, [...ordered].sort());
  });

  test('invalid filters are rejected', async () => {
    for (const query of [
      '?province-id=western', `?district-id=${MISSING}&district-id=${MISSING}`, '?substation-id=',
      '?installation-id=' + MISSING, '?from=2026-09-03', '?sort=timestamp,-id', '?limit=0',
    ]) {
      const { res } = await page(query);
      assert.equal(res.status, 400, query);
      assert.equal((await res.json()).code, 2001, query);
    }
  });

  test('conditional requests and validators', async () => {
    const query = `?district-id=${ids.colombo[0].district_id}&${DAY}&limit=3`;
    const { res } = await page(query, 'district');
    const tag = res.headers.get('etag');
    assert.equal(res.headers.get('last-modified'), null);
    assert.equal(res.headers.get('cache-control'), 'private, no-cache');
    assert.equal(res.headers.get('vary'), 'Authorization');
    const again = await page(query, 'district', { 'If-None-Match': tag });
    assert.equal(again.res.status, 304);
    assert.equal(await again.res.text(), '');

    await fixture.db.query('SAVEPOINT regional_reading');
    try {
      await fixture.db.query(
        `INSERT INTO generation_readings (installation_id, "timestamp", power_kw, energy_kwh, voltage)
         VALUES ($1, '2026-09-03T00:00:00+05:30', 0, 1, 230)`,
        [fixture.device.id], // the fixture installation is in Colombo
      );
      const changed = await page(query, 'district', { 'If-None-Match': tag });
      assert.equal(changed.res.status, 200);
    } finally {
      await fixture.db.query('ROLLBACK TO SAVEPOINT regional_reading');
    }
    const post = await fetch(`${fixture.url}/solar/v1.0/readings`, {
      method: 'POST', headers: { Authorization: `Bearer ${staff('national')}` },
    });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
  });
});
