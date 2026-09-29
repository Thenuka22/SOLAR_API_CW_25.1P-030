# Architecture

The backend is one Express application with PostgreSQL planned for storage. Render runs the Node server; deployment settings are in the [project README](../README.md#deployment).

## What exists now

`src/server.js` loads environment variables and starts the listener. `src/app.js` exports the Express app, parses JSON, returns the root status response, and serves Swagger UI at `/api-docs`. The PostgreSQL pool configuration exists, but no domain route uses it yet. Domain tables, authentication, and measurements are not implemented.

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
