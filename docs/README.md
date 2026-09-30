# Project Documentation

| File | Contents |
| --- | --- |
| [Domain model](domain-model.md) | Entities, measurements, relationships, integrity rules |
| [API endpoints](api-endpoints.md) | Paths, permissions, inputs, successful responses, error codes |
| [API guidelines](api-guidelines.md) | Relevant WSO2 rules, their application, and justified differences |
| [Architecture](architecture.md) | Current setup, planned components, request flow |
| [Security](security.md) | Access boundaries and the provisioning assumption |
| [Authentication](authentication.md) | Principals, sign-in credentials, JWT claims, credential storage |
| [Testing](testing.md) | Checks to run as features are implemented |

Deployment settings stay in the [project README](../README.md#deployment). Domain endpoints and security are still planned; these notes do not claim they are live or tested.

## Next coding steps

The database migrations for all six entities, the repeatable demonstration seed data, and the shared JSON error format are in place; see [Architecture](architecture.md#what-exists-now).

1. Add the credential tables described in [Authentication](authentication.md#credential-storage), with database tests.
2. Add a repeatable database test suite for the migrations and seed data before final submission.

Add OpenAPI schemas in separate small increments. Define the detailed summary schema before coding that feature. After each commit, review its changes and test results before continuing.
