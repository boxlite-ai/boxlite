**Status:** Implemented

# Secret fetch implementation

The fetch handler implements [#2724](https://github.com/boxlite-ai/boxlite/issues/2724)
on the single-value database from [#2571](https://github.com/boxlite-ai/boxlite/issues/2571).

## Scope and dependencies

Development starts at database PR [#2612](https://github.com/boxlite-ai/boxlite/pull/2612),
commit `32e04da7855cdc66d783900956a57fdf4f6dca0e`. That commit includes
runner attestation and envelope encryption. Merge the database prerequisite before
this change; do not duplicate its migrations or introduce a versioned secret model.

The API implements atomic consumption in BUI-1385. This handler calls that API
once and cannot independently guarantee consumption if the API violates its
contract. Tests provide a consuming fake over HTTP. The service skeleton owns
process startup, role selection and mounting the fetch handler.

## Contract

```text
runner proof -> attested runner ID -> consuming introspection
             -> validate runner and complete grants
             -> load and authorize all rows -> decrypt all -> response
```

`POST /internal/v1/fetch` accepts only a credential. It takes identity from
`attest.Verifier`, never a body field. Introspection receives the credential and
attested runner ID, with a three-second timeout, no redirects and no retries.
Active replies must contain valid identifiers, a nonexpired expiry and a complete
grant list. An inactive reply grants nothing. Repeated grants are rejected.

Each row must belong to the authorized organization. Box scope additionally
requires the authorized box ID; organization scope requires no box ID. Missing,
disabled and out-of-scope rows fail the entire operation before any decryption.
All decryption uses stored authenticated metadata and AAD version 1. Responses
contain the same routing metadata, with no version field.

All responses use `Cache-Control: no-store`. Errors use RFC 9457 problem details
with fixed public codes. No response contains partial secrets, upstream errors,
credentials or proofs. A deleted row has no available name to include.

Audit entries contain only credential, runner, box and secret identifiers plus
the outcome. Audit writes have a separate bounded context so request cancellation
does not erase the attempt. Write failures increment a counter and emit a fixed
log message, without changing the fetch outcome.

Request bodies are limited to 4 KiB, API replies to 64 KiB, grants to 64,
and concurrent fetch operations to 16. A single database statement checks
ciphertext (64 KiB) and serialized row (128 KiB) sizes before returning bounded
columns. This avoids a separate check/read race and limits memory allocation.
Success JSON is limited to 8 MiB, including escaping expansion. Oversized stored
rows and saturation return `store_unavailable`; oversized API replies return
`api_unavailable`. Tests cover limits and saturation.

## Alternatives and evidence

| Option | Decision | Reason |
| --- | --- | --- |
| Adapt RFC 7662 inactive response | Adopt | Explicit `active: false` denies access; no cached authorization survives consumption. |
| Reusable OAuth introspection | Reject | Hydra and Keycloak describe reusable tokens; this API consumes one-time credentials. |
| Retry or follow redirects | Reject | A consumed token cannot safely repeat; redirects can forward credentials. |
| Reuse attestation and cipher | Adopt | Existing implementations already enforce proof and authenticated envelope contracts. |
| Return secrets incrementally | Reject | Later authorization or authentication failures must expose no partial list. |

Sources: [RFC 7662 §2.2](https://www.rfc-editor.org/rfc/rfc7662#section-2.2),
[RFC 9457 §3](https://www.rfc-editor.org/rfc/rfc9457#section-3),
[Go 1.25.4 HTTP transport](https://pkg.go.dev/net/http@go1.25.4#Transport),
[Hydra introspection](https://github.com/ory/hydra/blob/master/oauth2/handler.go),
[Keycloak endpoints](https://github.com/keycloak/keycloak/blob/main/docs/guides/securing-apps/partials/oidc/available-endpoints.adoc).
These sources establish individual protocol mechanisms, not a consensus for
consume-on-introspection. The local design explicitly chooses that contract.

## Validation

Extend access-log results with `api_unavailable`,
`scope_mismatch`, `store_unavailable` and `attestation_unavailable`, rather than
misclassify these failures under existing results. The updated fetch design
defines these outcomes alongside the existing database foundation.

Invalid proofs return 401 before introspection. A verifier outage returns 503
`attestation_unavailable` without consuming a credential; a later retry can use
the same credential. Inactive introspection exposes no specific rejection reason,
so this service records only `credential_invalid`; the API owns detailed reasons.

This is a new endpoint: no equivalent fetch or introspection implementation
exists on the selected base. Full-revert defect proof does not apply.

Checks cover two-secret success, empty grants, replay, concurrent
redemption, invalid proof before API contact, mismatched runner and ownership,
missing and disabled rows, API timeout and malformed replies, tampered policy,
fixed AAD compatibility, audit failure and cancellation, and sensitive markers
absent from logs. PostgreSQL integration checks exercise the real queries and
audit constraints in an isolated database.
