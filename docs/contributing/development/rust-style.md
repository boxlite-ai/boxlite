# Rust style guide

This guide extends the [Microsoft Rust Guidelines](https://microsoft.github.io/rust-guidelines) with BoxLite-specific patterns.

## External references

- **Microsoft Rust Guidelines**: https://microsoft.github.io/rust-guidelines
- **Rust API Guidelines**: https://rust-lang.github.io/api-guidelines/

## Universal guidelines (must follow)

These guidelines from the Microsoft Rust Guidelines are particularly important for BoxLite:

| Guideline | Summary |
|-----------|---------|
| **M-PANIC-IS-STOP** | Panics terminate the program - they are not exceptions |
| **M-PANIC-ON-BUG** | Panic only on programming errors, never for expected failures |
| **M-CONCISE-NAMES** | Avoid weasel words: "Service", "Manager", "Factory", "Handler" |
| **M-LOG-STRUCTURED** | Use structured logging with meaningful fields |
| **M-DOCUMENTED-MAGIC** | Document all magic numbers and constants |
| **M-PUBLIC-DEBUG** | All public types must implement `Debug` |
| **M-PUBLIC-DISPLAY** | User-facing types should implement `Display` |
| **M-LINT-OVERRIDE-EXPECT** | Use `#[expect]` over `#[allow]` for lint overrides |
| **M-REGULAR-FN** | Prefer regular functions over methods when `self` isn't needed |
| **M-SMALLER-CRATES** | Keep crates focused on a single responsibility |

## Safety guidelines

| Guideline | Summary |
|-----------|---------|
| **M-UNSAFE** | Minimize unsafe code; isolate it in small, well-documented functions |
| **M-UNSAFE-IMPLIES-UB** | Document all undefined behavior conditions in unsafe code |
| **M-UNSOUND** | Never expose unsound APIs; soundness must be guaranteed |

## BoxLite-specific patterns

### Async-first architecture

All I/O operations use async/await with Tokio runtime:

```rust
// ✅ Correct: async I/O
async fn read_config(path: &Path) -> Result<Config> {
    let contents = tokio::fs::read_to_string(path).await?;
    Ok(toml::from_str(&contents)?)
}

// ❌ Wrong: blocking I/O in async context
async fn read_config(path: &Path) -> Result<Config> {
    let contents = std::fs::read_to_string(path)?;  // Blocks!
    Ok(toml::from_str(&contents)?)
}
```

### Centralized error handling

Use the `BoxliteError` enum for all errors (see `boxlite-shared/src/errors.rs`):

```rust
// ✅ Correct: use BoxliteError with context
std::fs::create_dir_all(&socket_dir).map_err(|e| {
    BoxliteError::Storage(format!(
        "Failed to create socket directory {}: {}", socket_dir.display(), e
    ))
})?;

// ❌ Wrong: generic error without context
std::fs::create_dir_all(&dir)?;
```

### Public types must be `Send + Sync`

All public types exposed through the API must be thread-safe:

```rust
// ✅ Correct: Arc for shared ownership across threads
pub struct LiteBox {
    inner: Arc<LiteBoxInner>,
}

// ❌ Wrong: Rc is not Send
pub struct LiteBox {
    inner: Rc<LiteBoxInner>,  // Not thread-safe!
}
```

## Formatting and linting

- **Formatting**: `cargo fmt` (enforced in CI)
- **Linting**: `cargo clippy` (warnings are errors in CI)

Run before committing:

```bash
cargo fmt
cargo clippy --all-targets --all-features
```

## Quick reference

When writing Rust code for BoxLite, ask yourself:

1. **Is this panic necessary?** (M-PANIC-ON-BUG) - Only panic on bugs, use `Result` for errors
2. **Is this name clear?** (M-CONCISE-NAMES) - Avoid "Manager", "Service", "Factory"
3. **Is this unsafe minimized?** (M-UNSAFE) - Isolate and document unsafe code
4. **Does this implement Debug?** (M-PUBLIC-DEBUG) - All public types need it
5. **Is this async?** - All I/O should be async with Tokio
6. **Is the error contextual?** - Use `BoxliteError` with descriptive messages
