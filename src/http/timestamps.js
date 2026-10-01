// RFC 3339 date-time with a required offset: Z or +hh:mm/-hh:mm. A local time without an offset
// is ambiguous, so it is rejected. At most three fractional digits, because JavaScript dates and
// the JSON responses hold milliseconds.
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

// Returns the instant as a Date, or null when the text is not such a timestamp or names a date
// or time that does not exist (Date.parse would turn 30 February into 2 March).
function parseTimestamp(text) {
  const match = typeof text === 'string' ? DATE_TIME.exec(text) : null;
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const millis = match[7] ? Math.round(Number(match[7]) * 1000) : 0;
  const [sign, offsetHours, offsetMinutes] = [match[8], Number(match[9] ?? 0), Number(match[10] ?? 0)];
  if (offsetHours > 23 || offsetMinutes > 59) return null;

  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
  // Leap seconds (:60) and out-of-range fields do not survive the round trip.
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day
      || local.getUTCHours() !== hour || local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second) {
    return null;
  }
  const offset = (sign === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60000;
  return new Date(local.getTime() - offset);
}

module.exports = { parseTimestamp };
