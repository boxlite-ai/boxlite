# BoxLite C SDK — Integration Patterns

The C SDK provides two APIs. Choose based on your needs:

| API | When to use |
|-----|-------------|
| **Simple API** (`boxlite_simple_*`) | Quick integration, buffered output, auto-managed runtime |
| **Native API** (`boxlite_*`) | Streaming output, custom config, multi-box, advanced control |

---

## Build & Link

```bash
# Build from source (requires Rust toolchain)
cargo build --release -p boxlite-c

# Link your program
gcc -Isdks/c/include -Ltarget/release -lboxlite your_agent.c -o agent

# macOS: set rpath
install_name_tool -add_rpath $(pwd)/target/release agent

# Linux: set library path
export LD_LIBRARY_PATH=$(pwd)/target/release:$LD_LIBRARY_PATH
```

Or use CMake — see `examples/c/CMakeLists.txt`.

---

## Simple API — Recommended Starting Point

The Simple API is synchronous and handles runtime management automatically.

```c
#include <stdio.h>
#include "boxlite.h"

int main() {
    CBoxliteSimple* box;
    CBoxliteError error = {0};

    if (boxlite_simple_new("python:slim", 0, 0, &box, &error) != Ok) {
        fprintf(stderr, "Error %d: %s\n", error.code, error.message);
        boxlite_error_free(&error);
        return 1;
    }

    const char* args[] = {"-c", "print('hello from sandbox')", NULL};
    CBoxliteExecResult* result;

    if (boxlite_simple_run(box, "python", args, 2, &result, &error) == Ok) {
        printf("stdout: %s\n", result->stdout_text);
        printf("exit: %d\n", result->exit_code);
        boxlite_result_free(result);
    } else {
        fprintf(stderr, "exec error: %s\n", error.message);
        boxlite_error_free(&error);
    }

    boxlite_simple_free(box); // auto-stop and remove
    return 0;
}
```

---

## Native API — Callback-based

The Native API is asynchronous. Lifecycle operations (`create`, `start`, `stop`, `remove`) and execution wait/kill deliver results via callbacks. `boxlite_box_exec` itself is synchronous and returns a `CExecutionHandle*` immediately — stream callbacks and wait are registered on that handle afterwards.

```c
#include <stdio.h>
#include "boxlite.h"

void on_stdout(const char* data, void* user_data) {
    printf("%s", data);
}

void on_exit(int exit_code, CBoxliteError* err, void* user_data) {
    printf("exit code: %d\n", exit_code);
}

void on_start(CBoxliteError* err, void* user_data) {
    if (err && err->code != Ok) {
        fprintf(stderr, "start failed: %s\n", err->message);
        return;
    }
    CBoxHandle* box = (CBoxHandle*)user_data;

    // boxlite_box_exec is synchronous — returns CExecutionHandle* immediately
    CExecutionHandle* execution = NULL;
    CBoxliteError exec_err = {0};
    BoxliteCommand cmd = {
        .command = "python",
        .args = (const char*[]){"-c", "print('hello')"},
        .argc = 2,
        .timeout_secs = 30.0,
    };
    if (boxlite_box_exec(box, &cmd, &execution, &exec_err) != Ok) {
        fprintf(stderr, "exec failed: %s\n", exec_err.message);
        boxlite_error_free(&exec_err);
        return;
    }

    // register stream + exit callbacks
    CBoxliteError cb_err = {0};
    boxlite_execution_on_stdout(execution, on_stdout, NULL, &cb_err);
    // boxlite_execution_wait is async — exit code arrives in on_exit callback
    boxlite_execution_wait(execution, on_exit, NULL, &cb_err);
    boxlite_execution_free(execution);
}

void on_create(CBoxHandle* box, CBoxliteError* err, void* user_data) {
    if (err && err->code != Ok) {
        fprintf(stderr, "create failed: %s\n", err->message);
        return;
    }
    CBoxliteError start_err = {0};
    // boxlite_start_box is async — result arrives in on_start callback
    boxlite_start_box(box, on_start, box, &start_err);
    if (start_err.code != Ok) {
        fprintf(stderr, "start dispatch failed: %s\n", start_err.message);
        boxlite_error_free(&start_err);
    }
}

int main() {
    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};

    if (boxlite_runtime_new(NULL, NULL, 0, &runtime, &error) != Ok) {
        fprintf(stderr, "runtime error: %s\n", error.message);
        boxlite_error_free(&error);
        return 1;
    }

    CBoxliteOptions* opts = NULL;
    boxlite_options_new("python:slim", &opts, &error);

    // boxlite_create_box is async — result arrives in on_create callback
    boxlite_create_box(runtime, opts, on_create, NULL, &error);
    boxlite_options_free(opts);

    // boxlite_runtime_free blocks until all pending callbacks complete, then frees all boxes
    boxlite_runtime_free(runtime);
    return 0;
}
```

**Summary of sync vs async:**

| Function | Sync/Async | Result delivery |
|----------|-----------|-----------------|
| `boxlite_box_exec` | Sync | `CExecutionHandle*` out-param |
| `boxlite_create_box` | Async | callback `CBoxHandle*` |
| `boxlite_start_box` | Async | callback `CBoxliteError*` |
| `boxlite_stop_box` | Async | callback `CBoxliteError*` |
| `boxlite_remove` | Async | callback `CBoxliteError*` |
| `boxlite_execution_wait` | Async | callback `int exit_code` |
| `boxlite_execution_kill` | Async | callback `CBoxliteError*` |

---

## Memory Management Rules

Every allocated value must be freed with the matching function:

| Value | Free with |
|-------|-----------|
| `CBoxliteRuntime*` | `boxlite_runtime_free()` (blocks until all callbacks done) |
| `CBoxHandle*` | `boxlite_box_free()` |
| `CBoxliteSimple*` | `boxlite_simple_free()` |
| `CBoxliteOptions*` | `boxlite_options_free()` |
| `CBoxliteError` | `boxlite_error_free()` |
| `CBoxliteExecResult*` | `boxlite_result_free()` |
| `CExecutionHandle*` | `boxlite_execution_free()` |
| `char*` from `boxlite_box_id()` | `boxlite_free_string()` |

All free functions are NULL-safe.

---

## Thread Safety

- `CBoxliteRuntime` is thread-safe — share across threads.
- `CBoxHandle` and `CBoxliteSimple` are **not** thread-safe — one per thread.
- Callbacks run on the calling thread — do not block inside them.
