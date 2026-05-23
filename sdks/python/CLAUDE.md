# sdks/python/ — Developer Guide for Claude

This file is an **additive delta** to the root `CLAUDE.md`. It covers pitfalls that only matter when *modifying* the Python SDK, not when using it (see `README.md` for usage and API). Read root rules first.

## 1. Tests must share a single runtime — use the session fixtures

`BoxliteRuntime` takes an exclusive `flock()` on `~/.boxlite`. Only **one** runtime instance can exist per process. If two tests construct fresh runtimes, the second blocks or fails with "resource busy".

- Async tests: depend on `shared_runtime` (session scope) from `tests/conftest.py:17`.
- Sync tests: depend on `shared_sync_runtime` (module scope, wraps the same async runtime via greenlet) from `tests/conftest.py:38`.
- **Never** call `boxlite.Boxlite(...)` or `boxlite.SyncBoxlite(...)` directly inside a test body. If a test seems to need its own runtime, the test is wrong, not the rule.

## 2. Every new `#[pyclass]` must be registered in `lib.rs`

The `#[pymodule]` macro in `src/lib.rs:30` is the single source of truth for what Python sees. There are 30+ classes today and the list is hand-maintained — Rust does **not** error if you forget to add a class.

- Symptom of a missing registration: `AttributeError: module 'boxlite' has no attribute 'PyFoo'` at import time.
- Rule: when you add `PyFoo` in a submodule, also add `m.add_class::<PyFoo>()?` to `lib.rs`. Group it with the related cluster of registrations to keep the list scannable.

## 3. Release the GIL for any operation that crosses into Tokio

Long-running calls (image pulls, container exec, network I/O) must release the GIL so the Python interpreter stays responsive and other Python threads can run.

- Pattern: wrap the Tokio block in `py.allow_threads(|| { ... })` inside the `#[pymethods]` function.
- Quick check: if your `#[pymethods]` function awaits anything or calls into the boxlite runtime, it almost certainly needs `allow_threads`.

## 4. Error mapping is two-layered — generic at the Rust boundary, typed in the Python wrappers

The actual error flow today:

- **Rust → Python (PyO3 boundary)**: every `BoxliteError` goes through `sdks/python/src/util.rs::map_err`, which calls `PyRuntimeError::new_err(err.to_string())`. There is no typed dispatch at the FFI layer — all variants surface as `RuntimeError` with the variant's `Display` text. ~40+ call sites across the binding use this helper.
- **Python layer (`sdks/python/boxlite/errors.py`)**: defines a small hierarchy (`BoxliteError`, `ExecError`, `TimeoutError`, `ParseError`). These are raised by *Python wrapper code* — e.g., a method calls into the binding, inspects the returned `exit_code`/result, and raises `ExecError(...)` itself. The Rust binding does **not** raise these classes.

What this means when modifying the SDK:

- Adding a new `BoxliteError` variant in `src/shared/src/errors.rs` does not by itself create a new Python exception type. The variant will surface as `RuntimeError` with its `Display` text.
- If a failure mode deserves a typed Python exception, raise it from a Python wrapper method (after inspecting structured return data, not by parsing exception strings). Add the class to `sdks/python/boxlite/errors.py` if a new category is needed.
- Building typed dispatch at the Rust boundary (e.g., `pyo3::create_exception!` classes registered in the `#[pymodule]` and selected per `BoxliteError` variant) is a meaningful architectural change. Treat it as a separate design proposal, not a per-variant tweak — and do not assume in tests that typed catchability already exists.

## 5. Builds: use `make dev:python` and `make dist:python`, not raw pip

- Local development: `make dev:python` runs `maturin develop`, which builds an editable in-tree extension. `pip install -e .` will not produce a working build because it skips maturin's compile step.
- Distribution wheels: `make dist:python` invokes `cibuildwheel`. The `before-all` scripts in `pyproject.toml` cache the guest binary and configure sccache. Bypassing them produces wheels that are not portable across machines.
- `pyproject.toml` is the authoritative build config. If something in `Cargo.toml` and `pyproject.toml` disagree, prefer `pyproject.toml`.

## 6. Pre-submission checklist (Python-specific)

In addition to root `CLAUDE.md`'s checklist:

- `make dev:python` succeeds and `pytest -x` passes against the rebuilt extension.
- `ruff format --check sdks/python` and `ruff check sdks/python` are clean.
- Any new `#[pyclass]` is registered in `src/lib.rs`.
- Any new long-running method uses `py.allow_threads`.
- Any new `BoxliteError` variant has a matching Python type and a regression test.

---
Last reviewed against codebase: 2026-05-11. Re-audit when the PyO3 surface, error taxonomy, or build pipeline changes meaningfully.
