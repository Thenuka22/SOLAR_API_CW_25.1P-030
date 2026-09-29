# Project Documentation

| File | Contents |
| --- | --- |
| [Domain model](domain-model.md) | Entities, measurements, relationships, integrity rules |
| [API endpoints](api-endpoints.md) | Paths, permissions, inputs, successful responses, error codes |
| [API guidelines](api-guidelines.md) | Relevant WSO2 rules, their application, and justified differences |
| [Architecture](architecture.md) | Current setup, planned components, request flow |
| [Security](security.md) | Access boundaries and the provisioning assumption |
| [Testing](testing.md) | Checks to run as features are implemented |

Deployment settings stay in the [project README](../README.md#deployment). Domain endpoints and security are still planned; these notes do not claim they are live or tested.

## Next coding step

Add shared JSON error handling: an error helper, malformed-JSON handling, unknown-route handling, and focused tests. Define the application error codes and detail shape in that increment. Preserve the existing root and Swagger routes. Suggested commit: `feat: add consistent JSON error handling`.

Then add OpenAPI schemas and database migrations in separate small increments. Define detailed credential and summary schemas before coding those features. After each commit, review its changes and test results before continuing.
