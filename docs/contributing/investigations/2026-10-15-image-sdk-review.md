## TL;DR

Make malformed REST timestamps deterministic and document the breaking image API migration raised in #1952.

## Scope and evidence

At 46b5b8de, `src/boxlite/src/rest/types.rs:543` maps invalid timestamps to the current clock. Its image-list, image-version, tag-history and registry conversions all use this helper. The local image manager already uses Unix epoch (`src/boxlite/src/images/manager.rs:383`); the REST adapter should preserve that fallback. Valid RFC 3339 timestamps must retain their instant. Optional timestamps keep their existing None behavior; separate volume and box conversions are outside this finding.

The #1952 diff removes pull and digest-ID image operations. Current `openapi/box.openapi.yaml` exposes name-based get/remove and list operations but lacks migration guidance. Add an explicit breaking-change note to the specification and a practical migration table to the HTTP reference. Also normalize the requested reference-server heading.

## How it works

Use the existing Chrono Unix epoch constant in the shared REST conversion helper, with no new abstraction or dependency. This keeps malformed metadata stable across reads; rejecting complete responses would change the existing tolerant contract. Retaining deprecated routes would advertise endpoints the servers no longer implement, so document migration instead.

## Validation

Before production edits, deserialize wire responses through all four conversion boundaries and assert invalid timestamps become epoch; record the original assertion failure. Include a valid timezone-offset timestamp as a positive control. Then apply the fallback and rerun the focused REST tests and Rust formatting. Check migration statements against current and pre-catalog routes. No VM is required.

Tracking: https://github.com/boxlite-ai/boxlite/issues/1948

Observed: with only the new regression present, all four converted timestamps were the current clock instead of epoch. After the fallback change, all 127 REST tests and five OpenAPI reference-server tests passed; Rust formatting passed. VM tests were not required or run.
