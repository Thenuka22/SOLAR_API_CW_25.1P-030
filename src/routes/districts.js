const express = require('express');
const pool = require('../config/db');
const { ERRORS, ApiError } = require('../errors');
const { authenticate, requirePrincipal } = require('../middleware/authenticate');
const { methodNotAllowed } = require('../middleware/errors');
const { checkQueryNames, parsePage, pageLinks, requireUuid } = require('../http/query');
const { sendCacheableJson, lastModifiedFrom } = require('../http/conditional');
const { readerScope, PROVINCE_VISIBLE, DISTRICT_VISIBLE } = require('../auth/scope');

const router = express.Router();

// Authentication and the staff check run before any input is read or data is queried.
router.use(['/provinces/:provinceId/districts', '/districts'], authenticate, requirePrincipal('staff'));

/**
 * @openapi
 * /solar/v1.0/provinces/{province-id}/districts:
 *   get:
 *     tags: [Districts]
 *     summary: List visible districts in a province
 *     description: |
 *       A national reader sees every district in the province; a provincial reader the districts
 *       of their own province; a district reader only their own district. A province outside the
 *       caller's jurisdiction returns the same 404 as a nonexistent one; a visible province with
 *       no visible districts returns an empty page. `count` is the total visible to the caller.
 *       Results are in ID order. Validated by ETag only: no Last-Modified, and If-Modified-Since
 *       is ignored. Only `offset` and `limit` are accepted.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/provinceId'
 *       - $ref: '#/components/parameters/offset'
 *       - $ref: '#/components/parameters/limit'
 *       - $ref: '#/components/parameters/ifNoneMatch'
 *     responses:
 *       200:
 *         description: A page of visible districts.
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
 *               $ref: '#/components/schemas/DistrictCollection'
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
  .route('/provinces/:provinceId/districts')
  .get(async (req, res) => {
    const page = parsePage(req);
    const provinceId = requireUuid(req.params.provinceId, 'province-id');
    // One statement, so the parent check, count, and page come from the same snapshot.
    const { rows } = await pool.query(
      `WITH parent AS (SELECT p.id FROM provinces p WHERE p.id = $4 AND ${PROVINCE_VISIBLE}),
       visible AS (
         SELECT d.id, d.province_id, d.name FROM districts d
         WHERE d.province_id = (SELECT id FROM parent) AND ${DISTRICT_VISIBLE}
       )
       SELECT
         EXISTS (SELECT 1 FROM parent) AS found,
         (SELECT count(*) FROM visible)::int AS count,
         coalesce(
           (SELECT json_agg(json_build_object('id', id, 'provinceId', province_id, 'name', name) ORDER BY id)
            FROM (SELECT * FROM visible ORDER BY id LIMIT $5 OFFSET $6) AS page),
           '[]'::json
         ) AS results`,
      [...readerScope(req.principal), provinceId, page.limit, page.offset],
    );
    const { found, count, results } = rows[0];
    // A missing province and one outside the caller's scope get the same 404.
    if (!found) throw new ApiError(ERRORS.RESOURCE_NOT_FOUND);
    // ETag only, as for the province collection: no row timestamp records scope changes,
    // deletions, or paging.
    sendCacheableJson(req, res, { count, ...pageLinks(req, page, count), results });
  })
  .all(methodNotAllowed('GET', 'HEAD'));

/**
 * @openapi
 * /solar/v1.0/districts/{district-id}:
 *   get:
 *     tags: [Districts]
 *     summary: Get one district
 *     description: |
 *       A district outside the caller's jurisdiction returns the same 404 as a nonexistent one.
 *       No query parameters are accepted.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/districtId'
 *       - $ref: '#/components/parameters/ifNoneMatch'
 *       - $ref: '#/components/parameters/ifModifiedSince'
 *     responses:
 *       200:
 *         description: The district.
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
 *               $ref: '#/components/schemas/District'
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
  .route('/districts/:districtId')
  .get(async (req, res) => {
    checkQueryNames(req, []);
    const id = requireUuid(req.params.districtId, 'district-id');
    const { rows } = await pool.query(
      `SELECT d.id, d.province_id, d.name, d.updated_at, statement_timestamp() AS now
       FROM districts d WHERE d.id = $4 AND ${DISTRICT_VISIBLE}`,
      [...readerScope(req.principal), id],
    );
    // A missing district and one outside the caller's scope get the same 404.
    if (rows.length === 0) throw new ApiError(ERRORS.RESOURCE_NOT_FOUND);
    const district = rows[0];
    // The body depends only on this row, so its updated_at is a reliable Last-Modified.
    sendCacheableJson(
      req,
      res,
      { id: district.id, provinceId: district.province_id, name: district.name },
      { lastModified: lastModifiedFrom(district.updated_at, district.now) },
    );
  })
  .all(methodNotAllowed('GET', 'HEAD'));

module.exports = router;
