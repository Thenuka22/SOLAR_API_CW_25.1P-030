# Security

Permissions as implemented. [User scope](domain-model.md#user-scope) defines valid role/jurisdiction combinations. [Authentication](authentication.md) defines how each caller signs in, its token claims, and credential storage.

| Caller | Token scopes | Permission |
| --- | --- | --- |
| Device | `readings:write` | Submit readings for its own installation only |
| National reader | `hierarchy:read installations:read readings:read` | Read all jurisdictions |
| Provincial reader | same | Read within one province |
| District reader | same | Read within one district |
| Provisioner | `installations:read installations:write` | Read necessary substation/installation metadata and manage installations; no measurement access |

The three readers hold the same scopes; what differs is their jurisdiction, which is not in the token. See [Scopes](authentication.md#scopes).

## Provisioning decision

Readings stay append-only. CRUD applies to installation metadata through a separate provisioning identity, not a normal SLSEA reader or device. This is a design assumption, not confirmed external guidance. No public registration may grant provisioning privileges.

An installation with readings cannot be deleted or moved to a different substation. Use database constraints and transactions to protect this rule.

## Checks required

- Verify credentials before issuing a JWT. Derive roles, scopes, and jurisdiction on the server; never accept them as client-granted permissions. This issuer is not a full OAuth server.
- Verify JWT signature, allowed algorithm, issuer, audience, expiry, principal type, and scope claim, then load the principal from the database and check its credential version. See [Bearer authentication](authentication.md#bearer-authentication).
- Apply jurisdiction restrictions in SQL before counting, paging, or aggregating. Ancestor metadata must not expose unauthorized siblings. Nested reading IDs must belong to the specified installation.
- Return 401 with a Bearer challenge for a missing or invalid bearer token, 400 for rejected token-request credentials (see [Token request](authentication.md#token-request)), 403 for a forbidden operation, and the same 404 response for missing and concealed out-of-scope resources. Validate access before returning 304 or exposing validators.
- Keep passwords/secrets hashed where verified, use HTTPS and parameterized SQL, and redact credentials from responses/logs. Token responses use no-store; authenticated data must not enter shared caches.

Endpoint-specific permissions and errors are listed in [API Endpoints](api-endpoints.md).
