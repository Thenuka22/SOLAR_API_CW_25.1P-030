# Testing

Run the automated tests with `npm test` (Node's built-in test runner, every `*.test.js` file under `test/`). The checks below are recorded results, not plans; anything not yet verified is listed under [Not verified](#not-verified).

## How the tests run

- HTTP tests start the Express app on a temporary local port and call it with `fetch`, so routing, middleware, headers, and JSON bodies are exercised as a client sees them.
- Tests that need data use real PostgreSQL through `DATABASE_URL`, after `npm run db:migrate` and `npm run db:seed`. `test/helpers/apiFixture.js` opens one connection, starts a transaction, creates its own staff users, device, and provisioner, and points the app's pool at that connection. Every write is rolled back when the file finishes, so the seeded data is never changed. These tests are skipped when `DATABASE_URL` is not set.
- A transaction the app opens becomes a savepoint inside the fixture's transaction. Tests that expect a database error, or that change a row other tests read, run inside their own savepoint.
- The summary calculation has no database access and is tested with small hand-worked numbers, independent of the function under test.

## Seed data the tests rely on

The demonstration seed contains 9 provinces, 25 districts, 35 substations, and 200 installations. Every district has a substation, and the extra ten are spread across selected districts. Readings cover 2026-09-01 00:00 to 2026-09-08 00:00 Sri Lanka time (+05:30), start inclusive and end exclusive, every 15 minutes: 672 per installation and 134,400 in total. Values come from md5 hashes of meter IDs, districts, and times rather than a random generator, so every run and database gets the same readings. Power is 0 at night and follows a daylight curve; energy is cumulative and never decreases.

The last sample is 23:45 on 7 September. The [district summary](api-endpoints.md#district-generation-summary) needs a sample at the next midnight to close a day, so 1 to 6 September are complete days and 7 September is reported as partial. That is the summary's rule, not a gap in the seed.

## Recorded results

`npm test` on 2026-10-01 against the development database: 185 tests in 24 suites, 185 passed, 0 failed, 0 skipped.

| Area | Test file | What it checks |
| --- | --- | --- |
| Error format | `test/errors.test.js` | Root and Swagger still served; `nosniff` on every response and no `X-Powered-By`; unknown path 404; unsupported method 405 with Allow; malformed or non-object JSON 400; oversized body 413; unsupported charset or content encoding 415; bad path encoding 400; unexpected errors give a generic 500 without internal details |
| Credential hashing | `test/credentialHash.test.js` | PHC format, random salt, right and wrong secrets, stored parameters honoured, NFC-equivalent secrets, malformed or out-of-range stored hashes rejected, device secret format |
| Credential tables | `test/db/credentials.test.js` | Only hash columns; plaintext and other non-scrypt values rejected; foreign keys; one credential per user and installation; provisioner username rules; `changed_at` and credential versions; cascade on delete; a credential kept for an installation with readings |
| Timestamps | `test/db/provinceTimestamp.test.js`, `test/timestamps.test.js` | `updated_at` moves to a later second on every real change; RFC 3339 parsing with offsets; local times and impossible dates rejected |
| Tokens and scopes | `test/auth-api.test.js`, `test/token-ip-rate.test.js` | Claims, lifetimes, and scope for each principal; identical failure body for every sign-in failure; algorithm, issuer, audience, expiry, and claim checks; a token with altered scopes rejected; 403 with an `insufficient_scope` challenge on ten operations; revocation on a credential change; rate limits per identifier and per address |
| Hierarchy reads | `test/provinces-api.test.js`, `test/districts-api.test.js`, `test/substations-api.test.js`, `test/installations-api.test.js` | Each role sees only its jurisdiction; out-of-scope resources give the same 404 as missing ones; empty collections; pagination with count, next, and previous; ETag and Last-Modified; 304; HEAD and 405 |
| Installation writes | `test/installation-create-api.test.js`, `test/installation-replace-api.test.js`, `test/installation-delete-api.test.js` | 201 with Location and validators; duplicate meter 409; full replacement only; If-Match and If-Unmodified-Since with precedence, 412 and nothing changed; move blocked after readings; delete receipt, repeat 404, 409 when readings exist and readings untouched, credential removed |
| Readings | `test/reading-ingest-api.test.js`, `test/reading-history-api.test.js`, `test/last-known-reading-api.test.js`, `test/regional-readings-api.test.js`, `test/overview-api.test.js` | Owning device only; duplicate instant 409 in any offset; precision limits; readings more than 5 minutes ahead rejected; the seeded week counted, ordered both ways, windowed, and paged without gaps; latest by measurement time; region filters combined with AND; authorization before counts, links, and 304s; composite overview |
| Summary calculation | `test/districtSummary.test.js` | Complete, partial, missing, and anomalous installations; separate totals; reset at the closing midnight; unordered samples; zero versus no data; exact decimal sums and the safe-range guard; fresh, stale, and future-dated power |
| Summary endpoint | `test/district-summary-api.test.js` | A seeded complete day equals the meter differences computed separately in SQL; 7 September partial up to 23:45; a day without readings gives nulls; jurisdiction 404s; device and provisioner 403; input, media type, and method errors |
| End to end | `test/end-to-end.test.js` | Real sign-in for each principal: register an installation, set a device secret, ingest a reading, read it in history, last-known, overview, and summary, then find deletion refused |
| OpenAPI | `test/openapi.test.js` | The document validates as OpenAPI 3.0.3 and lists exactly the implemented operations; live responses for every operation match their documented status, headers, and schema; Swagger UI serves the paths |

Query plans on the full seed, measured with `EXPLAIN ANALYZE`: a national reader's unfiltered week takes about 170 ms in the database and a one-day window about 25 ms, using the index on (`timestamp`, `id`).

## Deployed service

Checked on 2026-10-02 at `https://solar-api-cw-25-1p-030.onrender.com`, after the deployment of commit `18f5bf9`, using the demo accounts. All requests were reads or sign-ins; no deployed data was changed.

| Check | Result |
| --- | --- |
| HTTPS | `GET /` 200 `{"status":"ok"}`; `http://` answers 301 to the `https://` URL |
| Response headers | `X-Content-Type-Options: nosniff`; no `X-Powered-By` |
| Swagger UI | `/api-docs/` 200; lists the summary operation, DELETE, and the scopes |
| Sign-in | All three staff readers, the provisioner, and the device get 200 with their scopes; wrong credentials 400 (code 3001); no token 401 |
| Jurisdiction | National reader sees 9 provinces; the Western reader sees only Western; the Colombo reader gets 404 for a Galle district and for Galle's summary |
| Scopes | A device token on `/provinces` gets 403 with `error="insufficient_scope", scope="hierarchy:read"`; the provisioner gets 403 on reading history |
| Conditional GET | `If-None-Match` with the current ETag returns 304; a single district sends `Last-Modified` |
| Content negotiation | `Accept: text/html` returns 406 |
| History | One installation has 672 readings; newest first with `sort=-timestamp`; `next` link keeps the sort; a one-day window has 96 |
| Last-known reading and overview | 200; the reading at 2026-09-07T18:15:00.000Z; overview has installation, substation, district, province, and reading |
| Regional readings | The Western reader counts 30,240 readings |
| District summary | Colombo on 2026-09-06: complete, 1397.19 kWh from 20 installations. On 2026-09-07: partial, 1496.4 kWh up to 18:15 UTC |
| Write precondition | `DELETE` with a stale `If-Match` returns 412 (code 1010); nothing deleted |

## Not verified

- **Concurrent writes.** The fixture uses one connection, so two requests never truly race. Duplicate readings and meter IDs rely on unique indexes, and conditional PUT and DELETE rely on the row lock taken in the same transaction; neither has been shown with two real connections. This needs a disposable database, because the rows must be committed, and it was not run against the shared one.
- **Load beyond the bounded local check.** One bounded run was made on 2026-10-02: 25 concurrent clients for 20 seconds against a local server and the development database, read-only (provinces, a province's districts, a district's substations, and a one-day regional reading window of 50 rows), signed in as the national demo reader. 1,922 requests, all 200, no errors; latency 257 ms median, 286 ms at the 95th percentile, 490 ms at the 99th, 610 ms maximum. Server and clients ran in one process on one machine with the database in another region, so the figures mostly show the round trip to the database. Writes under load, and the deployed free instance, were not load tested.
- **Writes on the deployed service.** Creating installations and ingesting readings were tested locally only, so the seeded data stays as marked.
- **Client address behind Render's proxy.** The per-address token rate limit depends on `TRUST_PROXY_HOPS=1` giving the real client address; this was not confirmed on the deployed service.
