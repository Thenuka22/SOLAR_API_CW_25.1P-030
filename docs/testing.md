# Test Plan

Status: planned acceptance checks. This document does not record completed tests. Add actual results alongside the increment that implements each feature.

| Area | Required evidence |
| --- | --- |
| Startup | Importing the app opens no listener; server startup respects PORT; root and Swagger assets load |
| Model integrity | Correct parent relationships, valid User scope combinations, unique meter identifiers, unique installation/timestamp pairs |
| History | Reading updates/deletes and cascading history deletion are blocked; latest selection handles late arrivals |
| HTTP contract | Actual methods, statuses, headers, and JSON shapes agree with the endpoint register and executable OpenAPI |
| Input handling | Malformed JSON, wrong types, invalid dates, unknown fields, invalid pagination, unsupported Accept/Content-Type |
| Authorization | Every principal's allowed and denied operations; cross-installation writes and cross-jurisdiction reads fail |
| Leakage | Counts, links, ancestors, summaries, composites, and conditional responses disclose only authorized information |
| Collections | Empty/missing parents, first/middle/last pages, both timestamp orders, time boundaries, preserved filters |
| Conditional requests | Matching/nonmatching validators, header precedence, empty 304 bodies, stale writes, changed composite dependencies |
| Concurrency | Simultaneous duplicate ingestion creates at most one reading; conditional updates prevent lost updates |
| Summary calculations | Independent expected totals; cumulative energy differences; midnight boundaries; stale/missing readings and counter anomalies |
| Deployment | Public HTTPS access, correct startup, Swagger assets, authentication, and persisted data after redeployment |

## Test data and execution

Use real PostgreSQL for integration tests. Use small, independently calculated fixtures for arithmetic and permission checks; do not generate expected answers with the function under test.

The planned demonstration seed contains 9 provinces, 25 districts, 35 substations, and 200 installations. Give each district at least one substation and distribute the remaining ten across selected districts. Generate at least 7 days at 15-minute intervals per installation: 134,400 readings, plus required boundary samples. Record the random seed and time window, with plausible daytime generation and cumulative energy.

Keep empty parents and malformed-data cases in isolated fixtures. Seed and test reset commands must never silently erase the deployed dataset.

Check query plans and latency on the full seed. Run a bounded local load test at 25 concurrent clients; record latency, errors, and integrity results. Require no unexpected server errors, corruption, or authorization leakage. Do not run heavy tests against free hosting quotas.

For each increment, record the command, result, and limitations. Review failures before committing; do not mark unimplemented acceptance checks as passed. Rerun the relevant deployment smoke checks after publishing changes.
