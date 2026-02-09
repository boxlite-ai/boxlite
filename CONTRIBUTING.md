# Contributing to BoxLite

Thank you for your interest in contributing to BoxLite!

## Getting Started

### Prerequisites

- Rust 1.75+ (stable)
- macOS (Apple Silicon) or Linux (x86_64/ARM64) with KVM
- Python 3.10+ (for Python SDK development)

### Building from Source

```bash
# Clone the repository
git clone https://github.com/boxlite-labs/boxlite.git
cd boxlite

# Initialize submodules
git submodule update --init --recursive

# Build
make setup
make dev:python
```

For detailed build instructions, see [docs/guides](./docs/guides/README.md#building-from-source).

### Running Tests

```bash
cargo test
```

## How to Contribute

### Reporting Issues

- Use [GitHub Issues](https://github.com/boxlite-labs/boxlite/issues)
- Include OS, architecture, and BoxLite version
- Provide minimal reproduction steps

### Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run tests and formatting (`cargo test && cargo fmt`)
5. Commit with clear messages
6. Open a Pull Request

### Code Style

Follow the [Rust Style Guide](./docs/development/rust-style.md) which includes:
- [Microsoft Rust Guidelines](https://microsoft.github.io/rust-guidelines)
- BoxLite-specific patterns (async-first, centralized errors, thread-safe types)

**Quick reference:**
- `cargo fmt` for formatting (enforced in CI)
- `cargo clippy` for linting
- Keep functions focused (single responsibility)
- Add tests for new functionality
- Update documentation as needed

## Project Structure

```
boxlite/          # Core runtime (Rust)
boxlite-cli/      # CLI
guest/            # Guest agent (runs inside VM)
sdks/
  python/         # Python SDK
  c/              # C SDK
examples/         # Example code
```

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
