# API Design Guidelines

Reference: *WSO2 REST API Design Guidelines*. Section numbers below refer to that white paper. This summarizes relevant rules and their application; it is not a copy of the paper.

## Rules applied to this API

| WSO2 section | Rule | Project application |
| --- | --- | --- |
| 2-3 | Model data before deriving resources | Six entities and their relationships in [domain-model.md](domain-model.md) |
| 4.1-4.2 | Distinguish individual resources from collections | An installation is atomic; installations under a substation form a collection |
| 4.3 | Related entity types can be retrieved together as a composite | Overview combines installation, geographic ancestors, and latest reading |
| 4.5 | Expose explicit computations as processing functions | District summarization is a standalone processing endpoint |
| 5.1 | Use lowercase and hyphens; nouns for ordinary resources and verbs for processing functions | `/grid-substations`, `/overview`, and `/summarize-district-generation` |
| 5.1 | Processing functions are standalone; resource identifiers become parameters | District ID goes in the summary body, not in a nested function path |
| 5.4-5.5 | Base path identifies feature and version | `/solar/v1.0` |
| 5.6 | Identify members by ID; scope collections where appropriate | `/installations/{installation-id}` and `/installations/{installation-id}/readings` |
| 6 | Choose consistent representations | JSON with documented field names and units |
| 7.1 | GET is safe and idempotent | Reads do not create or change domain records |
| 7.2 | PUT replaces the complete writable representation | Required metadata must be supplied; omitted optional address resets to null |
| 7.3 | POST creates members or invokes processing functions | Creation returns 201; immediate computations return 200 |
| 8-9 | Use meaningful headers and statuses | Location for creation, validators for reads, and [per-endpoint statuses](api-endpoints.md) |
| 10.1 | Honour the requested response media type | Unsupported Accept gives 406; unsupported request-body type gives 415 |
| 10.2-10.3 | Support filtering, sorting, and pagination | Time/jurisdiction filters, timestamp sorting, offset/limit, count/next/previous |
| 10.4 | Let clients revalidate cached reads | ETag/Last-Modified; matching conditional GET returns 304 without a body |
| 10.5 | Check write preconditions to detect conflicts | Conditional metadata changes reject stale validators with 412 |
| 11 | Return useful, consistent client errors | Shared code/message/details structure |
| 12 | Design permissions and protect access | Device ownership and reader jurisdiction checks over HTTPS |

## Project choices, not WSO2 requirements

UUIDs, camelCase JSON, the feature name `solar`, page-size defaults, and exact endpoint names are project decisions. WSO2 supplies conventions, not a prescribed route list for this domain. See [API Endpoints](api-endpoints.md).

Body timestamps use [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339.html#section-5.6). The model's snake_case labels map to camelCase JSON. Keep power in kW separate from cumulative energy in kWh.

The overview is a read-only composite. WSO2 4.3 permits collective retrieval or deletion; shared deletion is not required. A composite resource is different from a composite key or an address split into component attributes.

The last-known-reading endpoint is a derived view of one installation's history. It does not modify data. The district computation uses the explicit processing-function form and its standalone naming rule.

## Corrections and assumptions

- **Maturity:** WSO2 section 1 says Level 1, while section 2 describes Level 2. The target is Level 2: resources plus meaningful HTTP methods and statuses. Pagination links alone do not supply Level 3 application transitions. See [Richardson Maturity Model](https://martinfowler.com/articles/richardsonMaturityModel.html).
- **DELETE:** WSO2 section 7.4 confuses identical responses with idempotency. A first DELETE returning 200 and a repeat returning 404 can remain idempotent because the intended server effect is unchanged. See [RFC 9110 section 9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2).
- **CRUD and immutable readings:** administrator-controlled installation metadata is our chosen way to support CRUD without changing sensor history. This is an interpretation, not confirmed external guidance; see [the provisioning decision](security.md#provisioning-decision).
