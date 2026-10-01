const express = require('express');
const pool = require('../config/db');
const { ERRORS, ApiError } = require('../errors');
const { authenticate, requirePrincipal } = require('../middleware/authenticate');
const { methodNotAllowed } = require('../middleware/errors');
const { checkQueryNames, parsePage, pageLinks, requireUuid } = require('../http/query');
const { sendCacheableJson, lastModifiedFrom } = require('../http/conditional');
const { metadataScope, DISTRICT_VISIBLE } = require('../auth/scope');

const router = express.Router();

// Installation metadata as JSON, for the row aliased i. Readings are never included.
// capacity_kw is numeric, so it becomes a JSON number.
const INSTALLATION_JSON = `json_build_object(
  'id', i.id, 'substationId', i.substation_id, 'meterId', i.meter_id,
  'address', i.address, 'capacityKw', i.capacity_kw)`;

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
  .all(methodNotAllowed('GET', 'HEAD'));

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
