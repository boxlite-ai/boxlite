# Rust Quick Start

Get up and running with BoxLite Rust crate in 5 minutes.

## Installation

**Requirements:** Rust 1.88 or later

Add BoxLite to your project:

```bash
cargo add boxlite tokio futures --features tokio/macros,tokio/rt-multi-thread
```

## Basic Execution

Create a file `src/main.rs`:

```rust
use boxlite::{BoxliteRuntime, BoxOptions, BoxCommand, RootfsSpec};
use futures::StreamExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Create runtime
    let runtime = BoxliteRuntime::default_runtime();

    // Create box
    let options = BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        ..Default::default()
    };
    let litebox = runtime.create(options, None).await?;

    // Execute command
    let mut execution = litebox
        .exec(BoxCommand::new("echo").arg("Hello from BoxLite!"))
        .await?;

    // Stream stdout
    let mut stdout = execution.stdout().unwrap();
    while let Some(line) = stdout.next().await {
        println!("{}", line);
    }

    Ok(())
}
```

Run it:
```bash
cargo run
```

## From Source (Development)

For contributing or local development:

```bash
# Clone repository
git clone https://github.com/boxlite-ai/boxlite.git
cd boxlite

# Initialize submodules (critical!)
git submodule update --init --recursive

# Install platform dependencies
make setup

# Build
cargo build

# Run tests
cargo test
```

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for detailed build instructions.

## Next Steps

- **[Architecture Documentation](../architecture/README.md)** - Understand how BoxLite works
  - Core components (Runtime, LiteBox, VMM, Portal)
  - Image management and rootfs preparation
  - Host-guest communication protocol
- **[Reference Documentation](../reference/README.md#rust-api)** - Rust API reference
