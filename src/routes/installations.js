const express = require('express');
const pool = require('../config/db');
const { ERRORS, ApiError, detail } = require('../errors');
const { authenticate, requirePrincipal } = require('../middleware/authenticate');
const { methodNotAllowed } = require('../middleware/errors');
const { requireJsonBody } = require('../middleware/http');
const { checkQueryNames, parsePage, pageLinks, requireUuid } = require('../http/query');
const { sendCacheableJson, lastModifiedFrom } = require('../http/conditional');
const { metadataScope, DISTRICT_VISIBLE } = require('../auth/scope');

const router = express.Router();

// Installation metadata as JSON, for the row aliased i. Readings are never included.
// capacity_kw is numeric, so it becomes a JSON number.
const INSTALLATION_JSON = `json_build_object(
  'id', i.id, 'substationId', i.substation_id, 'meterId', i.meter_id,
  'address', i.address, 'capacityKw', i.capacity_kw)`;

// meterId is also the device's sign-in identifier, which the token endpoint accepts up to 254
// characters, so a longer one could never sign in.
const MAX_METER_ID_LENGTH = 254;
// capacity_kw is numeric(10, 3): below 10,000,000 with at most three decimal places.
const MAX_CAPACITY_KW = 9999999.999;

// Validates the writable installation fields and reports every problem at once (400).
// Returns the values to store: meterId without surrounding spaces, address null when omitted.
function validateInstallationBody(body, allowed) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(ERRORS.VALIDATION_FAILED, { details: [detail('body', null, 'The body must be a JSON object.')] });
  }
  const problems = Object.keys(body)
    .filter((field) => !allowed.includes(field))
    .map((field) => detail('body', field, 'Unknown or read-only field.'));

  const { meterId, address = null, capacityKw } = body;
  if (typeof meterId !== 'string' || meterId.trim() === '' || meterId.trim().length > MAX_METER_ID_LENGTH) {
    problems.push(detail('body', 'meterId', `meterId must be a non-blank string of at most ${MAX_METER_ID_LENGTH} characters.`));
  }
  if (address !== null && (typeof address !== 'string' || address.trim() === '')) {
    problems.push(detail('body', 'address', 'address must be a non-blank string or null.'));
  }
  // toFixed(3) leaves a number with at most three decimal places unchanged.
  if (typeof capacityKw !== 'number' || !(capacityKw > 0 && capacityKw <= MAX_CAPACITY_KW)
      || Number(capacityKw.toFixed(3)) !== capacityKw) {
    problems.push(detail('body', 'capacityKw',
      `capacityKw must be a number greater than 0 and at most ${MAX_CAPACITY_KW}, with at most 3 decimal places.`));
  }
  if (problems.length > 0) throw new ApiError(ERRORS.VALIDATION_FAILED, { details: problems });
  return { meterId: meterId.trim(), address, capacityKw };
}

// 409 for a unique violation on the meter ID, which can also come from a concurrent request.
function meterIdConflict(err) {
  if (err.code === '23505' && err.constraint === 'solar_installations_meter_id_normalized_key') {
    return new ApiError(ERRORS.METER_ID_TAKEN, { details: [detail('body', 'meterId', 'This meter ID is already registered.')] });
  }
  return err;
}

// Authentication runs before any input is read or data is queried; each route checks the
// principal type.
router.use(['/grid-substations/:substationId/installations', '/installations'], authenticate);

/**
 * @openapi
 * /solar/v1.0/grid-substations/{substation-id}/installations:
 *   get:
 *     tags: [Installations]
 *     summary: List the installations at a visible substation
 *     description: |
 *       Staff readers see installations at substations in their jurisdiction; a provisioner may
 *       list any substation's installations. A substation outside the caller's jurisdiction
 *       returns the same 404 as a nonexistent one; a visible substation with no installations
 *       returns an empty page. Metadata only: no readings. Results are in ID order. Validated by
 *       ETag only: no Last-Modified, and If-Modified-Since is ignored. Only `offset` and `limit`
 *       are accepted.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/substationId'
 *       - $ref: '#/components/parameters/offset'
 *       - $ref: '#/components/parameters/limit'
 *       - $ref: '#/components/parameters/ifNoneMatch'
 *     responses:
 *       200:
 *         description: A page of the substation's installations.
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
 *               $ref: '#/components/schemas/InstallationCollection'
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
 *     tags: [Installations]
 *     summary: Register an installation at a substation
 *     description: |
 *       Provisioner only. The substation comes from the path and the server generates the ID, so
 *       neither may appear in the body; any other unknown field is also rejected. `address` may be
 *       omitted or null. Surrounding spaces are removed from `meterId`, and a meter ID already
 *       registered, ignoring case and surrounding spaces, returns 409. The device's secret is
 *       created afterwards with the operator command, not through the API.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/substationId'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/InstallationCreate'
 *     responses:
 *       201:
 *         description: Installation created.
 *         headers:
 *           Location:
 *             $ref: '#/components/headers/Location'
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Installation'
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
  .route('/grid-substations/:substationId/installations')
  .get(requirePrincipal('staff', 'provisioner'), async (req, res) => {
    const page = parsePage(req);
    const substationId = requireUuid(req.params.substationId, 'substation-id');
    // One statement, so the parent check, count, and page come from the same snapshot. Every
    // installation at a visible substation is visible.
    const { rows } = await pool.query(
      `WITH parent AS (
         SELECT s.id FROM grid_substations s JOIN districts d ON d.id = s.district_id
         WHERE s.id = $4 AND ${DISTRICT_VISIBLE}
       ),
       visible AS (SELECT * FROM solar_installations WHERE substation_id = (SELECT id FROM parent))
       SELECT
         EXISTS (SELECT 1 FROM parent) AS found,
         (SELECT count(*) FROM visible)::int AS count,
         coalesce(
           (SELECT json_agg(${INSTALLATION_JSON} ORDER BY i.id)
            FROM (SELECT * FROM visible ORDER BY id LIMIT $5 OFFSET $6) AS i),
           '[]'::json
         ) AS results`,
      [...metadataScope(req.principal), substationId, page.limit, page.offset],
    );
    const { found, count, results } = rows[0];
    // A missing substation and one outside the caller's scope get the same 404.
    if (!found) throw new ApiError(ERRORS.RESOURCE_NOT_FOUND);
    sendCacheableJson(req, res, { count, ...pageLinks(req, page, count), results });
  })
  .post(requirePrincipal('provisioner'), requireJsonBody, async (req, res) => {
    checkQueryNames(req, []);
    const substationId = requireUuid(req.params.substationId, 'substation-id');
    const values = validateInstallationBody(req.body, ['meterId', 'address', 'capacityKw']);
    // The parent comes from the path and the ID from the database. Selecting the substation in
    // the INSERT gives no row, and so a 404, when it does not exist.
    let rows;
    try {
      ({ rows } = await pool.query(
        `INSERT INTO solar_installations AS i (substation_id, meter_id, address, capacity_kw)
         SELECT id, $2, $3, $4 FROM grid_substations WHERE id = $1
         RETURNING ${INSTALLATION_JSON} AS installation`,
        [substationId, values.meterId, values.address, values.capacityKw],
      ));
    } catch (err) {
      throw meterIdConflict(err);
    }
    if (rows.length === 0) throw new ApiError(ERRORS.RESOURCE_NOT_FOUND);
    const { installation } = rows[0];
    res.status(201).location(`${req.baseUrl}/installations/${installation.id}`).json(installation);
  })
  .all(methodNotAllowed('GET', 'HEAD', 'POST'));

/**
 * @openapi
 * /solar/v1.0/installations/{installation-id}:
 *   get:
 *     tags: [Installations]
 *     summary: Get one installation's metadata
 *     description: |
 *       Staff readers see installations in their jurisdiction; a provisioner may read any
 *       installation. An installation outside the caller's jurisdiction returns the same 404 as a
 *       nonexistent one. Metadata only: the latest reading is in the overview and the
 *       last-known-reading resource. No query parameters are accepted.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/installationId'
 *       - $ref: '#/components/parameters/ifNoneMatch'
 *       - $ref: '#/components/parameters/ifModifiedSince'
 *     responses:
 *       200:
 *         description: The installation's metadata.
 *         headers:
 *           ETag:
 *             $ref: '#/components/headers/ETag'
 *           Last-Modified:
 *             $ref: '#/components/headers/LastModified'
 *           Cache-Control:
 *             $ref: '#/components/headers/CacheControl'
 *           Vary:
 *             $ref: '#/components/headers/Vary'
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Installation'
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
  .route('/installations/:installationId')
  .get(requirePrincipal('staff', 'provisioner'), async (req, res) => {
    checkQueryNames(req, []);
    const id = requireUuid(req.params.installationId, 'installation-id');
    const { rows } = await pool.query(
      `SELECT ${INSTALLATION_JSON} AS installation, i.updated_at, statement_timestamp() AS now
       FROM solar_installations i
       JOIN grid_substations s ON s.id = i.substation_id
       JOIN districts d ON d.id = s.district_id
       WHERE i.id = $4 AND ${DISTRICT_VISIBLE}`,
      [...metadataScope(req.principal), id],
    );
    // A missing installation and one outside the caller's scope get the same 404.
    if (rows.length === 0) throw new ApiError(ERRORS.RESOURCE_NOT_FOUND);
    const { installation, updated_at: updatedAt, now } = rows[0];
    // The body depends only on this row, so its updated_at is a reliable Last-Modified.
    sendCacheableJson(req, res, installation, { lastModified: lastModifiedFrom(updatedAt, now) });
  })
  .all(methodNotAllowed('GET', 'HEAD'));

module.exports = router;
