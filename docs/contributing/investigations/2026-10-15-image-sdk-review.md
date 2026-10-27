## TL;DR

Make malformed REST timestamps deterministic, correct nullable Box API schemas,
and document the breaking image API migration raised in #1952.

## Scope and evidence

At 46b5b8de, `src/boxlite/src/rest/types.rs:543` maps invalid timestamps to the current clock. Its image-list, image-version, tag-history and registry conversions all use this helper. The local image manager already uses Unix epoch (`src/boxlite/src/images/manager.rs:383`); the REST adapter should preserve that fallback. Valid RFC 3339 timestamps must retain their instant. Optional timestamps keep their existing None behavior; separate volume and box conversions are outside this finding.

The #1952 diff removes pull and digest-ID image operations. Current `openapi/box.openapi.yaml` exposes name-based get/remove and list operations but lacks migration guidance. Add an explicit breaking-change note to the specification and a practical migration table to the HTTP reference. Also normalize the requested reference-server heading.

## How it works

Use the existing Chrono Unix epoch constant in the shared REST conversion helper, with no new abstraction or dependency. This keeps malformed metadata stable across reads; rejecting complete responses would change the existing tolerant contract. Retaining deprecated routes would advertise endpoints the servers no longer implement, so document migration instead.

## Validation

Before production edits, deserialize wire responses through all four conversion boundaries and assert invalid timestamps become epoch; record the original assertion failure. Include a valid timezone-offset timestamp as a positive control. Then apply the fallback and rerun the focused REST tests and Rust formatting. Check migration statements against current and pre-catalog routes. No VM is required.

Tracking: https://github.com/boxlite-ai/boxlite/issues/1948

Observed: with only the new regression present, all four converted timestamps were the current clock instead of epoch. After the fallback change, all 127 REST tests and five OpenAPI reference-server tests passed; Rust formatting passed. VM tests were not required or run.

## OpenAPI nullability correction

The Box API declares OpenAPI 3.1.1 but uses the 3.0 `nullable` keyword. A standard
JSON Schema consumer therefore rejects explicit nulls that the servers return.
Correct the schema without changing response JSON, field presence, or SDK runtime
behavior. Keep this correction in the existing image registry stack.

### Evidence and alternatives

- [OpenAPI 3.1.1, schema objects](https://spec.openapis.org/oas/v3.1.1.html#schema-object)
  uses JSON Schema 2020-12 semantics.
  [Validation section 6.1.1](https://json-schema.org/draft/2020-12/json-schema-validation#section-6.1.1)
  permits a union in `type`; `required` independently controls field presence.
- At `23fbfbd1`, `BoxliteImageController.toImageDetail` copies nullable sizes,
  timestamps, prior digests and actors into response fields. The registry
  controller copies nullable `createdBy`. Rust REST response types already use
  `Option` for these fields. Changing server values would break this contract.
- `ImageInfo.size_bytes` and `ListImagesResponse.next_page_token` have the same
  defect on main, before this stack. Authentication, box, execution and metrics
  schemas also use `nullable`; correct every occurrence in the Box document.
- The generated product clients consume `dist/apps/api/openapi.json`, an
  OpenAPI 3.0 document. Its
  [nullable semantics](https://spec.openapis.org/oas/v3.0.3#schema-object)
  are valid; leave that specification and its generated clients unchanged.
- [Ajv](https://ajv.js.org/json-schema.html#nullable-openapi) accepts `nullable`
  as an extension even in its 2020-12 validator. Regression tests must ignore
  that annotation to exercise standard JSON Schema behavior.

### Approach and acceptance

Replace each scalar type plus `nullable: true` with a type union containing the
quoted string `"null"`. Preserve required lists, formats, constraints and all
other schema content. Prefer this over `oneOf`, which adds unnecessary nesting.
Estimated production additions are under 60 lines, including a reusable API-only
Make test entry point. Reuse the workspace YAML parser and declare Ajv explicitly
for semantic contract tests.

The API tests read the Box specification outside the Nx workspace. Its default
test inputs cover project files, not this contract. Add an
[Nx runtime input](https://nx.dev/docs/reference/inputs#runtime-inputs) using
`git hash-object ../openapi/box.openapi.yaml` so schema-only edits invalidate
cached test results while retaining existing project/dependency inputs.

### Validation plan

Before production edits, validate nullable fields and actual controller outputs
against the checked-in schema; observe type-validation failures. After correction,
accept nulls and ordinary values, reject incorrect types, and verify optional
fields may be absent while required identifiers still reject absence or null.
Run the focused API tests and existing OpenAPI suite. Check generated Box client
types in a temporary directory; no generated client in the repository consumes
this specification. Document the regeneration requirement in the HTTP reference.

Observed: reverting every non-test file left 32 null-validation failures and four
passing presence checks. Restoring the correction passed all 36 checks, the
existing image/registry controller and routing tests, and the OpenAPI unit suite.
Structural comparison confirmed that only the 30 nullable scalar schemas changed.

OpenAPI Generator 7.23.0 accepted the specification. Regenerated TypeScript models
passed strict nullability compilation; the five affected Go models compiled and
preserved explicit nulls through JSON round trips. Run the checked-in regressions
with `make test:apps:api FILTER='Box API JSON Schema nullability'`.

Cache verification: replacing only the specification with its pre-fix version
initially replayed a cached pass. With the runtime input present, the same edit
executed the tests and produced 32 null-validation failures; restoring the
corrected specification returned the passing result.

Full generated Go client compilation encounters invalid `CreateBoxRequest`
constructor syntax; generating from the pre-fix specification produces the
identical file. This existing generator limitation is outside the nullability fix.

## Alias fixture maintenance

The timestamp regression deserializes catalog history before checking timestamp
conversion. History fixtures must use `alias`; the image-list `tag` field still
names an OCI tag. Keep the epoch and timezone assertions unchanged. A stale
history key fails deserialization before reaching those assertions.
