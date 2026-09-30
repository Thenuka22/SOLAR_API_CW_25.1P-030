# Testing

These checks are planned, not recorded passes, except where listed under [Recorded results](#recorded-results). Add the command and actual result when each feature is implemented.

| Area | Check |
| --- | --- |
| Startup | Importing the app opens no port; server honours PORT; root and Swagger assets load |
| Data | Foreign keys, User scope rules, unique meters, unique installation/timestamp pairs, immutable history |
| Endpoints | Method, status, headers, and JSON match [API Endpoints](api-endpoints.md) and OpenAPI schemas |
| Invalid input | Malformed JSON, invalid UUIDs/dates/numbers, unknown fields/queries, unsupported Accept and Content-Type |
| Permissions | Each role's allowed and denied operations; cross-device writes; cross-jurisdiction IDs, counts, links, summaries, and overviews |
| Collections | Empty results, missing parents, pagination boundaries, timestamp ordering, filters, preserved page links |
| Conditions | Empty 304, header precedence, changed embedded data, stale writes, authorization before cache validation |
| Races | Concurrent duplicate submissions create at most one reading; conditional updates do not overwrite a newer version |
| Calculations | Independent energy differences, late arrivals, Sri Lankan midnight, stale/missing measurements, counter anomalies |
| Deployment | Public HTTPS, Swagger assets, authentication, database persistence after redeployment |

Use real PostgreSQL for integration tests. Keep small arithmetic fixtures independent of the calculation function under test. Put empty parents and invalid records in isolated fixtures.

The demonstration seed contains 9 provinces, 25 districts, 35 substations, and 200 installations. Every district has a substation, and the extra ten are spread across selected districts. Readings cover 2026-09-01 00:00 to 2026-09-08 00:00 Sri Lanka time (+05:30), start inclusive and end exclusive, every 15 minutes: 672 per installation and 134,400 in total. Values come from md5 hashes of meter IDs, districts, and times rather than a random generator, so every run and database gets the same readings. Power is 0 at night and follows a daylight curve; energy is cumulative and never decreases. The last sample is 23:45 on 7 September, which closes the half-open window. Whether a daily energy summary also needs the next day's 00:00 reading is a rule for the summary calculation, not a gap in the seed.

Inspect query plans on the full seed and run a bounded local load test at 25 concurrent clients. Record latency and errors; accept no unexpected server errors, corruption, or permission leakage. Avoid heavy tests on free hosting and never reset deployed data silently.

## Recorded results

Run the automated tests with `npm test` (Node's built-in test runner). Tests under `test/db/` use `DATABASE_URL` after `npm run db:migrate` and `npm run db:seed`; they run inside one transaction that is rolled back, and are skipped when `DATABASE_URL` is not set.

| Area | Test file | Result |
| --- | --- | --- |
| Error format | `test/errors.test.js` | 17 passed, 0 failed on 2026-09-30: root and Swagger still served; unknown path 404; unsupported method 405 with Allow; malformed or non-object JSON 400; oversized body 413; unsupported charset or content encoding 415; bad path encoding 400; unexpected errors give a generic 500 without internal details |
| Credential hashing | `test/credentialHash.test.js` | 8 passed, 0 failed on 2026-09-30: documented PHC format, random salt, right and wrong secrets, stored parameters honoured, NFC-equivalent secrets, malformed or out-of-range stored hashes rejected, device secret format |
| Credential tables | `test/db/credentials.test.js` | 17 passed, 0 failed on 2026-09-30 against the development database: only hash columns, plaintext and other non-scrypt values rejected in every hash column, null hashes, foreign keys, one credential per user and installation, provisioner username rules, `changed_at` set by the database and advanced only by a hash change, cascade on delete, and a credential kept for an installation with readings |
