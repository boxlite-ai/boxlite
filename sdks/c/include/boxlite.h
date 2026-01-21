#ifndef BOXLITE_H
#define BOXLITE_H

#pragma once

#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

/**
 * Opaque handle to a running box
 */
typedef struct CBoxHandle CBoxHandle;

/**
 * Opaque handle to a BoxliteRuntime instance
 */
typedef struct CBoxliteRuntime CBoxliteRuntime;

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
struct CBoxliteRuntime *boxlite_runtime_new(const char *home_dir,
                                            const char *registries_json,
                                            char **out_error);

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
struct CBoxHandle *boxlite_create_box(struct CBoxliteRuntime *runtime,
                                      const char *options_json,
                                      char **out_error);

/**
 * Execute a command in a box
 *
 * # Arguments
 * * `handle` - Box handle
 * * `command` - Command to execute
 * * `args_json` - JSON array of arguments, e.g.: `["arg1", "arg2"]`
 * * `callback` - Optional callback for streaming output (chunk_text, is_stderr, user_data)
 * * `user_data` - User data passed to callback
 * * `out_error` - Output parameter for error message
 *
 * # Returns
 * Exit code on success, -1 on failure
 *
 * # Example
 * ```c
 * const char *args = "[\"hello\"]";
 * int exit_code = boxlite_execute(box, "echo", args, NULL, NULL, &error);
 * ```
 */
int boxlite_execute(struct CBoxHandle *handle,
                    const char *command,
                    const char *args_json,
                    void (*callback)(const char*, int, void*),
                    void *user_data,
                    char **out_error);

/**
 * Stop a box
 *
 * # Arguments
 * * `handle` - Box handle (will be consumed/freed)
 * * `out_error` - Output parameter for error message
 *
 * # Returns
 * 0 on success, -1 on failure
 */
int boxlite_stop_box(struct CBoxHandle *handle, char **out_error);

/**
 * List all boxes as JSON
 *
 * # Arguments
 * * `runtime` - BoxLite runtime instance
 * * `out_json` - Output parameter for JSON array of box info
 * * `out_error` - Output parameter for error message
 *
 * # Returns
 * 0 on success, -1 on failure
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
int boxlite_list_info(struct CBoxliteRuntime *runtime, char **out_json, char **out_error);

/**
 * Get single box info as JSON
 *
 * # Arguments
 * * `runtime` - BoxLite runtime instance
 * * `id_or_name` - Box ID (full or prefix) or name
 * * `out_json` - Output parameter for JSON object
 * * `out_error` - Output parameter for error message
 *
 * # Returns
 * 0 on success, -1 on failure (including box not found)
 */
int boxlite_get_info(struct CBoxliteRuntime *runtime,
                     const char *id_or_name,
                     char **out_json,
                     char **out_error);

/**
 * Get box handle for reattaching to an existing box
 *
 * # Arguments
 * * `runtime` - BoxLite runtime instance
 * * `id_or_name` - Box ID (full or prefix) or name
 * * `out_error` - Output parameter for error message
 *
 * # Returns
 * Pointer to CBoxHandle on success, NULL on failure (including box not found)
 */
struct CBoxHandle *boxlite_get(struct CBoxliteRuntime *runtime,
                               const char *id_or_name,
                               char **out_error);

/**
 * Remove a box
 *
 * # Arguments
 * * `runtime` - BoxLite runtime instance
 * * `id_or_name` - Box ID (full or prefix) or name
 * * `force` - If non-zero, force remove even if running
 * * `out_error` - Output parameter for error message
 *
 * # Returns
 * 0 on success, -1 on failure
 */
int boxlite_remove(struct CBoxliteRuntime *runtime,
                   const char *id_or_name,
                   int force,
                   char **out_error);

/**
 * Get runtime metrics as JSON
 *
 * # Arguments
 * * `runtime` - BoxLite runtime instance
 * * `out_json` - Output parameter for JSON object
 * * `out_error` - Output parameter for error message (unused, provided for API consistency)
 *
 * # Returns
 * 0 on success, -1 on failure
 */
int boxlite_runtime_metrics(struct CBoxliteRuntime *runtime, char **out_json, char **out_error);

/**
 * Get box info from handle as JSON
 *
 * # Arguments
 * * `handle` - Box handle
 * * `out_json` - Output parameter for JSON object
 * * `out_error` - Output parameter for error message
 *
 * # Returns
 * 0 on success, -1 on failure
 */
int boxlite_box_info(struct CBoxHandle *handle, char **out_json, char **out_error);

/**
 * Get box metrics from handle as JSON
 *
 * # Arguments
 * * `handle` - Box handle
 * * `out_json` - Output parameter for JSON object
 * * `out_error` - Output parameter for error message
 *
 * # Returns
 * 0 on success, -1 on failure
 */
int boxlite_box_metrics(struct CBoxHandle *handle, char **out_json, char **out_error);

/**
 * Start or restart a stopped box
 *
 * # Arguments
 * * `handle` - Box handle
 * * `out_error` - Output parameter for error message
 *
 * # Returns
 * 0 on success, -1 on failure
 */
int boxlite_start_box(struct CBoxHandle *handle, char **out_error);

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
 * Free a runtime instance
 *
 * # Arguments
 * * `runtime` - Runtime instance to free (can be NULL)
 */
void boxlite_runtime_free(struct CBoxliteRuntime *runtime);

/**
 * Free a string allocated by BoxLite
 *
 * # Arguments
 * * `str` - String to free (can be NULL)
 */
void boxlite_free_string(char *str);

#ifdef __cplusplus
}  // extern "C"
#endif  // __cplusplus

#endif  /* BOXLITE_H */
