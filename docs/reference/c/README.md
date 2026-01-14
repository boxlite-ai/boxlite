# C SDK API Reference

Complete API reference for the BoxLite C SDK.

## Overview

The C SDK provides C-compatible FFI bindings for integrating BoxLite into C/C++ applications. The API uses JSON for complex types to avoid ABI compatibility issues.

**Library**: `libboxlite`
**Header**: `boxlite.h`

---

## Table of Contents

- [Quick Start](#quick-start)
- [Runtime Management](#runtime-management)
  - [boxlite_version](#boxlite_version)
  - [boxlite_runtime_new](#boxlite_runtime_new)
  - [boxlite_runtime_free](#boxlite_runtime_free)
- [Box Management](#box-management)
  - [boxlite_create_box](#boxlite_create_box)
  - [boxlite_execute](#boxlite_execute)
  - [boxlite_stop_box](#boxlite_stop_box)
- [Memory Management](#memory-management)
  - [boxlite_free_string](#boxlite_free_string)
- [JSON Schema Reference](#json-schema-reference)
  - [BoxOptions](#boxoptions-schema)
  - [RootfsSpec](#rootfsspec-schema)
  - [VolumeSpec](#volumespec-schema)
  - [PortSpec](#portspec-schema)
- [Error Handling](#error-handling)
- [Thread Safety](#thread-safety)
- [Platform Requirements](#platform-requirements)

---

## Quick Start

```c
#include <stdio.h>
#include "boxlite.h"

// Callback for streaming output
void output_callback(const char* text, int is_stderr, void* user_data) {
    if (is_stderr) {
        fprintf(stderr, "%s", text);
    } else {
        printf("%s", text);
    }
}

int main() {
    char* error = NULL;

    // Create runtime with default home directory
    CBoxliteRuntime* runtime = boxlite_runtime_new(NULL, NULL, &error);
    if (!runtime) {
        fprintf(stderr, "Failed to create runtime: %s\n", error);
        boxlite_free_string(error);
        return 1;
    }

    // Create box with Alpine Linux
    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"}}";
    CBoxHandle* box = boxlite_create_box(runtime, options, &error);
    if (!box) {
        fprintf(stderr, "Failed to create box: %s\n", error);
        boxlite_free_string(error);
        boxlite_runtime_free(runtime);
        return 1;
    }

    // Execute a command
    const char* args = "[\"-la\", \"/\"]";
    int exit_code = boxlite_execute(box, "ls", args, output_callback, NULL, &error);
    if (exit_code < 0) {
        fprintf(stderr, "Execution failed: %s\n", error);
        boxlite_free_string(error);
    }

    // Stop and cleanup
    boxlite_stop_box(box, &error);
    boxlite_runtime_free(runtime);

    return exit_code < 0 ? 1 : exit_code;
}
```

### Building

```bash
# Compile with the BoxLite library
gcc -I/path/to/boxlite/sdks/c/include \
    -L/path/to/boxlite/target/release \
    -lboxlite \
    my_program.c -o my_program

# On macOS, you may need to set the library path
export DYLD_LIBRARY_PATH=/path/to/boxlite/target/release:$DYLD_LIBRARY_PATH

# On Linux
export LD_LIBRARY_PATH=/path/to/boxlite/target/release:$LD_LIBRARY_PATH
```

---

## Runtime Management

### boxlite_version

Get BoxLite version string.

```c
const char* boxlite_version(void);
```

#### Returns

Static string containing the version (e.g., `"0.1.0"`).

#### Example

```c
printf("BoxLite version: %s\n", boxlite_version());
```

#### Notes

- Returns a static string - do not free.

---

### boxlite_runtime_new

Create a new BoxLite runtime instance.

```c
CBoxliteRuntime* boxlite_runtime_new(
    const char* home_dir,
    const char* registries_json,
    char** out_error
);
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `home_dir` | `const char*` | Path to BoxLite home directory. `NULL` uses default (`~/.boxlite`). |
| `registries_json` | `const char*` | JSON array of image registries, e.g. `["ghcr.io", "docker.io"]`. `NULL` uses default (docker.io). |
| `out_error` | `char**` | Output parameter for error message. Caller must free with `boxlite_free_string`. |

#### Returns

- Pointer to `CBoxliteRuntime` on success
- `NULL` on failure (check `out_error`)

#### Example

```c
char* error = NULL;

// Default configuration
CBoxliteRuntime* runtime = boxlite_runtime_new(NULL, NULL, &error);

// Custom home directory
CBoxliteRuntime* runtime = boxlite_runtime_new("/var/lib/boxlite", NULL, &error);

// Custom registries
const char* registries = "[\"ghcr.io/myorg\", \"docker.io\"]";
CBoxliteRuntime* runtime = boxlite_runtime_new(NULL, registries, &error);

if (!runtime) {
    fprintf(stderr, "Error: %s\n", error);
    boxlite_free_string(error);
    return 1;
}
```

---

### boxlite_runtime_free

Free a runtime instance.

```c
void boxlite_runtime_free(CBoxliteRuntime* runtime);
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `runtime` | `CBoxliteRuntime*` | Runtime instance to free. Can be `NULL`. |

#### Example

```c
boxlite_runtime_free(runtime);
runtime = NULL;  // Good practice
```

---

## Box Management

### boxlite_create_box

Create a new box with the given options.

```c
CBoxHandle* boxlite_create_box(
    CBoxliteRuntime* runtime,
    const char* options_json,
    char** out_error
);
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `runtime` | `CBoxliteRuntime*` | Runtime instance. |
| `options_json` | `const char*` | JSON-encoded BoxOptions. |
| `out_error` | `char**` | Output parameter for error message. |

#### Returns

- Pointer to `CBoxHandle` on success
- `NULL` on failure (check `out_error`)

#### Example

```c
// Minimal options (Alpine Linux)
const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"}}";

// Full options
const char* full_options = "{"
    "\"rootfs\":{\"Image\":\"python:3.11-slim\"},"
    "\"cpus\":2,"
    "\"memory_mib\":1024,"
    "\"working_dir\":\"/app\","
    "\"env\":[[\"PYTHONPATH\",\"/app\"]],"
    "\"volumes\":[{\"host_path\":\"/home/user/code\",\"guest_path\":\"/app\",\"read_only\":true}],"
    "\"ports\":[{\"host_port\":8080,\"guest_port\":80}]"
"}";

char* error = NULL;
CBoxHandle* box = boxlite_create_box(runtime, options, &error);
if (!box) {
    fprintf(stderr, "Failed: %s\n", error);
    boxlite_free_string(error);
}
```

---

### boxlite_execute

Run a command in a box.

```c
int boxlite_execute(
    CBoxHandle* handle,
    const char* command,
    const char* args_json,
    void (*callback)(const char* text, int is_stderr, void* user_data),
    void* user_data,
    char** out_error
);
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `handle` | `CBoxHandle*` | Box handle. |
| `command` | `const char*` | Command to run. |
| `args_json` | `const char*` | JSON array of arguments, e.g. `["arg1", "arg2"]`. Can be `NULL`. |
| `callback` | function pointer | Optional callback for streaming output. |
| `user_data` | `void*` | User data passed to callback. |
| `out_error` | `char**` | Output parameter for error message. |

#### Callback Signature

```c
void callback(const char* text, int is_stderr, void* user_data);
```

| Parameter | Description |
|-----------|-------------|
| `text` | Output text chunk |
| `is_stderr` | `0` for stdout, `1` for stderr |
| `user_data` | User data from `boxlite_execute` |

#### Returns

- Exit code on success (0-255)
- `-1` on failure (check `out_error`)

#### Example

```c
// Simple command without callback
int exit_code = boxlite_execute(box, "echo", "[\"hello\", \"world\"]", NULL, NULL, &error);

// With output callback
void print_output(const char* text, int is_stderr, void* data) {
    FILE* stream = is_stderr ? stderr : stdout;
    fprintf(stream, "%s", text);
}

int exit_code = boxlite_execute(box, "ls", "[\"-la\"]", print_output, NULL, &error);

// With user data
typedef struct {
    int line_count;
} OutputState;

void count_lines(const char* text, int is_stderr, void* data) {
    OutputState* state = (OutputState*)data;
    state->line_count++;
    printf("[%d] %s", state->line_count, text);
}

OutputState state = {0};
boxlite_execute(box, "cat", "[\"/etc/passwd\"]", count_lines, &state, &error);
printf("Total lines: %d\n", state.line_count);
```

---

### boxlite_stop_box

Stop and free a box.

```c
int boxlite_stop_box(CBoxHandle* handle, char** out_error);
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `handle` | `CBoxHandle*` | Box handle. Will be consumed and freed. |
| `out_error` | `char**` | Output parameter for error message. |

#### Returns

- `0` on success
- `-1` on failure (check `out_error`)

#### Example

```c
if (boxlite_stop_box(box, &error) != 0) {
    fprintf(stderr, "Failed to stop: %s\n", error);
    boxlite_free_string(error);
}
// box is now invalid, do not use
box = NULL;
```

#### Notes

- The handle is freed even on failure
- Do not use the handle after calling this function

---

## Memory Management

### boxlite_free_string

Free a string allocated by BoxLite.

```c
void boxlite_free_string(char* str);
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `str` | `char*` | String to free. Can be `NULL`. |

#### Example

```c
char* error = NULL;
CBoxliteRuntime* runtime = boxlite_runtime_new(NULL, NULL, &error);
if (!runtime) {
    fprintf(stderr, "Error: %s\n", error);
    boxlite_free_string(error);  // MUST free error strings
    return 1;
}
```

#### Notes

- Always free error strings returned via `out_error` parameters
- Safe to call with `NULL`

---

## JSON Schema Reference

### BoxOptions Schema

Complete schema for box configuration:

```json
{
  "rootfs": {
    "Image": "alpine:3.19"
  },
  "cpus": 2,
  "memory_mib": 512,
  "disk_size_gb": 10,
  "working_dir": "/workspace",
  "env": [
    ["KEY", "value"],
    ["ANOTHER_KEY", "another_value"]
  ],
  "volumes": [
    {
      "host_path": "/home/user/data",
      "guest_path": "/data",
      "read_only": false
    }
  ],
  "network": "Isolated",
  "ports": [
    {
      "host_port": 8080,
      "guest_port": 80,
      "protocol": "Tcp"
    }
  ],
  "auto_remove": true,
  "detach": false
}
```

#### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `rootfs` | object | Required | Root filesystem source |
| `cpus` | integer | 2 | Number of CPUs |
| `memory_mib` | integer | 512 | Memory in MiB |
| `disk_size_gb` | integer | null | Disk size in GB (sparse) |
| `working_dir` | string | null | Working directory inside box |
| `env` | array | `[]` | Environment variables as `[key, value]` pairs |
| `volumes` | array | `[]` | Volume mounts |
| `network` | string | `"Isolated"` | Network mode |
| `ports` | array | `[]` | Port mappings |
| `auto_remove` | boolean | `true` | Remove box when stopped |
| `detach` | boolean | `false` | Run independently of parent |

### RootfsSpec Schema

Two variants for specifying the root filesystem:

#### Image Reference

```json
{
  "rootfs": {
    "Image": "python:3.11-slim"
  }
}
```

#### Local Rootfs Path

```json
{
  "rootfs": {
    "RootfsPath": "/path/to/rootfs"
  }
}
```

### VolumeSpec Schema

```json
{
  "host_path": "/absolute/path/on/host",
  "guest_path": "/path/in/guest",
  "read_only": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `host_path` | string | Absolute path on host |
| `guest_path` | string | Mount path inside guest |
| `read_only` | boolean | Mount as read-only |

### PortSpec Schema

```json
{
  "host_port": 8080,
  "guest_port": 80,
  "protocol": "Tcp",
  "host_ip": "127.0.0.1"
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `host_port` | integer | null | Host port (null = dynamic) |
| `guest_port` | integer | Required | Guest port |
| `protocol` | string | `"Tcp"` | `"Tcp"` or `"Udp"` |
| `host_ip` | string | null | Bind IP (null = 0.0.0.0) |

---

## Error Handling

All functions that can fail use the `out_error` pattern:

```c
char* error = NULL;
CBoxHandle* box = boxlite_create_box(runtime, options, &error);
if (!box) {
    fprintf(stderr, "Error: %s\n", error);
    boxlite_free_string(error);  // MUST free
    return 1;
}
```

### Common Errors

| Error Type | Description |
|------------|-------------|
| `"runtime is null"` | Passed NULL runtime to function |
| `"handle is null"` | Passed NULL box handle to function |
| `"Invalid JSON options: ..."` | Malformed JSON in options |
| `"image error: ..."` | Failed to pull/resolve image |
| `"box not found: ..."` | Box ID doesn't exist |
| `"invalid state: ..."` | Operation not allowed in current state |

### Error Handling Best Practices

```c
// Always check return values
if (!runtime) {
    // Handle error
}

// Always free error strings
if (error) {
    boxlite_free_string(error);
    error = NULL;  // Good practice
}

// Use goto for cleanup
int result = -1;
char* error = NULL;
CBoxliteRuntime* runtime = NULL;
CBoxHandle* box = NULL;

runtime = boxlite_runtime_new(NULL, NULL, &error);
if (!runtime) goto cleanup;

box = boxlite_create_box(runtime, options, &error);
if (!box) goto cleanup;

result = boxlite_execute(box, "echo", "[\"hello\"]", NULL, NULL, &error);

cleanup:
    if (error) {
        fprintf(stderr, "Error: %s\n", error);
        boxlite_free_string(error);
    }
    if (box) boxlite_stop_box(box, NULL);
    if (runtime) boxlite_runtime_free(runtime);
    return result;
```

---

## Thread Safety

| Component | Thread Safety |
|-----------|---------------|
| `CBoxliteRuntime` | Thread-safe (uses internal async runtime) |
| `CBoxHandle` | NOT thread-safe. Do not share across threads. |
| Callbacks | Invoked on the calling thread |
| Error strings | Each thread gets its own error |

### Multi-threaded Usage

```c
// CORRECT: Each thread creates its own box
void* thread_func(void* arg) {
    CBoxliteRuntime* runtime = (CBoxliteRuntime*)arg;
    char* error = NULL;

    // Each thread creates its own box
    CBoxHandle* box = boxlite_create_box(runtime, options, &error);
    if (!box) {
        // Handle error
        return NULL;
    }

    // Use box in this thread only
    boxlite_execute(box, "echo", "[\"hello\"]", NULL, NULL, &error);
    boxlite_stop_box(box, NULL);
    return NULL;
}

// Create one runtime, share across threads
CBoxliteRuntime* runtime = boxlite_runtime_new(NULL, NULL, &error);

pthread_t threads[4];
for (int i = 0; i < 4; i++) {
    pthread_create(&threads[i], NULL, thread_func, runtime);
}

// Wait for threads
for (int i = 0; i < 4; i++) {
    pthread_join(threads[i], NULL);
}

boxlite_runtime_free(runtime);
```

---

## Platform Requirements

### macOS

- **Architecture**: arm64 (Apple Silicon) or x86_64 (Intel)
- **Requirements**: Hypervisor.framework entitlement
- **Library**: `libboxlite.dylib`

### Linux

- **Architecture**: x86_64 or aarch64
- **Requirements**: KVM enabled (`/dev/kvm` accessible)
- **Library**: `libboxlite.so`

### Checking Platform Support

```c
#include <stdio.h>
#include "boxlite.h"

int main() {
    char* error = NULL;

    CBoxliteRuntime* runtime = boxlite_runtime_new(NULL, NULL, &error);
    if (!runtime) {
        fprintf(stderr, "Platform not supported: %s\n", error);
        boxlite_free_string(error);
        return 1;
    }

    printf("BoxLite %s ready\n", boxlite_version());
    boxlite_runtime_free(runtime);
    return 0;
}
```

---

## Complete Example

```c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "boxlite.h"

// Output buffer for collecting results
typedef struct {
    char* buffer;
    size_t size;
    size_t capacity;
} OutputBuffer;

void init_buffer(OutputBuffer* buf) {
    buf->capacity = 1024;
    buf->buffer = malloc(buf->capacity);
    buf->buffer[0] = '\0';
    buf->size = 0;
}

void append_buffer(OutputBuffer* buf, const char* text) {
    size_t len = strlen(text);
    while (buf->size + len + 1 > buf->capacity) {
        buf->capacity *= 2;
        buf->buffer = realloc(buf->buffer, buf->capacity);
    }
    strcpy(buf->buffer + buf->size, text);
    buf->size += len;
}

void free_buffer(OutputBuffer* buf) {
    free(buf->buffer);
    buf->buffer = NULL;
}

void collect_output(const char* text, int is_stderr, void* user_data) {
    if (!is_stderr) {
        OutputBuffer* buf = (OutputBuffer*)user_data;
        append_buffer(buf, text);
    }
}

int main(int argc, char* argv[]) {
    char* error = NULL;
    int result = 1;

    CBoxliteRuntime* runtime = NULL;
    CBoxHandle* box = NULL;
    OutputBuffer output;
    init_buffer(&output);

    // Print version
    printf("BoxLite C SDK v%s\n", boxlite_version());

    // Create runtime
    runtime = boxlite_runtime_new(NULL, NULL, &error);
    if (!runtime) {
        fprintf(stderr, "Failed to create runtime: %s\n", error);
        boxlite_free_string(error);
        goto cleanup;
    }

    // Create Python box with volume mount
    const char* options = "{"
        "\"rootfs\":{\"Image\":\"python:3.11-slim\"},"
        "\"cpus\":2,"
        "\"memory_mib\":1024,"
        "\"working_dir\":\"/app\""
    "}";

    box = boxlite_create_box(runtime, options, &error);
    if (!box) {
        fprintf(stderr, "Failed to create box: %s\n", error);
        boxlite_free_string(error);
        goto cleanup;
    }

    printf("Box created successfully\n");

    // Run Python code
    const char* python_code = "print('Hello from Python in BoxLite!')";
    char args_json[512];
    snprintf(args_json, sizeof(args_json), "[\"-c\", \"%s\"]", python_code);

    int exit_code = boxlite_execute(box, "python3", args_json, collect_output, &output, &error);
    if (exit_code < 0) {
        fprintf(stderr, "Execution failed: %s\n", error);
        boxlite_free_string(error);
        goto cleanup;
    }

    printf("Output: %s", output.buffer);
    printf("Exit code: %d\n", exit_code);

    result = exit_code;

cleanup:
    free_buffer(&output);
    if (box) {
        if (boxlite_stop_box(box, &error) != 0) {
            fprintf(stderr, "Warning: failed to stop box: %s\n", error);
            boxlite_free_string(error);
        }
    }
    if (runtime) {
        boxlite_runtime_free(runtime);
    }
    return result;
}
```

---

## API Summary

| Function | Description |
|----------|-------------|
| `boxlite_version()` | Get version string |
| `boxlite_runtime_new()` | Create runtime instance |
| `boxlite_runtime_free()` | Free runtime instance |
| `boxlite_create_box()` | Create a new box |
| `boxlite_execute()` | Run command in box |
| `boxlite_stop_box()` | Stop and free box |
| `boxlite_free_string()` | Free BoxLite-allocated string |

---

## See Also

- [Getting Started Guide](../../getting-started/README.md)
- [Rust API Reference](../rust/README.md)
- [Configuration Reference](../README.md)
- [Architecture Overview](../../architecture/README.md)
