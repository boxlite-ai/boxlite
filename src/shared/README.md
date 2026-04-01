# boxlite-shared

Shared library containing common types and utilities used by both host-side runtime (`boxlite`) and guest agent (`guest`).

## Purpose

This crate provides truly shared code that is used by **both** sides:
- **Host side** - The BoxLite runtime running on the host machine
- **Guest side** - The agent running inside the VM

**Design principle**: Only include code here if it's genuinely used by both sides. Side-specific code stays in respective crates.

## Contents

### `channel.rs`
Shared channel configuration type:
- `ChannelConfig` - Enum representing TCP, Unix socket, or Vsock channels
- Used by host (to connect) and guest (to listen)
- Constructors: `tcp(port)`, `unix(socket_path)`, `vsock(port)`
- URI parsing: `from_uri()` supports `tcp://...`, `unix://...`, `vsock://...`

### `error.rs`
Common error types:
- `CoreError` - Error enum for shared error handling
- `Result<T>` - Type alias for `std::result::Result<T, CoreError>`

## Future Extensions

This crate can grow to include:
- **Protocol message types** - Shared request/response structures
- **Common utilities** - Path handling, ID generation, etc.
- **Shared configuration types** - Types used by both host and guest
- **Validation logic** - Shared validation rules

## What NOT to include

- **Host-only code** - Channel clients, VM management (stays in `boxlite/`)
- **Guest-only code** - Channel listeners, container execution (stays in `guest/`)
- **Platform-specific abstractions** - Unless truly used by both sides

## Current Status

Currently minimal, containing only common error types. Will grow organically as we identify more truly shared code.
