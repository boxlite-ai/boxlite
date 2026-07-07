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

## Native API — For Production Use

### Create runtime + box, exec with streaming

```c
#include <stdio.h>
#include "boxlite.h"

void on_output(const char* text, int is_stderr, void* user_data) {
    FILE* out = is_stderr ? stderr : stdout;
    fprintf(out, "%s", text);
}

int main() {
    CBoxliteRuntime* runtime = NULL;
    CBoxHandle* box = NULL;
    CBoxliteOptions* opts = NULL;
    CBoxliteError error = {0};

    // Runtime
    if (boxlite_runtime_new(NULL, NULL, 0, &runtime, &error) != Ok) {
        fprintf(stderr, "runtime: %s\n", error.message);
        boxlite_error_free(&error);
        return 1;
    }

    // Box options
    if (boxlite_options_new("python:slim", &opts, &error) != Ok) {
        fprintf(stderr, "options: %s\n", error.message);
        boxlite_error_free(&error);
        boxlite_runtime_free(runtime);
        return 1;
    }

    // Create + start box
    if (boxlite_create_box(runtime, opts, &box, &error) != Ok) {
        fprintf(stderr, "create: %s\n", error.message);
        boxlite_error_free(&error);
        boxlite_options_free(opts);
        boxlite_runtime_free(runtime);
        return 1;
    }
    boxlite_options_free(opts);

    // Execute
    const char* args[] = {"-c", "print('hello')"};
    BoxliteCommand cmd = {
        .command = "python",
        .args = args,
        .argc = 2,
        .timeout_secs = 30.0,
    };
    CExecutionHandle* execution = NULL;
    int exit_code = 0;

    if (boxlite_execute(box, &cmd, on_output, NULL, &execution, &error) == Ok) {
        boxlite_execution_wait(execution, &exit_code, &error);
        boxlite_execution_free(execution);
    }
    if (error.code != Ok) {
        fprintf(stderr, "exec error: %s\n", error.message);
        boxlite_error_free(&error);
    }

    // Cleanup — runtime_free auto-stops and removes all boxes
    boxlite_runtime_free(runtime);
    return 0;
}
```

---

## Timeout + Zombie Prevention

The Native API `BoxliteCommand.timeout_secs` kills the guest process automatically. Use it:

```c
BoxliteCommand cmd = {
    .command = "python",
    .args = args,
    .argc = 2,
    .timeout_secs = 30.0,  // guest process is killed after 30s — not optional
};
```

For the Simple API, `boxlite_simple_run` is synchronous and blocks until completion. Wrap it in a thread with `pthread_cancel` if you need external timeout control.

---

## Long-Running Pattern (Reuse Box Across Calls)

```c
typedef struct {
    CBoxliteRuntime* runtime;
    CBoxHandle* box;
} AgentBox;

int agent_box_init(AgentBox* ab) {
    CBoxliteError error = {0};

    if (boxlite_runtime_new(NULL, NULL, 0, &ab->runtime, &error) != Ok) {
        fprintf(stderr, "runtime: %s\n", error.message);
        boxlite_error_free(&error);
        return -1;
    }

    CBoxliteOptions* opts = NULL;
    boxlite_options_new("python:slim", &opts, &error);
    if (boxlite_create_box(ab->runtime, opts, &ab->box, &error) != Ok) {
        fprintf(stderr, "create: %s\n", error.message);
        boxlite_error_free(&error);
        boxlite_options_free(opts);
        boxlite_runtime_free(ab->runtime);
        return -1;
    }
    boxlite_options_free(opts);
    return 0;
}

void agent_box_destroy(AgentBox* ab) {
    if (ab->runtime) {
        boxlite_runtime_free(ab->runtime); // frees all boxes
        ab->runtime = NULL;
        ab->box = NULL;
    }
}
```

---

## Memory Management Rules

Every allocated value must be freed with the matching function:

| Value | Free with |
|-------|-----------|
| `CBoxliteRuntime*` | `boxlite_runtime_free()` (also frees all boxes) |
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
- Output callbacks run on the calling thread — do not block inside them.
