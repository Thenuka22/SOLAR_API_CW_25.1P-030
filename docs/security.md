# Security

Planned permissions; authentication is not implemented yet. [User scope](domain-model.md#user-scope) defines valid role/jurisdiction combinations.

| Caller | Permission |
| --- | --- |
| Device | Submit readings for its own installation only |
| National reader | Read all jurisdictions |
| Provincial reader | Read within one province |
| District reader | Read within one district |
| Provisioner | Read necessary substation/installation metadata and manage installations; no measurement access |

## Provisioning decision

Readings stay append-only. CRUD applies to installation metadata through a separate provisioning identity, not a normal SLSEA reader or device. This is a design assumption, not confirmed external guidance. No public registration may grant provisioning privileges.

An installation with readings cannot be deleted or moved to a different substation. Use database constraints and transactions to protect this rule.

## Checks required

- Verify credentials before issuing a JWT. Derive roles, scopes, and jurisdiction on the server; never accept them as client-granted permissions. This issuer is not a full OAuth server.
- Verify JWT signature, allowed algorithm, issuer, audience, expiry, and principal type. Define credential schemas and storage before implementing issuance.
- Apply jurisdiction restrictions in SQL before counting, paging, or aggregating. Ancestor metadata must not expose unauthorized siblings. Nested reading IDs must belong to the specified installation.
- Return 401 for invalid authentication, 403 for a forbidden operation, and the same 404 response for missing and concealed out-of-scope resources. Validate access before returning 304 or exposing validators.
- Keep passwords/secrets hashed where verified, use HTTPS and parameterized SQL, and redact credentials from responses/logs. Token responses use no-store; authenticated data must not enter shared caches.

Endpoint-specific permissions and errors are listed in [API Endpoints](api-endpoints.md).
