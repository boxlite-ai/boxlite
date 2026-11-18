**Status:** Upload and ownership regressions pass; validation recorded below

# Upload overwrite protection

Related issue: [#2411](https://github.com/boxlite-ai/boxlite/issues/2411).

## TL;DR

Propagate upload overwrite controls to guest extraction, and hand every object the copy creates to the box user the moment it is created. With `overwrite=false`, allow new files in existing directories, reject collisions without replacing existing contents, and permit earlier new entries to remain after failure.

## Scope and observable behavior

This proposal addresses the upload failure in [#2411](https://github.com/boxlite-ai/boxlite/issues/2411). It does not address that issue's execution/create idempotency, pagination, status filtering, or MCP annotations.

Example: `/app/keep.txt` contains `original`. An archive contains `new.txt`, then `keep.txt` with replacement bytes. Uploading to `/app` with `overwrite=false` creates `new.txt`, fails on `keep.txt`, and leaves `keep.txt` unchanged. The earlier new file can remain; this is not a transactional upload.

| Input | Result |
| --- | --- |
| `overwrite` omitted or `true` | Preserve default replacement behavior and unrelated destination files |
| `false`, existing directory, new entries | Add the entries successfully |
| `false`, missing destination | Create the destination when parent creation is allowed |
| `false`, existing file or incompatible file/directory entry | Return a conflict; retain the existing object and bytes |
| `false`, existing symlink at the entry destination | Return a conflict without replacing the link or target |
| Malformed boolean | Reject with HTTP 400 before guest writes |

Conflicts return HTTP 409 with the existing `already_exists` error envelope. Directory entries can reuse existing directories; they must not reset those directories' permissions or ownership. A conflict is an error, not an entry silently skipped followed by success.

## Observed public evidence

The public report describes HTTP 204 and replacement of existing guest bytes despite `overwrite=false`. It does not identify the deployed API/runner commits. The following observations come from static inspection of public commit `1c5ef25b57d31ce5e99678d1fad4ee86af149e32`; they are not a reproduction of that deployment.

| Boundary | Source observation |
| --- | --- |
| API contract | [OpenAPI upload](https://github.com/boxlite-ai/boxlite/blob/1c5ef25b57d31ce5e99678d1fad4ee86af149e32/openapi/box.openapi.yaml#L1106) defines `overwrite`, default `true`, and a 409 response |
| MCP/API forwarding | [Dispatcher](https://github.com/boxlite-ai/boxlite/blob/1c5ef25b57d31ce5e99678d1fad4ee86af149e32/apps/api/src/mcp/mcp-dispatcher.ts#L78) retains false query values; [file proxy](https://github.com/boxlite-ai/boxlite/blob/1c5ef25b57d31ce5e99678d1fad4ee86af149e32/apps/api/src/boxlite-rest/boxlite-proxy.controller.ts#L276) forwards the query |
| Runner | [Upload handler](https://github.com/boxlite-ai/boxlite/blob/1c5ef25b57d31ce5e99678d1fad4ee86af149e32/apps/runner/pkg/api/controllers/boxlite_files.go#L14) reads path/source shape but not overwrite |
| Go/C streaming | [Go entry](https://github.com/boxlite-ai/boxlite/blob/1c5ef25b57d31ce5e99678d1fad4ee86af149e32/sdks/go/copy.go#L229) has no overwrite option; [C entry](https://github.com/boxlite-ai/boxlite/blob/1c5ef25b57d31ce5e99678d1fad4ee86af149e32/sdks/c/src/copy.rs#L405) passes default copy options |
| Runtime/guest | [Runtime](https://github.com/boxlite-ai/boxlite/blob/1c5ef25b57d31ce5e99678d1fad4ee86af149e32/src/boxlite/src/litebox/box_impl.rs#L1072) already forwards overwrite; [guest](https://github.com/boxlite-ai/boxlite/blob/1c5ef25b57d31ce5e99678d1fad4ee86af149e32/src/guest/src/service/files.rs#L478) passes it to both hinted and staged extraction |
| Shared extraction | [Extraction](https://github.com/boxlite-ai/boxlite/blob/1c5ef25b57d31ce5e99678d1fad4ee86af149e32/src/shared/src/tar.rs#L281) rejects the entire existing destination directory; the directory check also runs after creating a missing destination |
| Other entry points | [Local serve](https://github.com/boxlite-ai/boxlite/blob/1c5ef25b57d31ce5e99678d1fad4ee86af149e32/src/cli/src/commands/serve/handlers/files.rs#L15) uses default options; [REST SDK](https://github.com/boxlite-ai/boxlite/blob/1c5ef25b57d31ce5e99678d1fad4ee86af149e32/src/boxlite/src/rest/litebox.rs#L459) explicitly refuses false to protect clients of older servers |

The source supports two distinct problems: lost policy in streaming adapters, and an extraction rule that cannot add new files to an existing directory with overwrite disabled.

## Related work and lessons

An earlier revision of this work added a descriptor-safe Linux extractor (pinned rootfs descriptor, `openat2` confinement, an inotify creation-identity check before metadata capture) to defend ownership and permission updates against a workload concurrently replacing directories on the upload path. That hardening assumed an adversarial in-box workload. It cost roughly 1,100 lines, a guest kernel option, and a second extraction implementation, while the uploader and the directory-replacing writer are the same tenant's code in this product.

Industry upload paths for same-user sandboxes apply ownership by path at creation and accept that exposure:

| Method | Projects / evidence | Decision and trade-off |
| --- | --- | --- |
| Chown at creation by path | [E2B envd](https://github.com/e2b-dev/runtime/blob/391b22443460fb30432da889b44aa413478d5717/packages/envd/internal/api/upload.go#L95-L117) opens then `ChownFile`; [Daytona daemon](https://github.com/daytonaio/daytona/blob/01c502bb1f1ff8f2885d0cd490e043736083dca8/apps/daemon/pkg/toolbox/fs/upload_files.go#L77-L110) `os.Create`; GNU tar (`--same-owner` for root); `docker cp` extraction | Adopt: the established default for tar-and-copy upload semantics |
| Descriptor-bound metadata | [microsandbox `FSetStat`](https://github.com/superradcompany/microsandbox/blob/c47f2598059bacbb86b53b3a7b3931bdde4287c6/crates/agentd/lib/fs.rs#L1379-L1409); [Kata `CopyFile`](https://github.com/kata-containers/kata-containers/blob/49bef8df3095baf132105c8174c2840bb425b504/src/agent/src/rpc.rs#L2334-L2482) via pathrs | Partially adopt where free: tar returns the created file's handle; the rest chowns by path |
| `openat2`/pathrs plus creation-identity watch | runc post-[CVE-2025-52565](https://github.com/opencontainers/runc/security/advisories/GHSA-qw9x-cqr3-wc7r) direction; Kata pathrs | Reject for now: adversarial model beyond the current product contract; revisit if multi-tenant adversarial workloads become supported |

The locked dependency's [tar 0.4.45 archive API](https://docs.rs/tar/0.4.45/tar/struct.Archive.html#method.set_overwrite) exposes overwrite control. Its entry implementation creates regular files with `create_new`, and only removes an existing destination when overwrite is enabled. Directory extraction also applies metadata, so setting the flag alone does not establish the directory-reuse contract. Shared extraction checks destination objects and ancestors, skips existing directory headers, and preserves tar's overwrite control for leaf creation.

| Alternative | Decision and reason |
| --- | --- |
| Reject any existing destination | Simpler, but also rejects unrelated new entries in common existing paths such as `/app` |
| Skip conflicting entries | Reject: a successful response would hide unapplied requested content |
| Runner stat/exec pre-check | Reject: duplicates extraction policy and separates checking from the actual write |
| Stage and pre-scan the whole archive | Not required for this contract; adds buffering without providing isolation from concurrent guest writers |
| Descriptor-safe extraction with creation watch | Dropped: defensible only against an adversarial workload; see the boundary section for what is accepted instead |
| Shared per-entry enforcement with creation-time chown | Selected: keeps one extraction implementation on every platform and matches the industry default |

## How it works

1. Parse overwrite at the HTTP boundary, distinguish omission from false, and pass it through runner, Go and C to the existing runtime/guest field. Keep the original C symbol and legacy Go calls defaulting to true; add a compatible overwrite-aware entry.
2. Enforce policy in the shared extractor, one implementation for staged and streamed extraction on every platform. Reuse valid directories, reject incompatible objects and occupied leaves, and configure tar's overwrite control for actual leaf creation. Repeated archive names count as occupied after their first successful creation. Preserve existing archive path checks, links validation and directory ordering. Do not introduce a separate runner-side extraction policy.
3. Hand every object the copy creates — the destination, the ancestors `mkdir_parents` conjures, implied directories, entries — to the container user. Ownership resolves each parent with `openat2(RESOLVE_IN_ROOT | RESOLVE_NO_MAGICLINKS)` against a rootfs descriptor pinned for the transfer, then applies `fchownat(AT_SYMLINK_NOFOLLOW)` to the leaf. Relative host destinations stop parent creation at the current directory. A `./` contents header preserves an existing destination's mode in both overwrite modes; a new destination still receives its archive mode.
4. Produce typed `AlreadyExists` conflicts. Preserve that class through guest RPC and portal to the existing runner 409 mapping; do not recognize collisions by arbitrary message substrings or turn unrelated storage errors into conflicts.
5. Honor the same parameter in local serve. Retain the REST SDK's refusal of false when remote support is unknown; enabling that SDK against mixed old/new servers needs a separate reliable capability strategy.

The shared destination check runs once the first archive entry decides the landing, before anything is written: an empty archive against an occupied destination remains a no-op, and a mount refusal still precedes a conflict verdict.

## Concurrency and ownership boundary

Ownership changes retain the container rootfs boundary: parent symlinks resolve inside the pinned root, and the final symlink itself is handed over. The upload trusts the box's own workload for object identity inside that boundary. Concurrent directory replacement can redirect metadata updates within the box; creation-identity watches and a separate descriptor-safe extractor remain outside this contract. Mount-shadow refusals gate every entry against container mounts, and uploads keep earlier writes after a conflict.

## Validation plan and current limits

The implementation forwards overwrite through runner, Go and C, preserves typed conflicts through guest RPC, applies the per-entry rule to staged and streamed extraction, and chowns created objects at creation. Local serve forwards the original archive and option through the runtime's stream API. This preserves entry order and duplicate names, so staging cannot silently replace an earlier archive entry before guest conflict checks.

Completed checks through repository `make` targets:

- With every production change restored to baseline, all six shared `no_overwrite` regressions failed at behavior assertions. The portal conflict regression also failed at its assertion. Restoring the fix made the shared cases pass.
- The real runner HTTP regression returned 204 for `overwrite=false` on baseline, failing its expected-409 assertion. With the fix restored it passed, including downloading unchanged original bytes and verifying true/default replacement.
- `make test:unit:rust FILTER=tar::` passes 69 shared cases: per-entry conflicts, existing-directory reuse, directory metadata preservation, symlink-destination refusal with and without a trailing slash, repeated archive names, sparse handling and the landing contract.
- `make test:unit:guest FILTER=service::files::` passes 13 cases, including partial-conflict byte and mode preservation with the completed file owned by the box user, image-directory metadata preservation, request-path symlink following, and empty-archive no-ops.
- `make coverage:copy:vm` passes the real-guest copy and ownership suites plus the serve duplicate-entry conflict: uploads hand created files and directories to a non-root box user, including when a later entry conflicts, and both overwrite settings keep their landing and replacement behavior.
- `make test:e2e E2E_ARGS='cases/test_upload_overwrite.py -x'` passes three real-stack cases: REST with and without a source hint, and MCP. Each checks adding new files with false, 409 conflicts with original and unrelated bytes retained, and true/default replacement. MCP uses the hintless path because its current OpenAPI catalog does not expose the runner's source-shape hint.
- C copy bindings, Go copy and runner HTTP upload checks, and the CLI unit suite are unchanged by this revision and keep their earlier passing results; the guest extractor change does not touch their code paths.

Defect proof restores all production files before observing behavioral failure; compile/setup failures do not reproduce defects.

Old-format tar headers with regular-file type and a trailing slash follow tar-rs's directory interpretation, including reuse without resetting existing metadata.

Hard-link entries retain tar 0.4.45's behavior: an occupied destination leaf returns `AlreadyExists` even with `overwrite=true`. The pinned dependency has no replacement branch for hard links. This separate limitation is tracked in [BUI-1772](https://linear.app/polygala/issue/BUI-1772).
