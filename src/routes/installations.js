const express = require('express');
const pool = require('../config/db');
const { ERRORS, ApiError, detail } = require('../errors');
const { authenticate, requireScope } = require('../middleware/authenticate');
const { methodNotAllowed } = require('../middleware/errors');
const { requireJsonBody } = require('../middleware/http');
const { checkQueryNames, parsePage, pageLinks, isUuid, requireUuid } = require('../http/query');
const {
  sendCacheableJson, lastModifiedFrom, writePreconditionsHold, setWriteValidators,
} = require('../http/conditional');
const { withTransaction } = require('../db/transaction');
const { readerScope, metadataScope, DISTRICT_VISIBLE } = require('../auth/scope');
const {
  PROVINCE_JSON, DISTRICT_JSON, SUBSTATION_JSON, INSTALLATION_JSON, READING_JSON,
} = require('../db/representations');

const router = express.Router();

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

  const { substationId, meterId, address = null, capacityKw } = body;
  if (allowed.includes('substationId') && !isUuid(substationId)) {
    problems.push(detail('body', 'substationId', 'substationId must be a UUID.'));
  }
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
  return { substationId: substationId?.toLowerCase(), meterId: meterId.trim(), address, capacityKw };
}

// 409 for a unique violation on the meter ID, which can also come from a concurrent request.
function meterIdConflict(err) {
  if (err.code === '23505' && err.constraint === 'solar_installations_meter_id_normalized_key') {
    return new ApiError(ERRORS.METER_ID_TAKEN, { details: [detail('body', 'meterId', 'This meter ID is already registered.')] });
  }
  return err;
}

function installationHasReadings() {
  return new ApiError(ERRORS.INSTALLATION_HAS_READINGS, {
    details: [detail('path', 'installation-id', 'An installation with readings cannot be deleted.')],
  });
}

// Authentication runs before any input is read or data is queried; each route checks the
// token's scope.
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
 *           Content-Location:
 *             $ref: '#/components/headers/ContentLocation'
 *           ETag:
 *             $ref: '#/components/headers/ETag'
 *           Last-Modified:
 *             $ref: '#/components/headers/LastModified'
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
  .get(requireScope('installations:read'), async (req, res) => {
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
  .post(requireScope('installations:write'), requireJsonBody, async (req, res) => {
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
         RETURNING ${INSTALLATION_JSON} AS installation, i.updated_at, clock_timestamp() AS now`,
        [substationId, values.meterId, values.address, values.capacityKw],
      ));
    } catch (err) {
      throw meterIdConflict(err);
    }
    if (rows.length === 0) throw new ApiError(ERRORS.RESOURCE_NOT_FOUND);
    const { installation, updated_at: updatedAt, now } = rows[0];
    // WSO2 sections 7.3 and 9: Location, plus the ETag and Last-Modified a GET of it would
    // return. The body is that representation, so Content-Location repeats its URL.
    const url = `${req.baseUrl}/installations/${installation.id}`;
    setWriteValidators(res, installation, lastModifiedFrom(updatedAt, now));
    res.status(201).location(url).set('Content-Location', url).json(installation);
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
 *   put:
 *     tags: [Installations]
 *     summary: Replace an installation's metadata
 *     description: |
 *       Provisioner only. A full replacement: `substationId`, `meterId`, and `capacityKw` are
 *       required, and an omitted `address` becomes null; partial bodies and read-only fields
 *       such as `id` are rejected. It never creates an installation, so a missing one returns
 *       404.
 *
 *       `If-Match` (strong comparison with the ETag from a GET) or, without it,
 *       `If-Unmodified-Since` (the Last-Modified from a GET) are checked in the same transaction
 *       as the update, with the row locked; a failed condition returns 412 and changes nothing.
 *       Conditions are optional, but without them a client may overwrite a newer version.
 *
 *       Moving the installation to another substation after it has readings returns 409 (4003),
 *       because its history would appear under another jurisdiction. A `substationId` that names
 *       no substation returns 400. A meter ID that another installation has returns 409 (4001).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/installationId'
 *       - $ref: '#/components/parameters/ifMatch'
 *       - $ref: '#/components/parameters/ifUnmodifiedSince'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/InstallationReplace'
 *     responses:
 *       200:
 *         description: The updated installation, with the validators a GET would now return.
 *         headers:
 *           ETag:
 *             $ref: '#/components/headers/ETag'
 *           Last-Modified:
 *             $ref: '#/components/headers/LastModified'
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
 *       412:
 *         $ref: '#/components/responses/PreconditionFailed'
 *       413:
 *         $ref: '#/components/responses/PayloadTooLarge'
 *       415:
 *         $ref: '#/components/responses/UnsupportedMediaType'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 *   delete:
 *     tags: [Installations]
 *     summary: Delete an installation that has no readings
 *     description: |
 *       Provisioner only; no request body. An installation with readings returns 409 (4003) and
 *       nothing is deleted, because readings are append-only history. The installation's device
 *       credential is deleted with it, so tokens issued to that device stop working.
 *
 *       `If-Match` or, without it, `If-Unmodified-Since` are checked as for PUT, in the same
 *       transaction as the delete; a failed condition returns 412 and deletes nothing.
 *       Conditions are optional.
 *
 *       Success is 200 with a short deletion receipt. Repeating the request returns 404, because
 *       the installation no longer exists.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/installationId'
 *       - $ref: '#/components/parameters/ifMatch'
 *       - $ref: '#/components/parameters/ifUnmodifiedSince'
 *     responses:
 *       200:
 *         description: The installation was deleted.
 *         headers:
 *           Cache-Control:
 *             $ref: '#/components/headers/CacheControl'
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/InstallationDeletion'
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
 *       412:
 *         $ref: '#/components/responses/PreconditionFailed'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */
router
  .route('/installations/:installationId')
  .get(requireScope('installations:read'), async (req, res) => {
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
  .put(requireScope('installations:write'), requireJsonBody, async (req, res) => {
    checkQueryNames(req, []);
    const id = requireUuid(req.params.installationId, 'installation-id');
    const values = validateInstallationBody(req.body, ['substationId', 'meterId', 'address', 'capacityKw']);

    const { installation, lastModified } = await withTransaction(async (db) => {
      // Lock the row, so the condition check, the history check, and the update see one version.
      // A first reading's insert waits for this lock too (migration 005).
      const current = (await db.query(
        `SELECT ${INSTALLATION_JSON} AS installation, i.updated_at,
                EXISTS (SELECT 1 FROM generation_readings r WHERE r.installation_id = i.id) AS has_readings
         FROM solar_installations i WHERE i.id = $1 FOR UPDATE`,
        [id],
      )).rows[0];
      // PUT replaces an existing installation; it never creates one.
      if (!current) throw new ApiError(ERRORS.RESOURCE_NOT_FOUND);
      if (!writePreconditionsHold(req, current.installation, current.updated_at)) {
        throw new ApiError(ERRORS.PRECONDITION_FAILED);
      }
      if (values.substationId !== current.installation.substationId) {
        const target = (await db.query('SELECT 1 FROM grid_substations WHERE id = $1', [values.substationId])).rows[0];
        if (!target) {
          throw new ApiError(ERRORS.VALIDATION_FAILED, {
            details: [detail('body', 'substationId', 'No substation has this ID.')],
          });
        }
        // Moving would show the existing history under another substation and jurisdiction.
        if (current.has_readings) {
          throw new ApiError(ERRORS.INSTALLATION_HAS_READINGS, {
            details: [detail('body', 'substationId', 'An installation with readings cannot move to another substation.')],
          });
        }
      }
      // The trigger sets updated_at from clock_timestamp(), after this statement started, so
      // compare it with the clock after the update rather than statement_timestamp().
      let updated;
      try {
        updated = (await db.query(
          `UPDATE solar_installations AS i
           SET substation_id = $2, meter_id = $3, address = $4, capacity_kw = $5
           WHERE i.id = $1
           RETURNING ${INSTALLATION_JSON} AS installation, i.updated_at, clock_timestamp() AS now`,
          [id, values.substationId, values.meterId, values.address, values.capacityKw],
        )).rows[0];
      } catch (err) {
        throw meterIdConflict(err);
      }
      return { installation: updated.installation, lastModified: lastModifiedFrom(updated.updated_at, updated.now) };
    });
    setWriteValidators(res, installation, lastModified);
    res.json(installation);
  })
  .delete(requireScope('installations:write'), async (req, res) => {
    checkQueryNames(req, []);
    const id = requireUuid(req.params.installationId, 'installation-id');

    const receipt = await withTransaction(async (db) => {
      // Lock the row, so the condition check, the history check, and the delete see one version.
      // A first reading's insert waits for this lock too (migration 005).
      const current = (await db.query(
        `SELECT ${INSTALLATION_JSON} AS installation, i.updated_at,
                EXISTS (SELECT 1 FROM generation_readings r WHERE r.installation_id = i.id) AS has_readings
         FROM solar_installations i WHERE i.id = $1 FOR UPDATE`,
        [id],
      )).rows[0];
      // Also the answer to a repeated DELETE: the installation is gone (WSO2 section 7.4).
      if (!current) throw new ApiError(ERRORS.RESOURCE_NOT_FOUND);
      if (!writePreconditionsHold(req, current.installation, current.updated_at)) {
        throw new ApiError(ERRORS.PRECONDITION_FAILED);
      }
      // Readings are append-only history and cannot be deleted, so neither can their installation.
      if (current.has_readings) throw installationHasReadings();
      try {
        // The device credential is deleted with the installation (ON DELETE CASCADE).
        return (await db.query(
          `DELETE FROM solar_installations WHERE id = $1
           RETURNING json_build_object(
             'id', id,
             'meterId', meter_id,
             'deletedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           ) AS receipt`,
          [id],
        )).rows[0].receipt;
      } catch (err) {
        // The readings foreign key also refuses the delete, should a reading get past the lock.
        if (err.code === '23503' && err.constraint === 'generation_readings_installation_id_fkey') {
          throw installationHasReadings();
        }
        throw err;
      }
    });
    // A receipt, not a representation: there is nothing left to validate or cache.
    res.set('Cache-Control', 'no-store').json(receipt);
  })
  .all(methodNotAllowed('GET', 'HEAD', 'PUT', 'DELETE'));

/**
 * @openapi
 * /solar/v1.0/installations/{installation-id}/overview:
 *   get:
 *     tags: [Installations]
 *     summary: Get an installation with its substation, district, province, and latest reading
 *     description: |
 *       A read-only composite: each embedded object has the same representation as its own
 *       endpoint. `lastKnownReading` is the reading with the latest measurement timestamp, or
 *       null when there are no readings; the full history is not embedded. Staff readers only,
 *       because it includes a measurement. An installation outside the caller's jurisdiction
 *       returns the same 404 as a nonexistent one. Validated by ETag only: the ETag changes when
 *       any embedded record changes or a newer reading arrives, but no single modification time
 *       covers all of them. No query parameters are accepted.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/installationId'
 *       - $ref: '#/components/parameters/ifNoneMatch'
 *     responses:
 *       200:
 *         description: The installation overview.
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
 *               $ref: '#/components/schemas/InstallationOverview'
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
  .route('/installations/:installationId/overview')
  .get(requireScope('readings:read'), async (req, res) => {
    checkQueryNames(req, []);
    const id = requireUuid(req.params.installationId, 'installation-id');
    // One statement, so every embedded record comes from the same snapshot.
    const { rows } = await pool.query(
      `SELECT json_build_object(
         'installation', ${INSTALLATION_JSON},
         'gridSubstation', ${SUBSTATION_JSON},
         'district', ${DISTRICT_JSON},
         'province', ${PROVINCE_JSON},
         'lastKnownReading', (
           SELECT ${READING_JSON} FROM generation_readings r
           WHERE r.installation_id = i.id ORDER BY r."timestamp" DESC LIMIT 1
         )
       ) AS overview
       FROM solar_installations i
       JOIN grid_substations s ON s.id = i.substation_id
       JOIN districts d ON d.id = s.district_id
       JOIN provinces p ON p.id = d.province_id
       WHERE i.id = $4 AND ${DISTRICT_VISIBLE}`,
      [...readerScope(req.principal), id],
    );
    // A missing installation and one outside the caller's scope get the same 404.
    if (rows.length === 0) throw new ApiError(ERRORS.RESOURCE_NOT_FOUND);
    sendCacheableJson(req, res, rows[0].overview);
  })
  .all(methodNotAllowed('GET', 'HEAD'));

module.exports = router;
