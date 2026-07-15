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
git clone https://github.com/boxlite-ai/boxlite.git
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
make test
```

Key test entry points:

- `make test` / `make test:all` - full test matrix (unit + integration)
- `make test:unit` - all unit suites
- `make test:integration` - all integration suites
- `make test:all:python` - Python unit + integration suites
- `make test:all:c` - C SDK suite via CMake/CTest

## How to Contribute

### Reporting Issues

- Use [GitHub Issues](https://github.com/boxlite-ai/boxlite/issues)
- Include OS, architecture, and BoxLite version
- Provide minimal reproduction steps
- **Security vulnerabilities:** do not open a public issue. See [SECURITY.md](./SECURITY.md) for the private reporting process.

### Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run quality and tests (`make lint && make fmt:check && make test`)
5. Commit with clear messages — see [Commit & PR messages](#commit--pr-messages)
6. Open a Pull Request
7. Sign the [BoxLite Contributor License Agreement](./docs/legal/CLA.md) when CLA Assistant asks you to do so

### Commit & PR messages

Write for a reviewer skimming in ~30 seconds. Describe the change, not the process that produced it.

**Commits** — [Conventional Commits](https://www.conventionalcommits.org):

- Subject: `type(scope): summary` — imperative, ≤72 chars, no trailing period. Types: `feat` `fix` `docs` `refactor` `test` `chore` `perf` `ci` `build`.
- Body (only when it adds value): the *why* and *what* at a high level; wrap ~72.

**PRs:**

- Title: a Conventional-Commit subject (same rule as above).
- Description: fill in [`.github/pull_request_template.md`](./.github/pull_request_template.md); delete sections that don't apply.

**Never put in a commit or PR** the process that produced the change (conversation / AI / step-by-step narrative), pasted logs or tickets, or secrets.

### Code Style

Follow the [Rust Style Guide](./docs/development/rust-style.md) which includes:

- [Microsoft Rust Guidelines](https://microsoft.github.io/rust-guidelines)
- BoxLite-specific patterns (async-first, centralized errors, thread-safe types)

**Quick reference:**

- `make fmt` / `make fmt:check` for formatting checks
- `make lint` / `make lint:fix` for lint checks and safe autofix
- Keep functions focused (single responsibility)
- Add tests for new functionality
- Update documentation as needed

## Project Structure

```
src/
  boxlite/        # Core runtime (Rust)
  cli/            # CLI
  server/         # Distributed server
  shared/         # Shared types and protocol
  ffi/            # FFI layer for SDKs
  guest/          # Guest agent (runs inside VM)
  test-utils/     # Test utilities
  deps/           # Vendored C sys crates
sdks/
  python/         # Python SDK
  c/              # C SDK
  node/           # Node.js SDK
examples/         # Example code
```

## License

BoxLite is licensed under the Apache License, Version 2.0.

By contributing, you agree that your contributions will be licensed under the Apache License, Version 2.0. Pull requests must satisfy CLA Assistant using the [BoxLite Contributor License Agreement](./docs/legal/CLA.md).
