# BoxLite Go SDK

Official Go SDK for BoxLite - a lightweight, embeddable virtual machine runtime for secure code execution.

> **Status**: 🛠 Under Development (Phase 1 Completed)

## Features

- [x] **Phase 1: Foundation**
    - [x] Rust Bridge with internal Tokio Runtime
    - [x] CGO binding infrastructure
    - [x] Thread-local error propagation mechanism
- [ ] **Phase 2: Lifecycle Management**
    - [ ] Create Box (Image pulling, Rootfs preparation)
    - [ ] Start / Stop / Restart
    - [ ] List / Get Info
    - [ ] Remove Box
- [ ] **Phase 3: Interaction**
    - [ ] Exec command (Sync)
    - [ ] Streaming I/O (Stdout/Stderr/Stdin)
    - [ ] Reference CLI implementation
- [ ] **Phase 4: Polishing**
    - [ ] Resource Metrics
    - [ ] File Copy (Cp)
    - [ ] CI/CD integration

## Architecture

The Go SDK uses a **Self-contained Embedded Bridge** architecture:
1.  **Rust Core**: The heavy lifting is done by the `boxlite` Rust crate.
2.  **Rust Bridge (`rust/`)**: A C-ABI wrapper around the core, managing its own Tokio runtime.
3.  **Go Binding (`internal/binding/`)**: CGO layer that handles the FFI (Foreign Function Interface) calls.
4.  **Go Client (`pkg/client/`)**: Idiomatic Go API for application developers.

## Development

### Prerequisites

- Rust (latest stable)
- Go (1.21+)
- Make

### Building & Testing

```bash
# Build the Rust bridge and run tests
make test

# Run the example
make run
```

## License

Apache-2.0
