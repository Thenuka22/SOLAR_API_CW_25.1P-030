# API Endpoints

Base path: `/solar/v1.0`. These are planned endpoints. At present, only `/` and Swagger UI at `/api-docs` are implemented, together with the shared [error format](#error-format).

All path IDs are UUIDs. JSON uses camelCase: for example, the model's `power_kw` becomes `powerKw`. Requests and responses use `application/json`.

## Read endpoints

These require a reader token and return only data within that reader's jurisdiction. The provisioner can also read a substation, its installation collection, and individual installation metadata; it cannot read measurements. See [permissions](security.md).

Every GET below can return 304 for an unchanged conditional request, with no body. Otherwise a successful request returns 200 with the result shown.

| Method | Path | 200 response / resource type | Errors |
| --- | --- | --- | --- |
| GET | `/provinces` | Visible provinces; collection | 400, 401, 403, 406 |
| GET | `/provinces/{province-id}` | Province; atomic | 400, 401, 403, 404, 406 |
| GET | `/provinces/{province-id}/districts` | Districts in the province; scoped collection | 400, 401, 403, 404, 406 |
| GET | `/districts/{district-id}` | District; atomic | 400, 401, 403, 404, 406 |
| GET | `/districts/{district-id}/grid-substations` | Substations in the district; scoped collection | 400, 401, 403, 404, 406 |
| GET | `/grid-substations/{substation-id}` | Substation; atomic | 400, 401, 403, 404, 406 |
| GET | `/grid-substations/{substation-id}/installations` | Installations at the substation; scoped collection | 400, 401, 403, 404, 406 |
| GET | `/installations/{installation-id}` | Installation metadata; atomic | 400, 401, 403, 404, 406 |
| GET | `/installations/{installation-id}/overview` | Installation and related records; composite | 400, 401, 403, 404, 406 |
| GET | `/installations/{installation-id}/last-known-reading` | Latest measurement; derived singleton | 400, 401, 403, 404, 406 |
| GET | `/installations/{installation-id}/readings` | Installation history; scoped collection | 400, 401, 403, 404, 406 |
| GET | `/installations/{installation-id}/readings/{reading-id}` | One reading; atomic | 400, 401, 403, 404, 406 |
| GET | `/readings` | Regional history across installations; collection | 400, 401, 403, 406 |

- The overview contains `installation`, `gridSubstation`, `district`, `province`, and `lastKnownReading`. It does not embed the full history. With no readings, `lastKnownReading` is null.
- The standalone last-known-reading endpoint returns 404 when there are no readings. Latest means greatest measurement timestamp, not latest insertion.
- A reading ID under the wrong installation returns 404. Missing and out-of-jurisdiction resources also return 404.
- An existing, authorized parent with no children returns an empty collection with 200. A missing or inaccessible parent returns 404.

### Query parameters

| Parameter | Applies to | Meaning |
| --- | --- | --- |
| `offset` | Collections | Results to skip; default 0; non-negative integer |
| `limit` | Collections | Page size; default 50; integer from 1 to 200 |
| `from` | Both reading collections | Inclusive measurement timestamp |
| `to` | Both reading collections | Exclusive measurement timestamp; after `from` when both are supplied |
| `sort` | Both reading collections | `timestamp` (default, ascending) or `-timestamp` (descending) |
| `province-id` | `/readings` | Filter by province UUID |
| `district-id` | `/readings` | Filter by district UUID |
| `substation-id` | `/readings` | Filter by substation UUID |

Collections return `{ count, next, previous, results }`. Count is the total after authorization and filtering. Page links preserve filters and sorting; an unavailable next/previous page is null. Hierarchy collections use a stable ID order. Reading order uses timestamp then ID to break ties across installations.

Combine regional filters with AND. Valid filters with no visible matches return an empty page; they never grant access. Unsupported query parameters or invalid values return 400.

## Write endpoints

| Method | Path | Caller and input | Success | Errors |
| --- | --- | --- | --- | --- |
| POST | `/installations/{installation-id}/readings` | Owning device; `timestamp`, `powerKw`, `energyKwh`, `voltage` | 201, created reading, Location | 400, 401, 403, 404, 406, 409, 415 |
| POST | `/grid-substations/{substation-id}/installations` | Provisioner; `meterId`, `address`, `capacityKw` | 201, created installation, Location | 400, 401, 403, 404, 406, 409, 415 |
| PUT | `/installations/{installation-id}` | Provisioner; complete writable metadata: `substationId`, `meterId`, `address`, `capacityKw` | 200, updated installation | 400, 401, 403, 404, 406, 409, 412, 415 |
| DELETE | `/installations/{installation-id}` | Provisioner; path ID, no request body | 200, deletion confirmation | 400, 401, 403, 404, 406, 409, 412 |

- Creation derives the parent from the path. The server generates the resource ID. Location uses the canonical individual URL from the read table.
- Reading ingestion derives ownership from the authenticated device and path. A device targeting another installation gets 403. It receives the created reading without gaining analyst read permission.
- Reading timestamps must include a timezone and are returned in UTC. Power is instantaneous kW, energy is cumulative kWh, and voltage is in V. Reject negative or non-finite measurements. Fix numeric precision in the measurement schema before implementation.
- Duplicate installation/timestamp pairs or meter identifiers return 409. Readings cannot be updated or deleted.
- `meterId`, `capacityKw`, and the applicable parent are required installation values; `capacityKw` must be positive. `address` is optional. PUT includes all required writable values; omitting `address` clears it to null. It is not a partial update and does not create a missing installation.
- Deleting an installation with readings or moving it to another substation after readings exist returns 409. Permitted descriptive changes do not alter history.
- PUT and DELETE support supplied If-Match and If-Unmodified-Since conditions. A failed condition returns 412 without changing data; check and mutation occur in one transaction. Clients should use conditions to avoid overwriting a newer version.
- Repeating a successful DELETE returns 404 once the installation is gone.

## Processing endpoints

| Method | Path | Caller and input | Success | Errors |
| --- | --- | --- | --- | --- |
| POST | `/summarize-district-generation` | Reader; `districtId`, optional `date` in YYYY-MM-DD | 200, district generation summary | 400, 401, 403, 404, 406, 415 |
| POST | `/issue-token` | Registered principal; credentials, not an existing bearer token | 200, access token, token type, expiry duration | 400, 401, 406, 415 |

The summary date defaults to today in Asia/Colombo. Return latest known district power separately from energy for the requested date, with freshness and contributing/missing installation counts. Calculate energy from cumulative-meter differences, never by summing cumulative values. Missing boundary samples or counter anomalies make the energy result incomplete. Fix the detailed calculation and response schema with small numerical examples before implementing this endpoint.

The summary is computed immediately, creates no persistent resource, and has no GET alias. It returns neither 201 nor 304. The token endpoint verifies credentials and derives permissions on the server; define its credential schema with authentication. Token responses use `Cache-Control: no-store`.

## Response codes and headers

| Code | Meaning in this API |
| --- | --- |
| 200 | Requested result or completed metadata operation |
| 201 | Resource created; include Location and the created representation |
| 304 | GET representation unchanged; empty body |
| 400 | Malformed JSON, invalid UUID/value/query, missing required input, or unknown writable field |
| 401 | Missing/invalid credentials or bearer token; include an appropriate WWW-Authenticate challenge |
| 403 | Principal lacks the operation permission, including a device targeting another installation |
| 404 | Missing or concealed out-of-scope resource, or reading under the wrong parent |
| 405 | Unsupported method on a known path; include Allow |
| 406 | Accept does not permit the supported JSON response |
| 409 | Uniqueness conflict or operation incompatible with retained history |
| 412 | Supplied write condition does not hold |
| 413 | Request body larger than the 100 KB JSON limit |
| 415 | POST/PUT body has an unsupported media type, character set, or content encoding |
| 500 | Unexpected server failure; generic message without internal details |

The endpoint tables list expected client errors for supported methods. A different method on a known path can return 405; an unknown path returns 404. Server failures can affect any endpoint and must not expose stack traces or credentials.

### Error format

Every error response, including 404 for unknown paths, is JSON:

```json
{
  "code": 1001,
  "message": "The request body is not valid JSON.",
  "details": [
    { "location": "body", "field": null, "issue": "Unexpected end of JSON input" }
  ]
}
```

`code` is a stable numeric application code, separate from the HTTP status. `message` is a readable explanation. `details` is always an array, empty when there is nothing more to say. Each item has `location` (`body`, `path`, `query`, `header`, `method`, or `request`), `field` (the parameter or property name, or null), and `issue`.

| Code | HTTP | Meaning |
| --- | --- | --- |
| 1000 | 500 | Unexpected server failure; the real error is logged, not returned |
| 1001 | 400 | Malformed JSON body, or JSON that is not an object or array |
| 1002 | 400 | Other unreadable request, such as a badly encoded path parameter |
| 1003 | 413 | Body larger than the JSON limit |
| 1004 | 415 | Unsupported character set or content encoding for a JSON body |
| 1005 | 404 | No endpoint matches the path |
| 1006 | 405 | Known path, unsupported method; the response includes Allow |

Codes 1000-1099 cover general request and routing errors. Validation, authentication, and domain errors get their own codes when those features are implemented. JSON bodies are parsed before routing, so malformed JSON sent to an unknown path returns 400, not 404. The code catalogue is in `src/errors.js`.

Domain GETs return ETag, Last-Modified, and private cache controls. Last-Modified uses HTTP-date in GMT, not a JSON timestamp. Composite validators change when relevant embedded data changes. If-None-Match takes precedence over If-Modified-Since; If-Match takes precedence over If-Unmodified-Since. Authenticate and check scope before evaluating response validators.
