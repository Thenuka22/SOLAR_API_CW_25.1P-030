const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTimestamp } = require('../src/http/timestamps');

test('timestamps with an offset convert to the same instant', () => {
  assert.equal(parseTimestamp('2026-09-08T12:00:00+05:30').toISOString(), '2026-09-08T06:30:00.000Z');
  assert.equal(parseTimestamp('2026-09-08T06:30:00Z').toISOString(), '2026-09-08T06:30:00.000Z');
  assert.equal(parseTimestamp('2026-09-08t06:30:00.5z').toISOString(), '2026-09-08T06:30:00.500Z');
  assert.equal(parseTimestamp('2026-09-07T20:00:00.123-10:30').toISOString(), '2026-09-08T06:30:00.123Z');
  assert.equal(parseTimestamp('2024-02-29T00:00:00Z').toISOString(), '2024-02-29T00:00:00.000Z');
});

test('local times, impossible dates, and finer precision are rejected', () => {
  for (const text of [
    '2026-09-08T12:00:00', // no offset
    '2026-09-08 12:00:00Z', // space instead of T
    '2026-09-08', // date only
    '2026-02-30T00:00:00Z', // Date.parse would give 2 March
    '2025-02-29T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-09-08T24:00:00Z',
    '2016-12-31T23:59:60Z', // leap second
    '2026-09-08T12:00:00.1234Z', // microseconds
    '2026-09-08T12:00:00+24:00',
    '2026-09-08T12:00:00+05:60',
    '2026-09-08T12:00:00+0530',
    '1773000000',
    '',
  ]) {
    assert.equal(parseTimestamp(text), null, text);
  }
  for (const value of [undefined, null, 1773000000000, {}]) assert.equal(parseTimestamp(value), null);
});
