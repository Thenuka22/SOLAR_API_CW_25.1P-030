# Security Design

Status: planned. Authentication and authorization are not implemented yet. The [domain model](domain-model.md#user-scope) owns valid User jurisdiction combinations; the [API contract](api-contract.md#endpoint-register) owns route permissions.

## Principals

| Principal | Allowed access |
| --- | --- |
| Installation device | Submit readings for its authenticated installation only |
| National reader | Read across all jurisdictions |
| Provincial reader | Read within its assigned province |
| District reader | Read within its assigned district |
| Provisioner | Inspect necessary substation/installation metadata and manage installations; no reading ingestion or analyst access is implied |

Ancestor metadata may be visible when needed to describe an authorized asset, but its collections and counts must not reveal unauthorized siblings. Missing and out-of-scope resource identifiers return the same 404 shape.

## Provisioning decision

Keep device measurements immutable while demonstrating CRUD on installation metadata through a separate provisioning identity. This administrative extension is a chosen interpretation, not confirmed external guidance. It does not give ordinary SLSEA readers write permissions or turn a device into an administrator.

The provisioning identity is separate from the national/provincial/district User roles. Its credentials must be configured securely, not exposed through public registration. Credential storage and issuance details will be fixed in the authentication implementation increment.

Reject deletion of an installation with readings and reject moving its history into another substation/jurisdiction. Enforce this in transactions and database constraints, not only route checks.

## Enforcement

- `/issue-token` verifies registered credentials and derives claims on the server. Never accept client-selected roles, scopes, or jurisdiction as authority. This is a custom JWT issuer, not a full OAuth server.
- Validate the signature, allowed algorithm, issuer, audience, expiry, and principal type. Scopes describe allowed operations; ownership/jurisdiction checks constrain the target data.
- Intersect authorized jurisdiction with requested filters inside database queries before counts, pagination, summaries, composites, or response validators are calculated.
- Check both the installation and reading identifiers on nested requests. Never authorize by possession of an identifier alone.
- Apply authorization to conditional requests before returning 304 or exposing ETag/Last-Modified.
- Use HTTPS, protected environment configuration, hashed credential storage where passwords/secrets are verified, and parameterized SQL. Do not commit credentials or log tokens/passwords.
- Redact credential attributes from all metadata and composite representations. Prevent shared caching of authenticated domain data and disable caching of token responses.

The security tests must demonstrate denials as well as successful access. A role label or JWT scope alone does not prove that jurisdiction isolation works.
