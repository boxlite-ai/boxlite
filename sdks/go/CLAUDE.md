# sdks/go/ — Developer Guide for Claude

This file is an **additive delta** to the root `CLAUDE.md`. It covers pitfalls that only matter when *modifying* the Go SDK or its CGO bridge (see `README.md` for usage). Read root rules first.

The Go SDK has the most distinct gotchas of any SDK because it combines CGO with a static-archive link strategy, two build modes, and Go's strict pointer rules. Every rule here exists because we hit the underlying bug at some point.

## 1. Two CGO build modes — get the tag right

The CGO directives live in two files with mutually exclusive build constraints:

- `bridge_cgo_dev.go` — `//go:build boxlite_dev`. Links against `../../target/debug/libboxlite.a`. The Rust library must be built first via `make dev:go`.
- `bridge_cgo_prebuilt.go` — `//go:build !boxlite_dev`. Links against `./libboxlite.a` in the module directory (downloaded by `cmd/setup`).

When iterating on the Rust side, use `go test -tags boxlite_dev ./...`. Without the tag, the linker pulls in a stale prebuilt archive — symptoms look like missing or weirdly-versioned symbols.

## 2. `cmd/setup` is mandatory for consumers — keep it in sync with releases

`go get` alone does not produce a buildable module. Consumers must also run `go run github.com/boxlite-ai/boxlite/sdks/go/cmd/setup` to download `libboxlite.a` and `boxlite.h` into the module cache.

- The setup binary lives at `cmd/setup/main.go`.
- When changing release artifacts (archive name, header name, asset layout, supported platforms), update `cmd/setup/main.go` in the same PR. Otherwise consumers can't install the new version.

## 3. Go pointers cannot cross the C boundary — always use `cgo.Handle`

Go's runtime forbids passing Go-allocated pointers to C if C stores them. The standard idiom is `runtime/cgo.Handle`: it produces a `uintptr` that's safe to hand to C as `user_data`, while keeping the underlying Go value alive in a side table.

- Existing pattern lives in `bridge_callback.go` (`handleToPtr`, etc.).
- When adding any callback that needs Go state on the C side, follow that pattern — never pass `&goStruct` or a raw `unsafe.Pointer` to Go memory.
- Symptom of a violation: random crashes, GC-eaten state, or `cgocheck` panics under `GODEBUG=cgocheck=2`.

## 4. `boxlite.h` is a stable wrapper — do not overwrite it with the C header

`sdks/go/boxlite.h` is a 10-line `#include` wrapper that resolves at compile time to whichever real header is present:

```c
#if __has_include("include/boxlite.h")
#include "include/boxlite.h"           // prebuilt path: extracted by cmd/setup
#elif __has_include("../c/include/boxlite.h")
#include "../c/include/boxlite.h"      // dev path: cbindgen output in sdks/c/
#else
#error "boxlite.h not found; run cmd/setup"
#endif
```

It is **not** a copy of `sdks/c/include/boxlite.h`. Replacing it with the generated header would break prebuilt Go consumers: their downloaded `libboxlite.a` would no longer pair with the freshly downloaded `include/boxlite.h` (the committed file would shadow it), producing silent ABI/header skew at link time.

When the C ABI changes:
- Regenerate `sdks/c/include/boxlite.h` via the normal C SDK build (`cbindgen`, see `sdks/c/build.rs`).
- Ensure the next release tarball ships `include/boxlite.h` alongside `libboxlite.a` so `cmd/setup` extracts a matching pair into the module cache.
- Run `go test -tags boxlite_dev -race ./...` to validate the dev path, and (post-release) `go test ./...` against the prebuilt path.
- **Do not** edit `sdks/go/boxlite.h` itself — leave the wrapper alone.

## 5. Race tests are load-bearing — run with `-race` after lifecycle changes

These tests exist because CGO + goroutines + close-during-use is a real footgun:

- `handle_race_test.go` — concurrent handle access.
- `runtime_close_test.go` — close during in-flight calls.
- `abandon_async_test.go` — abandoning an in-progress async operation.

After any change to handle lifecycle, callback wiring, or `cgo.Handle` usage, run `go test -tags boxlite_dev -race ./...`. Without `-race` you can pass a regression that ships and only fires in production.

## 6. Platform link flags live in two files — keep them in sync

macOS LDFLAGS pull in `CoreFoundation`, `Security`, `IOKit`, `Hypervisor`, `vmnet`, and `lresolv`. Linux is a single archive link with no extra frameworks.

- If a new Rust dependency introduces a new system framework (e.g., a macOS-only crate that links `CoreServices`), add it to **both** `bridge_cgo_dev.go` and `bridge_cgo_prebuilt.go`. They share no source; forgetting one breaks dev *or* prebuilt builds and you may not notice until CI.

## 7. Pre-submission checklist (Go-specific)

In addition to root `CLAUDE.md`'s checklist:

- `make dev:go` succeeds.
- `cd sdks/go && go test -tags boxlite_dev -race ./...` passes (especially the race tests in §5).
- `gofmt -l .` and `go vet ./...` are clean.
- If the C ABI moved: `sdks/go/boxlite.h` is re-synced from `sdks/c/include/boxlite.h`.
- If release artifacts moved: `cmd/setup/main.go` is updated.
- If a new system framework is needed: both `bridge_cgo_dev.go` and `bridge_cgo_prebuilt.go` have it.

---
Last reviewed against codebase: 2026-05-11. Re-audit when the CGO bridge, release artifact layout, or handle/callback discipline changes meaningfully.
