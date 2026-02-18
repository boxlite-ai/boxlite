# C Quick Start

Get up and running with BoxLite C SDK in 5 minutes.

## Installation

### Prerequisites

**macOS (Apple Silicon):**
- macOS 11.0+ (Big Sur or later)
- Xcode Command Line Tools: `xcode-select --install`
- GCC or Clang

**Linux:**
- x86_64 or ARM64 architecture
- KVM enabled (`/dev/kvm` accessible)
- GCC or Clang, CMake 3.15+

### Building the SDK

```bash
# Clone the repository
git clone https://github.com/boxlite-labs/boxlite.git
cd boxlite

# Initialize submodules (REQUIRED!)
git submodule update --init --recursive

# Build C SDK
cargo build --release -p boxlite-c

# Outputs:
# - target/release/libboxlite.{dylib,so}  (shared library)
# - target/release/libboxlite.a           (static library)
# - sdks/c/include/boxlite.h              (header file)
```

**Verify Build:**
```bash
ls -la target/release/libboxlite.*
ls -la sdks/c/include/boxlite.h
```

---

## Simple API (Easiest)

Create a file `hello.c`:

```c
#include <stdio.h>
#include "boxlite.h"

int main() {
    CBoxliteSimple* box = NULL;
    CBoxliteError error = {0};

    // Create box (no JSON required, auto-starts)
    if (boxlite_simple_new("python:slim", 0, 0, &box, &error) != Ok) {
        fprintf(stderr, "Error %d: %s\n", error.code, error.message);
        boxlite_error_free(&error);
        return 1;
    }

    // Run command and get buffered result
    const char* args[] = {"-c", "print('Hello from BoxLite!')", NULL};
    CBoxliteExecResult* result = NULL;

    if (boxlite_simple_run(box, "python", args, 2, &result, &error) == Ok) {
        printf("Output: %s", result->stdout_text);
        printf("Exit code: %d\n", result->exit_code);
        boxlite_result_free(result);
    } else {
        fprintf(stderr, "Exec error: %s\n", error.message);
        boxlite_error_free(&error);
    }

    boxlite_simple_free(box);  // Auto-cleanup
    return 0;
}
```

Build and run:

```bash
# macOS
gcc -o hello hello.c \
    -I/path/to/boxlite/sdks/c/include \
    -L/path/to/boxlite/target/release \
    -lboxlite

export DYLD_LIBRARY_PATH=/path/to/boxlite/target/release:$DYLD_LIBRARY_PATH
./hello

# Linux
gcc -o hello hello.c \
    -I/path/to/boxlite/sdks/c/include \
    -L/path/to/boxlite/target/release \
    -lboxlite

export LD_LIBRARY_PATH=/path/to/boxlite/target/release:$LD_LIBRARY_PATH
./hello
```

**What's happening:**
1. BoxLite pulls the `python:slim` OCI image (first run only)
2. Creates a lightweight VM with the image
3. Executes the Python command inside the VM
4. Buffers stdout/stderr and returns the result
5. Automatically cleans up when `boxlite_simple_free()` is called

---

## Native API (Full Control)

For advanced use cases with streaming output and custom configuration.

Create a file `native.c`:

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
        fprintf(stderr, "Runtime error: %s\n", error.message);
        boxlite_error_free(&error);
        return 1;
    }

    printf("BoxLite v%s\n", boxlite_version());

    // Create box with JSON configuration
    const char* options = "{"
        "\"rootfs\":{\"Image\":\"alpine:3.19\"},"
        "\"cpus\":2,"
        "\"memory_mib\":512,"
        "\"env\":[],"
        "\"volumes\":[],"
        "\"network\":\"Isolated\","
        "\"ports\":[]"
    "}";

    if (boxlite_create_box(runtime, options, &box, &error) != Ok) {
        fprintf(stderr, "Box error: %s\n", error.message);
        boxlite_error_free(&error);
        boxlite_runtime_free(runtime);
        return 1;
    }

    // Execute commands with streaming output
    int exit_code = 0;

    printf("\n--- Running: ls -la / ---\n");
    if (boxlite_execute(box, "/bin/ls", "[\"-la\", \"/\"]", output_callback, NULL, &exit_code, &error) == Ok) {
        printf("\nExit code: %d\n", exit_code);
    } else {
        fprintf(stderr, "Execute error: %s\n", error.message);
        boxlite_error_free(&error);
    }

    // Cleanup (runtime frees all boxes)
    boxlite_runtime_free(runtime);
    return 0;
}
```

Build and run using the same commands as above.

---

## Running Examples

BoxLite includes 8 comprehensive C examples:

```bash
# Navigate to examples
cd examples/c

# Build examples with CMake
mkdir -p build && cd build
cmake ..
make

# Run examples
./simple_api_demo    # Simple API basics
./execute            # Command execution with streaming
./shutdown           # Graceful shutdown
./01_lifecycle       # Create/stop/restart/remove
./02_list_boxes      # Discovery and introspection
./03_streaming_output  # Real-time output handling
./04_error_handling  # Error recovery patterns
./05_metrics         # Performance monitoring
```

**Examples overview:**

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

---

## Error Handling

The C SDK uses structured error handling:

```c
CBoxliteError error = {0};  // Always initialize to zero
BoxliteErrorCode code = boxlite_simple_new(..., &error);

if (code != Ok) {
    // Check specific error codes
    switch (code) {
        case NotFound:
            printf("Resource not found\n");
            break;
        case Image:
            printf("Image pull failed: %s\n", error.message);
            break;
        default:
            printf("Error %d: %s\n", code, error.message);
    }
    boxlite_error_free(&error);  // Always free on error
}
```

**Error codes:**
- `Ok (0)` - Success
- `NotFound (2)` - Resource not found
- `InvalidArgument (5)` - Invalid parameter
- `Image (8)` - Image pull/resolution failed
- `Execution (10)` - Command execution failed

See [C SDK API Reference](../reference/c/README.md#boxliteerrorcode) for the complete list.

---

## Next Steps

- **[C SDK README](../../sdks/c/README.md)** - Complete SDK documentation
  - Simple API and Native API details
  - JSON configuration schema
  - Memory management rules
  - Threading and safety
  - Troubleshooting guide

- **[C SDK API Reference](../reference/c/README.md)** - Function signatures and parameters

- **[C Examples](../../examples/c/)** - Working code examples
