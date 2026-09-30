# Testing

These checks are planned, not recorded passes. Add the command and actual result when each feature is implemented.

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

The demonstration seed contains 9 provinces, 25 districts, 35 substations, and 200 installations. Every district has a substation, and the extra ten are spread across selected districts. Readings cover 2026-09-01 00:00 to 2026-09-08 00:00 Sri Lanka time (+05:30), start inclusive and end exclusive, every 15 minutes: 672 per installation and 134,400 in total. Values come from md5 hashes of meter IDs, districts, and times rather than a random generator, so every run and database gets the same readings. Power is 0 at night and follows a daylight curve; energy is cumulative and never decreases. The last sample is 23:45 on 7 September, so under the boundary rule in [API Endpoints](api-endpoints.md#processing-endpoints) an energy summary for that date is incomplete.

Inspect query plans on the full seed and run a bounded local load test at 25 concurrent clients. Record latency and errors; accept no unexpected server errors, corruption, or permission leakage. Avoid heavy tests on free hosting and never reset deployed data silently.
