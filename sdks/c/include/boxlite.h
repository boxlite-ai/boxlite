#ifndef BOXLITE_H
#define BOXLITE_H

#pragma once

#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

// Error codes returned by BoxLite C API functions.
//
// These codes map directly to Rust's BoxliteError variants,
// allowing programmatic error handling in C.
typedef enum BoxliteErrorCode {
  // Operation succeeded
  Ok = 0,
  // Internal error
  Internal = 1,
  // Resource not found
  NotFound = 2,
  // Resource already exists
  AlreadyExists = 3,
  // Invalid state for operation
  InvalidState = 4,
  // Invalid argument provided
  InvalidArgument = 5,
  // Configuration error
  Config = 6,
  // Storage error
  Storage = 7,
  // Image error
  Image = 8,
  // Network error
  Network = 9,
  // Execution error
  Execution = 10,
  // Resource stopped
  Stopped = 11,
  // Engine error
  Engine = 12,
  // Unsupported operation
  Unsupported = 13,
  // Database error
  Database = 14,
  // Portal/communication error
  Portal = 15,
  // RPC error
  Rpc = 16,
  // RPC transport error
  RpcTransport = 17,
  // Metadata error
  Metadata = 18,
  // Unsupported engine error
  UnsupportedEngine = 19,
} BoxliteErrorCode;

// Opaque handle to a running box
typedef struct BoxHandle BoxHandle;

// Opaque handle for Runner API (auto-manages runtime)
typedef struct BoxRunner BoxRunner;

// Opaque handle to a BoxliteRuntime instance with associated Tokio runtime
typedef struct RuntimeHandle RuntimeHandle;

typedef struct RuntimeHandle CBoxliteRuntime;

// Extended error information for C API.
//
// Contains both an error code (for programmatic handling)
// and an optional detailed message (for debugging).
typedef struct FFIError {
  // Error code
  enum BoxliteErrorCode code;
  // Detailed error message (NULL if none, caller must free with boxlite_error_free)
  char *message;
} FFIError;

typedef struct FFIError CBoxliteError;

typedef struct BoxHandle CBoxHandle;

typedef struct BoxRunner CBoxliteSimple;

// Result structure for runner command execution
typedef struct ExecResult {
  int exit_code;
  char *stdout_text;
  char *stderr_text;
} ExecResult;

typedef struct ExecResult CBoxliteExecResult;

#ifdef __cplusplus
extern "C" {
#endif // __cplusplus

// Get BoxLite version string
//
// # Returns
// A pointer to a static C string containing the version. Do not free this string.
//
// # Example
// ```c
// printf("BoxLite Version: %s\n", boxlite_version());
// ```
const char *boxlite_version(void);

// Create a new BoxLite runtime configuration.
//
// # Arguments
// * `home_dir` - Optional path to the home directory. If NULL, defaults to `~/.boxlite`.
// * `registries_json` - Optional JSON array of registry configurations.
// * `out_runtime` - Output parameter to store the created `CBoxliteRuntime` pointer.
// * `out_error` - Output parameter for error information.
//
// # Returns
// `BoxliteErrorCode::Ok` on success, or an error code on failure.
//
// # Example
// ```c
// CBoxliteRuntime *runtime;
// CBoxliteError *error = malloc(sizeof(CBoxliteError));
// if (boxlite_runtime_new(NULL, NULL, &runtime, error) != BOXLITE_OK) {
//     fprintf(stderr, "Failed to create runtime\n");
// }
// ```
enum BoxliteErrorCode boxlite_runtime_new(const char *home_dir,
                                          const char *registries_json,
                                          CBoxliteRuntime **out_runtime,
                                          CBoxliteError *out_error);

// Create a new box with the given options (JSON).
//
// # Arguments
// * `runtime` - Pointer to the active `CBoxliteRuntime`.
// * `options_json` - JSON string defining the box (e.g., image, resources).
// * `out_box` - Output parameter to store the created `CBoxHandle`.
// * `out_error` - Output parameter for error information.
//
// # Returns
// `BoxliteErrorCode::Ok` on success.
//
// # Example
// ```c
// const char *options = "{\"rootfs\": {\"Image\": \"alpine:latest\"}}";
// CBoxHandle *box;
// if (boxlite_create_box(runtime, options, &box, error) == BOXLITE_OK) {
//     // Use box...
// }
// ```
enum BoxliteErrorCode boxlite_create_box(CBoxliteRuntime *runtime,
                                         const char *options_json,
                                         CBoxHandle **out_box,
                                         CBoxliteError *out_error);

// Execute a command in a box.
//
// # Arguments
// * `handle` - Box handle.
// * `command` - Command to execute (e.g., "/bin/sh").
// * `args_json` - JSON array of arguments, e.g.: `["-c", "echo hello"]`.
// * `callback` - Optional callback for streaming output.
// * `user_data` - User data passed to callback.
// * `out_exit_code` - Output parameter for command exit code.
// * `out_error` - Output parameter for error information.
//
// # Returns
// `BoxliteErrorCode::Ok` on success.
//
// # Example
// ```c
// int exit_code;
// const char *args = "[\"hello\"]";
// if (boxlite_execute(box, "echo", args, NULL, NULL, &exit_code, error) == BOXLITE_OK) {
//     printf("Exit code: %d\n", exit_code);
// }
// ```
enum BoxliteErrorCode boxlite_execute(CBoxHandle *handle,
                                      const char *command,
                                      const char *args_json,
                                      void (*callback)(const char*, int, void*),
                                      void *user_data,
                                      int *out_exit_code,
                                      CBoxliteError *out_error);

// Stop a box.
//
// # Arguments
// * `handle` - Box handle.
// * `out_error` - output error.
//
// # Example
// ```c
// boxlite_stop_box(box, error);
// ```
enum BoxliteErrorCode boxlite_stop_box(CBoxHandle *handle, CBoxliteError *out_error);

// List all boxes as JSON.
//
// # Arguments
// * `runtime` - Runtime handle.
// * `out_json` - Output pointer for JSON string. Caller must free this with `boxlite_free_string`.
// * `out_error` - Output error.
//
// # Example
// ```c
// char *json;
// if (boxlite_list_info(runtime, &json, error) == BOXLITE_OK) {
//     printf("Boxes: %s\n", json);
//     boxlite_free_string(json);
// }
// ```
enum BoxliteErrorCode boxlite_list_info(CBoxliteRuntime *runtime,
                                        char **out_json,
                                        CBoxliteError *out_error);

// Get single box info as JSON.
//
// # Arguments
// * `runtime` - Runtime handle.
// * `id_or_name` - ID or name of the box.
// * `out_json` - Output pointer for JSON string.
// * `out_error` - Output error.
//
// # Example
// ```c
// char *json;
// boxlite_get_info(runtime, "my-box", &json, error);
// ```
enum BoxliteErrorCode boxlite_get_info(CBoxliteRuntime *runtime,
                                       const char *id_or_name,
                                       char **out_json,
                                       CBoxliteError *out_error);

// Attach to an existing box.
//
// # Arguments
// * `runtime` - Runtime handle.
// * `id_or_name` - ID or name of the box.
// * `out_handle` - Output pointer for box handle.
// * `out_error` - Output error.
//
// # Example
// ```c
// CBoxHandle *handle;
// if (boxlite_get(runtime, "my-box", &handle, error) == BOXLITE_OK) {
//     // Use handle...
// }
// ```
enum BoxliteErrorCode boxlite_get(CBoxliteRuntime *runtime,
                                  const char *id_or_name,
                                  CBoxHandle **out_handle,
                                  CBoxliteError *out_error);

// Remove a box.
//
// # Arguments
// * `runtime` - Runtime handle.
// * `id_or_name` - ID or name of the box.
// * `force` - 1 to force remove (stop if running), 0 otherwise.
// * `out_error` - Output error.
//
// # Example
// ```c
// boxlite_remove(runtime, "my-box", 1, error);
// ```
enum BoxliteErrorCode boxlite_remove(CBoxliteRuntime *runtime,
                                     const char *id_or_name,
                                     int force,
                                     CBoxliteError *out_error);

// Get runtime metrics as JSON.
//
// # Arguments
// * `runtime` - Runtime handle.
// * `out_json` - Output pointer for JSON string.
// * `out_error` - Output error.
//
// # Example
// ```c
// char *json;
// boxlite_runtime_metrics(runtime, &json, error);
// ```
enum BoxliteErrorCode boxlite_runtime_metrics(CBoxliteRuntime *runtime,
                                              char **out_json,
                                              CBoxliteError *out_error);

// Gracefully shutdown all boxes in this runtime.
//
// # Arguments
// * `runtime` - Runtime handle.
// * `timeout` - Seconds to wait before force-killing each box:
//   - 0 - Use default timeout (10 seconds)
//   - Positive integer - Wait that many seconds
//   - -1 - Wait indefinitely (no timeout)
// * `out_error` - Output parameter for error information
//
// # Example
// ```c
// boxlite_runtime_shutdown(runtime, 5, error);
// ```
enum BoxliteErrorCode boxlite_runtime_shutdown(CBoxliteRuntime *runtime,
                                               int timeout,
                                               CBoxliteError *out_error);

// Get info for a box handle as JSON.
//
// # Arguments
// * `handle` - Box handle.
// * `out_json` - Output pointer for JSON string.
// * `out_error` - Output error.
//
// # Example
// ```c
// char *json;
// boxlite_box_info(handle, &json, error);
// ```
enum BoxliteErrorCode boxlite_box_info(CBoxHandle *handle,
                                       char **out_json,
                                       CBoxliteError *out_error);

// Get metrics for a box handle as JSON.
//
// # Arguments
// * `handle` - Box handle.
// * `out_json` - Output pointer for JSON string.
// * `out_error` - Output error.
//
// # Example
// ```c
// char *json;
// boxlite_box_metrics(handle, &json, error);
// ```
enum BoxliteErrorCode boxlite_box_metrics(CBoxHandle *handle,
                                          char **out_json,
                                          CBoxliteError *out_error);

// Start a stopped box.
//
// # Arguments
// * `handle` - Box handle.
// * `out_error` - output error.
//
// # Example
// ```c
// boxlite_start_box(handle, error);
// ```
enum BoxliteErrorCode boxlite_start_box(CBoxHandle *handle, CBoxliteError *out_error);

// Get box ID.
//
// # Arguments
// * `handle` - Box handle.
//
// # Returns
// Pointer to a C string containing the ID. Must be freed with `boxlite_free_string`.
//
// # Example
// ```c
// char *id = boxlite_box_id(handle);
// printf("Box ID: %s\n", id);
// boxlite_free_string(id);
// ```
char *boxlite_box_id(CBoxHandle *handle);

// Create a simplified box runner.
//
// # Arguments
// * `image` - Container image.
// * `cpus` - Number of CPUs.
// * `memory_mib` - Memory in MiB.
// * `out_box` - Output pointer for `CBoxliteSimple,`.
// * `out_error` - Output error.
//
// # Returns
// `BoxliteErrorCode::Ok` on success.
//
// # Example
// ```c
// CBoxliteSimple, *runner;
// if (boxlite_simple_new("alpine", 1, 128, &runner, error) == BOXLITE_OK) {
//     // Use runner...
// }
// ```
enum BoxliteErrorCode boxlite_simple_new(const char *image,
                                         int cpus,
                                         int memory_mib,
                                         CBoxliteSimple **out_box,
                                         CBoxliteError *out_error);

// Run a command using the simplified runner.
//
// # Arguments
// * `box_runner` - Runner handle.
// * `command` - Command to execute.
// * `args` - Array of argument strings.
// * `argc` - Count of arguments.
// * `out_result` - Output pointer for `CBoxliteExecResult`.
// * `out_error` - Output error.
//
// # Example
// ```c
// CBoxliteExecResult *result;
// const char *args[] = {"hello"};
// boxlite_simple_run(runner, "echo", args, 1, &result, error);
// ```
enum BoxliteErrorCode boxlite_simple_run(CBoxliteSimple *box_runner,
                                         const char *command,
                                         const char *const *args,
                                         int argc,
                                         CBoxliteExecResult **out_result,
                                         CBoxliteError *out_error);

// Free an execution result.
//
// # Arguments
// * `result` - Pointer to `CBoxliteExecResult` to free.
void boxlite_result_free(CBoxliteExecResult *result);

// Free a simple runner.
//
// # Arguments
// * `box_runner` - Pointer to `CBoxliteSimple,` to free.
void boxlite_simple_free(CBoxliteSimple *box_runner);

// Free a box handle.
//
// # Arguments
// * `handle` - Pointer to `CBoxHandle` to free.
void boxlite_box_free(CBoxHandle *handle);

// Free a runtime handle.
//
// # Arguments
// * `runtime` - Pointer to `CBoxliteRuntime` to free.
void boxlite_runtime_free(CBoxliteRuntime *runtime);

// Free a string allocated by the library.
//
// # Arguments
// * `s` - Pointer to string to free.
void boxlite_free_string(char *s);

// Free an error object.
//
// # Arguments
// * `error` - Pointer to `CBoxliteError` to free.
void boxlite_error_free(CBoxliteError *error);

#ifdef __cplusplus
}  // extern "C"
#endif  // __cplusplus

#endif  /* BOXLITE_H */
