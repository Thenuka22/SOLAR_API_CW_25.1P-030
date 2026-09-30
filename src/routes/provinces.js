const express = require('express');
const pool = require('../config/db');
const { ERRORS, ApiError } = require('../errors');
const { authenticate, requirePrincipal } = require('../middleware/authenticate');
const { methodNotAllowed } = require('../middleware/errors');
const { checkQueryNames, parsePage, pageLinks, requireUuid } = require('../http/query');
const { sendCacheableJson } = require('../http/conditional');

const router = express.Router();

// Provinces a staff reader may see: all for a national reader, otherwise only the province in
// their scope (their own, or their district's). $1 = national?, $2 = provinceId.
const VISIBLE = 'SELECT id, name, updated_at FROM provinces WHERE $1 OR id = $2';

function scopeParams(principal) {
  return [principal.role === 'national', principal.provinceId];
}

// Authentication and the staff check run before any input is read or data is queried.
router.use('/provinces', authenticate, requirePrincipal('staff'));

/**
 * @openapi
 * /solar/v1.0/provinces:
 *   get:
 *     tags: [Provinces]
 *     summary: List visible provinces
 *     description: |
 *       A national reader sees all provinces; a provincial reader only their province; a district
 *       reader only their district's province. `count` is the total visible to the caller.
 *       Results are in ID order. Validated by ETag only: no Last-Modified, and If-Modified-Since
 *       is ignored. Only `offset` and `limit` are accepted.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/offset'
 *       - $ref: '#/components/parameters/limit'
 *       - $ref: '#/components/parameters/ifNoneMatch'
 *     responses:
 *       200:
 *         description: A page of visible provinces.
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
 *               $ref: '#/components/schemas/ProvinceCollection'
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
  .route('/provinces')
  .get(async (req, res) => {
    const page = parsePage(req);
    // One statement, so count and page come from the same snapshot.
    const { rows } = await pool.query(
      `WITH visible AS (${VISIBLE})
       SELECT
         (SELECT count(*) FROM visible)::int AS count,
         coalesce(
           (SELECT json_agg(json_build_object('id', id, 'name', name) ORDER BY id)
            FROM (SELECT id, name FROM visible ORDER BY id LIMIT $3 OFFSET $4) AS page),
           '[]'::json
         ) AS results`,
      [...scopeParams(req.principal), page.limit, page.offset],
    );
    const { count, results } = rows[0];
    // ETag only: the collection also changes with the reader's scope, deletions, and paging,
    // which no updated_at records, so it has no reliable Last-Modified.
    sendCacheableJson(req, res, { count, ...pageLinks(req, page, count), results });
  })
  .all(methodNotAllowed('GET', 'HEAD'));

/**
 * @openapi
 * /solar/v1.0/provinces/{province-id}:
 *   get:
 *     tags: [Provinces]
 *     summary: Get one province
 *     description: |
 *       A province outside the caller's jurisdiction returns the same 404 as a nonexistent one.
 *       No query parameters are accepted.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/provinceId'
 *       - $ref: '#/components/parameters/ifNoneMatch'
 *       - $ref: '#/components/parameters/ifModifiedSince'
 *     responses:
 *       200:
 *         description: The province.
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
 *               $ref: '#/components/schemas/Province'
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
  .route('/provinces/:provinceId')
  .get(async (req, res) => {
    checkQueryNames(req, []);
    const id = requireUuid(req.params.provinceId, 'province-id');
    const { rows } = await pool.query(
      `SELECT id, name, updated_at, statement_timestamp() AS now FROM (${VISIBLE}) AS visible WHERE id = $3`,
      [...scopeParams(req.principal), id],
    );
    // A missing province and one outside the caller's scope get the same 404.
    if (rows.length === 0) throw new ApiError(ERRORS.RESOURCE_NOT_FOUND);
    const { name, updated_at: updatedAt, now } = rows[0];
    // The body depends only on this row, and every change moves updated_at to a later second
    // (migration 010), so it is a reliable Last-Modified. After rapid changes it can be ahead of
    // the clock; a Last-Modified in the future must not be sent (RFC 9110 section 8.8.2.1), and
    // replacing it with the current time could repeat an earlier version's second, so omit it.
    const lastModified = updatedAt <= now ? updatedAt : null;
    sendCacheableJson(req, res, { id: rows[0].id, name }, { lastModified });
  })
  .all(methodNotAllowed('GET', 'HEAD'));

module.exports = router;
