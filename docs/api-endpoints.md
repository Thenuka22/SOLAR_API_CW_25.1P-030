# API Endpoints

Base path: `/solar/v1.0`. These are planned endpoints. At present, `/`, Swagger UI at `/api-docs`, `POST /issue-token`, `GET /provinces`, `GET /provinces/{province-id}`, `GET /provinces/{province-id}/districts`, `GET /districts/{district-id}`, `GET /districts/{district-id}/grid-substations`, `GET /grid-substations/{substation-id}`, `GET` and `POST /grid-substations/{substation-id}/installations`, `GET`, `PUT`, and `DELETE /installations/{installation-id}`, `GET` and `POST /installations/{installation-id}/readings`, `GET /installations/{installation-id}/readings/{reading-id}`, `GET /installations/{installation-id}/last-known-reading`, `GET /installations/{installation-id}/overview`, and `GET /readings` are implemented, together with the shared [error format](#error-format). The OpenAPI document shown by Swagger UI describes only these implemented operations, with their request and response schemas, headers, and error responses.

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

### Provinces (implemented)

Only staff readers may read provinces; a device or provisioner token gets 403. A national reader sees all nine provinces. A provincial reader sees only their province, and a district reader only their district's province, so their collection has a count of 1 and any other province ID returns the same 404 as a nonexistent one.

A province is `{ "id": "<uuid>", "name": "Western" }`. The collection accepts only `offset` and `limit`; a single province accepts no query parameters. Page links are path-absolute, for example `/solar/v1.0/provinces?offset=2&limit=2`.

Each request is handled in this order: bearer authentication (401), principal type (403), input validation (400), scoped query, then the conditional check (304) or the response. A client therefore cannot learn about an out-of-scope province from a 304, a count, or a validator.

| Header | Value |
| --- | --- |
| `ETag` | Strong tag: SHA-256 of the exact response body, which already reflects the caller's scope |
| `Last-Modified` | Single province only: its `updated_at`. Not sent for the collection |
| `Cache-Control` | `private, no-cache`: only the caller's own cache may store it, and must revalidate |
| `Vary` | `Authorization` |

`If-None-Match` uses weak comparison and accepts `*`; when it is present, `If-Modified-Since` is ignored. A 304 has no body but repeats the validators.

The collection is validated by ETag only. Its content also changes when a reader's scope narrows, a province is deleted, or the page changes, and no row timestamp records those changes, so it has no reliable modification time. Without `Last-Modified`, `If-Modified-Since` is ignored (RFC 9110 section 13.1.3) and a 304 needs a matching ETag.

A single province's body depends only on its row, so its `updated_at` is a reliable `Last-Modified`. The database sets it and moves it to a later whole second on every change, so two changes within one second, or a change committed after a response was built, never share the earlier version's `Last-Modified`. After rapid changes `updated_at` can be slightly ahead of the clock; `Last-Modified` is then omitted rather than sent in the future (RFC 9110 section 8.8.2.1).

### Districts (implemented)

Staff readers only, in the same order of checks as provinces. A national reader sees every district, a provincial reader the districts of their province, and a district reader only their own district, so their collection under their province has a count of 1 and a sibling district returns 404. A province outside the reader's scope returns 404 for its district collection; a visible province with no districts returns an empty page.

A district is `{ "id": "<uuid>", "provinceId": "<uuid>", "name": "Colombo" }`. Headers and validators are as for provinces: the collection has an ETag only, and a single district also has `Last-Modified` from its `updated_at`, which the database maintains as for provinces.

### Grid substations (implemented)

A substation is `{ "id": "<uuid>", "districtId": "<uuid>", "name": "Kolonnawa" }`. Staff readers see every substation of a district in their scope; a district outside it returns 404 for its collection, and a substation outside it returns 404. The provisioner may read any individual substation, because it registers installations there, but gets 403 for the district's collection; a device gets 403 for both. Validators are as for districts.

### Installations (implemented)

An installation is `{ "id": "<uuid>", "substationId": "<uuid>", "meterId": "MTR-0001", "address": "<text or null>", "capacityKw": 5.5 }`, with metadata only; readings never appear in these responses. Staff readers see installations at substations in their scope, and the provisioner may list and read any installation. A device gets 403, even for its own installation. Validators are as for districts; the single installation's `Last-Modified` comes from its `updated_at`, which a new reading does not change.

The provisioner creates an installation with `POST /grid-substations/{substation-id}/installations`. `meterId` is stored without surrounding spaces and may be at most 254 characters, the token endpoint's identifier limit; `capacityKw` is a JSON number above 0 and at most 9,999,999.999 with at most three decimal places, matching the stored precision, so it is never rounded silently. `id` and `substationId` in the body are rejected as read-only. A duplicate meter ID returns 409 (code 4001), also when two requests race, because the unique index decides.

### Installation readings (implemented)

Staff readers within their scope read an installation's history and its individual readings; devices and the provisioner get 403. A reading is `{ "id", "installationId", "timestamp", "powerKw", "energyKwh", "voltage" }`. `from` and `to` must carry an offset like body timestamps; a `+` in a query string must be sent as `%2B`, otherwise it arrives as a space and is rejected. Page links repeat `from`, `to`, and `sort` as sent. The collection and the individual reading have an ETag only: readings never change, but the server keeps no insertion time that could serve as `Last-Modified`.

The last-known reading has the same representation as the reading it selects. Its 404 for an installation without readings has a detail naming `installation-id`; an out-of-scope installation gets the plain 404 of a missing one. It has an ETag only, because it changes whenever a newer reading arrives.

The overview is for staff readers only, because it embeds a measurement; the provisioner gets 403. Each embedded object has exactly the representation of its own endpoint, built from the same SQL expressions in `src/db/representations.js`. It has an ETag only: the tag changes when the installation, an ancestor, or the latest reading changes, but no single modification time covers all of them.

### Regional readings (implemented)

`GET /readings` applies the reader's jurisdiction in SQL first, then the region filters and the time window, and only then counts and pages. A filter outside the jurisdiction therefore returns `{ "count": 0, "next": null, "previous": null, "results": [] }` with 200, and the same URL gives each reader a different body and ETag. On the full seed a national reader's unfiltered week takes about 170 ms in the database and a one-day window about 25 ms, using an index on (`timestamp`, `id`).

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
| DELETE | `/installations/{installation-id}` | Provisioner; path ID, no request body | 200, deletion receipt | 400, 401, 403, 404, 406, 409, 412 |

- Creation derives the parent from the path. The server generates the resource ID. Location uses the canonical individual URL from the read table. As WSO2 sections 7.3 and 9 recommend, the 201 response also carries the ETag a GET of the new resource would return, its Last-Modified where that GET has one (installations, not readings), and a Content-Location equal to Location, because the body is that representation.
- Reading ingestion derives ownership from the authenticated device and path. A device targeting another installation gets 403. It receives the created reading without gaining analyst read permission.
- Reading timestamps must be RFC 3339 with a timezone offset (`Z` or `+hh:mm`) and at most millisecond precision; they are returned in UTC with milliseconds, for example `2026-09-08T06:30:00.000Z`. Power is instantaneous kW, energy is cumulative kWh, and voltage is in V. Measurements are JSON numbers from 0 up to the stored precision: `powerKw` numeric(10,3), `energyKwh` numeric(14,3), and `voltage` numeric(7,2). A value with more decimal places is rejected with 400 rather than rounded, so a stored reading is exactly what the device sent. A decrease in cumulative energy is accepted, because a meter can be replaced or reset; the summary treats it as a counter anomaly.
- Duplicate installation/timestamp pairs (code 4002, compared as instants, so `12:00+05:30` and `06:30Z` are the same) or meter identifiers (code 4001) return 409. Readings cannot be updated or deleted.
- `meterId`, `capacityKw`, and the applicable parent are required installation values; `capacityKw` must be positive. `address` is optional. PUT includes all required writable values; omitting `address` clears it to null. It is not a partial update and does not create a missing installation.
- Deleting an installation with readings or moving it to another substation after readings exist returns 409. Permitted descriptive changes do not alter history.
- PUT and DELETE support supplied If-Match and If-Unmodified-Since conditions. A failed condition returns 412 without changing data; check and mutation occur in one transaction. Clients should use conditions to avoid overwriting a newer version.
- Repeating a successful DELETE returns 404 once the installation is gone.
- DELETE (implemented) locks the row and checks conditions exactly as PUT does, then refuses an installation with readings with 409 (code 4003) even when the condition holds. Success returns 200 with a receipt `{ "id", "meterId", "deletedAt" }` and `Cache-Control: no-store`, with no ETag because nothing is left to validate. WSO2 section 7.4 only requires 200; the receipt body is this API's own choice, so the operator can confirm which meter was removed. The installation's device credential is deleted with it, so that device's tokens stop working.
- PUT locks the installation row, then checks `If-Match` (strong comparison; `*` matches any existing installation) or, only when `If-Match` is absent, `If-Unmodified-Since` against `updated_at`; an unparseable date is ignored. A missing installation returns 404 before any condition is checked. A `substationId` that names no substation returns 400 (code 2001), because the body is wrong, not the target resource. The 200 response carries the ETag and, unless `updated_at` is ahead of the clock, the `Last-Modified` that a GET would now return.

## Processing endpoints

| Method | Path | Caller and input | Success | Errors |
| --- | --- | --- | --- | --- |
| POST | `/summarize-district-generation` | Reader; `districtId`, optional `date` in YYYY-MM-DD | 200, district generation summary | 400, 401, 403, 404, 406, 415 |
| POST | `/issue-token` | Registered principal; `principalType` and its credentials, not an existing bearer token | 200, `accessToken`, `tokenType`, `expiresIn` | 400, 406, 415, 429 |

The summary date defaults to today in Asia/Colombo. Return latest known district power separately from energy for the requested date, with freshness and contributing/missing installation counts. Calculate energy from cumulative-meter differences, never by summing cumulative values. Missing boundary samples or counter anomalies make the energy result incomplete. Fix the detailed calculation and response schema with small numerical examples before implementing this endpoint.

The summary is computed immediately, creates no persistent resource, and has no GET alias. It returns neither 201 nor 304. The token endpoint verifies credentials and derives permissions on the server; its request bodies and token claims are defined in [Authentication](authentication.md). Token responses use `Cache-Control: no-store`.

## Response codes and headers

| Code | Meaning in this API |
| --- | --- |
| 200 | Requested result or completed metadata operation |
| 201 | Resource created; include Location and the created representation |
| 304 | GET representation unchanged; empty body |
| 400 | Malformed JSON, invalid UUID/value/query, missing required input, unknown writable field, or token request credentials that are not valid |
| 401 | Missing or invalid bearer token; include a `Bearer` WWW-Authenticate challenge |
| 403 | Principal lacks the operation permission, including a device targeting another installation |
| 404 | Missing or concealed out-of-scope resource, or reading under the wrong parent |
| 405 | Unsupported method on a known path; include Allow |
| 406 | Accept does not permit the supported JSON response |
| 409 | Uniqueness conflict or operation incompatible with retained history |
| 412 | Supplied write condition does not hold |
| 413 | Request body larger than the 100 KB JSON limit |
| 415 | POST/PUT body has an unsupported media type, character set, or content encoding |
| 429 | Rate limit exceeded; include Retry-After |
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
| 1007 | 406 | Accept does not allow `application/json` |
| 1008 | 415 | Request body is not `application/json` |
| 1009 | 429 | Rate limit exceeded; the response includes Retry-After |
| 1010 | 412 | `If-Match` or `If-Unmodified-Since` does not hold; nothing was changed |
| 2001 | 400 | Request input fails validation; `details` lists each problem |
| 3001 | 400 | Token request credentials are not valid; same response whatever the cause |
| 3002 | 401 | No bearer token was sent |
| 3003 | 401 | The bearer token is invalid, expired, or revoked |
| 3004 | 403 | The authenticated principal type may not use this operation |
| 4001 | 409 | Another installation already has this meter ID |
| 4002 | 409 | The installation already has a reading at this timestamp |
| 4003 | 409 | The installation has readings, so it cannot move to another substation or be deleted |

Codes 1000-1099 cover general request and routing errors, 2000-2099 input validation, 3000-3099 authentication and authorization, and 4000-4099 conflicts with stored data. JSON bodies are parsed before routing, so malformed JSON sent to an unknown path returns 400, not 404. The code catalogue is in `src/errors.js`.

Domain GETs return an ETag and private cache controls. They return Last-Modified only when the server has a reliable modification time for the whole representation, which scoped collections do not; a 304 must mean the representation has not changed. Last-Modified uses HTTP-date in GMT, not a JSON timestamp. Composite validators change when relevant embedded data changes. If-None-Match takes precedence over If-Modified-Since; If-Match takes precedence over If-Unmodified-Since. Authenticate and check scope before evaluating response validators.
