# Architecture

## Current implementation

- JavaScript and Express run as a Node.js application.
- `src/server.js` loads environment configuration and starts the HTTP listener.
- `src/app.js` exports the Express application and configures JSON parsing, the root status response, and Swagger UI at `/api-docs`.
- The PostgreSQL pool configuration exists but is not connected to domain routes. There are no domain tables, seed scripts, domain endpoints, or authentication yet.
- Render service configuration is checked in. Configuration alone does not verify the live deployment.

## Planned structure

Use one Express application and one PostgreSQL database. Separate ingestion and reading through permissions and service responsibilities, without adding separate deployed services.

| Component | Responsibility |
| --- | --- |
| Server entry point | Environment loading and network listener lifecycle |
| Application | Middleware order, routers, documentation, and consistent error handling |
| Routes and validation | Parse HTTP inputs, validate supported fields, and format responses |
| Authentication and authorization | Establish a trusted principal and restrict resource access |
| Services | Apply domain rules, compose installation overviews, and calculate summaries |
| Database queries | Execute parameterized SQL, scoped queries, and transactions |
| PostgreSQL | Persist entities and enforce relationships, uniqueness, and numeric constraints |

Request flow: parse input, authenticate, authorize the operation, validate inputs, execute scoped queries or a transactional service, evaluate applicable response validators, and serialize the result. Write preconditions must be checked atomically with the mutation. No response or cache validator bypasses authorization.

## Design decisions

- The [domain model](domain-model.md) owns the hierarchy and immutable reading history. The application uses that history to derive the latest reading.
- The installation overview is a bounded read composition, not another stored entity. A composite attribute is a decomposable value such as an address; no extra fields or tables are required merely to demonstrate that term.
- The [API contract](api-contract.md) owns canonical resource URLs. Domain resources target Richardson Level 2: HTTP methods and statuses are meaningful, while hypermedia-driven application transitions are not implemented.
- Installation metadata has a separate provisioning write path. The [security design](security.md#provisioning-decision) records its rationale and the unresolved interpretation risk.
- Render hosts the ordinary Node server. The external PostgreSQL database remains a later setup step; keep persistent data out of the web service filesystem.

Only introduce folders and libraries when implementing their responsibility. Keep the [testing plan](testing.md) and documentation aligned with each completed increment.
