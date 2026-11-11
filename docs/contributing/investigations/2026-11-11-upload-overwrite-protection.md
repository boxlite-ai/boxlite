**Status:** Implemented and verified through REST and MCP

# Upload overwrite protection

Related issue: [#2411](https://github.com/boxlite-ai/boxlite/issues/2411).

## TL;DR

Propagate upload overwrite controls to guest extraction. With `overwrite=false`, allow new files in existing directories, reject collisions without replacing existing contents, and permit earlier new entries to remain after failure.

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

The existing shared extraction function is the common owner of staged and streamed unpacking. Its [existing tests](https://github.com/boxlite-ai/boxlite/blob/1c5ef25b57d31ce5e99678d1fad4ee86af149e32/src/shared/src/tar.rs#L1264) verify file preservation and directory-wide refusal. Reuse the shared owner, but intentionally replace directory-wide refusal tests with per-entry outcomes.

The locked dependency's [tar 0.4.45 archive API](https://docs.rs/tar/0.4.45/tar/struct.Archive.html#method.set_overwrite) exposes overwrite control. Its [entry implementation](https://docs.rs/tar/0.4.45/src/tar/entry.rs.html) creates regular files with `create_new`, and only removes an existing destination when overwrite is enabled. Directory extraction also applies metadata, so setting the flag alone does not establish the directory-reuse contract. Shared extraction checks destination objects and ancestors, skips existing directory headers, and preserves tar's overwrite control for leaf creation.

| Alternative | Decision and reason |
| --- | --- |
| Reject any existing destination | Simpler, but also rejects unrelated new entries in common existing paths such as `/app` |
| Skip conflicting entries | Reject: a successful response would hide unapplied requested content |
| Runner stat/exec pre-check | Reject: duplicates extraction policy and separates checking from the actual write |
| Stage and pre-scan the whole archive | Not required for this contract; adds buffering without providing isolation from concurrent guest writers |
| Shared per-entry enforcement | Selected: keeps both guest paths consistent and preserves streaming without requiring rollback |

## How it works

1. Parse overwrite at the HTTP boundary, distinguish omission from false, and pass it through runner, Go and C to the existing runtime/guest field. Keep the original C symbol and legacy Go calls defaulting to true; add a compatible overwrite-aware entry.
2. Enforce policy in shared extraction. Reuse valid directories, reject incompatible objects and occupied leaves, and configure tar's overwrite control for actual leaf creation. Preserve existing archive path checks, links validation and directory ordering. Do not introduce a separate runner-side extraction policy.
3. Produce typed `AlreadyExists` conflicts. Preserve that class through guest RPC and portal to the existing runner 409 mapping; do not recognize collisions by arbitrary message substrings or turn unrelated storage errors into conflicts.
4. Honor the same parameter in local serve. Retain the REST SDK's current safe refusal for false when remote support is unknown; enabling that SDK against mixed old/new servers needs a separate reliable capability strategy.

Repeated names within an archive count as occupied after their first successful creation. Existing symlink destinations, dangling symlinks, hard-link collisions and file/directory conflicts require explicit tests. The proposal does not promise isolation from concurrent guest filesystem mutation, atomic rollback, or all-or-nothing permissions/ownership updates after partial failure.

## Validation plan and current limits

The implementation forwards overwrite through runner, Go and C, preserves typed conflicts through guest RPC, and applies the per-entry rule to staged and streamed extraction. Local serve forwards the original archive and option through the runtime's stream API. This preserves entry order and duplicate names, so staging cannot silently replace an earlier archive entry before guest conflict checks.

Completed checks through repository `make` targets:

- With every production change restored to baseline, all six shared `no_overwrite` regressions failed at behavior assertions. The portal conflict regression also failed at its assertion. Restoring the fix made the shared cases pass.
- The real runner HTTP regression returned 204 for `overwrite=false` on baseline, failing its expected-409 assertion. With the fix restored it passed, including downloading unchanged original bytes and verifying true/default replacement.
- The Go streaming VM regression passed with a 16 MiB archive. Its separate baseline attempt failed while pulling the image, so that run provides no Go defect proof; the runner and shared baseline assertions provide the defect evidence.
- C copy tests passed (10 cases), and the CLI unit suite passed (343 cases before the additional handler regression). A real-VM local-serve handler regression also passed: duplicate `x.txt` entries return 409 and retain the first entry's bytes. With all production files restored to baseline, that handler regression reached its status assertion and failed with 204 instead of 409.
- `make test:e2e E2E_ARGS='cases/test_upload_overwrite.py -x'` passed three real-stack cases: REST with and without a source hint, and MCP. Each checks adding new files with false, 409 conflicts with original and unrelated bytes retained, and true/default replacement. MCP uses the hintless path because its current OpenAPI catalog does not expose the runner's source-shape hint.
- The initial stack smoke timed out while a cold image create took 31 seconds; cached retries succeeded. A long inherited temporary path also prevented MCP's Unix socket from opening; rerunning with `TMPDIR=/tmp` passed. These were setup failures, not defect reproductions. The validation stack was shut down afterward.

Remaining validation criteria:

- Add shared staged/streamed cases for new files in existing directories, missing destinations, same-name conflicts, type/link conflicts, repeated archive names, directory metadata preservation and partial writes. Check actual filesystem bytes and objects.
- Run each defect regression with all production files at their original state, observe failure at the behavioral assertion, then restore the complete fix and require the same assertion to pass. A compile/setup failure does not reproduce the defect.
- Verify guest/portal typed errors, C/Go old-default compatibility, and runner/local-serve parsing and propagation with repository `make` targets.
- Through real REST and MCP entry points, upload conflicting bytes with false and read the guest file back. Repeat with true and omitted overwrite, checking replacement, other archive entries and unrelated existing files. Exercise hinted and hintless guest paths.
- Keep the REST SDK old-server refusal covered. Report missing dependencies, skipped checks and environment failures separately; do not label unit mocks as VM integration.

The implementation delivers shared/native extraction, guest and portal conflicts,
host copy-out compatibility, option-aware C/Go stream APIs, and runner/serve
forwarding together. Existing C and Go entry points retain their default behavior.
Partial failures retain extraction progress so ownership finalization runs before
the original conflict is returned. Untouched conflicting destinations keep their
owner; newly created empty destinations still belong to the box user.

Host destination resolution runs on a blocking worker. Normal merges include the
main branch changes through `6435328ebe`; both investigation-index entries are
retained. Local validation and updated CI results must be assessed on this final
combined tree.

The original core CI exposed macOS temporary-root symlinks. Policy fixtures now
use canonical roots; host copy-out resolves trusted parents while retaining leaf
protection. A VM regression failed on the prior core and passed after correction.
Additional regressions caught dropped trailing-slash directory intent and failure
on missing parents containing `..`; both failed against the earlier resolver and
passed after filesystem parent resolution. Directory intent is passed separately
from the resolved path. A directory-symlink leaf regression already rejected before
that separation, so the separation is not claimed as a demonstrated security fix.

A late archive directory header also exposed lost permissions on a directory
created by an earlier file entry. Its regression observed mode `0755` instead of
`0700` before correction and passed afterward. Only directories that predate the
archive retain their original metadata. Local green results do not establish that
the updated cross-platform CI or patch-coverage gate has passed.

The runner HTTP VM regression skips only the runtime constructor's typed
`ErrUnsupported` verdict when the host lacks usable virtualization, matching the
existing execution-inventory regression. Other constructor errors and every
upload/download assertion remain failures. Hosted Go coverage jobs may therefore
skip this VM case; the local supported-host run provides its HTTP/guest evidence.

`make coverage:copy:vm` adds the existing copy/ownership suites and the explicitly
ignored serve duplicate-entry regression to collected Rust profiles. The Linux
x64 Rust job runs it after enabling KVM access when Rust or CLI inputs change.
Unlike the unit pass, this pass installs native build prerequisites through
`make setup:build`, builds the runtime without dependency stubs and boots real
guests. It preserves earlier profiles, fails on missing KVM or a test
failure, and leaves the 90% patch gate unchanged. This connects upload and host
copy behavior already checked locally to the report reviewers see in CI.

Old-format tar headers with regular-file type and a trailing slash follow tar-rs's
directory interpretation, including reuse without resetting existing metadata.
Protected Rust copy-out retains terminal `/.` directory intent as well as `/`;
a non-directory host ancestor returns `AlreadyExists`, while other resolution
errors remain storage errors. Regression runs against the prior production tree
failed at each of these behavioral checks before these corrections.
