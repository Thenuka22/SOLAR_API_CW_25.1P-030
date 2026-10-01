const express = require('express');
const pool = require('../config/db');
const { ERRORS, ApiError, detail } = require('../errors');
const { authenticate, requirePrincipal } = require('../middleware/authenticate');
const { methodNotAllowed } = require('../middleware/errors');
const { requireJsonBody } = require('../middleware/http');
const { checkQueryNames, parsePage, pageLinks, isUuid, requireUuid } = require('../http/query');
const { sendCacheableJson, setWriteValidators } = require('../http/conditional');
const { parseTimestamp } = require('../http/timestamps');
const { readerScope, DISTRICT_VISIBLE } = require('../auth/scope');
const { READING_JSON } = require('../db/representations');

const router = express.Router();

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
router.use(['/installations/:installationId/readings', '/installations/:installationId/last-known-reading'], authenticate);
router.use('/readings', authenticate, requirePrincipal('staff'));

// Regional filters on GET /readings: query name -> SQL column, all combined with AND.
const REGION_FILTERS = { 'province-id': 'd.province_id', 'district-id': 'd.id', 'substation-id': 's.id' };

/**
 * @openapi
 * /solar/v1.0/readings:
 *   get:
 *     tags: [Readings]
 *     summary: List readings across installations in the caller's jurisdiction
 *     description: |
 *       The analytical history across many installations. Staff readers only. The caller's
 *       jurisdiction is applied first; `province-id`, `district-id`, and `substation-id` then
 *       narrow it, combined with each other and the time window by AND. A filter naming a region
 *       outside the jurisdiction, or one that does not exist, matches nothing and returns an
 *       empty page; it never widens access. `count` is the total after both. Ordered by
 *       timestamp, then reading ID, so readings of several installations with the same timestamp
 *       keep a stable order across pages. Page links keep every filter and the sort. Validated
 *       by ETag only.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/offset'
 *       - $ref: '#/components/parameters/limit'
 *       - $ref: '#/components/parameters/from'
 *       - $ref: '#/components/parameters/to'
 *       - $ref: '#/components/parameters/sort'
 *       - $ref: '#/components/parameters/provinceFilter'
 *       - $ref: '#/components/parameters/districtFilter'
 *       - $ref: '#/components/parameters/substationFilter'
 *       - $ref: '#/components/parameters/ifNoneMatch'
 *     responses:
 *       200:
 *         description: A page of matching readings.
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
 *       406:
 *         $ref: '#/components/responses/NotAcceptable'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */
router
  .route('/readings')
  .get(async (req, res) => {
    const { page, from, to, direction, kept } = parseReadingQuery(req, Object.keys(REGION_FILTERS));
    const problems = [];
    const regions = Object.keys(REGION_FILTERS).map((name) => {
      const raw = req.query[name];
      if (raw === undefined) return null;
      if (isUuid(raw)) return raw.toLowerCase();
      problems.push(detail('query', name, `${name} must be a UUID.`));
      return null;
    });
    if (problems.length > 0) throw new ApiError(ERRORS.VALIDATION_FAILED, { details: problems });

    // The jurisdiction condition and the filters both apply before counting and paging, in
    // one statement, so the count and the page come from the same snapshot.
    const filters = Object.values(REGION_FILTERS)
      .map((column, index) => `($${index + 4}::uuid IS NULL OR ${column} = $${index + 4})`)
      .join(' AND ');
    const { rows } = await pool.query(
      `WITH visible AS (
         SELECT r.* FROM generation_readings r
         JOIN solar_installations i ON i.id = r.installation_id
         JOIN grid_substations s ON s.id = i.substation_id
         JOIN districts d ON d.id = s.district_id
         WHERE ${DISTRICT_VISIBLE} AND ${filters}
           AND ($7::timestamptz IS NULL OR r."timestamp" >= $7)
           AND ($8::timestamptz IS NULL OR r."timestamp" < $8)
       )
       SELECT
         (SELECT count(*) FROM visible)::int AS count,
         coalesce(
           (SELECT json_agg(${READING_JSON} ORDER BY r."timestamp" ${direction}, r.id ${direction})
            FROM (SELECT * FROM visible ORDER BY "timestamp" ${direction}, id ${direction} LIMIT $9 OFFSET $10) AS r),
           '[]'::json
         ) AS results`,
      [...readerScope(req.principal), ...regions, from, to, page.limit, page.offset],
    );
    const { count, results } = rows[0];
    const keptRegions = Object.fromEntries(Object.keys(REGION_FILTERS).map((name) => [name, req.query[name]]));
    sendCacheableJson(req, res, { count, ...pageLinks(req, page, count, { ...keptRegions, ...kept }), results });
  })
  .all(methodNotAllowed('GET', 'HEAD'));

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
 *           Content-Location:
 *             $ref: '#/components/headers/ContentLocation'
 *           ETag:
 *             $ref: '#/components/headers/ETag'
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
    // WSO2 sections 7.3 and 9: Location and the ETag a GET of it would return. The body is that
    // representation, so Content-Location repeats its URL. No Last-Modified, as for the GET.
    const url = `${req.baseUrl}/installations/${installationId}/readings/${created.id}`;
    setWriteValidators(res, created, null);
    res.status(201).location(url).set('Content-Location', url).json(created);
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

/**
 * @openapi
 * /solar/v1.0/installations/{installation-id}/last-known-reading:
 *   get:
 *     tags: [Readings]
 *     summary: Get an installation's most recent reading
 *     description: |
 *       The operational view of one installation: its reading with the latest measurement
 *       timestamp, derived from the history on each request. A late reading with an earlier
 *       timestamp does not replace it, whenever it arrives. Staff readers only. 404 when the
 *       installation has no readings yet, and the same 404 as a nonexistent installation when it
 *       is outside the caller's jurisdiction. Validated by ETag only, because it changes whenever
 *       a newer reading arrives. No query parameters are accepted.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/installationId'
 *       - $ref: '#/components/parameters/ifNoneMatch'
 *     responses:
 *       200:
 *         description: The latest reading.
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
  .route('/installations/:installationId/last-known-reading')
  .get(requirePrincipal('staff'), async (req, res) => {
    checkQueryNames(req, []);
    const installationId = requireUuid(req.params.installationId, 'installation-id');
    // Latest by measurement timestamp, not by insertion; the (installation_id, timestamp DESC)
    // index serves it directly.
    const { rows } = await pool.query(
      `SELECT (
         SELECT ${READING_JSON} FROM generation_readings r
         WHERE r.installation_id = i.id ORDER BY r."timestamp" DESC LIMIT 1
       ) AS reading
       FROM solar_installations i WHERE i.id = $4 AND ${INSTALLATION_VISIBLE}`,
      [...readerScope(req.principal), installationId],
    );
    // A missing installation and one outside the caller's scope get the same 404.
    if (rows.length === 0) throw new ApiError(ERRORS.RESOURCE_NOT_FOUND);
    if (rows[0].reading === null) {
      throw new ApiError(ERRORS.RESOURCE_NOT_FOUND, {
        details: [detail('path', 'installation-id', 'The installation has no readings yet.')],
      });
    }
    sendCacheableJson(req, res, rows[0].reading);
  })
  .all(methodNotAllowed('GET', 'HEAD'));

module.exports = router;
