const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeDistrict } = require('../src/services/districtSummary');

// 7 September 2026 in Sri Lanka (+05:30). Expected totals below are worked out by hand.
const dayStart = new Date('2026-09-07T00:00:00+05:30');
const dayEnd = new Date('2026-09-08T00:00:00+05:30');
const at = (time) => new Date(`2026-09-07T${time}:00+05:30`);
const reading = (timestamp, energyKwh) => ({ timestamp, energyKwh });
// PostgreSQL returns numeric columns as strings, so the fixtures use strings too.
const fullDay = (startKwh, endKwh) => [reading(dayStart, startKwh), reading(at('12:00'), startKwh), reading(dayEnd, endKwh)];

function summarize(installations, now = new Date('2026-10-01T12:00:00+05:30')) {
  return summarizeDistrict({ installations, dayStart, dayEnd, now });
}
const installation = (readings, latest = null) => ({ readings, latest });

describe('district energy for a day', () => {
  test('samples at both midnights give the difference, and the district is complete', () => {
    const { installations, energy } = summarize([
      installation(fullDay('1000.000', '1012.345')), // 12.345
      installation(fullDay('250.100', '257.855')), // 7.755
    ]);
    assert.equal(installations, 2);
    assert.deepEqual(energy, {
      complete: true,
      completeKwh: 20.1,
      partialKwh: null,
      completeInstallations: 2,
      partialInstallations: 0,
      missingInstallations: 0,
      anomalousInstallations: 0,
      earliestPartialSampleAt: null,
      latestPartialSampleAt: null,
    });
  });

  test('without the closing midnight sample the energy is partial, up to the latest sample', () => {
    const { energy } = summarize([
      installation([reading(dayStart, '500.000'), reading(at('12:00'), '503.250'), reading(at('23:45'), '509.500')]),
    ]);
    assert.equal(energy.complete, false);
    assert.equal(energy.completeKwh, null);
    assert.equal(energy.partialKwh, 9.5);
    assert.equal(energy.partialInstallations, 1);
    assert.equal(energy.latestPartialSampleAt, '2026-09-07T18:15:00.000Z');
  });

  test('complete and partial installations are totalled separately, with the range of partial samples', () => {
    const { energy } = summarize([
      installation(fullDay('100.000', '110.000')), // complete: 10
      installation([reading(dayStart, '40.000'), reading(at('09:00'), '41.500')]), // partial: 1.5 to 09:00
      installation([reading(dayStart, '70.000'), reading(at('15:30'), '76.250')]), // partial: 6.25 to 15:30
    ]);
    assert.equal(energy.complete, false);
    assert.equal(energy.completeKwh, 10);
    assert.equal(energy.partialKwh, 7.75);
    assert.equal(energy.completeInstallations, 1);
    assert.equal(energy.partialInstallations, 2);
    assert.equal(energy.earliestPartialSampleAt, '2026-09-07T03:30:00.000Z');
    assert.equal(energy.latestPartialSampleAt, '2026-09-07T10:00:00.000Z');
  });

  test('without the opening midnight sample the installation is missing and adds nothing', () => {
    const { energy } = summarize([
      installation([reading(at('00:15'), '900.000'), reading(dayEnd, '950.000')]),
      installation([]),
    ]);
    assert.equal(energy.missingInstallations, 2);
    assert.equal(energy.complete, false);
    assert.equal(energy.completeKwh, null);
    assert.equal(energy.partialKwh, null);
  });

  test('a meter value that decreases is an anomaly, also at the closing midnight', () => {
    const { energy } = summarize([
      installation([reading(dayStart, '800.000'), reading(at('10:00'), '805.000'), reading(at('10:15'), '0.250'), reading(dayEnd, '6.000')]),
      installation([reading(dayStart, '800.000'), reading(at('23:45'), '812.000'), reading(dayEnd, '0.000')]),
      installation(fullDay('10.000', '14.000')),
    ]);
    assert.equal(energy.anomalousInstallations, 2);
    assert.equal(energy.completeInstallations, 1);
    // Only the sound installation is in the total, and the district is not complete.
    assert.equal(energy.completeKwh, 4);
    assert.equal(energy.complete, false);
  });

  test('samples can arrive in any order, and those outside the day are ignored', () => {
    const { energy } = summarize([
      installation([
        reading(dayEnd, '330.000'),
        reading(new Date('2026-09-06T23:45:00+05:30'), '999.000'), // the day before
        reading(at('12:00'), '310.000'),
        reading(dayStart, '300.000'),
        reading(new Date('2026-09-08T00:15:00+05:30'), '1.000'), // the day after
      ]),
    ]);
    assert.equal(energy.complete, true);
    assert.equal(energy.completeKwh, 30);
  });

  test('zero generation is 0; no data is null', () => {
    const still = summarize([installation(fullDay('640.000', '640.000'))]);
    assert.equal(still.energy.completeKwh, 0);
    assert.equal(still.energy.complete, true);

    const empty = summarize([]);
    assert.equal(empty.installations, 0);
    assert.equal(empty.energy.complete, false);
    assert.equal(empty.energy.completeKwh, null);
    assert.equal(empty.energy.partialKwh, null);
    assert.equal(empty.power.totalKw, null);
  });

  test('decimal sums are exact, and a total beyond the exact range is refused', () => {
    // 0.1 + 0.2 is not 0.3 in floating point; in thousandths it is.
    const { energy } = summarize([installation(fullDay('0.000', '0.100')), installation(fullDay('0.000', '0.200'))]);
    assert.equal(energy.completeKwh, 0.3);

    // 100 installations at the column maximum: about 1e16 thousandths, above 2^53.
    const huge = Array.from({ length: 100 }, () => installation(fullDay('0.000', '99999999999.999')));
    assert.throws(() => summarize(huge), RangeError);
  });
});

describe('current district power', () => {
  const now = new Date('2026-09-07T12:00:00+05:30');
  const latest = (time, powerKw) => ({ timestamp: at(time), powerKw });

  test('fresh latest readings are summed; older ones are counted as stale', () => {
    const { power } = summarize([
      installation([], latest('12:00', '3.250')), // now
      installation([], latest('11:30', '1.125')), // exactly 30 minutes old: still fresh
      installation([], latest('11:29', '9.000')), // stale
      installation([], null), // never reported
    ], now);
    assert.deepEqual(power, {
      totalKw: 4.375,
      reportingInstallations: 2,
      staleInstallations: 1,
      latestReadingAt: '2026-09-07T06:30:00.000Z',
    });
  });

  test('when nothing is fresh the total is null, not 0', () => {
    const { power } = summarize([installation([], latest('08:00', '2.000'))], now);
    assert.deepEqual(power, { totalKw: null, reportingInstallations: 0, staleInstallations: 1, latestReadingAt: null });
  });

  test('a fresh reading of zero power gives 0', () => {
    const { power } = summarize([installation([], latest('11:45', '0.000'))], now);
    assert.equal(power.totalKw, 0);
    assert.equal(power.reportingInstallations, 1);
  });

  test('a reading dated after now is ignored', () => {
    const { power } = summarize([installation([], latest('12:15', '5.000'))], now);
    assert.deepEqual(power, { totalKw: null, reportingInstallations: 0, staleInstallations: 0, latestReadingAt: null });
  });
});
