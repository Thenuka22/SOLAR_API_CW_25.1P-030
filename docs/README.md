# Design Documentation

These documents describe the agreed design. They are engineering notes, not evidence that the planned features are implemented or tested.

| Document | Owns |
| --- | --- |
| [Architecture](architecture.md) | Components, request flow, current state, and design decisions |
| [Domain model](domain-model.md) | Entities, attributes, relationships, measurement meanings, and data integrity |
| [API contract](api-contract.md) | Resource classifications, endpoint names, representations, and HTTP behaviour |
| [Security](security.md) | Client identities, permissions, jurisdiction enforcement, and credential handling |
| [Testing](testing.md) | Planned acceptance checks and the evidence needed before a feature is complete |

Read the architecture and domain model before the API contract. Each topic has one owning document; link to it instead of copying its rules elsewhere.

The [project README](../README.md#deployment) owns the Render deployment settings. Keep the root README as the project entry point.

## Review workflow

Make one focused change with relevant checks, commit it, and stop for review. Report the commit hash, changed behaviour, checks performed, and next increment. Do not describe planned tests as passed or planned endpoints as live.
