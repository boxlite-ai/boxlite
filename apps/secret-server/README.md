## TL;DR

The internal encryption package protects secret values and routing policy with per-write data keys and a replaceable key provider.

## Scope

This Go module contains the encryption package and a Secret Server skeleton.
The skeleton validates configuration, checks encryption and database connectivity,
and exposes `/health` and `/ready`. Write and fetch business endpoints are not yet
implemented. The existing API encryption service and stored values remain unchanged.

## Server skeleton

Set `SECRET_SERVER_ROLE` to `write`, `fetch`, or `all`; set `ENVIRONMENT`,
`DATABASE_URL`, `SECRET_MASTER_KEY_ID`, `SECRET_MASTER_KEY_BASE64`, and
`SECRET_SERVER_AUTH_MODE`. Google mode requires `SECRET_SERVER_AUDIENCE` and,
for write or all roles, `SECRET_SERVER_ALLOWED_CALLERS`. Dev mode requires
`SECRET_SERVER_DEV_TOKEN` and is limited to local and dev environments. The
environment key provider is rejected in production.

The write route group validates Google ID tokens and permits only verified emails
on the allowlist. The reserved fetch path and all business handlers return 404
until their separate implementations land. `/health` is liveness; `/ready`
checks database connectivity. Startup also performs an encryption round trip.

Migration and durable canary verification are placeholders. When #2571 is
integrated, both must succeed before the service reports readiness. Until then,
readiness does not prove that the database schema or persisted key matches.

Request logging and OpenTelemetry integration remain open under [#2570](https://github.com/boxlite-ai/boxlite/issues/2570);
the current service emits only startup and recovery logs. Configuration uses explicit
environment parsing and validation to keep errors limited to variable names and avoid
exposing secret values; it does not use envconfig or validator.

For a local run, supply a persistent development key, database URL, and dev token
through the environment, then run `make run:apps:secret-server`. The role defaults
to `write`; set `SECRET_SERVER_ROLE=fetch` to select fetch. Do not commit or print
the key or token. The local database must use the same key across restarts.

Design: [envelope encryption and KeyProvider](https://github.com/boxlite-ai/boxlite/issues/2495).
Routing metadata follows the [headers map contract](https://github.com/boxlite-ai/boxlite/issues/2467).

## Calling the package

The future application configuration layer reads `SECRET_MASTER_KEY_ID` and
`SECRET_MASTER_KEY_BASE64`, then passes both strings to `NewEnvKeyProvider`.
The package does not read process environment itself.

```go
provider, err := encryption.NewEnvKeyProvider(keyID, encodedKey)
if err != nil {
    return err
}
cipher, err := encryption.NewCipher(provider)
if err != nil {
    return err
}
identity := encryption.SecretContext{
    OrganizationID: organizationID,
    SecretID:       secretID,
    Version:        1,
    Hosts:          []string{"api.example.com"},
    Headers:       map[string]string{"Authorization": "Bearer {value}"},
}
envelope, err := cipher.Encrypt(ctx, identity, value)
```

The provider requires a canonical standard Base64 encoding of exactly 32 random
key bytes. IDs start with `env:`, followed by ASCII letters, digits, `.`, `_`, or
`-`, with a maximum total length of 128 bytes. There is no default key.
Construct the provider and cipher before serving requests; their zero values are
not configured instances. Configure one master key for development/staging only.

`Encrypt` creates a new 32-byte DEK on every call, even for identical inputs.
`Decrypt` unwraps the saved DEK and authenticates the value before returning it.
An authorized service caller supplies the context for both operations.

```text
value + identity + policy -- DEK --> value ciphertext
DEK + identity + key ID -- master key --> wrapped DEK
```

Map `Envelope.Ciphertext` to `ciphertext`, `WrappedDEK.Ciphertext` to
`encrypted_dek`, and `WrappedDEK.KeyID` to `key_id`. Ciphertext fields are binary;
the service owns database transactions and transport encoding.

## Authenticated context and format

IDs use standard dashed UUID text, accepting either letter case. Versions range
from 1 through 2147483647. UUIDs become 16-byte values; versions use uint32 big-endian.

Hosts must be nonempty with no empty entries. ASCII lowercasing, bytewise sorting,
and deduplication produce the canonical host set; wildcard syntax is preserved.
No DNS lookup, whitespace trimming, trailing-dot removal, or IDNA conversion occurs.

Headers must be an explicit nonempty map with valid HTTP token names. Names are
ASCII-lowercased and sorted bytewise. Duplicate canonical names fail even with
identical templates. Templates remain byte-exact, including whitespace and case.
The transport must reject exact duplicate object keys before converting to a map.

```text
identity = org_uuid[16] || secret_uuid[16] || version_u32be
string(s) = byte_length_u32be || bytes(s)
hosts = count_u32be || string(host_1) || ... || string(host_n)
headers = count_u32be || string(name_1) || string(template_1) || ...
value_aad = "boxlite.secret.value.v1\0" || identity || hosts || headers
dek_aad = "boxlite.secret.dek.v1\0" || identity
env_wrap_aad = dek_aad || string(key_id)
sealed = 0x01 || nonce[12] || encrypted_bytes || tag[16]
```

Value ciphertext is plaintext length plus 29 bytes. Environment-wrapped DEKs are
exactly 61 bytes. Unknown format versions and malformed records fail without fallback.
Changing an authenticated destination, header membership, or template causes
decryption to fail. Equivalent case/order changes and repeated hosts remain valid.

The service owns secret-value size limits, host policy, prohibited header names,
template syntax, and rendered-value validation. Resolve omitted headers to
`{"Authorization": "Bearer {value}"}` before calling this package. Never invent
defaults while reading encrypted records: reconstruct the original effective policy.
Return exactly the authenticated metadata to the runner, without rereading it.
AAD does not provide authorization or prevent rollback of an entire historical record.

## Errors and key lifecycle

Use `errors.Is` with `ErrInvalidInput`, `ErrUnknownKey`, `ErrAuthentication`,
`ErrProviderUnavailable`, `context.Canceled`, and `context.DeadlineExceeded`.
Unexpected provider errors are masked, so upstream messages cannot leak values or keys.
Failures return no partial plaintext. There is no plaintext compatibility fallback.

Providers must support concurrent calls and return independently owned buffers.
Callers must not concurrently mutate inputs. Temporary DEKs are cleared after use,
without a guarantee that every Go runtime copy is erased.

Each DEK encrypts one value. The environment master key wraps many DEKs; Go's
random-nonce GCM limit is 2^32 encryptions per key across all uses. There is no MVP
usage counter. DEK generation uses Go 1.25's
[`crypto/rand.Read`](https://pkg.go.dev/crypto/rand@go1.25.4#Read): it fills the buffer
or terminates the process on entropy failure; it cannot return a provider error.

Master-key rotation is not supported yet. Once encrypted data exists, do not change
`SECRET_MASTER_KEY_ID` or `SECRET_MASTER_KEY_BASE64`: changing the ID makes existing
versions fail with `ErrUnknownKey`; changing only the key material makes them fail
with `ErrAuthentication`. `EnvKeyProvider` holds only one key, and the package does
not expose a rewrap operation.

A future change will add a rewrap API or a keyring provider that routes by key ID.
The envelope format allows rewrapping a DEK without changing the value ciphertext,
but KMS, provider routing, and migration jobs are not implemented here.

## Verification

Run from the repository root with Go 1.25.4 or newer:

```sh
make test:apps:secret-server
make lint:apps:secret-server
make fmt:apps:secret-server
make test:apps:secret-server GOTEST_FILTER='-fuzz=FuzzDecryptEnvelope -fuzztime=5s -parallel=2'
```

The test target runs with the race detector and `GOWORK=off`, so it needs no VM,
native SDK library, Node installation, cloud permissions, or external Go modules.
The Nx test target delegates to the same make target for workspace test discovery.
Nx caching is disabled for this target because the workspace default inputs exclude
Go test files. Every invocation reaches Go, whose own test cache tracks test changes.
The Go CI job selects Secret Server source and test changes and runs this package
through `make coverage:go` with the race detector and `GOWORK=off`. It uploads
`target/coverage/secret-server.out` to Codecov alongside the other Go reports.
Tests cover real environment-key encryption, tampering, policy canonicalization,
key selection, provider errors, cancellation, and concurrent use. An internal test
checks the envelope format's rewrap compatibility; it does not expose rotation to callers.
Boundary tests reject malformed UUID hex and non-AES-256 keys, and cancel at
explicit context checkpoints after cryptographic operations to verify that no
result is released. These checkpoints avoid timing-dependent sleeps.
Fuzzing covers malformed envelope decoding; it is not a cryptographic proof.

Go reports statement coverage; Codecov also distinguishes partially covered source
lines, so a passing statement percentage does not imply passing patch coverage.
The uint32 framing overflow guards remain in place; tests do not allocate multi-GiB
inputs merely to exercise those guards.

This is a new contract with no equivalent on the base branch. Full-revert defect
proof is not applicable; positive, negative, and boundary tests exercise the new code.
