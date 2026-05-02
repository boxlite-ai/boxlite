# C SDK API Reference

Complete API reference for the BoxLite C SDK.

## Overview

The C SDK provides C-compatible FFI bindings for integrating BoxLite into C/C++ applications.

**Library**: `libboxlite`
**Header**: `boxlite.h`
**C Standard**: C11-compatible compiler (GCC/Clang)

### API Styles

The SDK provides two API styles:

1. **Simple API** (`boxlite_simple_*`) - Convenience layer for common use cases
   - No runtime setup required
   - Auto-managed runtime
   - Buffered command results

2. **Native API** (`boxlite_*`) - Full-featured, flexible interface
   - Typed `CBoxliteOptions` configuration
   - Streaming output callbacks
   - Advanced features (volumes, networking, etc.)

---

## Table of Contents

- [Quick Start](#quick-start)
- [Error Handling](#error-handling)
  - [BoxliteErrorCode](#boxliteerrorcode)
  - [CBoxliteError](#cboxliteerror)
  - [Error Handling Patterns](#error-handling-patterns)
- [Simple API](#simple-api)
  - [boxlite_simple_new](#boxlite_simple_new)
  - [boxlite_simple_run](#boxlite_simple_run)
  - [boxlite_simple_free](#boxlite_simple_free)
  - [boxlite_result_free](#boxlite_result_free)
- [Native API](#native-api)
  - [Runtime Management](#runtime-management)
  - [Box Management](#box-management)
  - [Command Execution](#command-execution)
  - [Discovery & Introspection](#discovery--introspection)
  - [Metrics](#metrics)
- [Memory Management](#memory-management)
- [Thread Safety](#thread-safety)
- [Platform Requirements](#platform-requirements)
- [Migration from v0.1.x](#migration-from-v01x)

---

## Quick Start

### Simple API (Recommended)

```c
#include <stdio.h>
#include "boxlite.h"

int main() {
    CBoxliteSimple* box = NULL;
    CBoxliteError error = {0};

    // Create box and auto-start it
    if (boxlite_simple_new("python:slim", 0, 0, &box, &error) != Ok) {
        fprintf(stderr, "Error %d: %s\n", error.code, error.message);
        boxlite_error_free(&error);
        return 1;
    }

    // Run command and get buffered result
    const char* args[] = {"-c", "print('Hello from BoxLite!')", NULL};
    CBoxliteExecResult* result = NULL;

    if (boxlite_simple_run(box, "python", args, 2, &result, &error) == Ok) {
        printf("Output: %s\n", result->stdout_text);
        printf("Exit code: %d\n", result->exit_code);
        boxlite_result_free(result);
    }

    boxlite_simple_free(box);  // Auto-cleanup
    return 0;
}
```

### Native API (Full Control)

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
    if (boxlite_runtime_new(NULL, NULL, 0, &runtime, &error) != Ok) {
        fprintf(stderr, "Error %d: %s\n", error.code, error.message);
        boxlite_error_free(&error);
        return 1;
    }

    // Create box with typed options
    CBoxliteOptions* opts = NULL;
    if (boxlite_options_new("alpine:3.19", &opts, &error) != Ok) {
        fprintf(stderr, "Error %d: %s\n", error.code, error.message);
        boxlite_error_free(&error);
        boxlite_runtime_free(runtime);
        return 1;
    }
    boxlite_options_set_network_enabled(opts);

    if (boxlite_create_box(runtime, opts, &box, &error) != Ok) {
        fprintf(stderr, "Error %d: %s\n", error.code, error.message);
        boxlite_error_free(&error);
        boxlite_options_free(opts);
        boxlite_runtime_free(runtime);
        return 1;
    }
    boxlite_options_free(opts);

    // Start command with streaming output, then wait for completion
    int exit_code = 0;
    const char* args[] = {"-la", "/"};
    BoxliteCommand cmd = {.command = "/bin/ls", .args = args, .argc = 2};
    CExecutionHandle* execution = NULL;

    if (boxlite_execute(box, &cmd, output_callback, NULL, &execution, &error) == Ok) {
        if (boxlite_execution_wait(execution, &exit_code, &error) == Ok) {
            printf("\nExit code: %d\n", exit_code);
        }
        boxlite_execution_free(execution);
    }
    if (error.code != Ok) {
        fprintf(stderr, "Error: %s\n", error.message);
        boxlite_error_free(&error);
    }

    // Cleanup
    boxlite_runtime_free(runtime);
    return 0;
}
```

### Building

```bash
# Compile with the BoxLite library
gcc -I/path/to/boxlite/sdks/c/include \
    -L/path/to/boxlite/target/release \
    -lboxlite \
    my_program.c -o my_program

# macOS: Set library path
export DYLD_LIBRARY_PATH=/path/to/boxlite/target/release:$DYLD_LIBRARY_PATH

# Linux: Set library path
export LD_LIBRARY_PATH=/path/to/boxlite/target/release:$LD_LIBRARY_PATH
```

---

## Error Handling

The C SDK introduces structured error handling with error codes and detailed messages.

### BoxliteErrorCode

All API functions return `BoxliteErrorCode` to indicate success or failure type:

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

### CBoxliteError

Detailed error information for debugging:

```c
typedef struct CBoxliteError {
    BoxliteErrorCode code;  // Error code for programmatic handling
    char* message;          // Detailed message (NULL if none)
} CBoxliteError;
```

### Error Handling Patterns

**Pattern 1: Basic Check**

```c
CBoxliteError error = {0};
BoxliteErrorCode code = boxlite_simple_new("alpine:3.19", 0, 0, &box, &error);

if (code != Ok) {
    fprintf(stderr, "Error %d: %s\n", error.code, error.message);
    boxlite_error_free(&error);
    return 1;
}
```

**Pattern 2: Switch on Error Code**

```c
BoxliteErrorCode code = boxlite_get(runtime, "box-id", &box, &error);

switch (code) {
    case Ok:
        // Success - use box
        break;
    case NotFound:
        fprintf(stderr, "Box not found\n");
        break;
    case InvalidState:
        fprintf(stderr, "Box in invalid state\n");
        break;
    default:
        fprintf(stderr, "Error %d: %s\n", error.code, error.message);
}

boxlite_error_free(&error);
```

**Pattern 3: Retry Logic**

```c
int retries = 3;
for (int i = 0; i < retries; i++) {
    code = boxlite_simple_new("alpine:3.19", 0, 0, &box, &error);
    if (code == Ok) break;

    fprintf(stderr, "Retry %d/%d: %s\n", i+1, retries, error.message);
    boxlite_error_free(&error);

    if (code == InvalidArgument || code == Unsupported) {
        break;  // Non-retryable errors
    }
    sleep(1);  // Backoff
}
```

---

## Simple API

The Simple API provides a streamlined interface for common use cases.

### boxlite_simple_new

Create and auto-start a box with sensible defaults.

```c
BoxliteErrorCode boxlite_simple_new(
    const char* image,
    int cpus,
    int memory_mib,
    CBoxliteSimple** out_box,
    CBoxliteError* out_error
);
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `image` | `const char*` | OCI image reference (e.g., `"python:slim"`, `"alpine:3.19"`) |
| `cpus` | `int` | Number of CPUs (0 = default: 2) |
| `memory_mib` | `int` | Memory in MiB (0 = default: 512) |
| `out_box` | `CBoxliteSimple**` | Output: created box handle |
| `out_error` | `CBoxliteError*` | Output: error information |

#### Returns

`BoxliteErrorCode` - `Ok` on success, error code on failure.

#### Example

```c
CBoxliteSimple* box = NULL;
CBoxliteError error = {0};

// Default resources
if (boxlite_simple_new("alpine:3.19", 0, 0, &box, &error) != Ok) {
    fprintf(stderr, "Error: %s\n", error.message);
    boxlite_error_free(&error);
    return 1;
}

// Custom resources
if (boxlite_simple_new("python:slim", 4, 2048, &box, &error) != Ok) {
    // Handle error
}
```

---

### boxlite_simple_run

Run a command and get buffered result.

```c
BoxliteErrorCode boxlite_simple_run(
    CBoxliteSimple* box,
    const char* command,
    const char* const* args,
    int argc,
    CBoxliteExecResult** out_result,
    CBoxliteError* out_error
);
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `box` | `CBoxliteSimple*` | Box handle from `boxlite_simple_new` |
| `command` | `const char*` | Command to execute |
| `args` | `const char* const*` | NULL-terminated array of arguments |
| `argc` | `int` | Number of arguments (excluding NULL terminator) |
| `out_result` | `CBoxliteExecResult**` | Output: execution result |
| `out_error` | `CBoxliteError*` | Output: error information |

#### Result Structure

```c
typedef struct CBoxliteExecResult {
    int exit_code;       // Command exit code
    char* stdout_text;   // Standard output
    char* stderr_text;   // Standard error
} CBoxliteExecResult;
```

#### Example

```c
const char* args[] = {"-c", "print('hello')", NULL};
CBoxliteExecResult* result = NULL;

if (boxlite_simple_run(box, "python", args, 2, &result, &error) == Ok) {
    printf("stdout: %s\n", result->stdout_text);
    printf("stderr: %s\n", result->stderr_text);
    printf("exit: %d\n", result->exit_code);
    boxlite_result_free(result);
}
```

---

### boxlite_simple_free

Free a simple box (auto-stops and removes).

```c
void boxlite_simple_free(CBoxliteSimple* box);
```

Safe to call with NULL.

---

### boxlite_result_free

Free an execution result.

```c
void boxlite_result_free(CBoxliteExecResult* result);
```

Safe to call with NULL.

---

## Native API

### Runtime Management

#### boxlite_version

Get BoxLite version string.

```c
const char* boxlite_version(void);
```

Returns static string (do not free). Example: `"0.5.7"`.

---

#### boxlite_runtime_new

Create a new runtime instance.

```c
typedef enum BoxliteRegistryTransport {
    BoxliteRegistryTransportHttps = 0,
    BoxliteRegistryTransportHttp = 1,
} BoxliteRegistryTransport;

typedef struct BoxliteImageRegistry {
    const char* host;
    BoxliteRegistryTransport transport;
    int skip_verify;
    int search;
    const char* username;
    const char* password;
    const char* bearer_token;
} BoxliteImageRegistry;

BoxliteErrorCode boxlite_runtime_new(
    const char* home_dir,
    const BoxliteImageRegistry* image_registries,
    int image_registries_count,
    CBoxliteRuntime** out_runtime,
    CBoxliteError* out_error
);
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `home_dir` | `const char*` | Path to BoxLite home. `NULL` = default (`~/.boxlite`) |
| `image_registries` | `const BoxliteImageRegistry*` | Optional registry transport, TLS, search, and auth settings |
| `image_registries_count` | `int` | Number of entries in `image_registries` |
| `out_runtime` | `CBoxliteRuntime**` | Output: runtime handle |
| `out_error` | `CBoxliteError*` | Output: error information |

#### Example

```c
CBoxliteRuntime* runtime = NULL;
CBoxliteError error = {0};

// Default configuration
if (boxlite_runtime_new(NULL, NULL, 0, &runtime, &error) != Ok) {
    fprintf(stderr, "Error: %s\n", error.message);
    boxlite_error_free(&error);
    return 1;
}

// Custom registries
BoxliteImageRegistry image_registries[] = {
  {
    .host = "ghcr.io",
    .transport = BoxliteRegistryTransportHttps,
    .skip_verify = 0,
    .search = 1,
    .username = NULL,
    .password = NULL,
    .bearer_token = NULL,
  },
  {
    .host = "registry.example.com",
    .transport = BoxliteRegistryTransportHttps,
    .skip_verify = 0,
    .search = 0,
    .username = "user",
    .password = "password",
    .bearer_token = NULL,
  },
};
if (boxlite_runtime_new("/var/lib/boxlite", image_registries, 2, &runtime, &error) != Ok) {
    // Handle error
}
```

---

#### boxlite_runtime_shutdown

Gracefully stop all running boxes.

```c
BoxliteErrorCode boxlite_runtime_shutdown(
    CBoxliteRuntime* runtime,
    int timeout,
    CBoxliteError* out_error
);
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `runtime` | `CBoxliteRuntime*` | Runtime instance |
| `timeout` | `int` | Seconds: 0=default(10), -1=infinite, >0=custom |
| `out_error` | `CBoxliteError*` | Output: error information |

---

#### boxlite_runtime_free

Free a runtime instance.

```c
void boxlite_runtime_free(CBoxliteRuntime* runtime);
```

Safe to call with NULL. Automatically frees all boxes.

---

### Box Management

#### boxlite_create_box

Create and auto-start a box.

```c
BoxliteErrorCode boxlite_create_box(
    CBoxliteRuntime* runtime,
    CBoxliteOptions* opts,
    CBoxHandle** out_box,
    CBoxliteError* out_error
);
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `runtime` | `CBoxliteRuntime*` | Runtime instance |
| `opts` | `CBoxliteOptions*` | Box options created with `boxlite_options_new()` |
| `out_box` | `CBoxHandle**` | Output: box handle |
| `out_error` | `CBoxliteError*` | Output: error information |

#### Example

```c
CBoxliteOptions* opts = NULL;
if (boxlite_options_new("alpine:3.19", &opts, &error) != Ok) {
    // Handle error
}
boxlite_options_set_cpus(opts, 2);
boxlite_options_set_memory(opts, 512);
boxlite_options_set_network_enabled(opts);

CBoxHandle* box = NULL;
if (boxlite_create_box(runtime, opts, &box, &error) != Ok) {
    fprintf(stderr, "Error: %s\n", error.message);
    boxlite_error_free(&error);
}
boxlite_options_free(opts);
```

---

#### boxlite_start_box

Start or restart a stopped box.

```c
BoxliteErrorCode boxlite_start_box(
    CBoxHandle* handle,
    CBoxliteError* out_error
);
```

---

#### boxlite_stop_box

Stop a running box.

```c
BoxliteErrorCode boxlite_stop_box(
    CBoxHandle* handle,
    CBoxliteError* out_error
);
```

**Note:** Consumes the handle - do not use after calling.

---

#### boxlite_remove

Remove a box.

```c
BoxliteErrorCode boxlite_remove(
    CBoxliteRuntime* runtime,
    const char* id_or_name,
    int force,
    CBoxliteError* out_error
);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `id_or_name` | `const char*` | Box ID (full or prefix) or name |
| `force` | `int` | Non-zero to force remove running box |

---

#### boxlite_get

Reattach to an existing box.

```c
BoxliteErrorCode boxlite_get(
    CBoxliteRuntime* runtime,
    const char* id_or_name,
    CBoxHandle** out_handle,
    CBoxliteError* out_error
);
```

---

#### boxlite_box_id

Get box ID string from handle.

```c
char* boxlite_box_id(CBoxHandle* handle);
```

**Important:** Caller must free with `boxlite_free_string()`.

---

#### boxlite_box_free

Free a box handle.

```c
void boxlite_box_free(CBoxHandle* handle);
```

Safe to call with NULL. Use when you need to release a box handle without freeing the entire runtime.

---

### Command Execution

#### boxlite_execute

Start a command with optional streaming output and return an execution handle.

```c
typedef struct BoxliteCommand {
    const char* command;      // Required: command to execute
    const char* const* args;  // Argument array, or NULL
    int argc;                 // Number of entries in args
    const char* const* env_pairs; // [key0, value0, key1, value1, ...], or NULL
    int env_count;            // Number of strings in env_pairs
    const char* workdir;      // Working directory, or NULL
    const char* user;         // User spec (e.g., "nobody", "1000:1000"), or NULL
    double timeout_secs;      // Timeout in seconds (0.0 = no timeout)
    int tty;                  // 0 = no TTY, non-zero = TTY
} BoxliteCommand;

BoxliteErrorCode boxlite_execute(
    CBoxHandle* handle,
    const BoxliteCommand* cmd,
    void (*callback)(const char* text, int is_stderr, void* user_data),
    void* user_data,
    CExecutionHandle** out_execution,
    CBoxliteError* out_error
);
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `handle` | `CBoxHandle*` | Box handle |
| `cmd` | `const BoxliteCommand*` | Command descriptor |
| `callback` | function pointer | Optional streaming output callback |
| `user_data` | `void*` | User data passed to callback |
| `out_execution` | `CExecutionHandle**` | Output: execution handle |
| `out_error` | `CBoxliteError*` | Output: error information |

#### Callback Signature

```c
void callback(const char* text, int is_stderr, void* user_data);
```

| Parameter | Description |
|-----------|-------------|
| `text` | Output text chunk |
| `is_stderr` | `0` for stdout, `1` for stderr |
| `user_data` | User data from `boxlite_execute` |

#### Example

```c
void output_handler(const char* text, int is_stderr, void* data) {
    FILE* stream = is_stderr ? stderr : stdout;
    fprintf(stream, "%s", text);
}

int exit_code = 0;
const char* args[] = {"-c", "print('hello')"};
BoxliteCommand cmd = {.command = "python", .args = args, .argc = 2};
CExecutionHandle* execution = NULL;
BoxliteErrorCode code = boxlite_execute(
    box,
    &cmd,
    output_handler,
    NULL,
    &execution,
    &error
);

if (code == Ok) {
    code = boxlite_execution_wait(execution, &exit_code, &error);
    boxlite_execution_free(execution);
}
if (code == Ok) {
    printf("Exit code: %d\n", exit_code);
}
```

---

#### Execution Control

```c
BoxliteErrorCode boxlite_execution_write(CExecutionHandle* execution, const char* data, int len, CBoxliteError* out_error);
BoxliteErrorCode boxlite_execution_wait(CExecutionHandle* execution, int* out_exit_code, CBoxliteError* out_error);
BoxliteErrorCode boxlite_execution_kill(CExecutionHandle* execution, CBoxliteError* out_error);
BoxliteErrorCode boxlite_execution_resize_tty(CExecutionHandle* execution, int rows, int cols, CBoxliteError* out_error);
void boxlite_execution_free(CExecutionHandle* execution);
```

#### Example: command options

```c
const char* args[] = {"-c", "import os; print(os.getcwd())"};
const char* env[] = {"MY_VAR", "hello"};
BoxliteCommand cmd = {
    .command = "python",
    .args = args,
    .argc = 2,
    .env_pairs = env,
    .env_count = 2,
    .workdir = "/tmp",
    .user = "nobody",
    .timeout_secs = 30.0,
};

int exit_code = 0;
CExecutionHandle* execution = NULL;
BoxliteErrorCode code =
    boxlite_execute(box, &cmd, output_handler, NULL, &execution, &error);
if (code == Ok) {
    code = boxlite_execution_wait(execution, &exit_code, &error);
    boxlite_execution_free(execution);
}
```

---

### Discovery & Introspection

#### boxlite_list_info

List all boxes.

```c
BoxliteErrorCode boxlite_list_info(
    CBoxliteRuntime* runtime,
    CBoxInfoList** out_list,
    CBoxliteError* out_error
);
```

Caller must free `out_list` with `boxlite_free_box_info_list()`.

---

#### boxlite_get_info

Get single box info by ID or name.

```c
BoxliteErrorCode boxlite_get_info(
    CBoxliteRuntime* runtime,
    const char* id_or_name,
    CBoxInfo** out_info,
    CBoxliteError* out_error
);
```

---

#### boxlite_box_info

Get box info from handle.

```c
BoxliteErrorCode boxlite_box_info(
    CBoxHandle* handle,
    CBoxInfo** out_info,
    CBoxliteError* out_error
);
```

Caller must free `out_info` with `boxlite_free_box_info()`.

```c
CBoxInfo* info = NULL;
if (boxlite_box_info(box, &info, &error) == Ok) {
    printf("Box %s status: %s\n", info->id, info->status);
    boxlite_free_box_info(info);
}
```

---

### Metrics

#### boxlite_runtime_metrics

Get runtime-wide metrics.

```c
BoxliteErrorCode boxlite_runtime_metrics(
    CBoxliteRuntime* runtime,
    CRuntimeMetrics* out_metrics,
    CBoxliteError* out_error
);
```

---

#### boxlite_box_metrics

Get per-box metrics.

```c
BoxliteErrorCode boxlite_box_metrics(
    CBoxHandle* handle,
    CBoxMetrics* out_metrics,
    CBoxliteError* out_error
);
```

---

## Memory Management

### Rules

1. **All allocated strings must be freed**
   - `boxlite_box_id()` → `boxlite_free_string()`

2. **Error structs must be freed**
   - `CBoxliteError` → `boxlite_error_free()`

3. **Results must be freed**
   - `CBoxliteExecResult` → `boxlite_result_free()`
   - `CBoxInfo` → `boxlite_free_box_info()`
   - `CBoxInfoList` → `boxlite_free_box_info_list()`
   - `CImagePullResult` → `boxlite_free_image_pull_result()`
   - `CImageInfoList` → `boxlite_free_image_info_list()`

4. **All cleanup functions are NULL-safe**

### Functions

#### boxlite_free_string

Free a string allocated by BoxLite.

```c
void boxlite_free_string(char* str);
```

---

#### boxlite_error_free

Free error struct (message only - struct itself is stack-allocated).

```c
void boxlite_error_free(CBoxliteError* error);
```

---

#### boxlite_box_free

Free a box handle.

```c
void boxlite_box_free(CBoxHandle* handle);
```

Safe to call with NULL.

---

## Thread Safety

| Component | Thread Safety |
|-----------|---------------|
| `CBoxliteRuntime` | Thread-safe |
| `CBoxHandle` | **NOT** thread-safe - do not share across threads |
| `CBoxliteSimple` | **NOT** thread-safe - do not share across threads |
| Callbacks | Invoked on the calling thread |

### Safe Multi-threaded Usage

```c
// CORRECT: Share runtime, create per-thread boxes
void* thread_func(void* arg) {
    CBoxliteRuntime* runtime = (CBoxliteRuntime*)arg;
    CBoxliteError error = {0};
    CBoxliteOptions* opts = NULL;
    CBoxHandle* box = NULL;

    // Each thread creates its own box
    boxlite_options_new("alpine:3.19", &opts, &error);
    boxlite_create_box(runtime, opts, &box, &error);
    boxlite_options_free(opts);
    // Use box in this thread only
    boxlite_stop_box(box, &error);
    return NULL;
}

CBoxliteRuntime* runtime;
boxlite_runtime_new(NULL, NULL, 0, &runtime, &error);

pthread_t threads[4];
for (int i = 0; i < 4; i++) {
    pthread_create(&threads[i], NULL, thread_func, runtime);
}
```

---

## Platform Requirements

| Platform | Architecture | Status | Requirements |
|----------|-------------|--------|--------------|
| macOS | ARM64 (Apple Silicon) | Supported | macOS 11.0+, Hypervisor.framework |
| macOS | x86_64 (Intel) | **Not supported** | N/A |
| Linux | x86_64 | Supported | KVM enabled |
| Linux | ARM64 (aarch64) | Supported | KVM enabled |
| Windows | Any | Via WSL2 | WSL2 with KVM |

---

## Migration from v0.1.x

### Error Handling Change

**v0.1.x (old):**
```c
char* error = NULL;
CBoxliteRuntime* runtime = boxlite_runtime_new(NULL, &error);
if (!runtime) {
    fprintf(stderr, "Error: %s\n", error);
    boxlite_free_string(error);
    return 1;
}
```

**v0.2.0 (new):**
```c
CBoxliteRuntime* runtime = NULL;
CBoxliteError error = {0};
BoxliteErrorCode code = boxlite_runtime_new(NULL, NULL, 0, &runtime, &error);
if (code != Ok) {
    fprintf(stderr, "Error %d: %s\n", error.code, error.message);
    boxlite_error_free(&error);
    return 1;
}
```

### Execute Change

**v0.1.x:**
```c
int exit_code = old_execute_api_returning_exit_code(...);
if (exit_code < 0) {
    // Error
}
```

**v0.2.0:**
```c
int exit_code = 0;
const char* args[] = {"hello"};
BoxliteCommand cmd = {.command = "echo", .args = args, .argc = 1};
CExecutionHandle* execution = NULL;
BoxliteErrorCode code =
    boxlite_execute(box, &cmd, callback, NULL, &execution, &error);
if (code == Ok) {
    code = boxlite_execution_wait(execution, &exit_code, &error);
    boxlite_execution_free(execution);
}
if (code != Ok) {
    // Error
}
```

### Migration Checklist

- [ ] Replace `char* error = NULL` with `CBoxliteError error = {0}`
- [ ] Initialize output pointers to NULL (e.g., `CBoxliteRuntime* runtime = NULL`)
- [ ] Update all function calls to use output parameters
- [ ] Replace return value checks with `BoxliteErrorCode` checks
- [ ] Replace `boxlite_free_string(error)` with `boxlite_error_free(&error)`
- [ ] Create boxes with `CBoxliteOptions`

---

## API Summary

| Function | Description |
|----------|-------------|
| `boxlite_version()` | Get version string |
| `boxlite_runtime_new()` | Create runtime |
| `boxlite_runtime_shutdown()` | Graceful shutdown |
| `boxlite_runtime_free()` | Free runtime |
| `boxlite_runtime_metrics()` | Get runtime metrics |
| `boxlite_create_box()` | Create box |
| `boxlite_start_box()` | Start/restart box |
| `boxlite_stop_box()` | Stop box |
| `boxlite_remove()` | Remove box |
| `boxlite_get()` | Reattach to box |
| `boxlite_box_id()` | Get box ID |
| `boxlite_box_free()` | Free box handle |
| `boxlite_box_info()` | Get box info |
| `boxlite_box_metrics()` | Get box metrics |
| `boxlite_execute()` | Execute command |
| `boxlite_list_info()` | List all boxes |
| `boxlite_get_info()` | Get box info by ID |
| `boxlite_simple_new()` | Create simple box |
| `boxlite_simple_run()` | Run command (simple) |
| `boxlite_simple_free()` | Free simple box |
| `boxlite_result_free()` | Free exec result |
| `boxlite_free_string()` | Free string |
| `boxlite_error_free()` | Free error |

---

## Common Patterns

### Streaming Output

```c
void output_callback(const char* text, int is_stderr, void* user_data) {
    FILE* stream = is_stderr ? stderr : stdout;
    fprintf(stream, "%s", text);
}

int exit_code = 0;
const char* args[] = {"-c", "print('hello')"};
BoxliteCommand cmd = {.command = "python", .args = args, .argc = 2};
CExecutionHandle* execution = NULL;
if (boxlite_execute(box, &cmd, output_callback, NULL, &execution, &error) == Ok) {
    boxlite_execution_wait(execution, &exit_code, &error);
    boxlite_execution_free(execution);
}
```

### Reattach to Box

```c
// Get box ID
char* box_id = boxlite_box_id(box);

// Later, in different process:
CBoxHandle* box2 = NULL;
boxlite_get(runtime, box_id, &box2, &error);

boxlite_free_string(box_id);
```

### Get Box Info

```c
CBoxInfo* info = NULL;
if (boxlite_box_info(box, &info, &error) == Ok) {
    printf("Box %s status: %s\n", info->id, info->status);
    boxlite_free_box_info(info);
}
```

---

## Common Mistakes

### Uninitialized error struct

```c
CBoxliteError error;       // Wrong: uninitialized
CBoxliteError error = {0}; // Correct: zero-initialized
```

### Forgetting to free error

```c
if (code != Ok) {
    printf("Error: %s\n", error.message);
    return 1;                       // Wrong: memory leak
}

if (code != Ok) {
    printf("Error: %s\n", error.message);
    boxlite_error_free(&error);     // Correct
    return 1;
}
```

### Forgetting to free result structs

```c
CBoxInfoList* list;
boxlite_list_info(runtime, &list, &error);
// Wrong: forgot to free

CBoxInfoList* list;
boxlite_list_info(runtime, &list, &error);
boxlite_free_box_info_list(list);  // Correct
```

---

## Build & Link

### CMake

```cmake
cmake_minimum_required(VERSION 3.15)
project(my_app)

set(BOXLITE_INCLUDE "/path/to/boxlite/sdks/c/include")
set(BOXLITE_LIB_DIR "/path/to/boxlite/target/release")

include_directories(${BOXLITE_INCLUDE})

add_executable(my_app main.c)
target_link_libraries(my_app ${BOXLITE_LIB_DIR}/libboxlite.dylib)
```

### Direct Compilation

```bash
# macOS
gcc -o myapp myapp.c \
    -I/path/to/boxlite/sdks/c/include \
    -L/path/to/boxlite/target/release \
    -lboxlite

export DYLD_LIBRARY_PATH=/path/to/boxlite/target/release:$DYLD_LIBRARY_PATH
./myapp

# Linux
gcc -o myapp myapp.c \
    -I/path/to/boxlite/sdks/c/include \
    -L/path/to/boxlite/target/release \
    -lboxlite

export LD_LIBRARY_PATH=/path/to/boxlite/target/release:$LD_LIBRARY_PATH
./myapp
```

---

## See Also

- **[C SDK README](../../../sdks/c/README.md)** - Full SDK documentation
- **[C Quick Start](../../getting-started/quickstart-c.md)** - 5-minute guide
- **[C Examples](../../../examples/c/)** - Working examples
- **[Architecture](../../architecture/README.md)** - How BoxLite works
