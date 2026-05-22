# SDK `copy_out_many`: reaching POST /files/bulk-download

**Date:** 2026-05-22
**Branch:** feat/bulk-upload-files
**Status:** Design — pending user approval

## Problem

POST `/files/bulk-download` is shipped on three servers (runner, serve, daemon) and in the public OpenAPI spec, but no SDK can call it. The `BoxBackend::copy_out` trait method is single-`container_src` / single-`host_dst`, and the runner has no list endpoint that would let the SDK enumerate box-side paths and fan out symmetrically with `copy_into(dir)`. The asymmetry is documented in-line at `src/boxlite/src/rest/litebox.rs:373-378` but not fixed. Result: the only callers of bulk-download are HTTP clients that bypass the SDK entirely.

## Goal

Make POST `/files/bulk-download` reachable from SDKs without breaking the existing `copy_out` surface or wire contract.

## Non-goals

- **No `copy_in_many`.** `copy_into(dir)` already reaches bulk-upload by walking the host fs; there's no analogous gap to close.
- **No new bulk-download wire options** (e.g. `follow_symlinks`). The runner endpoint accepts only `{paths: [...]}` today; extending the wire and the SDK in lockstep is a separate change if needed.
- **No retry, parallelism, or chunking inside the SDK.** Caller decides.
- **No atomicity.** The wire allows partial failure (one `name="error"` part per failure, batch continues). The SDK surface mirrors this.

## Design

### Trait surface (additive)

`BoxBackend` is `pub(crate)` (`src/boxlite/src/runtime/backend.rs:70`) — adding a method here is an internal-surface change. The new **public** symbol is `LiteBox::copy_out_many` (see "LiteBox wrapper" below); this section describes the internal trait change that the public wrapper delegates through.

Add to `BoxBackend` in `src/boxlite/src/runtime/backend.rs`:

```rust
async fn copy_out_many(
    &self,
    pairs: &[CopyOutPair],
) -> BoxliteResult<Vec<CopyOutOutcome>> {
    // Default impl fans out to copy_out so non-REST backends Just Work.
    let mut out = Vec::with_capacity(pairs.len());
    for p in pairs {
        let res = self
            .copy_out(&p.container_src, &p.host_dst, CopyOptions::default())
            .await;
        out.push(CopyOutOutcome {
            container_src: p.container_src.clone(),
            host_dst: p.host_dst.clone(),
            error: res.err().map(|e| e.to_string()),
        });
    }
    Ok(out)
}
```

Types in `src/boxlite/src/litebox/copy.rs` alongside `CopyOptions`:

```rust
pub struct CopyOutPair {
    pub container_src: String,
    pub host_dst: PathBuf,
}

pub struct CopyOutOutcome {
    pub container_src: String,
    pub host_dst: PathBuf,
    pub error: Option<String>,
}
```

`CopyOutPair` is the input contract; `CopyOutOutcome` is the per-pair result. Outcome carries the resolved `host_dst` so the caller doesn't have to thread the input back through.

### REST backend override

`RestBox` in `src/boxlite/src/rest/litebox.rs` overrides the default with one POST and parses the multipart response. **Routing is index-based, not filename-based**, because the server emits parts in request-order (verified at `src/cli/src/commands/serve/handlers/files.rs:360-372`) and the input `pairs` may contain duplicate `container_src` entries with different `host_dst`s — a filename→host_dst map would silently clobber the duplicates.

1. Empty `pairs` → return `Ok(vec![])` without touching the network. Rationale: the server returns 400 `InvalidArgumentError` on empty `paths` (`src/cli/src/commands/serve/handlers/files.rs:335-341`); short-circuiting on the client side gives callers a stable "no work, no error" semantic rather than surfacing the 400 as `BoxliteError::Internal`. Future refactors that remove the short-circuit must extend the wire instead.
2. Build JSON body `{"paths": [pair.container_src for pair in pairs]}` in input order.
3. POST to `/boxes/{box_id}/files/bulk-download` with `Accept: multipart/form-data`. Non-2xx → propagate as `BoxliteError::Internal` (transport-level failure, distinct from per-pair errors).
4. Pre-allocate `let mut outcomes: Vec<Option<CopyOutOutcome>> = vec![None; pairs.len()]` and a cursor `let mut idx = 0`.
5. Parse multipart parts in order. For each part:
   - If `name == "file"` or `name == "error"`:
     - If `idx >= pairs.len()`: server returned more parts than requested — transport-level violation; abort with `BoxliteError::Internal`.
     - `name == "file"`: create parent dirs of `pairs[idx].host_dst` if needed, stream part body to that dst, record `Some(CopyOutOutcome { error: None, .. })` at `outcomes[idx]`. A local write failure here records `error: Some("write: ...")` so the batch continues.
     - `name == "error"`: read part body as error text, record `Some(CopyOutOutcome { error: Some(text), .. })` at `outcomes[idx]`.
     - Increment `idx`.
   - Else (unknown `name`): skip without advancing `idx` (forward-compat: tolerate future part types without breaking ordering).
6. After streaming completes, fold `outcomes` into `Vec<CopyOutOutcome>`: any remaining `None` slot becomes `CopyOutOutcome { error: Some("missing from response"), .. }` populated from the corresponding `pairs[i]`. **Guarantee: `outcomes[i]` corresponds to `pairs[i]` regardless of server response shape.**

Parse `Content-Disposition` with a parser that preserves the raw `filename` parameter (do NOT use any API that runs `basename`/`filepath.Base` on the value — that already caused a test-side bug in the Go runner earlier on this branch). The parsed `filename` is informational (we may log it on index-mismatch) but NOT used for routing — that's purely index-based.

### LiteBox wrapper

Mirror the existing `pub async fn copy_out` shape on `LiteBox` in `src/boxlite/src/litebox/mod.rs`:

```rust
pub async fn copy_out_many(
    &self,
    pairs: &[CopyOutPair],
) -> BoxliteResult<Vec<CopyOutOutcome>> {
    self.box_backend.copy_out_many(pairs).await
}
```

### SDK bindings

| SDK | Status | Work |
|------|--------|------|
| Rust | included | trait + REST + Local default |
| Python (PyO3) | included | one wrapper exposing `box.copy_out_many([(src, dst), ...])` → `list[CopyOutOutcome]` |
| Node (napi-rs) | included | analogous wrapper |
| C | **deferred** | new FFI symbol `boxlite_copy_out_many` with struct-array argument + outcome buffer needs its own ABI design |
| Go | **deferred** | inherits from C |

Deferring C/Go is explicit. The existing C FFI for copy is fixed-shape with no options/array argument, so adding `copy_out_many` is not a wrap-and-ship — it requires designing a `CCopyOutPair[]` struct shape, lifetime rules for the outcome buffer, and the corresponding cgo wrapper. That's a separate change; this one keeps the C/Go gap exactly as wide as it is today rather than blocking on a larger FFI redesign.

## Error handling

Four categories, all distinct:

1. **Transport / protocol failure** (network down, non-2xx, malformed multipart, server returned MORE parts than requested): returned as `Err(BoxliteError::Internal(...))`. The whole call failed; no outcomes are returned.
2. **Per-pair server failure** (path missing in box, CopyOut failed inside the server): server emits `name="error"` part with text body; surfaced as `CopyOutOutcome { error: Some(text), .. }`. Overall `Result` stays `Ok`.
3. **Per-pair local write failure** (cannot create `host_dst` parent dir, cannot write file): batch continues; surfaced as `CopyOutOutcome { error: Some("write: ..."), .. }`.
4. **Missing-from-response** (server returned FEWER parts than requested, or skipped one): the corresponding `outcomes[i]` slot is filled with `CopyOutOutcome { error: Some("missing from response"), .. }` at the fold step. This is technically a wire-contract violation but the SDK tolerates it rather than failing the whole batch.

## Testing

- **Trait default impl test** (local backend): `copy_out_many(pairs)` calls underlying `copy_out` N times in input order; mock backend records calls and confirms `outcomes[i] ↔ pairs[i]` ordering.
- **REST impl wire test**: spin up an `httpmock`-style server that returns a known multipart body (one success, one error part); assert outcomes map back to the correct host_dst by index.
- **REST impl duplicate-src test**: `pairs = [(/etc/a, /host/x), (/etc/a, /host/y)]` — both parts must land at distinct host_dsts. This is the test that fails if anyone replaces index-based routing with a filename map.
- **REST impl empty-input test**: `copy_out_many(&[])` returns `Ok(vec![])` and makes zero HTTP requests.
- **REST impl missing-part test**: server returns fewer parts than requested → unfilled slots become synthetic "missing from response" outcomes at the right indices.
- **REST impl too-many-parts test**: server returns more parts than requested → call fails with `BoxliteError::Internal`.
- **REST impl local-write-failure test**: pair where `host_dst` parent is unwritable → outcome carries `error: Some("write: ...")`, batch continues for other pairs.
- **Python binding round-trip**: integration test that constructs pairs in Python, runs the call against the local backend, asserts outcomes shape.
- **Node binding round-trip**: same shape as Python.

## Tradeoffs

- **Default impl in the trait** means local backend works for free. Cost: a backend that wants atomic batch semantics can't express them without overriding; that's acceptable because nothing on the wire offers atomicity either.
- **`Vec<Outcome>` instead of `Result<()>`** forces callers to inspect errors instead of bubbling with `?`. Correct for partial-failure semantics, slightly less ergonomic.
- **Deferring C/Go** leaves two SDKs without bulk surface; gap stays the same width as today.
- **No `CopyOptions` parameter, by wire constraint.** The bulk-download endpoint accepts only `{paths: [...]}`; the serve handler forces `CopyOptions::default()` server-side (`src/cli/src/commands/serve/handlers/files.rs:363`). This means a caller migrating `N × copy_out(path, dst, opts.follow_symlinks(true))` to one `copy_out_many` call **silently loses `follow_symlinks` and any other non-default option**. We document this rather than accept a footgun where the SDK pretends to forward options it can't. Extending the wire to carry per-pair options + bumping the SDK signature is the path forward when a concrete consumer needs it.
- **Per-pair error is `Option<String>`, not a structured enum.** The wire genuinely returns plain text in `name="error"` parts, and the default-impl path stringifies `BoxliteError` for symmetry. Callers cannot pattern-match `NotFound` vs `Internal` on the per-pair error the way they can with `copy_out`. Modeling this as a real enum is possible but adds API surface (and Python/Node bindings have to mirror it); we accept the lossier shape for the first cut and revisit if a consumer needs structured error routing.

## Implementation-time risks

No design choices are unresolved. The following assumptions get verified during implementation; escalate if any turn out wrong:

- The chosen Rust multipart parser streams part bodies to disk without buffering whole files into memory. If it doesn't, large bulk-downloads will OOM and we need a streaming alternative.
- The Rust Content-Disposition parser preserves the raw `filename` parameter without basename-stripping. (See §"REST backend override" footnote.)
