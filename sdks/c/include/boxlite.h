#ifndef BOXLITE_H
#define BOXLITE_H

#pragma once

#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

/**
 * Error codes returned by BoxLite C API functions.
 *
 * These codes map directly to Rust's BoxliteError variants,
 * allowing programmatic error handling in C.
 */
typedef enum BoxliteErrorCode {
  /**
   * Operation succeeded
   */
  Ok = 0,
  /**
   * Internal error
   */
  Internal = 1,
  /**
   * Resource not found
   */
  NotFound = 2,
  /**
   * Resource already exists
   */
  AlreadyExists = 3,
  /**
   * Invalid state for operation
   */
  InvalidState = 4,
  /**
   * Invalid argument provided
   */
  InvalidArgument = 5,
  /**
   * Configuration error
   */
  Config = 6,
  /**
   * Storage error
   */
  Storage = 7,
  /**
   * Image error
   */
  Image = 8,
  /**
   * Network error
   */
  Network = 9,
  /**
   * Execution error
   */
  Execution = 10,
  /**
   * Resource stopped
   */
  Stopped = 11,
  /**
   * Engine error
   */
  Engine = 12,
  /**
   * Unsupported operation
   */
  Unsupported = 13,
  /**
   * Database error
   */
  Database = 14,
  /**
   * Portal/communication error
   */
  Portal = 15,
  /**
   * RPC error
   */
  Rpc = 16,
} BoxliteErrorCode;

/**
 * Opaque handle to a running box
 */
typedef struct CBoxHandle CBoxHandle;

/**
 * Opaque handle to a BoxliteRuntime instance
 */
typedef struct CBoxliteRuntime CBoxliteRuntime;

/**
 * Opaque handle for simple API (auto-manages runtime)
 */
typedef struct CBoxliteSimple CBoxliteSimple;

/**
 * Extended error information for C API.
 *
 * Contains both an error code (for programmatic handling)
 * and an optional detailed message (for debugging).
 */
typedef struct CBoxliteError {
  /**
   * Error code
   */
  enum BoxliteErrorCode code;
  /**
   * Detailed error message (NULL if none, caller must free with boxlite_error_free)
   */
  char *message;
} CBoxliteError;

/**
 * Result structure for simple API command execution
 */
typedef struct CBoxliteExecResult {
  int exit_code;
  char *stdout_text;
  char *stderr_text;
} CBoxliteExecResult;

#ifdef __cplusplus
extern "C" {
#endif // __cplusplus

/**
 * Get BoxLite version string
 *
 * # Returns
 * Static string containing the version (e.g., "0.1.0")
 */
const char *boxlite_version(void);

/**
 * Create a new BoxLite runtime
 *
 * # Arguments
 * * `home_dir` - Path to BoxLite home directory (stores images, rootfs, etc.)
 *                If NULL, uses default: ~/.boxlite
 * * `registries_json` - JSON array of registries to search for unqualified images,
 *                       e.g. `["ghcr.io", "quay.io"]`. If NULL, uses default (docker.io).
 *                       Registries are tried in order; first successful pull wins.
 * * `out_error` - Output parameter for error message (caller must free with boxlite_free_string)
 *
 * # Returns
 * Pointer to CBoxliteRuntime on success, NULL on failure
 *
 * # Example
 * ```c
 * char *error = NULL;
 * const char *registries = "[\"ghcr.io\", \"docker.io\"]";
 * BoxliteRuntime *runtime = boxlite_runtime_new("/tmp/boxlite", registries, &error);
 * if (!runtime) {
 *     fprintf(stderr, "Error: %s\n", error);
 *     boxlite_free_string(error);
 *     return 1;
 * }
 * ```
 */
enum BoxliteErrorCode boxlite_runtime_new(const char *home_dir,
                                          const char *registries_json,
                                          struct CBoxliteRuntime **out_runtime,
                                          struct CBoxliteError *out_error);

/**
 * Create a new box with the given options (JSON)
 *
 * # Arguments
 * * `runtime` - BoxLite runtime instance
 * * `options_json` - JSON-encoded BoxOptions, e.g.:
 *                    `{"rootfs": {"Image": "alpine:3.19"}, "working_dir": "/workspace"}`
 * * `out_error` - Output parameter for error message
 *
 * # Returns
 * Pointer to CBoxHandle on success, NULL on failure
 *
 * # Example
 * ```c
 * const char *opts = "{\"rootfs\":{\"Image\":\"alpine:3.19\"}}";
 * BoxHandle *box = boxlite_create_box(runtime, opts, &error);
 * ```
 */
enum BoxliteErrorCode boxlite_create_box(struct CBoxliteRuntime *runtime,
                                         const char *options_json,
                                         struct CBoxHandle **out_box,
                                         struct CBoxliteError *out_error);

/**
 * Execute a command in a box
 *
 * # Arguments
 * * `handle` - Box handle
 * * `command` - Command to execute
 * * `args_json` - JSON array of arguments, e.g.: `["arg1", "arg2"]`
 * * `callback` - Optional callback for streaming output (chunk_text, is_stderr, user_data)
 * * `user_data` - User data passed to callback
 * * `out_exit_code` - Output parameter for command exit code
 * * `out_error` - Output parameter for error information
 *
 * # Returns
 * BoxliteErrorCode::Ok on success, error code on failure
 *
 * # Example
 * ```c
 * int exit_code;
 * CBoxliteError error = {0};
 * const char *args = "[\"hello\"]";
 * BoxliteErrorCode code = boxlite_execute(box, "echo", args, NULL, NULL, &exit_code, &error);
 * if (code == BOXLITE_OK) {
 *     printf("Command exited with code: %d\n", exit_code);
 * }
 * ```
 */
enum BoxliteErrorCode boxlite_execute(struct CBoxHandle *handle,
                                      const char *command,
                                      const char *args_json,
                                      void (*callback)(const char*, int, void*),
                                      void *user_data,
                                      int *out_exit_code,
                                      struct CBoxliteError *out_error);

/**
 * Stop a box
 *
 * # Arguments
 * * `handle` - Box handle (will be consumed/freed)
 * * `out_error` - Output parameter for error information
 *
 * # Returns
 * BoxliteErrorCode::Ok on success, error code on failure
 */
enum BoxliteErrorCode boxlite_stop_box(struct CBoxHandle *handle, struct CBoxliteError *out_error);

/**
 * List all boxes as JSON
 *
 * # Arguments
 * * `runtime` - BoxLite runtime instance
 * * `out_json` - Output parameter for JSON array of box info
 * * `out_error` - Output parameter for error information
 *
 * # Returns
 * BoxliteErrorCode::Ok on success, error code on failure
 *
 * # JSON Format
 * ```json
 * [
 *   {
 *     "id": "01HJK4TNRPQSXYZ8WM6NCVT9R5",
 *     "name": "my-box",
 *     "state": { "status": "running", "running": true, "pid": 12345 },
 *     "created_at": "2024-01-15T10:30:00Z",
 *     "image": "alpine:3.19",
 *     "cpus": 2,
 *     "memory_mib": 512
 *   }
 * ]
 * ```
 */
enum BoxliteErrorCode boxlite_list_info(struct CBoxliteRuntime *runtime,
                                        char **out_json,
                                        struct CBoxliteError *out_error);

/**
 * Get single box info as JSON
 *
 * # Arguments
 * * `runtime` - BoxLite runtime instance
 * * `id_or_name` - Box ID (full or prefix) or name
 * * `out_json` - Output parameter for JSON object
 * * `out_error` - Output parameter for error information
 *
 * # Returns
 * BoxliteErrorCode::Ok on success, error code on failure (including box not found)
 */
enum BoxliteErrorCode boxlite_get_info(struct CBoxliteRuntime *runtime,
                                       const char *id_or_name,
                                       char **out_json,
                                       struct CBoxliteError *out_error);

/**
 * Get box handle for reattaching to an existing box
 *
 * # Arguments
 * * `runtime` - BoxLite runtime instance
 * * `id_or_name` - Box ID (full or prefix) or name
 * * `out_handle` - Output parameter for box handle
 * * `out_error` - Output parameter for error information
 *
 * # Returns
 * BoxliteErrorCode::Ok on success, error code on failure (including box not found)
 */
enum BoxliteErrorCode boxlite_get(struct CBoxliteRuntime *runtime,
                                  const char *id_or_name,
                                  struct CBoxHandle **out_handle,
                                  struct CBoxliteError *out_error);

/**
 * Remove a box
 *
 * # Arguments
 * * `runtime` - BoxLite runtime instance
 * * `id_or_name` - Box ID (full or prefix) or name
 * * `force` - If non-zero, force remove even if running
 * * `out_error` - Output parameter for error information
 *
 * # Returns
 * BoxliteErrorCode::Ok on success, error code on failure
 */
enum BoxliteErrorCode boxlite_remove(struct CBoxliteRuntime *runtime,
                                     const char *id_or_name,
                                     int force,
                                     struct CBoxliteError *out_error);

/**
 * Get runtime metrics as JSON
 *
 * # Arguments
 * * `runtime` - BoxLite runtime instance
 * * `out_json` - Output parameter for JSON object
 * * `out_error` - Output parameter for error information
 *
 * # Returns
 * BoxliteErrorCode::Ok on success, error code on failure
 */
enum BoxliteErrorCode boxlite_runtime_metrics(struct CBoxliteRuntime *runtime,
                                              char **out_json,
                                              struct CBoxliteError *out_error);

/**
 * Gracefully shutdown all boxes in this runtime.
 *
 * This method stops all running boxes, waiting up to `timeout` seconds
 * for each box to stop gracefully before force-killing it.
 *
 * After calling this method, the runtime is permanently shut down and
 * will return errors for any new operations (like `create()`).
 *
 * # Arguments
 * * `runtime` - BoxLite runtime instance
 * * `timeout` - Seconds to wait before force-killing each box:
 *   - 0 - Use default timeout (10 seconds)
 *   - Positive integer - Wait that many seconds
 *   - -1 - Wait indefinitely (no timeout)
 * * `out_error` - Output parameter for error information
 *
 * # Returns
 * BoxliteErrorCode::Ok on success, error code on failure
 */
enum BoxliteErrorCode boxlite_runtime_shutdown(struct CBoxliteRuntime *runtime,
                                               int timeout,
                                               struct CBoxliteError *out_error);

/**
 * Get box info from handle as JSON
 *
 * # Arguments
 * * `handle` - Box handle
 * * `out_json` - Output parameter for JSON object
 * * `out_error` - Output parameter for error information
 *
 * # Returns
 * BoxliteErrorCode::Ok on success, error code on failure
 */
enum BoxliteErrorCode boxlite_box_info(struct CBoxHandle *handle,
                                       char **out_json,
                                       struct CBoxliteError *out_error);

/**
 * Get box metrics from handle as JSON
 *
 * # Arguments
 * * `handle` - Box handle
 * * `out_json` - Output parameter for JSON object
 * * `out_error` - Output parameter for error information
 *
 * # Returns
 * BoxliteErrorCode::Ok on success, error code on failure
 */
enum BoxliteErrorCode boxlite_box_metrics(struct CBoxHandle *handle,
                                          char **out_json,
                                          struct CBoxliteError *out_error);

/**
 * Start or restart a stopped box
 *
 * # Arguments
 * * `handle` - Box handle
 * * `out_error` - Output parameter for error information
 *
 * # Returns
 * BoxliteErrorCode::Ok on success, error code on failure
 */
enum BoxliteErrorCode boxlite_start_box(struct CBoxHandle *handle, struct CBoxliteError *out_error);

/**
 * Get box ID string from handle
 *
 * # Arguments
 * * `handle` - Box handle
 *
 * # Returns
 * Pointer to C string (caller must free with boxlite_free_string), NULL on failure
 */
char *boxlite_box_id(struct CBoxHandle *handle);

/**
 * Create and start a box using simple API
 */
enum BoxliteErrorCode boxlite_simple_new(const char *image,
                                         int cpus,
                                         int memory_mib,
                                         struct CBoxliteSimple **out_box,
                                         struct CBoxliteError *out_error);

/**
 * Run a command and get buffered result
 */
enum BoxliteErrorCode boxlite_simple_run(struct CBoxliteSimple *simple_box,
                                         const char *command,
                                         const char *const *args,
                                         int argc,
                                         struct CBoxliteExecResult **out_result,
                                         struct CBoxliteError *out_error);

/**
 * Free execution result
 */
void boxlite_result_free(struct CBoxliteExecResult *result);

/**
 * Free simple box (auto-cleanup)
 */
void boxlite_simple_free(struct CBoxliteSimple *simple_box);

/**
 * Free a runtime instance
 */
void boxlite_runtime_free(struct CBoxliteRuntime *runtime);

/**
 * Free a string allocated by BoxLite
 */
void boxlite_free_string(char *str);

/**
 * Free error struct
 */
void boxlite_error_free(struct CBoxliteError *error);

#ifdef __cplusplus
}  // extern "C"
#endif  // __cplusplus

#endif  /* BOXLITE_H */
