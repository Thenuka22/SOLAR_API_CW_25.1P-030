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

## Next coding steps

The database migrations for provinces, districts, substations, installations, and readings are in place; see [Architecture](architecture.md#what-exists-now).

1. Add the scoped users table, with database checks for the valid role and jurisdiction combinations.
2. Seed provinces, districts, and substations, then solar installations, then one week of generation readings (see [Testing](testing.md)), as repeatable inserts.
3. Start the API layer with shared JSON error handling: an error helper, malformed-JSON handling, unknown-route handling, and focused tests. Define the application error codes and detail shape in that increment. Preserve the existing root and Swagger routes.

Add OpenAPI schemas in separate small increments. Define detailed credential and summary schemas before coding those features. After each commit, review its changes and test results before continuing.
