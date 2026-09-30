# Architecture

The backend is one Express application with PostgreSQL for storage. Render runs the Node server; deployment settings are in the [project README](../README.md#deployment).

## What exists now

`src/server.js` loads environment variables and starts the listener. `src/app.js` exports the Express app, parses JSON, returns the root status response, and serves Swagger UI at `/api-docs`. Unmatched paths and all errors go through `src/middleware/errors.js`, which returns the JSON [error format](api-endpoints.md#error-format) using the code catalogue in `src/errors.js`. The PostgreSQL pool configuration exists, but no route uses it yet.

The schema is built by numbered SQL migrations in `src/db/migrations/`, applied with `npm run db:migrate` (see the [project README](../README.md#database-migrations)). They create tables for the six [domain model](domain-model.md) entities, with UUID primary keys and these rules enforced by PostgreSQL:

| Table | Integrity rules |
| --- | --- |
| `provinces` | Name required; unique ignoring case and surrounding spaces |
| `districts` | Province required; name required and unique within its province, ignoring case and surrounding spaces |
| `grid_substations` | District required; name required but not unique |
| `solar_installations` | Substation required; `meter_id` required and unique ignoring case and surrounding spaces; address optional; `capacity_kw` greater than 0; `substation_id` cannot change once the installation has readings |
| `generation_readings` | Installation required; `timestamptz` timestamp; one reading per installation and timestamp; power, energy, and voltage non-negative; UPDATE, DELETE, and TRUNCATE rejected by triggers |
| `users` | Name required; email required, basic format, unique ignoring case; role `national`, `provincial`, or `district` with the matching [scope](domain-model.md#user-scope) |

A parent row that still has children cannot be deleted. The reading column keeps the domain model's name, `timestamp`, so write it as `"timestamp"` in SQL.

Repeatable seed files in `src/db/seeds/`, applied with `npm run db:seed`, load the demonstration data: 9 provinces, 25 districts, 35 substations, 200 installations, and one week of readings (134,400). Authentication and domain routes are not implemented yet.

## Planned request flow

Request -> input parsing -> authentication -> permission checks -> route/service -> database -> response.

| Part | Job |
| --- | --- |
| Server | Start and stop the HTTP listener |
| App and routes | Configure middleware, validate HTTP inputs, call services, return responses |
| Security middleware | Identify the caller and check operation permissions |
| Services | Apply domain rules, build the overview, calculate summaries |
| Database queries | Apply jurisdiction filters, use parameterized SQL, handle transactions |
| PostgreSQL | Store records and enforce relationships, uniqueness, and value constraints |

A device writes its own readings. SLSEA readers query their permitted jurisdictions. Both use the same application and database; they have different permissions, not separate deployed services. Authorization also covers counts, summaries, and cache validators. Write preconditions are checked in the same transaction as the change.

The [domain model](domain-model.md) defines stored data. [API Endpoints](api-endpoints.md) defines HTTP operations. The [guidelines](api-guidelines.md) explain the design rules. Keep access checks in [Security](security.md) and acceptance checks in [Testing](testing.md).
