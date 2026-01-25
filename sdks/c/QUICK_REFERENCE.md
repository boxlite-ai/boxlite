# BoxLite C SDK v0.2.0 - Quick Reference

## Basic Usage Pattern

```c
#include "boxlite.h"

int main() {
    // 1. Initialize error struct
    CBoxliteError error = {0};

    // 2. Initialize output pointers
    CBoxliteRuntime* runtime = NULL;
    CBoxHandle* box = NULL;

    // 3. Create runtime
    BoxliteErrorCode code = boxlite_runtime_new(
        NULL,        // home_dir (NULL = default ~/.boxlite)
        NULL,        // registries_json (NULL = default)
        &runtime,    // output parameter
        &error       // error info
    );

    if (code != Ok) {
        fprintf(stderr, "Error %d: %s\n", error.code, error.message);
        boxlite_error_free(&error);
        return 1;
    }

    // 4. Create box
    const char* opts = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},"
                       "\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[]}";
    code = boxlite_create_box(runtime, opts, &box, &error);
    if (code != Ok) {
        fprintf(stderr, "Error %d: %s\n", error.code, error.message);
        boxlite_error_free(&error);
        boxlite_runtime_free(runtime);
        return 1;
    }

    // 5. Execute command
    int exit_code = 0;
    const char* args = "[\"hello\"]";
    code = boxlite_execute(box, "/bin/echo", args, NULL, NULL, &exit_code, &error);
    if (code != Ok) {
        fprintf(stderr, "Error %d: %s\n", error.code, error.message);
        boxlite_error_free(&error);
    } else {
        printf("Exit code: %d\n", exit_code);
    }

    // 6. Cleanup
    boxlite_runtime_free(runtime);  // Auto-frees all boxes

    return 0;
}
```

---

## Simple API (Easiest)

```c
#include "boxlite.h"

int main() {
    CBoxliteSimple* box = NULL;
    CBoxliteError error = {0};

    // Create box (auto-starts)
    if (boxlite_simple_new("python:slim", 0, 0, &box, &error) != Ok) {
        fprintf(stderr, "Error: %s\n", error.message);
        boxlite_error_free(&error);
        return 1;
    }

    // Run command
    const char* args[] = {"-c", "print('hello')", NULL};
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

---

## Error Handling

### Check Error Codes

```c
BoxliteErrorCode code = boxlite_get(runtime, "box-id", &box, &error);

switch (code) {
    case Ok:
        // Success
        break;
    case NotFound:
        fprintf(stderr, "Box not found\n");
        break;
    case InvalidState:
        fprintf(stderr, "Box in invalid state\n");
        break;
    default:
        fprintf(stderr, "Error %d: %s\n", error.code, error.message);
        break;
}

boxlite_error_free(&error);
```

### Always Free Errors

```c
CBoxliteError error = {0};

if (code != Ok) {
    printf("Error: %s\n", error.message);
    boxlite_error_free(&error);  // ✅ Always free
}
```

---

## Common Patterns

### Streaming Output

```c
void output_callback(const char* text, int is_stderr, void* user_data) {
    FILE* stream = is_stderr ? stderr : stdout;
    fprintf(stream, "%s", text);
}

int exit_code = 0;
boxlite_execute(box, "python", args, output_callback, NULL, &exit_code, &error);
```

### Get Box Info

```c
char* json = NULL;
if (boxlite_box_info(box, &json, &error) == Ok) {
    printf("Box info: %s\n", json);
    boxlite_free_string(json);  // Free JSON string
}
```

### List All Boxes

```c
char* json = NULL;
if (boxlite_list_info(runtime, &json, &error) == Ok) {
    printf("Boxes: %s\n", json);
    boxlite_free_string(json);
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

---

## Memory Management

### What You Must Free

```c
// Error messages
CBoxliteError error = {0};
// ... use error ...
boxlite_error_free(&error);  // ✅

// JSON strings
char* json = NULL;
boxlite_list_info(runtime, &json, &error);
boxlite_free_string(json);  // ✅

// Box IDs
char* id = boxlite_box_id(box);
boxlite_free_string(id);  // ✅

// Execution results (Simple API)
CBoxliteExecResult* result;
boxlite_simple_run(box, "echo", args, 1, &result, &error);
boxlite_result_free(result);  // ✅

// Simple API boxes
CBoxliteSimple* box;
boxlite_simple_new("alpine", 0, 0, &box, &error);
boxlite_simple_free(box);  // ✅
```

### What's Auto-Freed

```c
// Runtime (frees all boxes)
boxlite_runtime_free(runtime);  // ✅ Frees boxes too

// Box handles (freed by runtime)
// Don't manually free box handles!
```

---

## Error Codes Reference

| Code | Value | Meaning |
|------|-------|---------|
| `Ok` | 0 | Success |
| `Internal` | 1 | Internal error |
| `NotFound` | 2 | Resource not found |
| `AlreadyExists` | 3 | Resource exists |
| `InvalidState` | 4 | Invalid operation |
| `InvalidArgument` | 5 | Bad parameter |
| `Config` | 6 | Configuration error |
| `Storage` | 7 | Storage error |
| `Image` | 8 | Image error |
| `Network` | 9 | Network error |
| `Execution` | 10 | Execution error |
| `Stopped` | 11 | Box stopped |
| `Engine` | 12 | Engine error |

---

## JSON Options Reference

### Minimal

```json
{
  "rootfs": {"Image": "alpine:3.19"},
  "env": [],
  "volumes": [],
  "network": "Isolated",
  "ports": []
}
```

### With Environment

```json
{
  "rootfs": {"Image": "python:slim"},
  "env": [["DEBUG", "1"], ["PORT", "8080"]],
  "volumes": [],
  "network": "Isolated",
  "ports": []
}
```

### With Volumes

```json
{
  "rootfs": {"Image": "node:20"},
  "env": [],
  "volumes": [
    {
      "host_path": "/Users/me/data",
      "guest_path": "/data",
      "readonly": false
    }
  ],
  "network": "Isolated",
  "ports": []
}
```

### With Ports

```json
{
  "rootfs": {"Image": "nginx:alpine"},
  "env": [],
  "volumes": [],
  "network": "Isolated",
  "ports": [
    {
      "host_port": 8080,
      "guest_port": 80,
      "protocol": "Tcp"
    }
  ]
}
```

### With Resources

```json
{
  "rootfs": {"Image": "alpine:3.19"},
  "cpus": 4,
  "memory_mib": 1024,
  "disk_size_gb": 10,
  "env": [],
  "volumes": [],
  "network": "Isolated",
  "ports": []
}
```

### Don't Auto-Remove

```json
{
  "rootfs": {"Image": "alpine:3.19"},
  "env": [],
  "volumes": [],
  "network": "Isolated",
  "ports": [],
  "auto_remove": false
}
```

---

## Common Mistakes

### ❌ Wrong: Don't initialize error

```c
CBoxliteError error;  // ❌ Uninitialized
```

```c
CBoxliteError error = {0};  // ✅ Correct
```

### ❌ Wrong: Don't check pointer

```c
CBoxliteRuntime* runtime = boxlite_runtime_new(...);  // ❌ Old API
```

```c
BoxliteErrorCode code = boxlite_runtime_new(..., &runtime, &error);  // ✅ New API
if (code != Ok) { /* handle error */ }
```

### ❌ Wrong: Forget to free error

```c
if (code != Ok) {
    printf("Error: %s\n", error.message);
    return 1;  // ❌ Memory leak
}
```

```c
if (code != Ok) {
    printf("Error: %s\n", error.message);
    boxlite_error_free(&error);  // ✅ Correct
    return 1;
}
```

### ❌ Wrong: Incomplete JSON

```c
const char* opts = "{\"rootfs\":{\"Image\":\"alpine\"}}";  // ❌ Missing fields
```

```c
const char* opts = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},"
                   "\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[]}";  // ✅
```

### ❌ Wrong: Don't free JSON

```c
char* json;
boxlite_list_info(runtime, &json, &error);
// ❌ Forgot to free
```

```c
char* json;
boxlite_list_info(runtime, &json, &error);
boxlite_free_string(json);  // ✅ Correct
```

---

## Build & Link

### CMake

```cmake
cmake_minimum_required(VERSION 3.15)
project(my_app)

# Find BoxLite
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

# Run
export DYLD_LIBRARY_PATH=/path/to/boxlite/target/release:$DYLD_LIBRARY_PATH
./myapp
```

```bash
# Linux
gcc -o myapp myapp.c \
    -I/path/to/boxlite/sdks/c/include \
    -L/path/to/boxlite/target/release \
    -lboxlite

# Run
export LD_LIBRARY_PATH=/path/to/boxlite/target/release:$LD_LIBRARY_PATH
./myapp
```

---

## Migration from v0.1.x

### Step 1: Error Handling

```c
// OLD
char* error = NULL;

// NEW
CBoxliteError error = {0};
```

### Step 2: Function Calls

```c
// OLD
CBoxliteRuntime* rt = boxlite_runtime_new(NULL, &error);
if (!rt) { ... }

// NEW
CBoxliteRuntime* rt = NULL;
BoxliteErrorCode code = boxlite_runtime_new(NULL, NULL, &rt, &error);
if (code != Ok) { ... }
```

### Step 3: Execute

```c
// OLD
int exit_code = boxlite_execute(box, cmd, args, cb, data, &error);
if (exit_code < 0) { ... }

// NEW
int exit_code = 0;
BoxliteErrorCode code = boxlite_execute(box, cmd, args, cb, data, &exit_code, &error);
if (code != Ok) { ... }
```

### Step 4: Cleanup

```c
// OLD
boxlite_free_string(error);

// NEW
boxlite_error_free(&error);
```

---

## More Examples

See `/examples/c/` for 12 comprehensive examples:

1. `execute.c` - Basic usage
2. `shutdown.c` - Graceful shutdown
3. `01_simple_api.c` - Simple convenience API
4. `02_lifecycle.c` - Lifecycle management
5. `03_list_boxes.c` - Discovery
6. `04_streaming_output.c` - Streaming
7. `05_error_handling.c` - Error recovery
8. `06_volumes.c` - Volume mounting
9. `07_environment.c` - Environment vars
10. `08_networking.c` - Port forwarding
11. `09_detach_reattach.c` - Cross-process
12. `10_metrics.c` - Monitoring

---

## Getting Help

- **Full Documentation**: `sdks/c/README.md`
- **API Reference**: `sdks/c/README.md#api-reference`
- **Migration Guide**: `sdks/c/CHANGELOG.md`
- **Examples**: `examples/c/`
