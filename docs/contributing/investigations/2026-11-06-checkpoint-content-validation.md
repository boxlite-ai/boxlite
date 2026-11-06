## TL;DR

Remove checkpoint payload integrity scans from capture, transfer and restore. Use
a versioned memory envelope and metadata identities for retries, preserving format
bounds, access controls, durable publication and actual I/O errors.

## Scope

This changes the Linux/KVM memory checkpoint contract, including local pairs,
managed archives and runner transfers. New exports use memory format v10; older
runtimes cannot consume them. Existing v9 inputs remain readable without content
verification. Same-size payload corruption is no longer detected before restore.

Keep host-path policy, allocation checks, descriptor roles, archive member names,
length bounds, fsync, cancellation and VM compatibility checks. They are not
bulk content scans. Do not change pause reconciliation or deployment.

## Related work and lessons

At BoxLite `7740e719874756f7fb7a4b41e0f4cdc31c1e4e08`:

- `src/boxlite/src/litebox/checkpoint/pair.rs:468` hashes memory metadata and the
  entire payload on each open; `:653` hashes the paired QCOW2 again. Remove these
  integrity passes while retaining envelope and QCOW2 structural checks.
- `src/boxlite/src/runtime/checkpoints/local/archive.rs:49` hashes all members;
  `:245` copies boot solely to verify it; `:263` rescans directories for retries.
  Use member lengths and capture metadata for replay identity; remove the
  verification-only copy.
- `src/boxlite/src/runtime/checkpoints/local/cloud.rs:81` hashes both full files
  for admission. Replace this with a bounded metadata identity including a fresh
  capture nonce. This binds admitted configuration, not payload integrity.
- `src/boxlite/src/runtime/checkpoint_import.rs:150` searches cached boot files by
  content identity. Keep this dependency identifier and its generation/lookup;
  remove repeated verification after selection. Size alone cannot identify boot.
- `apps/api/src/boxlite-rest/checkpoint-transfer.service.ts:85` selects an existing
  same-organization boot archive by that identifier. Preserve this lookup contract.
- Pinned libkrun `10042c5a90dda787da2e79544362b66b156250c1`,
  `src/vmm/src/ram_snapshot/full/format.rs:81` verifies memory;
  `:124` generates metadata/payload hashes; `full.rs:427` hashes QCOW2;
  `full.rs:836` rehashes restore disks. Remove these bulk integrity operations.
- [RFC 8878, sections 3 and 3.1.1](https://www.rfc-editor.org/rfc/rfc8878.html#section-3.1.1)
  defines an optional content checksum and permits ignoring it during decoding.
  Disable checkpoint zstd checksums while preserving decompression errors and
  tar framing.

Rust zstd 0.13.3 exposes decoder parameters; zstd-safe 7.2.4 gates
`ForceIgnoreChecksum` behind its experimental feature.

No change leaves the repeated full reads intact. Replacing SHA-256 with a faster
hash still scans RAM and disks. Placeholder hashes under v9 misrepresent the
contract; a new format makes the loss of integrity detection explicit.

## How it works

V10 keeps the 160-byte envelope and length fields. Bytes 48–80 hold a random
capture identity, and bytes 80–160 are reserved zeroes. Payload and disk hashes
are absent. Readers distinguish v9 from v10 and never validate payload checksums.
Metadata fingerprints cover the envelope and bounded JSON only, never RAM/disk
contents. They preserve distinct captures and detect changed admission metadata;
they cannot detect payload mutation.

Managed manifest v2 records member lengths, the boot dependency identifier and
`metadata_sha256`, without memory/disk member digests. Native import recomputes
this bounded metadata identity before publication. V1 manifests remain accepted
by local native import; cloud restore requires v2 and reports an explicit
re-export requirement for old archives.
Replay checks compare capture metadata and lengths. Keep actual boot ownership
copies; remove the temporary boot-check copy and all post-copy hashing.

Runner capture reports `metadata_sha256` through the existing `ContentSHA256`
field; the API persists and returns that expected identity in the restore job.
Before native import, runner compares it to the downloaded manifest identity;
native import compares that identity to actual envelope/JSON bytes. This retains
the admitted configuration binding without reading RAM or disk for hashing.
Runner archive downloads stop recomputing/validating compressed archive hashes.
Boot identifiers remain available for dependency lookup. GCS transport integrity
remains the storage library's responsibility.

This replaces the admission protection previously supplied by
`apps/runner/pkg/boxlite/checkpoints.go:359`: checking CPU/memory alone after
import cannot bind the configuration admitted at
`apps/api/src/boxlite-rest/checkpoint-box.service.ts:27`. The existing job already
carries the expected identity (`apps/api/src/box/runner-adapter/runnerAdapter.v2.ts:158`).
Test a different valid archive with the same resource sizes and altered network
configuration: its metadata identity must fail before restore.

## Validation

This is an intentional relaxation of the previous corruption-rejection contract,
not a claim that the previous validator was incorrect. Test unchanged lengths
with changed payloads as accepted, and test malformed metadata, truncated files,
unexpected archive entries and changed admission configuration as rejected.
Test v9/v10 and manifest v1/v2 reads, publication, replay and source independence.

Run project make targets for focused Rust and runner tests plus formatting.
Native format tests require Linux; VM continuation and before/after timings
require Linux x86_64/KVM. Report unavailable checks explicitly; envelope-only
measurements do not establish complete capture or restore latency.
