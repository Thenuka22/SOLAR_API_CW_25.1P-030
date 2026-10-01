const express = require('express');
const pool = require('../config/db');
const { ERRORS, ApiError, detail } = require('../errors');
const { authenticate, requireScope } = require('../middleware/authenticate');
const { methodNotAllowed } = require('../middleware/errors');
const { requireJsonBody } = require('../middleware/http');
const { checkQueryNames, isUuid } = require('../http/query');
const { readerScope, DISTRICT_VISIBLE } = require('../auth/scope');
const { summarizeDistrict } = require('../services/districtSummary');

const router = express.Router();

const TIME_ZONE = 'Asia/Colombo';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Today's date in Sri Lanka as YYYY-MM-DD (the en-CA locale formats dates that way).
function todayInColombo() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());
}

// A YYYY-MM-DD string that names a real calendar date: 2026-02-30 does not survive the round trip.
function isCalendarDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// Validates { districtId, date? } and reports every problem at once (400).
function validateSummaryRequest(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(ERRORS.VALIDATION_FAILED, { details: [detail('body', null, 'The body must be a JSON object.')] });
  }
  const problems = Object.keys(body)
    .filter((field) => !['districtId', 'date'].includes(field))
    .map((field) => detail('body', field, 'Unknown field.'));

  const today = todayInColombo();
  const { districtId, date = today } = body;
  if (!isUuid(districtId)) problems.push(detail('body', 'districtId', 'districtId must be a UUID.'));
  if (!isCalendarDate(date)) {
    problems.push(detail('body', 'date', 'date must be a calendar date in the form YYYY-MM-DD.'));
  } else if (date > today) {
    // Same-format dates compare correctly as text.
    problems.push(detail('body', 'date', `date must not be after today in ${TIME_ZONE} (${today}).`));
  }
  if (problems.length > 0) throw new ApiError(ERRORS.VALIDATION_FAILED, { details: problems });
  return { districtId: districtId.toLowerCase(), date };
}

/**
 * @openapi
 * /solar/v1.0/summarize-district-generation:
 *   post:
 *     tags: [Summaries]
 *     summary: Summarize a district's generation
 *     description: |
 *       A processing function: it computes a result across every installation in a district and
 *       stores nothing, so it is a POST with the district in the body, returns 200 (never 201),
 *       and is not cacheable. Staff readers only. A district outside the caller's jurisdiction
 *       returns the same 404 as a nonexistent one.
 *
 *       `date` is a day in Asia/Colombo and defaults to today; a future date is rejected.
 *
 *       **Energy** is the difference between each installation's cumulative meter values at the
 *       day's two midnights. `completeKwh` totals installations with both samples. `partialKwh`
 *       totals installations with no closing sample, each up to its own latest sample in the day;
 *       the two are never added together. Installations with no opening sample (missing) or a
 *       decreasing meter value (anomalous) are counted but not totalled. `complete` is true only
 *       when every installation in a non-empty district is complete.
 *
 *       **Power** is current, whatever the date: the sum of each installation's latest reading
 *       when it is at most 30 minutes old. Older latest readings are counted as stale.
 *
 *       A figure with no contributing installation is null; 0 means measured zero. Totals are
 *       exact to three decimal places up to 9,007,199,254,740.991.
 *
 *       The seeded readings cover 2026-09-01 to 2026-09-07: the first six days are complete and
 *       the seventh is partial, because the seed has no sample at 00:00 on 8 September.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/DistrictSummaryRequest'
 *     responses:
 *       200:
 *         description: The district's summary.
 *         headers:
 *           Cache-Control:
 *             description: '`no-store`'
 *             schema: { type: string }
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DistrictGenerationSummary'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       406:
 *         $ref: '#/components/responses/NotAcceptable'
 *       413:
 *         $ref: '#/components/responses/PayloadTooLarge'
 *       415:
 *         $ref: '#/components/responses/UnsupportedMediaType'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */
router
  .route('/summarize-district-generation')
  .post(authenticate, requireScope('readings:read'), requireJsonBody, async (req, res) => {
    checkQueryNames(req, []);
    const { districtId, date } = validateSummaryRequest(req.body);

    // One statement, so the jurisdiction check and every reading come from the same snapshot.
    // Numbers are sent as text: the calculation converts them to exact thousandths.
    const { rows } = await pool.query(
      `WITH district AS (
         SELECT d.id FROM districts d WHERE d.id = $4 AND ${DISTRICT_VISIBLE}
       ),
       day AS (
         SELECT $5::date::timestamp AT TIME ZONE '${TIME_ZONE}' AS day_start,
                ($5::date + 1)::timestamp AT TIME ZONE '${TIME_ZONE}' AS day_end,
                statement_timestamp() AS now
       )
       SELECT
         EXISTS (SELECT 1 FROM district) AS found,
         day.day_start, day.day_end, day.now,
         coalesce((
           SELECT json_agg(json_build_object(
             'readings', coalesce((
               SELECT json_agg(json_build_object('timestamp', r."timestamp", 'energyKwh', r.energy_kwh::text))
               FROM generation_readings r
               WHERE r.installation_id = i.id AND r."timestamp" >= day.day_start AND r."timestamp" <= day.day_end
             ), '[]'::json),
             'latest', (
               SELECT json_build_object('timestamp', r."timestamp", 'powerKw', r.power_kw::text)
               FROM generation_readings r
               WHERE r.installation_id = i.id AND r."timestamp" <= day.now
               ORDER BY r."timestamp" DESC LIMIT 1
             )
           ))
           FROM solar_installations i
           JOIN grid_substations s ON s.id = i.substation_id
           WHERE s.district_id = (SELECT id FROM district)
         ), '[]'::json) AS installations
       FROM day`,
      [...readerScope(req.principal), districtId, date],
    );
    const { found, day_start: dayStart, day_end: dayEnd, now, installations } = rows[0];
    // A missing district and one outside the caller's scope get the same 404.
    if (!found) throw new ApiError(ERRORS.RESOURCE_NOT_FOUND);

    // Timestamps inside JSON arrive as text.
    const withDates = (reading) => reading && { ...reading, timestamp: new Date(reading.timestamp) };
    const summary = summarizeDistrict({
      installations: installations.map(({ readings, latest }) => ({
        readings: readings.map(withDates),
        latest: withDates(latest),
      })),
      dayStart,
      dayEnd,
      now,
    });
    // Computed for this moment and this caller; nothing is stored, so nothing may be cached.
    res.set('Cache-Control', 'no-store').json({ districtId, date, timeZone: TIME_ZONE, ...summary });
  })
  .all(methodNotAllowed('POST'));

module.exports = router;
