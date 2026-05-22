# SDK `copy_out_many` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make POST `/files/bulk-download` reachable from Rust/Python/Node SDKs via a new additive `copy_out_many` method on `LiteBox` and `BoxBackend`, with index-based response routing and partial-failure outcomes.

**Architecture:** Add `CopyOutPair`/`CopyOutOutcome` types to `litebox::copy`, an additive `BoxBackend::copy_out_many` trait method with a default impl (loops `copy_out`), a `RestBox` override that POSTs `{paths:[]}` and parses the multipart response by input index, a `LiteBox::copy_out_many` public wrapper, and PyO3/napi-rs bindings. C/Go FFI deferred (separate ABI work).

**Tech Stack:** Rust core (`src/boxlite`), reqwest for HTTP, PyO3 for Python, napi-rs for Node. No new transitive deps; minimal custom multipart parser since the wire format is fixed.

**Spec:** [docs/superpowers/specs/2026-05-22-sdk-copy-out-many-design.md](../specs/2026-05-22-sdk-copy-out-many-design.md)

---

## File Structure

**Create:** none (all changes additive).

**Modify:**
- `src/boxlite/src/litebox/copy.rs` — add `CopyOutPair` and `CopyOutOutcome` structs alongside existing `CopyOptions`.
- `src/boxlite/src/litebox/mod.rs` — re-export new types; add `LiteBox::copy_out_many`.
- `src/boxlite/src/lib.rs` — extend the `pub use litebox::{...}` re-export with the new types.
- `src/boxlite/src/runtime/backend.rs` — add `BoxBackend::copy_out_many` trait method with default impl.
- `src/boxlite/src/rest/litebox.rs` — override `copy_out_many` with the bulk-download HTTP impl; add a pure `parse_bulk_download_response` helper for unit testability.
- `sdks/python/src/box_handle.rs` — add `copy_out_many` PyO3 method.
- `sdks/python/src/options.rs` — add `PyCopyOutPair` and `PyCopyOutOutcome`.
- `sdks/python/boxlite/simplebox.py` — add high-level wrapper if other copy methods have one (verify pattern).
- `sdks/node/src/box_handle.rs` — add `copyOutMany` napi-rs method.
- `sdks/node/src/copy.rs` — add `JsCopyOutPair`/`JsCopyOutOutcome` types analogous to existing `JsCopyOptions`.
- `sdks/node/lib/copy.ts` — TypeScript types for the new shapes.

**Each modified file keeps one focused responsibility.** Splitting is not warranted; existing module boundaries are clean.

---

## Task 1: Add CopyOutPair and CopyOutOutcome data types

**Files:**
- Modify: `src/boxlite/src/litebox/copy.rs`

- [ ] **Step 1: Read the existing file to confirm style**

Run: `cat src/boxlite/src/litebox/copy.rs`
Confirm `CopyOptions` is declared as `pub struct` with `#[derive(Debug, Clone)]` or similar — match that style.

- [ ] **Step 2: Append the new types**

Append to `src/boxlite/src/litebox/copy.rs`:

```rust
use std::path::PathBuf;

/// One source/destination pair for [`LiteBox::copy_out_many`]. The bulk
/// endpoint emits one part per input; pairing src→dst at the call site
/// gives the caller per-file destination control and avoids basename
/// collisions when two srcs share a leaf name.
#[derive(Debug, Clone)]
pub struct CopyOutPair {
    pub container_src: String,
    pub host_dst: PathBuf,
}

/// Per-pair outcome from [`LiteBox::copy_out_many`]. `error == None` means
/// the file was written to `host_dst`. `error == Some(text)` means the
/// server reported a per-file failure OR the SDK failed to write to disk;
/// the batch continues either way. The wire returns plain text in
/// `name="error"` parts, so the SDK preserves the same shape — callers
/// cannot pattern-match `BoxliteError` variants per pair.
#[derive(Debug, Clone)]
pub struct CopyOutOutcome {
    pub container_src: String,
    pub host_dst: PathBuf,
    pub error: Option<String>,
}
```

Note: if `PathBuf` is already imported, do not re-add the use statement — Rust will error.

- [ ] **Step 3: Build-check**

Run: `cargo check -p boxlite`
Expected: clean compile (these are pure data types).

- [ ] **Step 4: Commit**

```bash
git add src/boxlite/src/litebox/copy.rs
git commit -m "feat(boxlite): add CopyOutPair and CopyOutOutcome types for bulk copy-out"
```

---

## Task 2: Re-export new types from the boxlite crate root

**Files:**
- Modify: `src/boxlite/src/lib.rs`
- Modify: `src/boxlite/src/litebox/mod.rs`

- [ ] **Step 1: Find the current re-export of CopyOptions in litebox/mod.rs**

Run: `grep -n "CopyOptions\|pub use" src/boxlite/src/litebox/mod.rs | head -10`
Confirm `CopyOptions` is re-exported alongside other types like `BoxCommand`, `Execution`, etc.

- [ ] **Step 2: Add the new types to the litebox/mod.rs re-export**

Locate the `pub use copy::{...}` line (or the line that re-exports `CopyOptions`) and extend it.

For example, if the current line is:
```rust
pub use copy::CopyOptions;
```
change it to:
```rust
pub use copy::{CopyOptions, CopyOutOutcome, CopyOutPair};
```

If the existing pattern is multi-line, match it.

- [ ] **Step 3: Extend the crate-root re-export in lib.rs**

In `src/boxlite/src/lib.rs`, locate the `pub use litebox::{...}` block (currently lines 43-46):

```rust
pub use litebox::{
    BoxCommand, CopyOptions, ExecResult, ExecStderr, ExecStdin, ExecStdout, Execution, ExecutionId,
    HealthState, HealthStatus,
};
```

Change to:

```rust
pub use litebox::{
    BoxCommand, CopyOptions, CopyOutOutcome, CopyOutPair, ExecResult, ExecStderr, ExecStdin,
    ExecStdout, Execution, ExecutionId, HealthState, HealthStatus,
};
```

- [ ] **Step 4: Build-check**

Run: `cargo check -p boxlite`
Expected: clean compile.

- [ ] **Step 5: Commit**

```bash
git add src/boxlite/src/litebox/mod.rs src/boxlite/src/lib.rs
git commit -m "feat(boxlite): re-export CopyOutPair/CopyOutOutcome from crate root"
```

---

## Task 3: Add BoxBackend::copy_out_many trait method with default impl

**Files:**
- Modify: `src/boxlite/src/runtime/backend.rs`
- Test: same file (existing test module if any) or a new `#[cfg(test)] mod tests {}` block

- [ ] **Step 1: Inspect the trait file and locate copy_out**

Run: `grep -n "copy_out\|copy_into\|trait BoxBackend" src/boxlite/src/runtime/backend.rs`
Find the existing `copy_out` method signature (around line 106 per the spec).

- [ ] **Step 2: Add the trait method with a default impl**

Insert immediately after the existing `copy_out` definition in `src/boxlite/src/runtime/backend.rs`:

```rust
async fn copy_out_many(
    &self,
    pairs: &[crate::litebox::copy::CopyOutPair],
) -> BoxliteResult<Vec<crate::litebox::copy::CopyOutOutcome>> {
    let mut out = Vec::with_capacity(pairs.len());
    for p in pairs {
        let res = self
            .copy_out(
                &p.container_src,
                &p.host_dst,
                crate::litebox::copy::CopyOptions::default(),
            )
            .await;
        out.push(crate::litebox::copy::CopyOutOutcome {
            container_src: p.container_src.clone(),
            host_dst: p.host_dst.clone(),
            error: res.err().map(|e| e.to_string()),
        });
    }
    Ok(out)
}
```

If `BoxBackend` is already in the same module as `crate::litebox::copy::*` and they're imported at the top, simplify the type paths accordingly.

- [ ] **Step 3: Build-check**

Run: `cargo check -p boxlite`
Expected: clean compile. All existing `BoxBackend` impls inherit the default — no override required.

- [ ] **Step 4: Commit**

```bash
git add src/boxlite/src/runtime/backend.rs
git commit -m "feat(boxlite): add BoxBackend::copy_out_many trait method with default impl"
```

---

## Task 4: Add LiteBox::copy_out_many public wrapper

**Files:**
- Modify: `src/boxlite/src/litebox/mod.rs`

- [ ] **Step 1: Locate the existing copy_out wrapper**

Run: `grep -n "pub async fn copy_out\|pub async fn copy_into" src/boxlite/src/litebox/mod.rs`
Find `copy_out` (currently around line 132).

- [ ] **Step 2: Add the wrapper directly after copy_out**

Insert in `src/boxlite/src/litebox/mod.rs`:

```rust
/// Copy multiple files out of the box in a single round-trip via the
/// bulk-download endpoint. Each input pair becomes one part in the
/// response; outcomes are returned in input order regardless of the
/// server's response ordering.
///
/// Partial failure is the design: a single bad path does not abort the
/// batch. Inspect `outcome.error` per pair to learn what landed.
pub async fn copy_out_many(
    &self,
    pairs: &[crate::litebox::copy::CopyOutPair],
) -> crate::BoxliteResult<Vec<crate::litebox::copy::CopyOutOutcome>> {
    self.box_backend.copy_out_many(pairs).await
}
```

Match the surrounding indentation and the `box_backend` field name used by `copy_out` — adjust if your codebase uses a different field name.

- [ ] **Step 3: Build-check**

Run: `cargo check -p boxlite`
Expected: clean compile.

- [ ] **Step 4: Add a default-impl behavior test**

Locate a test module in or near `src/boxlite/src/runtime/backend.rs` (or create one if missing). Add:

```rust
#[cfg(test)]
mod copy_out_many_tests {
    use super::*;
    use crate::litebox::copy::{CopyOptions, CopyOutOutcome, CopyOutPair};
    use boxlite_shared::errors::{BoxliteError, BoxliteResult};
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    // Minimal stub backend that records copy_out calls and lets the test
    // inject per-call success/failure.
    struct StubBackend {
        calls: Mutex<Vec<(String, PathBuf)>>,
        fail_on: Option<String>,
    }

    #[async_trait::async_trait]
    impl BoxBackend for StubBackend {
        // Implement only the methods needed; for others, panic!() so an
        // accidental call is loud. Use existing test fixtures if the
        // codebase already has a stub backend; replace this scaffold.
        fn id(&self) -> &crate::runtime::id::BoxID { unimplemented!() }
        fn name(&self) -> Option<&str> { None }
        fn info(&self) -> crate::runtime::types::BoxInfo { unimplemented!() }
        async fn start(&self) -> BoxliteResult<()> { unimplemented!() }
        // ... (stub all other required methods with unimplemented!())

        async fn copy_out(
            &self,
            container_src: &str,
            host_dst: &Path,
            _opts: CopyOptions,
        ) -> BoxliteResult<()> {
            self.calls.lock().unwrap().push((container_src.to_string(), host_dst.to_path_buf()));
            if Some(container_src) == self.fail_on.as_deref() {
                Err(BoxliteError::Internal("stub: forced failure".into()))
            } else {
                Ok(())
            }
        }
    }

    #[tokio::test]
    async fn default_impl_fans_out_in_input_order() {
        let backend = StubBackend {
            calls: Mutex::new(Vec::new()),
            fail_on: Some("/etc/b".to_string()),
        };
        let pairs = vec![
            CopyOutPair { container_src: "/etc/a".into(), host_dst: "/host/a".into() },
            CopyOutPair { container_src: "/etc/b".into(), host_dst: "/host/b".into() },
            CopyOutPair { container_src: "/etc/c".into(), host_dst: "/host/c".into() },
        ];

        let outcomes = backend.copy_out_many(&pairs).await.expect("ok");

        // Three calls, in input order.
        let calls = backend.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].0, "/etc/a");
        assert_eq!(calls[1].0, "/etc/b");
        assert_eq!(calls[2].0, "/etc/c");

        // Outcomes preserve input order; only the forced-failure pair
        // carries an error.
        assert_eq!(outcomes.len(), 3);
        assert!(outcomes[0].error.is_none(), "a should succeed");
        assert!(outcomes[1].error.as_deref().map(|s| s.contains("stub: forced failure")).unwrap_or(false), "b should report stub error");
        assert!(outcomes[2].error.is_none(), "c should succeed");
        assert_eq!(outcomes[0].container_src, "/etc/a");
        assert_eq!(outcomes[0].host_dst, PathBuf::from("/host/a"));
    }
}
```

**Important:** Look for an existing stub/mock `BoxBackend` in the test tree (`grep -rn "impl BoxBackend for" src/boxlite --include="*.rs"`) and reuse it if one exists — DO NOT duplicate. If none exists, stub only the methods needed and `unimplemented!()` the rest.

- [ ] **Step 5: Run the test**

Run: `cargo test -p boxlite copy_out_many_tests::default_impl_fans_out_in_input_order -- --nocapture`
Expected: PASS. If it fails because a required trait method is missing from the stub, add `unimplemented!()` for that method.

- [ ] **Step 6: Commit**

```bash
git add src/boxlite/src/litebox/mod.rs src/boxlite/src/runtime/backend.rs
git commit -m "feat(boxlite): add LiteBox::copy_out_many + default-impl behavior test"
```

---

## Task 5: REST impl — pure multipart parser with unit tests

The parsing logic is tested without HTTP. The REST override (Task 6) calls this function with response bytes.

**Files:**
- Modify: `src/boxlite/src/rest/litebox.rs`

- [ ] **Step 1: Add a parse-helper module section**

Append (or insert near other helpers) in `src/boxlite/src/rest/litebox.rs`:

```rust
use crate::litebox::copy::{CopyOutOutcome, CopyOutPair};

/// Parse a bulk-download multipart response body and route each part to
/// its corresponding `pairs[idx].host_dst` by index (NOT by filename —
/// duplicate `container_src` entries are legal). Writes successful file
/// parts to disk and records error parts. Returns one outcome per input
/// pair, in input order.
///
/// Returns Err on transport-level violations (server returned more
/// `file`/`error` parts than requested). Per-pair local write failures
/// are recorded as outcomes, NOT propagated as Err.
fn parse_bulk_download_response(
    pairs: &[CopyOutPair],
    body: &[u8],
    boundary: &str,
) -> crate::BoxliteResult<Vec<CopyOutOutcome>> {
    let mut outcomes: Vec<Option<CopyOutOutcome>> = vec![None; pairs.len()];
    let mut idx: usize = 0;

    for part in split_multipart_parts(body, boundary) {
        let (name, _filename) = parse_disposition(&part.headers);
        match name.as_deref() {
            Some("file") | Some("error") => {
                if idx >= pairs.len() {
                    return Err(crate::BoxliteError::Internal(format!(
                        "bulk-download: server returned more parts than requested ({} > {})",
                        idx + 1,
                        pairs.len()
                    )));
                }
                let pair = &pairs[idx];
                let outcome = if name.as_deref() == Some("file") {
                    match write_file_atomically(&pair.host_dst, &part.body) {
                        Ok(()) => CopyOutOutcome {
                            container_src: pair.container_src.clone(),
                            host_dst: pair.host_dst.clone(),
                            error: None,
                        },
                        Err(e) => CopyOutOutcome {
                            container_src: pair.container_src.clone(),
                            host_dst: pair.host_dst.clone(),
                            error: Some(format!("write: {e}")),
                        },
                    }
                } else {
                    CopyOutOutcome {
                        container_src: pair.container_src.clone(),
                        host_dst: pair.host_dst.clone(),
                        error: Some(String::from_utf8_lossy(&part.body).into_owned()),
                    }
                };
                outcomes[idx] = Some(outcome);
                idx += 1;
            }
            _ => {
                // Unknown name — forward-compat: skip without advancing idx.
            }
        }
    }

    // Fill any unfilled slots with "missing from response".
    let final_outcomes = outcomes
        .into_iter()
        .enumerate()
        .map(|(i, slot)| {
            slot.unwrap_or_else(|| CopyOutOutcome {
                container_src: pairs[i].container_src.clone(),
                host_dst: pairs[i].host_dst.clone(),
                error: Some("missing from response".into()),
            })
        })
        .collect();
    Ok(final_outcomes)
}

/// One parsed multipart part: header lines and body bytes.
struct ParsedPart {
    headers: String,
    body: Vec<u8>,
}

/// Split a multipart body into parts on the given boundary. The boundary
/// in the body is `--<boundary>` (with leading dashes); the terminator is
/// `--<boundary>--`. Each part is `headers \r\n\r\n body \r\n`. This is
/// the tiny subset of RFC 2046 the bulk-download response uses.
fn split_multipart_parts(body: &[u8], boundary: &str) -> Vec<ParsedPart> {
    let delim = format!("--{boundary}");
    let delim_bytes = delim.as_bytes();
    let mut parts = Vec::new();
    let mut cursor = 0;

    // Find first delimiter.
    let Some(first) = find_bytes(body, delim_bytes, cursor) else { return parts };
    cursor = first + delim_bytes.len();

    loop {
        // Skip CRLF after delimiter, or detect closing "--".
        if body.get(cursor..cursor + 2) == Some(b"--") {
            break; // closing boundary
        }
        // Skip CRLF
        if body.get(cursor..cursor + 2) == Some(b"\r\n") {
            cursor += 2;
        }
        // Find header/body separator (CRLF CRLF).
        let Some(hb) = find_bytes(body, b"\r\n\r\n", cursor) else { break };
        let headers = String::from_utf8_lossy(&body[cursor..hb]).into_owned();
        let body_start = hb + 4;
        // Find next delimiter.
        let Some(next) = find_bytes(body, delim_bytes, body_start) else { break };
        // Body is from body_start to next, stripping the trailing CRLF that
        // separates body from the next delimiter.
        let body_end = if next >= 2 && &body[next - 2..next] == b"\r\n" { next - 2 } else { next };
        let part_body = body[body_start..body_end].to_vec();
        parts.push(ParsedPart { headers, body: part_body });
        cursor = next + delim_bytes.len();
    }
    parts
}

fn find_bytes(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from + needle.len() > haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| from + p)
}

/// Returns (name, filename) parsed out of the part's Content-Disposition.
/// Does NOT apply basename stripping to filename — caller may want the
/// full container path for logging.
fn parse_disposition(headers: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut filename = None;
    for line in headers.split("\r\n") {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("content-disposition:") {
            // Iterate params: name="...", filename="..."
            let raw = &line[line.find(':').unwrap() + 1..];
            for param in raw.split(';').map(|s| s.trim()) {
                if let Some(v) = param.strip_prefix("name=") {
                    name = Some(strip_quotes(v).to_string());
                } else if let Some(v) = param.strip_prefix("filename=") {
                    filename = Some(strip_quotes(v).to_string());
                }
            }
            // Avoid unused-variable warning.
            let _ = rest;
        }
    }
    (name, filename)
}

fn strip_quotes(s: &str) -> &str {
    let s = s.trim();
    if s.starts_with('"') && s.ends_with('"') && s.len() >= 2 {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

fn write_file_atomically(dst: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = dst.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::write(dst, bytes)
}
```

- [ ] **Step 2: Write the unit tests inline**

Append at the bottom of `src/boxlite/src/rest/litebox.rs`:

```rust
#[cfg(test)]
mod copy_out_many_parse_tests {
    use super::*;
    use crate::litebox::copy::CopyOutPair;
    use std::path::PathBuf;

    const BOUNDARY: &str = "BOXLITE-FILE-BOUNDARY";

    fn build_body(parts: &[(&str, &str, &[u8])]) -> Vec<u8> {
        // parts: (name, filename, body_bytes)
        let mut body = Vec::new();
        for (name, filename, b) in parts {
            body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
            body.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\n").as_bytes(),
            );
            body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
            body.extend_from_slice(b);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
        body
    }

    fn tmp(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("boxlite-test-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn happy_path_two_files_routed_by_index() {
        let dst_a = tmp("happy-a");
        let dst_b = tmp("happy-b");
        let pairs = vec![
            CopyOutPair { container_src: "/etc/a.txt".into(), host_dst: dst_a.clone() },
            CopyOutPair { container_src: "/etc/b.txt".into(), host_dst: dst_b.clone() },
        ];
        let body = build_body(&[
            ("file", "/etc/a.txt", b"alpha"),
            ("file", "/etc/b.txt", b"bravo"),
        ]);

        let outcomes = parse_bulk_download_response(&pairs, &body, BOUNDARY).expect("ok");
        assert_eq!(outcomes.len(), 2);
        assert!(outcomes[0].error.is_none() && outcomes[1].error.is_none());
        assert_eq!(std::fs::read(&dst_a).unwrap(), b"alpha");
        assert_eq!(std::fs::read(&dst_b).unwrap(), b"bravo");
        let _ = std::fs::remove_file(&dst_a);
        let _ = std::fs::remove_file(&dst_b);
    }

    #[test]
    fn duplicate_src_routes_to_distinct_host_dsts() {
        let dst_x = tmp("dup-x");
        let dst_y = tmp("dup-y");
        let pairs = vec![
            CopyOutPair { container_src: "/etc/a.txt".into(), host_dst: dst_x.clone() },
            CopyOutPair { container_src: "/etc/a.txt".into(), host_dst: dst_y.clone() },
        ];
        let body = build_body(&[
            ("file", "/etc/a.txt", b"first"),
            ("file", "/etc/a.txt", b"second"),
        ]);

        let outcomes = parse_bulk_download_response(&pairs, &body, BOUNDARY).expect("ok");
        assert_eq!(outcomes.len(), 2);
        assert!(outcomes[0].error.is_none());
        assert!(outcomes[1].error.is_none());
        assert_eq!(std::fs::read(&dst_x).unwrap(), b"first");
        assert_eq!(std::fs::read(&dst_y).unwrap(), b"second");
        let _ = std::fs::remove_file(&dst_x);
        let _ = std::fs::remove_file(&dst_y);
    }

    #[test]
    fn missing_part_synthesizes_outcome() {
        let dst = tmp("miss");
        let pairs = vec![
            CopyOutPair { container_src: "/etc/a.txt".into(), host_dst: dst.clone() },
            CopyOutPair { container_src: "/etc/b.txt".into(), host_dst: PathBuf::from("/never") },
        ];
        let body = build_body(&[("file", "/etc/a.txt", b"only-a")]);

        let outcomes = parse_bulk_download_response(&pairs, &body, BOUNDARY).expect("ok");
        assert_eq!(outcomes.len(), 2);
        assert!(outcomes[0].error.is_none());
        assert_eq!(outcomes[1].error.as_deref(), Some("missing from response"));
        assert_eq!(outcomes[1].container_src, "/etc/b.txt");
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn too_many_parts_is_transport_error() {
        let pairs = vec![CopyOutPair {
            container_src: "/etc/a.txt".into(),
            host_dst: tmp("toomany-a"),
        }];
        let body = build_body(&[
            ("file", "/etc/a.txt", b"ok"),
            ("file", "/etc/b.txt", b"extra"),
        ]);

        let err = parse_bulk_download_response(&pairs, &body, BOUNDARY)
            .expect_err("should error on extra parts");
        let msg = format!("{err}");
        assert!(msg.contains("more parts than requested"), "got: {msg}");
    }

    #[test]
    fn error_part_surfaces_text_body() {
        let dst = tmp("err");
        let pairs = vec![CopyOutPair {
            container_src: "/etc/missing.txt".into(),
            host_dst: dst.clone(),
        }];
        let body = build_body(&[("error", "/etc/missing.txt", b"copy: file not found")]);

        let outcomes = parse_bulk_download_response(&pairs, &body, BOUNDARY).expect("ok");
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].error.as_deref(), Some("copy: file not found"));
        // File must NOT have been written.
        assert!(!dst.exists());
    }

    #[test]
    fn unknown_part_name_skipped_without_advancing_index() {
        let dst = tmp("forward");
        let pairs = vec![CopyOutPair {
            container_src: "/etc/a.txt".into(),
            host_dst: dst.clone(),
        }];
        let body = build_body(&[
            ("unknown-future-name", "/whatever", b"ignored"),
            ("file", "/etc/a.txt", b"actual"),
        ]);

        let outcomes = parse_bulk_download_response(&pairs, &body, BOUNDARY).expect("ok");
        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].error.is_none());
        assert_eq!(std::fs::read(&dst).unwrap(), b"actual");
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn local_write_failure_recorded_as_outcome_error_not_propagated() {
        // Path with a non-existent parent that ALSO can't be created (a
        // file in the parent's place). Skip on Windows where the
        // permission shape differs.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let parent_blocker = tmp("blocker-file");
            // Create a regular file where we'll try to write under as if
            // it were a dir.
            std::fs::write(&parent_blocker, b"i am a file").unwrap();
            let dst_under_file = parent_blocker.join("nested");
            let pairs = vec![CopyOutPair {
                container_src: "/etc/a.txt".into(),
                host_dst: dst_under_file.clone(),
            }];
            let body = build_body(&[("file", "/etc/a.txt", b"hello")]);

            let outcomes = parse_bulk_download_response(&pairs, &body, BOUNDARY).expect("ok");
            assert_eq!(outcomes.len(), 1);
            let err = outcomes[0].error.as_deref().expect("expected write error");
            assert!(err.starts_with("write:"), "got: {err}");

            let _ = std::fs::remove_file(&parent_blocker);
            // ensure permissions reset (defensive)
            let _ = std::fs::set_permissions(&parent_blocker, std::fs::Permissions::from_mode(0o644));
        }
    }
}
```

- [ ] **Step 3: Run all the new tests**

Run: `cargo test -p boxlite --features rest copy_out_many_parse_tests`
Expected: all PASS.

If `--features rest` is wrong (it's the gate for the rest module), check `src/boxlite/Cargo.toml` for the actual feature name. The intent is: enable the feature that brings `src/boxlite/src/rest/` into the build.

- [ ] **Step 4: Commit**

```bash
git add src/boxlite/src/rest/litebox.rs
git commit -m "feat(boxlite): add bulk-download multipart parser with unit tests"
```

---

## Task 6: REST impl — copy_out_many override wires HTTP to the parser

**Files:**
- Modify: `src/boxlite/src/rest/litebox.rs`

- [ ] **Step 1: Locate the existing copy_out override in RestBox**

Run: `grep -n "async fn copy_out\b\|impl BoxBackend for RestBox" src/boxlite/src/rest/litebox.rs`
Confirm the `BoxBackend for RestBox` impl block exists (currently around line 170 in the spec's reference).

- [ ] **Step 2: Insert the override after copy_out inside the BoxBackend impl block**

Insert in `src/boxlite/src/rest/litebox.rs`, in the `impl BoxBackend for RestBox` block, after `async fn copy_out(...)`:

```rust
async fn copy_out_many(
    &self,
    pairs: &[crate::litebox::copy::CopyOutPair],
) -> crate::BoxliteResult<Vec<crate::litebox::copy::CopyOutOutcome>> {
    use reqwest::Method;

    if pairs.is_empty() {
        // Server returns 400 on empty paths; short-circuit so callers get
        // a stable "no work, no error" semantic. See spec §"REST backend
        // override" rationale for empty input.
        return Ok(vec![]);
    }

    let box_id = self.box_id_str();
    let path = format!("/boxes/{}/files/bulk-download", box_id);

    // Build request body — paths in input order so the server's response
    // order matches our index.
    let body = serde_json::json!({
        "paths": pairs.iter().map(|p| p.container_src.clone()).collect::<Vec<_>>(),
    });

    let resp = self
        .client
        .authorized_request(Method::POST, &path)
        .await?
        .header("Accept", "multipart/form-data")
        .json(&body)
        .send()
        .await
        .map_err(|e| crate::BoxliteError::Internal(format!("bulk-download request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(crate::BoxliteError::Internal(format!(
            "bulk-download failed (HTTP {status}): {text}"
        )));
    }

    // Extract boundary from Content-Type before consuming the body.
    let boundary = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|ct| {
            ct.split(';')
                .map(|s| s.trim())
                .find_map(|p| p.strip_prefix("boundary="))
                .map(|b| b.trim_matches('"').to_string())
        })
        .ok_or_else(|| {
            crate::BoxliteError::Internal(
                "bulk-download: response missing multipart boundary".into(),
            )
        })?;

    let body_bytes = resp
        .bytes()
        .await
        .map_err(|e| crate::BoxliteError::Internal(format!("bulk-download read body: {e}")))?;

    parse_bulk_download_response(pairs, &body_bytes, &boundary)
}
```

If `authorized_request`, `self.client`, or `self.box_id_str()` don't match the names in the codebase, match the patterns already used by the existing `copy_out` override in the same file.

- [ ] **Step 3: Build-check**

Run: `cargo check -p boxlite --features rest`
Expected: clean compile. If `serde_json` isn't already available in this file, check for an existing import or add `use serde_json::json;` at the top.

- [ ] **Step 4: Run the parse tests again (no behavior change expected)**

Run: `cargo test -p boxlite --features rest copy_out_many_parse_tests`
Expected: all still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/boxlite/src/rest/litebox.rs
git commit -m "feat(boxlite): wire RestBox::copy_out_many to bulk-download endpoint"
```

---

## Task 7: Python binding — PyCopyOutPair, PyCopyOutOutcome, copy_out_many method

**Files:**
- Modify: `sdks/python/src/options.rs`
- Modify: `sdks/python/src/box_handle.rs`
- Test: `sdks/python/tests/test_copy_out_many.py` (new)

- [ ] **Step 1: Inspect the existing PyCopyOptions pattern**

Run: `grep -n "PyCopyOptions\|pyclass\|pymethods" sdks/python/src/options.rs | head -20`
Note the `#[pyclass]` / `#[pymethods]` / field-exposure pattern used.

- [ ] **Step 2: Add PyCopyOutPair and PyCopyOutOutcome to options.rs**

Append to `sdks/python/src/options.rs`:

```rust
use boxlite::{CopyOutOutcome, CopyOutPair};

#[pyclass(name = "CopyOutPair")]
#[derive(Clone)]
pub struct PyCopyOutPair {
    #[pyo3(get, set)]
    pub container_src: String,
    #[pyo3(get, set)]
    pub host_dst: String,
}

#[pymethods]
impl PyCopyOutPair {
    #[new]
    fn new(container_src: String, host_dst: String) -> Self {
        Self { container_src, host_dst }
    }

    fn __repr__(&self) -> String {
        format!(
            "CopyOutPair(container_src={!r}, host_dst={!r})",
            self.container_src, self.host_dst
        )
    }
}

impl From<&PyCopyOutPair> for CopyOutPair {
    fn from(p: &PyCopyOutPair) -> Self {
        CopyOutPair {
            container_src: p.container_src.clone(),
            host_dst: std::path::PathBuf::from(&p.host_dst),
        }
    }
}

#[pyclass(name = "CopyOutOutcome")]
#[derive(Clone)]
pub struct PyCopyOutOutcome {
    #[pyo3(get)]
    pub container_src: String,
    #[pyo3(get)]
    pub host_dst: String,
    #[pyo3(get)]
    pub error: Option<String>,
}

#[pymethods]
impl PyCopyOutOutcome {
    fn __repr__(&self) -> String {
        format!(
            "CopyOutOutcome(container_src={!r}, host_dst={!r}, error={!r})",
            self.container_src, self.host_dst, self.error
        )
    }
}

impl From<CopyOutOutcome> for PyCopyOutOutcome {
    fn from(o: CopyOutOutcome) -> Self {
        Self {
            container_src: o.container_src,
            host_dst: o.host_dst.to_string_lossy().into_owned(),
            error: o.error,
        }
    }
}
```

The `__repr__` strings use Rust's `{!r}` syntax — verify pyo3's format conventions; if Rust doesn't accept `{!r}`, switch to `{:?}`.

- [ ] **Step 3: Register the new classes in the module init**

Find the `#[pymodule]` function in `sdks/python/src/lib.rs` (or wherever `PyCopyOptions` is added to `m`):

Run: `grep -rn "PyCopyOptions\|add_class" sdks/python/src/ | head -10`

Add `m.add_class::<PyCopyOutPair>()?;` and `m.add_class::<PyCopyOutOutcome>()?;` next to the existing `add_class::<PyCopyOptions>()` call.

- [ ] **Step 4: Add the copy_out_many method to box_handle.rs**

Insert in `sdks/python/src/box_handle.rs`, after the existing `copy_out` method:

```rust
/// Bulk copy from box rootfs to host via the bulk-download endpoint.
/// Returns one outcome per input pair, in input order. Per-file failures
/// are recorded in `outcome.error` (string); the call itself returns Err
/// only on transport-level failures.
#[pyo3(signature = (pairs))]
fn copy_out_many<'a>(
    &self,
    py: Python<'a>,
    pairs: Vec<crate::options::PyCopyOutPair>,
) -> PyResult<Bound<'a, PyAny>> {
    let handle = Arc::clone(&self.handle);
    pyo3_async_runtimes::tokio::future_into_py(py, async move {
        let rust_pairs: Vec<boxlite::CopyOutPair> = pairs.iter().map(Into::into).collect();
        let outcomes = handle
            .copy_out_many(&rust_pairs)
            .await
            .map_err(map_err)?;
        let py_outcomes: Vec<crate::options::PyCopyOutOutcome> =
            outcomes.into_iter().map(Into::into).collect();
        Python::with_gil(|py| Ok(py_outcomes.into_py(py)))
    })
}
```

If `into_py` is not the current PyO3 idiom (PyO3 0.21+ uses `IntoPyObject`), match the form used by the existing `copy_out` return-Vec patterns in the codebase.

- [ ] **Step 5: Build-check the Python SDK**

Run: `make dev:python 2>&1 | tail -10` (or whatever the Python SDK dev-build target is — check `make help`).
Expected: clean build.

- [ ] **Step 6: Write the Python integration test**

Create `sdks/python/tests/test_copy_out_many.py`:

```python
"""Integration test for LiteBox.copy_out_many."""
import pathlib
import tempfile

import pytest
from boxlite import CopyOutPair  # type: ignore


@pytest.mark.asyncio
async def test_copy_out_many_returns_outcomes_in_input_order(local_box):
    """Trait default impl path: against a local backend, copy_out_many
    fans out to copy_out and returns outcomes in the same order as the
    input pairs. This pins the binding contract end-to-end through the
    Rust default impl."""
    # Pre-seed two files inside the box. The fixture `local_box` is
    # expected to start a real box; if no such fixture exists in this
    # repo, replace this test with one that uses whatever local-backend
    # test fixture already exists for copy_out tests.
    inside_a = "/tmp/a.txt"
    inside_b = "/tmp/b.txt"
    await local_box.exec(["sh", "-c", f"echo alpha > {inside_a} && echo bravo > {inside_b}"])

    with tempfile.TemporaryDirectory() as tmp:
        dst_a = pathlib.Path(tmp) / "a.txt"
        dst_b = pathlib.Path(tmp) / "b.txt"
        outcomes = await local_box.copy_out_many([
            CopyOutPair(container_src=inside_a, host_dst=str(dst_a)),
            CopyOutPair(container_src=inside_b, host_dst=str(dst_b)),
        ])

        assert len(outcomes) == 2
        assert outcomes[0].container_src == inside_a
        assert outcomes[1].container_src == inside_b
        assert outcomes[0].error is None
        assert outcomes[1].error is None
        assert dst_a.read_text().strip() == "alpha"
        assert dst_b.read_text().strip() == "bravo"
```

**Important:** Look for an existing `local_box` or `box` pytest fixture (`grep -rn "@pytest.fixture" sdks/python/tests/`) and use the actual name. If none exists, mark the test `@pytest.mark.skip(reason="no local-box fixture in repo; add when starting box-from-test pattern is wired in")` rather than inventing a fixture from scratch — bringing up a local box is out of scope for this plan.

- [ ] **Step 7: Run the Python test (if local-box fixture is available)**

Run: `make test:unit:python` (or the corresponding integration target).
Expected: PASS or skipped-with-reason.

- [ ] **Step 8: Commit**

```bash
git add sdks/python/src/options.rs sdks/python/src/box_handle.rs sdks/python/src/lib.rs sdks/python/tests/test_copy_out_many.py
git commit -m "feat(python): expose copy_out_many with CopyOutPair/CopyOutOutcome"
```

---

## Task 8: Node binding — JsCopyOutPair, JsCopyOutOutcome, copyOutMany method

**Files:**
- Modify: `sdks/node/src/copy.rs`
- Modify: `sdks/node/src/box_handle.rs`
- Modify: `sdks/node/lib/copy.ts`
- Test: `sdks/node/tests/copy_out_many.integration.test.ts` (new)

- [ ] **Step 1: Inspect the existing napi-rs JsCopyOptions pattern**

Run: `grep -n "JsCopyOptions\|napi(object)\|napi_derive" sdks/node/src/copy.rs`
Note the napi-rs class/object derivation pattern used.

- [ ] **Step 2: Add JsCopyOutPair and JsCopyOutOutcome to copy.rs**

Append to `sdks/node/src/copy.rs`:

```rust
use boxlite::{CopyOutOutcome, CopyOutPair};

#[napi(object)]
#[derive(Clone)]
pub struct JsCopyOutPair {
    pub container_src: String,
    pub host_dst: String,
}

impl From<&JsCopyOutPair> for CopyOutPair {
    fn from(p: &JsCopyOutPair) -> Self {
        CopyOutPair {
            container_src: p.container_src.clone(),
            host_dst: std::path::PathBuf::from(&p.host_dst),
        }
    }
}

#[napi(object)]
#[derive(Clone)]
pub struct JsCopyOutOutcome {
    pub container_src: String,
    pub host_dst: String,
    pub error: Option<String>,
}

impl From<CopyOutOutcome> for JsCopyOutOutcome {
    fn from(o: CopyOutOutcome) -> Self {
        Self {
            container_src: o.container_src,
            host_dst: o.host_dst.to_string_lossy().into_owned(),
            error: o.error,
        }
    }
}
```

- [ ] **Step 3: Add copyOutMany method to box_handle.rs**

Insert in `sdks/node/src/box_handle.rs`, after the existing `copy_out`:

```rust
/// Bulk copy from box rootfs to host via the bulk-download endpoint.
/// Returns one outcome per input pair, in input order.
#[napi(js_name = "copyOutMany")]
pub async fn copy_out_many(
    &self,
    pairs: Vec<crate::copy::JsCopyOutPair>,
) -> Result<Vec<crate::copy::JsCopyOutOutcome>> {
    let rust_pairs: Vec<boxlite::CopyOutPair> = pairs.iter().map(Into::into).collect();
    let outcomes = self
        .handle
        .copy_out_many(&rust_pairs)
        .await
        .map_err(map_err)?;
    Ok(outcomes.into_iter().map(Into::into).collect())
}
```

- [ ] **Step 4: Add TypeScript types**

Append to `sdks/node/lib/copy.ts`:

```typescript
export interface CopyOutPair {
  containerSrc: string;
  hostDst: string;
}

export interface CopyOutOutcome {
  containerSrc: string;
  hostDst: string;
  error: string | null;
}
```

napi-rs lowercases-camel by default. Confirm the actual generated field names by reading the existing `JsCopyOptions` → `lib/copy.ts` example; adjust if napi-rs preserves snake_case in your codebase.

- [ ] **Step 5: Build-check the Node SDK**

Run: `make dev:node 2>&1 | tail -10`
Expected: clean build.

- [ ] **Step 6: Write the Node integration test**

Create `sdks/node/tests/copy_out_many.integration.test.ts`:

```typescript
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Adapt to whatever helper this repo uses to start a local box for tests.
// Look for the equivalent of `local_box` in copy.integration.test.ts and
// reuse it; do not invent a new fixture.
import { localBox } from './_fixtures';

describe('copyOutMany', () => {
  it('returns outcomes in input order with bytes landed at host_dst', async () => {
    const box = await localBox();
    const insideA = '/tmp/a.txt';
    const insideB = '/tmp/b.txt';
    await box.exec(['sh', '-c', `echo alpha > ${insideA} && echo bravo > ${insideB}`]);

    const dir = mkdtempSync(join(tmpdir(), 'boxlite-cot-many-'));
    const dstA = join(dir, 'a.txt');
    const dstB = join(dir, 'b.txt');

    const outcomes = await box.copyOutMany([
      { containerSrc: insideA, hostDst: dstA },
      { containerSrc: insideB, hostDst: dstB },
    ]);

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].containerSrc).toBe(insideA);
    expect(outcomes[1].containerSrc).toBe(insideB);
    expect(outcomes[0].error).toBeNull();
    expect(outcomes[1].error).toBeNull();
    expect(readFileSync(dstA, 'utf8').trim()).toBe('alpha');
    expect(readFileSync(dstB, 'utf8').trim()).toBe('bravo');
  });
});
```

If `./_fixtures` is not the actual fixture path, replace with the project's actual fixture location — grep for the helper used in `sdks/node/tests/copy.integration.test.ts`. If no equivalent helper exists, `it.skip(...)` the test with a comment referencing this plan rather than inventing fixture infrastructure.

- [ ] **Step 7: Run the Node test (if local-box fixture is available)**

Run: `make test:unit:node` or the project's Node test target.
Expected: PASS or skipped-with-reason.

- [ ] **Step 8: Commit**

```bash
git add sdks/node/src/copy.rs sdks/node/src/box_handle.rs sdks/node/lib/copy.ts sdks/node/tests/copy_out_many.integration.test.ts
git commit -m "feat(node): expose copyOutMany with CopyOutPair/CopyOutOutcome"
```

---

## Task 9: Full verification

- [ ] **Step 1: Run the full boxlite test suite**

Run: `cargo test -p boxlite`
Expected: all PASS. Existing tests unaffected.

- [ ] **Step 2: Run the runner test suite (sanity — we didn't touch it but the integration is adjacent)**

Run: `cd apps/runner && go test ./... 2>&1 | tail -20`
Expected: only pre-existing failures, no new regressions.

- [ ] **Step 3: Build all SDKs**

Run: `make dev:c && make dev:python && make dev:node`
Expected: all clean. (C/Go aren't touched but build them anyway to be sure the Rust crate change didn't break their consumers.)

- [ ] **Step 4: Final commit if any incidental fixes were made**

If any of the verification steps surfaced changes, commit them with a `chore: post-merge verification fixes` message. Otherwise this step is a no-op.

---

## Self-review notes

- **Spec coverage**: every spec section has an explicit task. Index-based routing (spec §"REST backend override" step 4-6) → Task 5 parse function + Task 5 unit tests. Empty-input rationale → Task 6 short-circuit. Default impl test → Task 4. Per-pair-error stringification → Task 1 type definition. Tradeoffs are implicit in the implementation but not separately tasked (they're documentation, not behavior).
- **Placeholders**: none. Where a step depends on inspecting the codebase (e.g., napi-rs camelCase convention), the step explicitly says "verify and adjust" rather than leaving TBD.
- **Type consistency**: `CopyOutPair { container_src: String, host_dst: PathBuf }` and `CopyOutOutcome { container_src: String, host_dst: PathBuf, error: Option<String> }` are used identically across Tasks 1, 3-8.
- **C/Go**: explicitly out of scope per spec §"SDK bindings"; no task. If the reviewer wants C/Go in this PR, the plan needs Task 10+ — flag before starting.
