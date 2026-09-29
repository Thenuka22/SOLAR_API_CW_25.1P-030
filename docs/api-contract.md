# API Contract

Status: planned domain API. The current application exposes only `/` and the Swagger UI scaffold at `/api-docs`. The table below does not claim that domain routes exist.

## Naming and resources

Base path: `/solar/v1.0`. Use lowercase, hyphenated paths, plural collection names, and immediate-parent scoped collections. An individual resource has one canonical URL; do not repeat every ancestor in its path. Path identifiers are UUIDs.

Atomic, collection, and composite resources use nouns. Explicit processing functions use standalone verb-based paths with identifiers supplied as parameters in the request body.

An atomic resource represents one entity. A collection groups resources of one type. A composite combines related entity types in one read. A derived singleton selects one result from stored data; this is a descriptive term, not an additional formal resource-taxonomy category. A processing function performs an explicitly requested calculation or operation.

## Endpoint register

Every path below is relative to the base path. Reader means a jurisdiction-authorized SLSEA user; provisioner means the separate administrative identity defined in [Security](security.md).

| Method | Path | Classification and purpose | Caller |
| --- | --- | --- | --- |
| GET | `/provinces` | Collection: visible provinces | Reader |
| GET | `/provinces/{province-id}` | Atomic province | Reader |
| GET | `/provinces/{province-id}/districts` | Scoped district collection | Reader |
| GET | `/districts/{district-id}` | Atomic district | Reader |
| GET | `/districts/{district-id}/grid-substations` | Scoped substation collection | Reader |
| GET | `/grid-substations/{substation-id}` | Atomic substation | Reader, provisioner |
| GET | `/grid-substations/{substation-id}/installations` | Scoped installation collection | Reader, provisioner |
| GET | `/installations/{installation-id}` | Atomic installation metadata | Reader, provisioner |
| GET | `/installations/{installation-id}/overview` | Composite installation read | Reader |
| GET | `/installations/{installation-id}/last-known-reading` | Derived singleton: latest measurement | Reader |
| GET | `/installations/{installation-id}/readings` | Scoped historical collection | Reader |
| GET | `/installations/{installation-id}/readings/{reading-id}` | Atomic reading belonging to the specified installation | Reader |
| POST | `/installations/{installation-id}/readings` | Create immutable reading | Owning device |
| GET | `/readings` | Collection: regional analysis across installations | Reader |
| POST | `/grid-substations/{substation-id}/installations` | Create installation metadata in the parent collection | Provisioner |
| PUT | `/installations/{installation-id}` | Replace writable installation metadata | Provisioner |
| DELETE | `/installations/{installation-id}` | Remove installation without history | Provisioner |
| POST | `/summarize-district-generation` | Processing: compute district generation statistics | Reader |
| POST | `/issue-token` | Processing: verify credentials and issue a scoped JWT | Registered principal presenting credentials |

The overview contains `installation`, `gridSubstation`, `district`, `province`, and `lastKnownReading`; the last value is null if no reading exists. It does not include unbounded history. The standalone latest-reading endpoint returns 404 when no reading exists. Latest means greatest measurement timestamp, not latest arrival.

The district summary accepts `districtId` and a reporting `date` in YYYY-MM-DD format, defaults the date to today in Asia/Colombo, and returns 200. It creates no persistent summary and has no second GET alias. It reports latest known district power with freshness/coverage and daily energy from cumulative-counter differences. Missing boundaries or counter anomalies must be disclosed instead of producing an invented complete total.

## Representations and queries

- JSON uses camelCase; the conceptual model's snake_case labels map to those names (for example, `power_kw` becomes `powerKw`). Document units and numeric precision in OpenAPI before implementing measurements.
- Measurement timestamps require RFC 3339 with an explicit timezone; normalize responses to UTC. HTTP date headers use HTTP-date in GMT. Reporting-day boundaries use Asia/Colombo.
- Reading requests provide `timestamp`, `powerKw`, `energyKwh`, and `voltage`; ownership comes from the authorized path, not a client-selected body field.
- Collection responses use `{ count, next, previous, results }`. `count` is the total authorized, filtered count; absent page links are null. Default `offset=0`, default `limit=50`, maximum `limit=200`.
- Both reading collections support `from` inclusive, `to` exclusive, and `sort=timestamp` or `sort=-timestamp`; default is ascending. Regional `/readings` also supports `province-id`, `district-id`, and `substation-id`. Combine filters with AND, never use them to grant access.
- Pagination links preserve the query. Reject unsupported query parameters, malformed values, invalid time windows, and unknown writable fields with 400.
- PUT supplies the complete writable metadata. Missing required properties fail; omitted optional properties reset to their documented defaults rather than retaining previous values. It does not create a missing installation.

## HTTP behaviour

| Status | Use |
| --- | --- |
| 200 | Successful retrieval, metadata replacement, deletion confirmation, or processing result |
| 201 | Installation/reading creation, with a Location identifying its canonical resource |
| 304 | Authorized conditional GET whose representation is unchanged; no response body |
| 400 | Invalid JSON, fields, values, or query parameters |
| 401 | Missing or invalid authentication; include WWW-Authenticate |
| 403 | Authenticated principal lacks the operation permission |
| 404 | Missing resource, wrong-parent reading, or concealed out-of-jurisdiction resource |
| 405 | Unsupported method on a known resource; include Allow |
| 406 | No acceptable supported response representation |
| 409 | Duplicate reading or a metadata operation conflicting with retained history |
| 412 | A supplied write precondition fails |
| 415 | Unsupported request-body media type |

Client errors use `{ code, message, details }`, with a stable numeric application code. The HTTP status remains the protocol outcome. Empty collections return 200 with zero count; a nonexistent or inaccessible parent returns 404.

Domain GET responses provide ETag and Last-Modified with private cache controls. Validators reflect persisted data and composite dependencies, not the time of each GET. If-None-Match takes precedence over If-Modified-Since; If-Match takes precedence over If-Unmodified-Since. Conditional writes use transactional checks. Repeated DELETE may return 200 then 404 while remaining idempotent because the intended final state is unchanged.

The processing summary and token issuer return 200 rather than 201 or 304. Token responses use no-store. POST ingestion returns the created reading so the device can acknowledge it without being granted analyst read access.

Executable OpenAPI schemas and examples are the next contract increment; keep their paths, permissions, and responses consistent with this register.
