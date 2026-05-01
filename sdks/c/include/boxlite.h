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
  // System resource limit reached
  ResourceExhausted = 20,
} BoxliteErrorCode;

// Opaque handle to a running box.
typedef struct BoxHandle BoxHandle;

// Opaque handle for Runner API (auto-manages runtime)
typedef struct BoxRunner BoxRunner;

// Opaque handle to a running command execution.
typedef struct ExecutionHandle ExecutionHandle;

// Opaque handle to runtime image operations.
typedef struct ImageHandle ImageHandle;

typedef struct OptionsHandle OptionsHandle;

// Opaque handle to a BoxliteRuntime instance with associated Tokio runtime
typedef struct RuntimeHandle RuntimeHandle;

typedef struct RuntimeHandle CBoxliteRuntime;

typedef struct OptionsHandle CBoxliteOptions;

typedef struct BoxHandle CBoxHandle;

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

// C-compatible command descriptor with all BoxCommand options.
//
// All string fields are nullable — NULL means "use default".
// `timeout_secs` of 0.0 means no timeout.
typedef struct BoxliteCommand {
  // Command to execute (required, must not be NULL).
  const char *command;
  // Array of argument strings. NULL = no args.
  const char *const *args;
  // Number of arguments in `args`.
  int argc;
  // Array of env var pairs: [key0, val0, key1, ...]. NULL = inherit env.
  const char *const *env_pairs;
  // Number of strings in `env_pairs`; odd trailing values are ignored.
  int env_count;
  // Working directory inside the container. NULL = container default.
  const char *workdir;
  // User spec (e.g., "nobody", "1000:1000"). NULL = container default.
  const char *user;
  // Timeout in seconds. 0.0 = no timeout.
  double timeout_secs;
  // Enable TTY mode for interactive programs.
  int tty;
} BoxliteCommand;

typedef struct ExecutionHandle CExecutionHandle;

typedef struct BoxRunner CBoxliteSimple;

// Result structure for runner command execution
typedef struct ExecResult {
  int exit_code;
  char *stdout_text;
  char *stderr_text;
} ExecResult;

typedef struct ExecResult CBoxliteExecResult;

typedef struct ImageHandle CBoxliteImageHandle;

typedef struct CImagePullResult {
  char *reference;
  char *config_digest;
  int layer_count;
} CImagePullResult;

typedef struct CImageInfo {
  char *reference;
  char *repository;
  char *tag;
  char *id;
  int64_t cached_at;
  uint64_t size;
  int has_size;
} CImageInfo;

typedef struct CImageInfoList {
  struct CImageInfo *items;
  int count;
} CImageInfoList;

typedef struct CBoxInfo {
  char *id;
  char *name;
  char *image;
  char *status;
  int running;
  int pid;
  int cpus;
  int memory_mib;
  int64_t created_at;
} CBoxInfo;

typedef struct CBoxInfoList {
  struct CBoxInfo *items;
  int count;
} CBoxInfoList;

typedef struct CBoxMetrics {
  double cpu_percent;
  int64_t memory_bytes;
  int commands_executed;
  int exec_errors;
  int64_t bytes_sent;
  int64_t bytes_received;
  int64_t create_duration_ms;
  int64_t boot_duration_ms;
  int64_t network_bytes_sent;
  int64_t network_bytes_received;
  int network_tcp_connections;
  int network_tcp_errors;
} CBoxMetrics;

typedef struct CRuntimeMetrics {
  int boxes_created_total;
  int boxes_failed_total;
  int num_running_boxes;
  int total_commands_executed;
  int total_exec_errors;
} CRuntimeMetrics;

#ifdef __cplusplus
extern "C" {
#endif // __cplusplus

enum BoxliteErrorCode boxlite_create_box(CBoxliteRuntime *runtime,
                                         CBoxliteOptions *opts,
                                         CBoxHandle **out_box,
                                         CBoxliteError *out_error);

enum BoxliteErrorCode boxlite_stop_box(CBoxHandle *handle, CBoxliteError *out_error);

enum BoxliteErrorCode boxlite_get(CBoxliteRuntime *runtime,
                                  const char *id_or_name,
                                  CBoxHandle **out_handle,
                                  CBoxliteError *out_error);

enum BoxliteErrorCode boxlite_remove(CBoxliteRuntime *runtime,
                                     const char *id_or_name,
                                     int force,
                                     CBoxliteError *out_error);

enum BoxliteErrorCode boxlite_start_box(CBoxHandle *handle, CBoxliteError *out_error);

char *boxlite_box_id(CBoxHandle *handle);

void boxlite_box_free(CBoxHandle *handle);

enum BoxliteErrorCode boxlite_copy_into(CBoxHandle *handle,
                                        const char *host_src,
                                        const char *guest_dst,
                                        CBoxliteError *out_error);

enum BoxliteErrorCode boxlite_copy_out(CBoxHandle *handle,
                                       const char *guest_src,
                                       const char *host_dst,
                                       CBoxliteError *out_error);

void boxlite_error_free(CBoxliteError *error);

enum BoxliteErrorCode boxlite_execute(CBoxHandle *handle,
                                      const struct BoxliteCommand *cmd,
                                      void (*callback)(const char*, int, void*),
                                      void *user_data,
                                      CExecutionHandle **out_execution,
                                      CBoxliteError *out_error);

enum BoxliteErrorCode boxlite_execution_write(CExecutionHandle *execution,
                                              const char *data,
                                              int len,
                                              CBoxliteError *out_error);

enum BoxliteErrorCode boxlite_execution_wait(CExecutionHandle *execution,
                                             int *out_exit_code,
                                             CBoxliteError *out_error);

enum BoxliteErrorCode boxlite_execution_kill(CExecutionHandle *execution, CBoxliteError *out_error);

enum BoxliteErrorCode boxlite_execution_resize_tty(CExecutionHandle *execution,
                                                   int rows,
                                                   int cols,
                                                   CBoxliteError *out_error);

void boxlite_execution_free(CExecutionHandle *execution);

enum BoxliteErrorCode boxlite_simple_new(const char *image,
                                         int cpus,
                                         int memory_mib,
                                         CBoxliteSimple **out_box,
                                         CBoxliteError *out_error);

enum BoxliteErrorCode boxlite_simple_run(CBoxliteSimple *box_runner,
                                         const char *command,
                                         const char *const *args,
                                         int argc,
                                         CBoxliteExecResult **out_result,
                                         CBoxliteError *out_error);

void boxlite_simple_free(CBoxliteSimple *box_runner);

void boxlite_result_free(CBoxliteExecResult *result);

enum BoxliteErrorCode boxlite_image_pull(CBoxliteImageHandle *handle,
                                         const char *image_ref,
                                         struct CImagePullResult **out_result,
                                         CBoxliteError *out_error);

enum BoxliteErrorCode boxlite_image_list(CBoxliteImageHandle *handle,
                                         struct CImageInfoList **out_list,
                                         CBoxliteError *out_error);

void boxlite_image_free(CBoxliteImageHandle *handle);

void boxlite_free_image_info_list(struct CImageInfoList *list);

void boxlite_free_image_pull_result(struct CImagePullResult *result);

enum BoxliteErrorCode boxlite_box_info(CBoxHandle *handle,
                                       struct CBoxInfo **out_info,
                                       CBoxliteError *out_error);

enum BoxliteErrorCode boxlite_get_info(CBoxliteRuntime *runtime,
                                       const char *id_or_name,
                                       struct CBoxInfo **out_info,
                                       CBoxliteError *out_error);

enum BoxliteErrorCode boxlite_list_info(CBoxliteRuntime *runtime,
                                        struct CBoxInfoList **out_list,
                                        CBoxliteError *out_error);

void boxlite_free_box_info(struct CBoxInfo *info);

void boxlite_free_box_info_list(struct CBoxInfoList *list);

enum BoxliteErrorCode boxlite_box_metrics(CBoxHandle *handle,
                                          struct CBoxMetrics *out_metrics,
                                          CBoxliteError *out_error);

enum BoxliteErrorCode boxlite_runtime_metrics(CBoxliteRuntime *runtime,
                                              struct CRuntimeMetrics *out_metrics,
                                              CBoxliteError *out_error);

enum BoxliteErrorCode boxlite_options_new(const char *image,
                                          CBoxliteOptions **out_opts,
                                          CBoxliteError *out_error);

void boxlite_options_set_rootfs_path(CBoxliteOptions *opts, const char *path);

void boxlite_options_set_name(CBoxliteOptions *opts, const char *name);

void boxlite_options_set_cpus(CBoxliteOptions *opts, int cpus);

void boxlite_options_set_memory(CBoxliteOptions *opts, int memory_mib);

void boxlite_options_set_workdir(CBoxliteOptions *opts, const char *workdir);

void boxlite_options_add_env(CBoxliteOptions *opts, const char *key, const char *val);

void boxlite_options_add_volume(CBoxliteOptions *opts,
                                const char *host_path,
                                const char *guest_path,
                                int read_only);

void boxlite_options_add_port(CBoxliteOptions *opts, int guest_port, int host_port);

void boxlite_options_set_network_enabled(CBoxliteOptions *opts);

void boxlite_options_set_network_disabled(CBoxliteOptions *opts);

void boxlite_options_add_network_allow(CBoxliteOptions *opts, const char *host);

void boxlite_options_add_secret(CBoxliteOptions *opts,
                                const char *name,
                                const char *value,
                                const char *placeholder,
                                const char *const *hosts,
                                int hosts_count);

void boxlite_options_set_auto_remove(CBoxliteOptions *opts, int val);

void boxlite_options_set_detach(CBoxliteOptions *opts, int val);

void boxlite_options_set_entrypoint(CBoxliteOptions *opts, const char *const *args, int argc);

void boxlite_options_set_cmd(CBoxliteOptions *opts, const char *const *args, int argc);

void boxlite_options_free(CBoxliteOptions *opts);

const char *boxlite_version(void);

enum BoxliteErrorCode boxlite_runtime_new(const char *home_dir,
                                          const char *const *registries,
                                          int registries_count,
                                          CBoxliteRuntime **out_runtime,
                                          CBoxliteError *out_error);

enum BoxliteErrorCode boxlite_runtime_images(CBoxliteRuntime *runtime,
                                             CBoxliteImageHandle **out_handle,
                                             CBoxliteError *out_error);

enum BoxliteErrorCode boxlite_runtime_shutdown(CBoxliteRuntime *runtime,
                                               int timeout,
                                               CBoxliteError *out_error);

void boxlite_runtime_free(CBoxliteRuntime *runtime);

void boxlite_free_string(char *s);

#ifdef __cplusplus
}  // extern "C"
#endif  // __cplusplus

#endif  /* BOXLITE_H */
