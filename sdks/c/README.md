# BoxLite C SDK

C bindings for the BoxLite runtime, providing a stable C API for integrating BoxLite into C/C++ applications.

**C Standard:** C11-compatible compiler (GCC/Clang)

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Overview](#api-overview)
  - [Simple API](#simple-api)
  - [Native API](#native-api)
  - [Error Handling](#error-handling)
- [Complete API Reference](#complete-api-reference)
- [Examples](#examples)
- [Memory Management](#memory-management)
- [Threading & Safety](#threading--safety)
- [Platform Support](#platform-support)
- [Migration Guide](#migration-guide)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)
- [Links](#links)

---

## Overview

The C SDK provides two API styles:

1. **Simple API** (`boxlite_simple_*`) - Convenience layer for common use cases
   - No JSON required
   - Auto-managed runtime
   - Buffered command results
   - Automatic cleanup

2. **Native API** (`boxlite_*`) - Full-featured, flexible interface
   - JSON configuration
   - Streaming output callbacks
   - Fine-grained control
   - Advanced features (volumes, networking, etc.)

Both APIs support:
- ✅ Structured error handling (error codes + messages)
- ✅ OCI container images
- ✅ Hardware-accelerated VMs (KVM/Hypervisor.framework)
- ✅ Command execution with streaming output
- ✅ Box lifecycle management
- ✅ Performance metrics
- ✅ Multi-box management

---

## Features

### Core Features
- **C-compatible FFI bindings** (`cdylib`, `staticlib`)
- **Auto-generated header file** (`include/boxlite.h`)
- **Structured error handling** - Error codes + detailed messages
- **Simple convenience API** - No JSON, auto-cleanup
- **Streaming output support** - Real-time callbacks
- **JSON-based configuration** - Avoid ABI compatibility issues

### Advanced Features
- **Box lifecycle management** - Create, start, stop, restart, remove
- **Persistent boxes** - Cross-process reattachment
- **Performance metrics** - Runtime and per-box statistics
- **Multiple boxes** - Concurrent container management
- **Prefix lookup** - Find boxes by ID prefix

---

## Installation

### Prerequisites

**macOS:**
- Apple Silicon (ARM64) or Intel x86_64
- macOS 11.0+ (Big Sur or later)
- Xcode Command Line Tools

**Linux:**
- x86_64 or ARM64 architecture
- KVM support (check: `kvm-ok` or `lsmod | grep kvm`)
- GCC or Clang

### Building from Source

```bash
# From repository root
git clone https://github.com/boxlite/boxlite.git
cd boxlite

# Initialize submodules (REQUIRED!)
git submodule update --init --recursive

# Build C SDK
cargo build --release -p boxlite-c

# Outputs:
# - target/release/libboxlite.{dylib,so}     (shared library)
# - target/release/libboxlite.a              (static library)
# - sdks/c/include/boxlite.h                 (auto-generated header)
```

### Option 1: Direct Linking (Development)

```bash
# Copy library and header to your project
cp target/release/libboxlite.{dylib,so} /path/to/your/project/lib/
cp sdks/c/include/boxlite.h /path/to/your/project/include/

# Compile your program
gcc -I/path/to/include -L/path/to/lib -lboxlite your_program.c -o your_program

# macOS: Set runtime library path
install_name_tool -add_rpath /path/to/lib your_program

# Linux: Set LD_LIBRARY_PATH
export LD_LIBRARY_PATH=/path/to/lib:$LD_LIBRARY_PATH
./your_program
```

### Option 2: CMake (Recommended)

See `examples/c/CMakeLists.txt` for a complete example.

```cmake
cmake_minimum_required(VERSION 3.15)
project(my_boxlite_app C)

set(BOXLITE_ROOT "/path/to/boxlite")
set(BOXLITE_INCLUDE_DIR "${BOXLITE_ROOT}/sdks/c/include")
set(BOXLITE_LIB_DIR "${BOXLITE_ROOT}/target/release")

include_directories(${BOXLITE_INCLUDE_DIR})

add_executable(my_app main.c)
target_link_libraries(my_app ${BOXLITE_LIB_DIR}/libboxlite.dylib)

# Set RPATH
if(APPLE)
    set_target_properties(my_app PROPERTIES
        BUILD_RPATH "${BOXLITE_LIB_DIR}"
    )
endif()
```

---

## Quick Start

### Simple API (Recommended for Most Use Cases)

```c
#include <stdio.h>
#include "boxlite.h"

int main() {
    // Create a box (no JSON, no runtime management)
    CBoxliteSimple* box;
    CBoxliteError error = {0};

    if (boxlite_simple_new("python:slim", 0, 0, &box, &error) != Ok) {
        fprintf(stderr, "Error %d: %s\n", error.code, error.message);
        boxlite_error_free(&error);
        return 1;
    }

    // Run a command
    const char* args[] = {"-c", "print('Hello!')", NULL};
    CBoxliteExecResult* result;

    if (boxlite_simple_run(box, "python", args, 2, &result, &error) == Ok) {
        printf("Output: %s\n", result->stdout_text);
        printf("Exit code: %d\n", result->exit_code);
        boxlite_result_free(result);
    }

    // Cleanup (auto-stop and remove)
    boxlite_simple_free(box);
    return 0;
}
```

### Native API (For Advanced Use Cases)

```c
#include <stdio.h>
#include "boxlite.h"

void output_callback(const char* text, int is_stderr, void* user_data) {
    FILE* stream = is_stderr ? stderr : stdout;
    fprintf(stream, "%s", text);
}

int main() {
    CBoxliteRuntime* runtime = NULL;
    CBoxHandle* box = NULL;
    CBoxliteError error = {0};

    // Create runtime
    if (boxlite_runtime_new(NULL, NULL, &runtime, &error) != Ok) {
        fprintf(stderr, "Error %d: %s\n", error.code, error.message);
        boxlite_error_free(&error);
        return 1;
    }

    // Create box with JSON configuration
    const char* options = "{"
        "\"rootfs\":{\"Image\":\"alpine:3.19\"},"
        "\"env\":[],\"volumes\":[],\"network\":{\"mode\":\"enabled\",\"allow_net\":[]},\"ports\":[]"
    "}";

    if (boxlite_create_box(runtime, options, &box, &error) != Ok) {
        fprintf(stderr, "Error %d: %s\n", error.code, error.message);
        boxlite_error_free(&error);
        boxlite_runtime_free(runtime);
        return 1;
    }

    // The raw JSON surface also accepts NetworkSpec and secrets:
    // "\"network\":{\"mode\":\"enabled\",\"allow_net\":[\"api.openai.com\"]},"
    // "\"secrets\":[{\"name\":\"openai\",\"value\":\"sk-...\",\"hosts\":[\"api.openai.com\"]}]"

    // Execute command with streaming output
    int exit_code = 0;
    const char* args = "[\"-la\", \"/\"]";

    if (boxlite_execute(box, "/bin/ls", args, output_callback, NULL, &exit_code, &error) == Ok) {
        printf("\nExit code: %d\n", exit_code);
    } else {
        fprintf(stderr, "Error: %s\n", error.message);
        boxlite_error_free(&error);
    }

    // Cleanup (runtime frees all boxes)
    boxlite_runtime_free(runtime);
    return 0;
}
```

### Runtime Image Management

```c
CBoxliteImageHandle* images = NULL;
char* json = NULL;

if (boxlite_runtime_images(runtime, &images, &error) == Ok) {
    if (boxlite_image_pull(images, "alpine:latest", &json, &error) == Ok) {
        printf("Pulled: %s\n", json);
        boxlite_free_string(json);
    }

    if (boxlite_image_list(images, &json, &error) == Ok) {
        printf("Images: %s\n", json);
        boxlite_free_string(json);
    }

    boxlite_image_free(images);
}
```

---

## API Overview

### Simple API

The Simple API provides a streamlined interface for common use cases. No JSON configuration required, automatic resource management.

#### Key Functions

```c
// Create and auto-start a box
BoxliteErrorCode boxlite_simple_new(
    const char* image,          // "python:slim", "alpine:3.19", etc.
    int cpus,                   // 0 = default (2)
    int memory_mib,             // 0 = default (512)
    CBoxliteSimple** out_box,
    CBoxliteError* out_error
);

// Run command and get buffered result
BoxliteErrorCode boxlite_simple_run(
    CBoxliteSimple* box,
    const char* command,
    const char** args,          // NULL-terminated array
    int argc,
    CBoxliteExecResult** out_result,
    CBoxliteError* out_error
);

// Free result (stdout, stderr, exit code)
void boxlite_result_free(CBoxliteExecResult* result);

// Auto-cleanup (stop + remove)
void boxlite_simple_free(CBoxliteSimple* box);
```

#### When to Use Simple API
- ✅ Quick prototypes and scripts
- ✅ Single-box applications
- ✅ Buffered output is acceptable
- ✅ Standard resource limits (2 CPUs, 512 MB)

#### When to Use Native API Instead
- ❌ Need streaming output callbacks
- ❌ Custom volumes or networking
- ❌ Multi-box orchestration
- ❌ Advanced configuration (custom JSON options)

### Native API

The Native API provides full control and advanced features.

#### Runtime Management

```c
// Get version
const char* boxlite_version(void);

// Create runtime with options
BoxliteErrorCode boxlite_runtime_new(
    const char* home_dir,        // NULL = ~/.boxlite
    const char* registries_json, // NULL = ["docker.io"]
    CBoxliteRuntime** out_runtime,
    CBoxliteError* out_error
);

// Graceful shutdown
BoxliteErrorCode boxlite_runtime_shutdown(
    CBoxliteRuntime* runtime,
    int timeout,  // 0=default(10s), -1=infinite
    CBoxliteError* out_error
);

// Runtime-wide metrics (JSON)
BoxliteErrorCode boxlite_runtime_metrics(
    CBoxliteRuntime* runtime,
    char** out_json,
    CBoxliteError* out_error
);

// Free runtime (auto-frees all boxes)
void boxlite_runtime_free(CBoxliteRuntime* runtime);
```

#### Box Lifecycle

```c
// Create box (auto-started)
BoxliteErrorCode boxlite_create_box(
    CBoxliteRuntime* runtime,
    const char* options_json,
    CBoxHandle** out_box,
    CBoxliteError* out_error
);

// Start/restart a stopped box
BoxliteErrorCode boxlite_start_box(
    CBoxHandle* handle,
    CBoxliteError* out_error
);

// Stop box (can restart later)
BoxliteErrorCode boxlite_stop_box(
    CBoxHandle* handle,
    CBoxliteError* out_error
);

// Remove box
BoxliteErrorCode boxlite_remove(
    CBoxliteRuntime* runtime,
    const char* id_or_name,
    int force,  // 1=remove even if running
    CBoxliteError* out_error
);

// Reattach to existing box
BoxliteErrorCode boxlite_get(
    CBoxliteRuntime* runtime,
    const char* id_or_name,      // Full ID or prefix
    CBoxHandle** out_handle,
    CBoxliteError* out_error
);

// Get box ID (caller must free with boxlite_free_string)
char* boxlite_box_id(CBoxHandle* handle);
```

#### Command Execution

```c
// Simple: execute command with optional streaming callback
BoxliteErrorCode boxlite_execute(
    CBoxHandle* handle,
    const char* command,
    const char* args_json,  // JSON array: ["arg1", "arg2"]
    void (*callback)(const char* text, int is_stderr, void* user_data),
    void* user_data,
    int* out_exit_code,
    CBoxliteError* out_error
);

// Structured: execute with full options (env, user, timeout, workdir)
typedef struct BoxliteCommand {
    const char* command;      // Required
    const char* args_json;    // JSON array, or NULL
    const char* env_json;     // JSON array of ["key","val"] pairs, or NULL
    const char* workdir;      // Working directory, or NULL
    const char* user;         // User spec (e.g., "nobody", "1000:1000"), or NULL
    double timeout_secs;      // 0.0 = no timeout
} BoxliteCommand;

BoxliteErrorCode boxlite_execute_cmd(
    CBoxHandle* handle,
    const BoxliteCommand* cmd,
    void (*callback)(const char* text, int is_stderr, void* user_data),
    void* user_data,
    int* out_exit_code,
    CBoxliteError* out_error
);
```

**Example: structured command with options**

```c
BoxliteCommand cmd = {
    .command = "pwd",
    .args_json = NULL,
    .env_json = "[[\"MY_VAR\",\"hello\"]]",
    .workdir = "/tmp",
    .user = "nobody",
    .timeout_secs = 30.0,
};
int exit_code;
boxlite_execute_cmd(box, &cmd, my_callback, NULL, &exit_code, &error);
```

#### Discovery & Introspection

```c
// List all boxes (returns JSON array)
BoxliteErrorCode boxlite_list_info(
    CBoxliteRuntime* runtime,
    char** out_json,
    CBoxliteError* out_error
);

// Get specific box info (returns JSON object)
BoxliteErrorCode boxlite_get_info(
    CBoxliteRuntime* runtime,
    const char* id_or_name,
    char** out_json,
    CBoxliteError* out_error
);

// Get box info from handle
BoxliteErrorCode boxlite_box_info(
    CBoxHandle* handle,
    char** out_json,
    CBoxliteError* out_error
);

// Per-box metrics (JSON)
BoxliteErrorCode boxlite_box_metrics(
    CBoxHandle* handle,
    char** out_json,
    CBoxliteError* out_error
);
```

### Error Handling

The C SDK introduces structured error handling with error codes and detailed messages.

#### Error Codes

```c
typedef enum BoxliteErrorCode {
    Ok = 0,               // Success
    Internal = 1,         // Internal error
    NotFound = 2,         // Resource not found
    AlreadyExists = 3,    // Resource already exists
    InvalidState = 4,     // Invalid state for operation
    InvalidArgument = 5,  // Invalid argument
    Config = 6,           // Configuration error
    Storage = 7,          // Storage error
    Image = 8,            // Image error
    Network = 9,          // Network error
    Execution = 10,       // Execution error
    Stopped = 11,         // Resource stopped
    Engine = 12,          // Engine error
    Unsupported = 13,     // Unsupported operation
    Database = 14,        // Database error
    Portal = 15,          // Portal/communication error
    Rpc = 16,             // RPC error
    RpcTransport = 17,    // RPC transport error
    Metadata = 18,        // Metadata error
    UnsupportedEngine = 19, // Unsupported engine error
} BoxliteErrorCode;
```

#### Error Struct

```c
typedef struct CBoxliteError {
    BoxliteErrorCode code;  // Error code for programmatic handling
    char* message;           // Detailed message (NULL if none)
} CBoxliteError;
```

#### Error Handling Patterns

**Pattern 1: Basic Check**

```c
CBoxliteError error = {0};
BoxliteErrorCode code = boxlite_simple_new("alpine:3.19", 0, 0, &box, &error);

if (code != Ok) {
    fprintf(stderr, "Error %d: %s\n", error.code, error.message);
    boxlite_error_free(&error);
    return 1;
}

// Success path
boxlite_simple_free(box);
```

**Pattern 2: Switch on Error Code**

```c
CBoxliteError error = {0};
BoxliteErrorCode code = boxlite_get(runtime, "box-id", &box, &error);

switch (code) {
    case Ok:
        // Success
        break;
    case InvalidArgument:
        printf("Invalid argument: %s\n", error.message);
        break;
    case NotFound:
        printf("Resource not found: %s\n", error.message);
        break;
    default:
        printf("Error %d: %s\n", error.code, error.message);
}

boxlite_error_free(&error);
```

**Pattern 3: Retry Logic**

```c
int retries = 3;
for (int i = 0; i < retries; i++) {
    code = boxlite_simple_new(..., &error);
    if (code == Ok) {
        break;  // Success
    }

    printf("Retry %d/%d failed: %s\n", i+1, retries, error.message);
    boxlite_error_free(&error);

    if (code == InvalidArgument || code == Unsupported) {
        break;  // Non-retryable errors
    }
    sleep(1);  // Backoff
}
```

---

## Complete API Reference

For the full API reference with detailed parameter tables, JSON schema, and code examples, see:

**[C SDK API Reference](docs/reference/c/README.md)**

---

## Examples

The `examples/c/` directory contains 8 examples:

| Example | Description |
|---------|-------------|
| `simple_api_demo.c` | Quick start with Simple API |
| `execute.c` | Command execution with streaming output |
| `shutdown.c` | Runtime shutdown with multiple boxes |
| `01_lifecycle.c` | Complete box lifecycle (create/stop/restart/remove) |
| `02_list_boxes.c` | Discovery, introspection, ID prefix lookup |
| `03_streaming_output.c` | Real-time output handling with callbacks |
| `04_error_handling.c` | Error codes, retry logic, graceful degradation |
| `05_metrics.c` | Runtime and per-box metrics |

### Building and Running Examples

```bash
cd examples/c
mkdir -p build && cd build
cmake ..
make

# Run any example
./simple_api_demo
./01_lifecycle
./05_metrics
```

---

## Memory Management

### Rules

1. **All allocated strings must be freed**
   - `boxlite_box_id()` → `boxlite_free_string()`
   - `boxlite_list_info()` JSON → `boxlite_free_string()`
   - Info/metrics JSON → `boxlite_free_string()`

2. **Error structs must be freed**
   - `CBoxliteError` → `boxlite_error_free()`

3. **Results must be freed**
   - `CBoxliteExecResult` → `boxlite_result_free()`

4. **Handles have specific free functions**
   - `CBoxliteRuntime` → `boxlite_runtime_free()` (auto-frees all boxes)
   - `CBoxHandle` → `boxlite_box_free()`
   - `CBoxliteSimple` → `boxlite_simple_free()`

5. **All cleanup functions are NULL-safe**

### Common Patterns

**String output:**
```c
char* id = boxlite_box_id(box);
printf("ID: %s\n", id);
boxlite_free_string(id);  // MUST free
```

**Error handling:**
```c
CBoxliteError error = {0};
BoxliteErrorCode code = boxlite_simple_new(..., &error);
if (code != Ok) {
    fprintf(stderr, "%s\n", error.message);
    boxlite_error_free(&error);  // MUST free
}
```

**Execution results:**
```c
CBoxliteExecResult* result;
boxlite_simple_run(..., &result, &error);
printf("Output: %s\n", result->stdout_text);
boxlite_result_free(result);  // MUST free
```

### Memory Leak Detection

Use valgrind (Linux) or Instruments (macOS) to detect leaks:

```bash
# Linux
valgrind --leak-check=full ./my_app

# macOS
leaks -atExit -- ./my_app
```

---

## Threading & Safety

### Thread Safety

- ✅ **`CBoxliteRuntime` is thread-safe** - Multiple threads can call runtime functions concurrently
- ⚠️ **`CBoxHandle` is NOT thread-safe** - Don't share box handles across threads
- ⚠️ **`CBoxliteSimple` is NOT thread-safe** - Don't share simple boxes across threads

### Best Practices

**Safe: One runtime, multiple threads**
```c
CBoxliteRuntime* runtime = NULL;
CBoxliteError error = {0};
boxlite_runtime_new(NULL, NULL, &runtime, &error);

// Thread 1
CBoxHandle* box1 = NULL;
boxlite_create_box(runtime, options, &box1, &error);

// Thread 2
CBoxHandle* box2 = NULL;
boxlite_create_box(runtime, options, &box2, &error);
```

**Unsafe: Sharing box handle across threads**
```c
CBoxHandle* box = NULL;
boxlite_create_box(runtime, options, &box, &error);

// Thread 1
boxlite_execute(box, ...);  // UNSAFE

// Thread 2
boxlite_execute(box, ...);  // UNSAFE
```

**Safe: Per-thread boxes**
```c
void* thread_func(void* arg) {
    CBoxliteRuntime* runtime = (CBoxliteRuntime*)arg;
    CBoxHandle* box = NULL;
    CBoxliteError error = {0};
    boxlite_create_box(runtime, options, &box, &error);
    int exit_code = 0;
    boxlite_execute(box, "/bin/echo", "[\"hello\"]", NULL, NULL, &exit_code, &error);
    boxlite_stop_box(box, &error);
    return NULL;
}
```

### Callback Execution

Callbacks are invoked on the **calling thread**. Do not block in callbacks.

---

## Platform Support

### Supported Platforms

| Platform | Architecture | Status | Requirements |
|----------|-------------|--------|--------------|
| macOS    | ARM64 (Apple Silicon) | ✅ Full support | macOS 11.0+, Hypervisor.framework |
| macOS    | x86_64 (Intel) | ❌ Not supported | N/A |
| Linux    | x86_64 | ✅ Full support | KVM enabled |
| Linux    | ARM64 (aarch64) | ✅ Full support | KVM enabled |
| Windows  | Any | ❌ Not supported | Use WSL2 |

### Platform-Specific Notes

**macOS:**
- Requires Hypervisor.framework (built-in on macOS 11.0+)
- Intel Macs are not supported
- Dylib search paths: use `install_name_tool` or `DYLD_LIBRARY_PATH`

**Linux:**
- Requires KVM kernel module: `sudo modprobe kvm kvm_intel` (or `kvm_amd`)
- Check support: `kvm-ok` or `lsmod | grep kvm`
- Library search paths: use `LD_LIBRARY_PATH` or `ldconfig`

**Windows:**
- Use WSL2 (Windows Subsystem for Linux 2)
- Follow Linux instructions inside WSL2

---

## Migration Guide

### From 0.1.x to 0.2.0

**Breaking Changes:**
- Simple API added (new feature, backward compatible)
- Error handling enhanced (new `CBoxliteError` struct, backward compatible with old API)

**No code changes required** if using old API. Existing programs will continue to work.

**Recommended migrations:**

**1. Simple use cases → Simple API**

Before (0.1.x):
```c
char* error = NULL;
CBoxliteRuntime* runtime = boxlite_runtime_new(NULL, NULL, &error);
const char* opts = "{\"rootfs\":{\"Image\":\"alpine:3.19\"}}";
CBoxHandle* box = boxlite_create_box(runtime, opts, &error);
boxlite_execute(box, "/bin/echo", "[\"hello\"]", NULL, NULL, &error);
boxlite_stop_box(box, &error);
boxlite_runtime_free(runtime);
```

After (0.2.0):
```c
CBoxliteSimple* box;
CBoxliteError error = {0};

boxlite_simple_new("alpine:3.19", 0, 0, &box, &error);
const char* args[] = {"hello", NULL};
CBoxliteExecResult* result;
boxlite_simple_run(box, "/bin/echo", args, 1, &result, &error);
boxlite_result_free(result);
boxlite_simple_free(box);
```

**2. Error handling → Structured errors**

Before:
```c
char* error = NULL;
if (!runtime) {
    fprintf(stderr, "Error: %s\n", error);
    // Parse error string to understand type
}
```

After:
```c
CBoxliteError error = {0};
if (code != Ok) {
    switch (error.code) {
        case NotFound:
            // Handle not found
            break;
        case InvalidArgument:
            // Handle invalid argument
            break;
    }
    boxlite_error_free(&error);
}
```

---

## Troubleshooting

### Library Not Found

**Error:** `dyld: Library not loaded: @rpath/libboxlite.dylib`

**Solution:**
```bash
# macOS: Add RPATH to executable
install_name_tool -add_rpath /path/to/lib my_app

# Linux: Set LD_LIBRARY_PATH
export LD_LIBRARY_PATH=/path/to/lib:$LD_LIBRARY_PATH
```

### Box Creation Fails

**Error:** `Failed to create box: Image error: ...`

**Solutions:**
1. Check internet connection (for image pull)
2. Verify image name: `"alpine:3.19"` (not `alpine:3.19` without quotes)
3. Check disk space: `df -h ~/.boxlite`
4. Enable debug logs: `RUST_LOG=debug ./my_app`

### KVM Not Available (Linux)

**Error:** `UnsupportedEngine` or `kvm: Permission denied`

**Solutions:**
```bash
# Check KVM support
kvm-ok

# Load KVM module
sudo modprobe kvm kvm_intel  # or kvm_amd

# Add user to kvm group
sudo usermod -aG kvm $USER
newgrp kvm
```

### Crash on Apple Intel Mac

**Error:** Segmentation fault or `UnsupportedEngine`

**Solution:** Intel Macs are not supported. Use ARM64 Mac or Linux.

### Memory Leaks

**Run valgrind:**
```bash
valgrind --leak-check=full --show-leak-kinds=all ./my_app
```

**Common causes:**
- Not freeing strings: `boxlite_box_id()`, `boxlite_list_info()`
- Not freeing errors: `boxlite_error_free()`
- Not freeing results: `boxlite_result_free()`

### High Memory Usage

**Check box count:**
```c
char* metrics = NULL;
CBoxliteError error = {0};
boxlite_runtime_metrics(runtime, &metrics, &error);
printf("Metrics: %s\n", metrics);
boxlite_free_string(metrics);
```

**Reduce memory per box:**
```c
// Simple API: Can't configure (uses defaults)
// Use native API instead:
const char* opts = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"memory_mib\":256}";
```

### Command Hangs

**Possible causes:**
1. Command waiting for input (use non-interactive commands)
2. Large output without callback (output buffer full)
3. Deadlock in callback function

**Solutions:**
- Use streaming callback for large output
- Don't block in callbacks
- Set command timeout (future feature)

---

## Architecture

The C SDK is a thin wrapper around the Rust `boxlite` crate:

```
ffi/src/lib.rs
  ↓ (re-export)
ffi/src/ops.rs       (box operations)
ffi/src/runtime.rs   (runtime management)
ffi/src/runner.rs    (simple API)
  ↓ (wraps)
boxlite/src/runtime/
```

- Built as separate crate (`boxlite-ffi` in `ffi/`) to produce `cdylib`/`staticlib`
- Header auto-generated from Rust code using `cbindgen`
- JSON used for complex types to avoid ABI issues
- Maintains same functionality as Rust API

### Development

**Rebuilding Header:**
```bash
cargo build -p boxlite-ffi
# Outputs: sdks/c/include/boxlite.h
```

**Adding New Functions:**
1. Add function to the appropriate file in `ffi/src/` with `#[no_mangle]` and `extern "C"`
2. Rebuild: `cargo build -p boxlite-ffi`
3. Header is automatically updated

**Testing:**
See `sdks/c/tests/` for the test suite.

---

## License

Apache-2.0

---

## Links

- **[C SDK API Reference](docs/reference/c/README.md)** - Complete function reference
- **[C Quick Start](docs/getting-started/quickstart-c.md)** - 5-minute guide
- **Examples:** `examples/c/`
- **Tests:** `sdks/c/tests/`
