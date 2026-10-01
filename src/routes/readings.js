const express = require('express');
const pool = require('../config/db');
const { ERRORS, ApiError, detail } = require('../errors');
const { authenticate, requirePrincipal } = require('../middleware/authenticate');
const { methodNotAllowed } = require('../middleware/errors');
const { requireJsonBody } = require('../middleware/http');
const { checkQueryNames, requireUuid } = require('../http/query');
const { parseTimestamp } = require('../http/timestamps');

const router = express.Router();

// A reading as JSON, for the row aliased r. The timestamp is returned in UTC with milliseconds;
// the numeric measurements become JSON numbers.
const READING_JSON = `json_build_object(
  'id', r.id, 'installationId', r.installation_id,
  'timestamp', to_char(r."timestamp" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'powerKw', r.power_kw, 'energyKwh', r.energy_kwh, 'voltage', r.voltage)`;

// The stored precision of each measurement (migration 003). A value with more decimal places
// or above the maximum is rejected rather than rounded, so what is stored is what was sent.
const MEASUREMENTS = {
  powerKw: { decimals: 3, max: 9999999.999, unit: 'kW' }, // numeric(10, 3)
  energyKwh: { decimals: 3, max: 99999999999.999, unit: 'kWh' }, // numeric(14, 3)
  voltage: { decimals: 2, max: 99999.99, unit: 'V' }, // numeric(7, 2)
};

// Validates a reading body and reports every problem at once (400).
function validateReadingBody(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(ERRORS.VALIDATION_FAILED, { details: [detail('body', null, 'The body must be a JSON object.')] });
  }
  const allowed = ['timestamp', ...Object.keys(MEASUREMENTS)];
  const problems = Object.keys(body)
    .filter((field) => !allowed.includes(field))
    .map((field) => detail('body', field, 'Unknown or read-only field.'));

  const timestamp = parseTimestamp(body.timestamp);
  if (!timestamp) {
    problems.push(detail('body', 'timestamp',
      'timestamp must be an RFC 3339 date-time with a timezone offset (Z or +hh:mm), at most millisecond precision.'));
  }
  for (const [field, { decimals, max, unit }] of Object.entries(MEASUREMENTS)) {
    const value = body[field];
    // JSON cannot carry NaN or Infinity, so a number here is finite. toFixed leaves a number
    // with at most `decimals` decimal places unchanged.
    if (typeof value !== 'number' || !(value >= 0 && value <= max) || Number(value.toFixed(decimals)) !== value) {
      problems.push(detail('body', field,
        `${field} must be a number in ${unit} from 0 to ${max}, with at most ${decimals} decimal places.`));
    }
  }
  if (problems.length > 0) throw new ApiError(ERRORS.VALIDATION_FAILED, { details: problems });
  return { timestamp, powerKw: body.powerKw, energyKwh: body.energyKwh, voltage: body.voltage };
}

// Authentication runs before any input is read or data is queried.
router.use('/installations/:installationId/readings', authenticate);

/**
 * @openapi
 * /solar/v1.0/installations/{installation-id}/readings:
 *   post:
 *     tags: [Readings]
 *     summary: Submit a reading from the installation's device
 *     description: |
 *       Device tokens only, and only for the device's own installation: any other installation ID
 *       returns 403, whether or not it exists. The server generates the reading ID. `timestamp`
 *       must include a timezone offset and is returned in UTC. Measurements are non-negative and
 *       are rejected, not rounded, if they have more decimal places than are stored. Readings are
 *       append-only; a second reading for the same instant returns 409, even when written with a
 *       different offset.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/installationId'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ReadingCreate'
 *     responses:
 *       201:
 *         description: Reading stored.
 *         headers:
 *           Location:
 *             $ref: '#/components/headers/Location'
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Reading'
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
 *       409:
 *         $ref: '#/components/responses/Conflict'
 *       413:
 *         $ref: '#/components/responses/PayloadTooLarge'
 *       415:
 *         $ref: '#/components/responses/UnsupportedMediaType'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */
router
  .route('/installations/:installationId/readings')
  .post(requirePrincipal('device'), requireJsonBody, async (req, res) => {
    checkQueryNames(req, []);
    const installationId = requireUuid(req.params.installationId, 'installation-id');
    // The installation comes from the authenticated device, so a device writes only its own.
    if (installationId !== req.principal.id) {
      throw new ApiError(ERRORS.FORBIDDEN, {
        details: [detail('path', 'installation-id', 'A device may submit readings only for its own installation.')],
      });
    }
    const reading = validateReadingBody(req.body);

    let rows;
    try {
      ({ rows } = await pool.query(
        `INSERT INTO generation_readings AS r (installation_id, "timestamp", power_kw, energy_kwh, voltage)
         SELECT id, $2, $3, $4, $5 FROM solar_installations WHERE id = $1
         RETURNING ${READING_JSON} AS reading`,
        [installationId, reading.timestamp, reading.powerKw, reading.energyKwh, reading.voltage],
      ));
    } catch (err) {
      // The unique index decides, so two concurrent submissions store at most one reading.
      if (err.code === '23505' && err.constraint === 'generation_readings_installation_id_timestamp_key') {
        throw new ApiError(ERRORS.READING_EXISTS, {
          details: [detail('body', 'timestamp', 'A reading for this installation and instant already exists.')],
        });
      }
      throw err;
    }
    // The installation was deleted after the token was checked.
    if (rows.length === 0) throw new ApiError(ERRORS.RESOURCE_NOT_FOUND);
    const { reading: created } = rows[0];
    res.status(201)
      .location(`${req.baseUrl}/installations/${installationId}/readings/${created.id}`)
      .json(created);
  })
  .all(methodNotAllowed('POST'));

module.exports = router;
