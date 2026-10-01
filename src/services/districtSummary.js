// District generation summary: a pure calculation over readings, with no database access.
// The rules are described in docs/api-endpoints.md (District generation summary).
//
// energyKwh is the meter's cumulative value at the reading's timestamp, so the energy of a day
// is the difference between the samples at its two midnights, never a sum of meter values.

// A latest reading older than this is stale: two 15-minute reporting intervals.
const FRESH_MILLISECONDS = 30 * 60 * 1000;

// kW and kWh have at most three decimal places (numeric(10,3) and numeric(14,3)), so integer
// thousandths add and subtract exactly. PostgreSQL returns numeric values as strings.
function toThousandths(value) {
  return Math.round(Number(value) * 1000);
}

// Back to a JSON number. A double holds three decimals exactly only while the integer of
// thousandths is safe (up to 9,007,199,254,740.991), so a larger total is refused, not rounded.
function fromThousandths(total) {
  if (!Number.isSafeInteger(total)) throw new RangeError('A summary total is outside the exact numeric range.');
  return total / 1000;
}

// The state of one installation's energy for the day [dayStart, dayEnd]:
//   missing   - no sample at dayStart, so there is nothing to subtract from
//   anomalous - the meter value decreases between two samples (reset or replacement)
//   complete  - samples at both midnights; energy is their difference
//   partial   - no sample at dayEnd; energy runs only to the latest sample in the day
function installationEnergy(readings, dayStart, dayEnd) {
  const samples = readings
    .filter((reading) => reading.timestamp >= dayStart && reading.timestamp <= dayEnd)
    .map((reading) => ({ time: reading.timestamp.getTime(), energy: toThousandths(reading.energyKwh) }))
    .sort((a, b) => a.time - b.time);

  if (samples.length === 0 || samples[0].time !== dayStart.getTime()) return { state: 'missing' };
  // Checked up to and including the closing sample, so a reset just before midnight is caught.
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].energy < samples[index - 1].energy) return { state: 'anomalous' };
  }
  const last = samples[samples.length - 1];
  return {
    state: last.time === dayEnd.getTime() ? 'complete' : 'partial',
    energy: last.energy - samples[0].energy,
    lastSampleAt: last.time,
  };
}

const isoOrNull = (milliseconds) => (milliseconds === null ? null : new Date(milliseconds).toISOString());

// installations: [{ readings: [{ timestamp: Date, energyKwh }], latest: { timestamp: Date, powerKw } | null }]
//   readings - the installation's readings from dayStart to dayEnd inclusive, in any order
//   latest   - its reading with the greatest timestamp, or null when it has none
// dayStart and dayEnd are the day's two midnights; now is the time of the request.
function summarizeDistrict({ installations, dayStart, dayEnd, now }) {
  const counts = { complete: 0, partial: 0, missing: 0, anomalous: 0 };
  let completeEnergy = 0;
  let partialEnergy = 0;
  let earliestPartial = null;
  let latestPartial = null;

  let power = 0;
  let reporting = 0;
  let stale = 0;
  let latestReading = null;

  for (const installation of installations) {
    const result = installationEnergy(installation.readings, dayStart, dayEnd);
    counts[result.state] += 1;
    if (result.state === 'complete') completeEnergy += result.energy;
    if (result.state === 'partial') {
      partialEnergy += result.energy;
      earliestPartial = earliestPartial === null ? result.lastSampleAt : Math.min(earliestPartial, result.lastSampleAt);
      latestPartial = latestPartial === null ? result.lastSampleAt : Math.max(latestPartial, result.lastSampleAt);
    }

    // Power is "now", whatever day was asked for. A reading dated after now is ignored: a wrong
    // device clock must not count as current.
    const { latest } = installation;
    if (latest && latest.timestamp <= now) {
      if (now - latest.timestamp <= FRESH_MILLISECONDS) {
        reporting += 1;
        power += toThousandths(latest.powerKw);
        latestReading = Math.max(latestReading ?? 0, latest.timestamp.getTime());
      } else {
        stale += 1;
      }
    }
  }

  // null means no data; 0 means measured zero.
  return {
    installations: installations.length,
    power: {
      totalKw: reporting > 0 ? fromThousandths(power) : null,
      reportingInstallations: reporting,
      staleInstallations: stale,
      latestReadingAt: isoOrNull(latestReading),
    },
    energy: {
      // An empty district is not complete: there is nothing to total.
      complete: installations.length > 0 && counts.complete === installations.length,
      completeKwh: counts.complete > 0 ? fromThousandths(completeEnergy) : null,
      partialKwh: counts.partial > 0 ? fromThousandths(partialEnergy) : null,
      completeInstallations: counts.complete,
      partialInstallations: counts.partial,
      missingInstallations: counts.missing,
      anomalousInstallations: counts.anomalous,
      earliestPartialSampleAt: isoOrNull(earliestPartial),
      latestPartialSampleAt: isoOrNull(latestPartial),
    },
  };
}

module.exports = { summarizeDistrict, FRESH_MILLISECONDS };
