const express = require('express');
const pool = require('../config/db');
const { ERRORS, ApiError, detail } = require('../errors');
const { authenticate, requirePrincipal } = require('../middleware/authenticate');
const { methodNotAllowed } = require('../middleware/errors');
const { requireJsonBody } = require('../middleware/http');
const { checkQueryNames, parsePage, pageLinks, requireUuid } = require('../http/query');
const { sendCacheableJson } = require('../http/conditional');
const { parseTimestamp } = require('../http/timestamps');
const { readerScope, DISTRICT_VISIBLE } = require('../auth/scope');

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

// Reading collection queries: offset and limit, from (inclusive) and to (exclusive) as
// timestamps with an offset, and sort by timestamp ascending (default) or descending.
// `extra` names further accepted parameters. Returns the page, the parsed window, the SQL sort
// direction, and the values to keep in page links.
function parseReadingQuery(req, extra = []) {
  const page = parsePage(req, ['offset', 'limit', 'from', 'to', 'sort', ...extra]);
  const problems = [];
  const time = (name) => {
    const raw = req.query[name];
    if (raw === undefined) return null;
    const value = parseTimestamp(raw);
    if (!value) {
      problems.push(detail('query', name, `${name} must be an RFC 3339 date-time with a timezone offset (send + as %2B).`));
    }
    return value;
  };
  const from = time('from');
  const to = time('to');
  if (from && to && to <= from) problems.push(detail('query', 'to', 'to must be later than from.'));
  const { sort = 'timestamp' } = req.query;
  if (sort !== 'timestamp' && sort !== '-timestamp') {
    problems.push(detail('query', 'sort', 'sort must be timestamp or -timestamp.'));
  }
  if (problems.length > 0) throw new ApiError(ERRORS.VALIDATION_FAILED, { details: problems });
  return {
    page,
    from,
    to,
    direction: sort === '-timestamp' ? 'DESC' : 'ASC',
    kept: { from: req.query.from, to: req.query.to, sort: req.query.sort },
  };
}

// The installation aliased i is visible to a staff reader. Uses $1-$3 from readerScope().
const INSTALLATION_VISIBLE = `EXISTS (
  SELECT 1 FROM grid_substations s JOIN districts d ON d.id = s.district_id
  WHERE s.id = i.substation_id AND ${DISTRICT_VISIBLE})`;

// Authentication runs before any input is read or data is queried.
router.use('/installations/:installationId/readings', authenticate);

/**
 * @openapi
 * /solar/v1.0/installations/{installation-id}/readings:
 *   get:
 *     tags: [Readings]
 *     summary: List an installation's reading history
 *     description: |
 *       Staff readers only; devices and the provisioner get 403. An installation outside the
 *       caller's jurisdiction returns the same 404 as a nonexistent one; a visible installation
 *       with no readings in the window returns an empty page. `from` is inclusive and `to`
 *       exclusive, both timestamps with an offset (send `+` as `%2B`). Ordered by timestamp, then
 *       ID; page links keep the filters and sorting. Validated by ETag only.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/installationId'
 *       - $ref: '#/components/parameters/offset'
 *       - $ref: '#/components/parameters/limit'
 *       - $ref: '#/components/parameters/from'
 *       - $ref: '#/components/parameters/to'
 *       - $ref: '#/components/parameters/sort'
 *       - $ref: '#/components/parameters/ifNoneMatch'
 *     responses:
 *       200:
 *         description: A page of the installation's readings.
 *         headers:
 *           ETag:
 *             $ref: '#/components/headers/ETag'
 *           Cache-Control:
 *             $ref: '#/components/headers/CacheControl'
 *           Vary:
 *             $ref: '#/components/headers/Vary'
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReadingCollection'
 *       304:
 *         $ref: '#/components/responses/NotModified'
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
 *       500:
 *         $ref: '#/components/responses/InternalError'
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
  .get(requirePrincipal('staff'), async (req, res) => {
    const { page, from, to, direction, kept } = parseReadingQuery(req);
    const installationId = requireUuid(req.params.installationId, 'installation-id');
    // One statement, so the parent check, count, and page come from the same snapshot.
    const { rows } = await pool.query(
      `WITH parent AS (SELECT i.id FROM solar_installations i WHERE i.id = $4 AND ${INSTALLATION_VISIBLE}),
       visible AS (
         SELECT * FROM generation_readings
         WHERE installation_id = (SELECT id FROM parent)
           AND ($5::timestamptz IS NULL OR "timestamp" >= $5)
           AND ($6::timestamptz IS NULL OR "timestamp" < $6)
       )
       SELECT
         EXISTS (SELECT 1 FROM parent) AS found,
         (SELECT count(*) FROM visible)::int AS count,
         coalesce(
           (SELECT json_agg(${READING_JSON} ORDER BY r."timestamp" ${direction}, r.id ${direction})
            FROM (SELECT * FROM visible ORDER BY "timestamp" ${direction}, id ${direction} LIMIT $7 OFFSET $8) AS r),
           '[]'::json
         ) AS results`,
      [...readerScope(req.principal), installationId, from, to, page.limit, page.offset],
    );
    const { found, count, results } = rows[0];
    // A missing installation and one outside the caller's scope get the same 404.
    if (!found) throw new ApiError(ERRORS.RESOURCE_NOT_FOUND);
    // ETag only: the page changes when a reading arrives, which no row timestamp records.
    sendCacheableJson(req, res, { count, ...pageLinks(req, page, count, kept), results });
  })
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
  .all(methodNotAllowed('GET', 'HEAD', 'POST'));

/**
 * @openapi
 * /solar/v1.0/installations/{installation-id}/readings/{reading-id}:
 *   get:
 *     tags: [Readings]
 *     summary: Get one reading
 *     description: |
 *       Staff readers only. The reading must belong to the installation in the path: a reading
 *       of another installation returns the same 404 as a missing reading, as does an
 *       installation outside the caller's jurisdiction. Readings never change, but the server
 *       keeps no time of insertion, so the response is validated by ETag only. No query
 *       parameters are accepted.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/installationId'
 *       - $ref: '#/components/parameters/readingId'
 *       - $ref: '#/components/parameters/ifNoneMatch'
 *     responses:
 *       200:
 *         description: The reading.
 *         headers:
 *           ETag:
 *             $ref: '#/components/headers/ETag'
 *           Cache-Control:
 *             $ref: '#/components/headers/CacheControl'
 *           Vary:
 *             $ref: '#/components/headers/Vary'
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Reading'
 *       304:
 *         $ref: '#/components/responses/NotModified'
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
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */
router
  .route('/installations/:installationId/readings/:readingId')
  .get(requirePrincipal('staff'), async (req, res) => {
    checkQueryNames(req, []);
    const installationId = requireUuid(req.params.installationId, 'installation-id');
    const readingId = requireUuid(req.params.readingId, 'reading-id');
    const { rows } = await pool.query(
      `SELECT ${READING_JSON} AS reading
       FROM generation_readings r JOIN solar_installations i ON i.id = r.installation_id
       WHERE r.id = $5 AND r.installation_id = $4 AND ${INSTALLATION_VISIBLE}`,
      [...readerScope(req.principal), installationId, readingId],
    );
    // Missing, under another installation, or outside the caller's scope: the same 404.
    if (rows.length === 0) throw new ApiError(ERRORS.RESOURCE_NOT_FOUND);
    sendCacheableJson(req, res, rows[0].reading);
  })
  .all(methodNotAllowed('GET', 'HEAD'));

module.exports = router;
