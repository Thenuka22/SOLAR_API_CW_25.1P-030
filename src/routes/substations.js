const express = require('express');
const pool = require('../config/db');
const { ERRORS, ApiError } = require('../errors');
const { authenticate, requireScope } = require('../middleware/authenticate');
const { methodNotAllowed } = require('../middleware/errors');
const { checkQueryNames, parsePage, pageLinks, requireUuid } = require('../http/query');
const { sendCacheableJson, lastModifiedFrom } = require('../http/conditional');
const { readerScope, metadataScope, DISTRICT_VISIBLE } = require('../auth/scope');

const router = express.Router();

// Authentication runs before any input is read or data is queried. The district's substation
// collection is for staff readers only; a provisioner may read an individual substation.
router.use('/districts/:districtId/grid-substations', authenticate, requireScope('hierarchy:read'));
router.use('/grid-substations', authenticate);

/**
 * @openapi
 * /solar/v1.0/districts/{district-id}/grid-substations:
 *   get:
 *     tags: [Grid substations]
 *     summary: List the substations in a visible district
 *     description: |
 *       Staff readers only. A district outside the caller's jurisdiction returns the same 404 as a
 *       nonexistent one; a visible district with no substations returns an empty page. Results
 *       are in ID order. Validated by ETag only: no Last-Modified, and If-Modified-Since is
 *       ignored. Only `offset` and `limit` are accepted.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/districtId'
 *       - $ref: '#/components/parameters/offset'
 *       - $ref: '#/components/parameters/limit'
 *       - $ref: '#/components/parameters/ifNoneMatch'
 *     responses:
 *       200:
 *         description: A page of the district's substations.
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
 *               $ref: '#/components/schemas/GridSubstationCollection'
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
  .route('/districts/:districtId/grid-substations')
  .get(async (req, res) => {
    const page = parsePage(req);
    const districtId = requireUuid(req.params.districtId, 'district-id');
    // One statement, so the parent check, count, and page come from the same snapshot. Every
    // substation of a visible district is visible.
    const { rows } = await pool.query(
      `WITH parent AS (SELECT d.id FROM districts d WHERE d.id = $4 AND ${DISTRICT_VISIBLE}),
       visible AS (SELECT s.id, s.district_id, s.name FROM grid_substations s WHERE s.district_id = (SELECT id FROM parent))
       SELECT
         EXISTS (SELECT 1 FROM parent) AS found,
         (SELECT count(*) FROM visible)::int AS count,
         coalesce(
           (SELECT json_agg(json_build_object('id', id, 'districtId', district_id, 'name', name) ORDER BY id)
            FROM (SELECT * FROM visible ORDER BY id LIMIT $5 OFFSET $6) AS page),
           '[]'::json
         ) AS results`,
      [...readerScope(req.principal), districtId, page.limit, page.offset],
    );
    const { found, count, results } = rows[0];
    // A missing district and one outside the caller's scope get the same 404.
    if (!found) throw new ApiError(ERRORS.RESOURCE_NOT_FOUND);
    sendCacheableJson(req, res, { count, ...pageLinks(req, page, count), results });
  })
  .all(methodNotAllowed('GET', 'HEAD'));

/**
 * @openapi
 * /solar/v1.0/grid-substations/{substation-id}:
 *   get:
 *     tags: [Grid substations]
 *     summary: Get one substation
 *     description: |
 *       Staff readers see substations in their jurisdiction; a substation outside it returns the
 *       same 404 as a nonexistent one. A provisioner may read any substation, because it registers
 *       installations there; a device may not. No query parameters are accepted.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/substationId'
 *       - $ref: '#/components/parameters/ifNoneMatch'
 *       - $ref: '#/components/parameters/ifModifiedSince'
 *     responses:
 *       200:
 *         description: The substation.
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
 *               $ref: '#/components/schemas/GridSubstation'
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
  .route('/grid-substations/:substationId')
  .get(requireScope('installations:read'), async (req, res) => {
    checkQueryNames(req, []);
    const id = requireUuid(req.params.substationId, 'substation-id');
    const { rows } = await pool.query(
      `SELECT s.id, s.district_id, s.name, s.updated_at, statement_timestamp() AS now
       FROM grid_substations s JOIN districts d ON d.id = s.district_id
       WHERE s.id = $4 AND ${DISTRICT_VISIBLE}`,
      [...metadataScope(req.principal), id],
    );
    // A missing substation and one outside the caller's scope get the same 404.
    if (rows.length === 0) throw new ApiError(ERRORS.RESOURCE_NOT_FOUND);
    const substation = rows[0];
    // The body depends only on this row, so its updated_at is a reliable Last-Modified.
    sendCacheableJson(
      req,
      res,
      { id: substation.id, districtId: substation.district_id, name: substation.name },
      { lastModified: lastModifiedFrom(substation.updated_at, substation.now) },
    );
  })
  .all(methodNotAllowed('GET', 'HEAD'));

module.exports = router;
