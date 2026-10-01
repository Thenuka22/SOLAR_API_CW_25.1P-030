# Project Documentation

| File | Contents |
| --- | --- |
| [Domain model](domain-model.md) | Entities, measurements, relationships, integrity rules |
| [API endpoints](api-endpoints.md) | Paths, permissions, inputs, successful responses, error codes |
| [API guidelines](api-guidelines.md) | Relevant WSO2 rules, their application, and justified differences |
| [Architecture](architecture.md) | Components, database rules, request flow |
| [Security](security.md) | Access boundaries and the provisioning assumption |
| [Authentication](authentication.md) | Principals, sign-in credentials, JWT claims, credential storage |
| [Testing](testing.md) | How the tests run, recorded results, and what is not verified |

Deployment settings stay in the [project README](../README.md#deployment). Every endpoint in [API endpoints](api-endpoints.md) is implemented and covered by `npm test`; [Testing](testing.md#not-verified) lists what has not been verified.

## Known limitations

- An installation with readings cannot be moved or deleted. If the site must operate under another substation, the policy is to retire the record and register a new one, so the history stays with the original. Retirement itself is not implemented: there is no retired status, and a meter ID is unique, so a replacement record cannot reuse it.
- Substations are not written through the API, so a substation's district can only change by a database correction. That would move the jurisdiction of its installations' history; no constraint prevents it.
- Concurrent writes and load have not been tested; see [Testing](testing.md#not-verified).

The OpenAPI document at `/api-docs` covers every implemented endpoint. Document each new endpoint there in the same commit.
