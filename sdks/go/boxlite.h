#ifndef BOXLITE_H
#define BOXLITE_H

#pragma once

#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

typedef enum BoxliteErrorCode {
  Ok = 0,
  Internal = 1,
  NotFound = 2,
  AlreadyExists = 3,
  InvalidState = 4,
  InvalidArgument = 5,
  Config = 6,
  Storage = 7,
  Image = 8,
  Network = 9,
  Execution = 10,
  Stopped = 11,
  Engine = 12,
  Unsupported = 13,
  Database = 14,
  Portal = 15,
  Rpc = 16,
  RpcTransport = 17,
  Metadata = 18,
  UnsupportedEngine = 19,
} BoxliteErrorCode;

typedef struct BoxHandle BoxHandle;
typedef struct BoxRunner BoxRunner;
typedef struct RuntimeHandle RuntimeHandle;
typedef struct OptionsHandle OptionsHandle;

typedef struct RuntimeHandle CBoxliteRuntime;
typedef struct BoxHandle CBoxHandle;
typedef struct OptionsHandle CBoxliteOptions;
typedef struct BoxRunner CBoxliteSimple;

typedef struct FFIError {
  enum BoxliteErrorCode code;
  char *message;
} FFIError;

typedef struct FFIError CBoxliteError;

// ── C struct returns (no JSON) ──

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
  CBoxInfo *items;
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
  CImageInfo *items;
  int count;
} CImageInfoList;

// ── Command struct ──

typedef struct BoxliteCommand {
  const char *command;
  const char *args_json;
  const char *env_json;
  const char *workdir;
  const char *user;
  double timeout_secs;
} BoxliteCommand;

typedef struct ExecResult {
  int exit_code;
  char *stdout_text;
  char *stderr_text;
} ExecResult;

typedef struct ExecResult CBoxliteExecResult;

#ifdef __cplusplus
extern "C" {
#endif

// ── Version ──
const char *boxlite_version(void);

// ── Runtime ──
enum BoxliteErrorCode boxlite_runtime_new(const char *home_dir,
                                          const char *registries_json,
                                          const char *insecure_registries_json,
                                          CBoxliteRuntime **out_runtime,
                                          CBoxliteError *out_error);
enum BoxliteErrorCode boxlite_runtime_shutdown(CBoxliteRuntime *runtime,
                                               int timeout,
                                               CBoxliteError *out_error);
enum BoxliteErrorCode boxlite_runtime_metrics_struct(CBoxliteRuntime *runtime,
                                                     CRuntimeMetrics *out_metrics,
                                                     CBoxliteError *out_error);

// ── Box Options Builder ──
enum BoxliteErrorCode boxlite_options_new(const char *image,
                                          CBoxliteOptions **out_opts,
                                          CBoxliteError *out_error);
void boxlite_options_set_name(CBoxliteOptions *opts, const char *name);
void boxlite_options_set_cpus(CBoxliteOptions *opts, int cpus);
void boxlite_options_set_memory(CBoxliteOptions *opts, int memory_mib);
void boxlite_options_set_disk(CBoxliteOptions *opts, int64_t disk_gb);
void boxlite_options_set_user(CBoxliteOptions *opts, const char *user);
void boxlite_options_set_workdir(CBoxliteOptions *opts, const char *workdir);
void boxlite_options_add_env(CBoxliteOptions *opts, const char *key, const char *val);
void boxlite_options_add_volume(CBoxliteOptions *opts, const char *host_path, const char *guest_path, int read_only);
void boxlite_options_add_port(CBoxliteOptions *opts, int guest_port, int host_port);
void boxlite_options_set_network_enabled(CBoxliteOptions *opts);
void boxlite_options_set_network_disabled(CBoxliteOptions *opts);
void boxlite_options_add_network_allow(CBoxliteOptions *opts, const char *host);
void boxlite_options_set_auto_remove(CBoxliteOptions *opts, int val);
void boxlite_options_set_detach(CBoxliteOptions *opts, int val);
void boxlite_options_set_entrypoint(CBoxliteOptions *opts, const char **args, int argc);
void boxlite_options_set_cmd(CBoxliteOptions *opts, const char **args, int argc);
void boxlite_options_free(CBoxliteOptions *opts);

// ── Box Lifecycle ──
enum BoxliteErrorCode boxlite_create_box(CBoxliteRuntime *runtime,
                                         CBoxliteOptions *opts,
                                         CBoxHandle **out_box,
                                         CBoxliteError *out_error);
enum BoxliteErrorCode boxlite_start_box(CBoxHandle *handle, CBoxliteError *out_error);
enum BoxliteErrorCode boxlite_stop_box(CBoxHandle *handle, CBoxliteError *out_error);
enum BoxliteErrorCode boxlite_get(CBoxliteRuntime *runtime,
                                  const char *id_or_name,
                                  CBoxHandle **out_handle,
                                  CBoxliteError *out_error);
enum BoxliteErrorCode boxlite_remove(CBoxliteRuntime *runtime,
                                     const char *id_or_name,
                                     int force,
                                     CBoxliteError *out_error);
char *boxlite_box_id(CBoxHandle *handle);

// ── Box Info & Metrics (C structs) ──
enum BoxliteErrorCode boxlite_box_info_struct(CBoxHandle *handle,
                                              CBoxInfo **out_info,
                                              CBoxliteError *out_error);
enum BoxliteErrorCode boxlite_box_metrics_struct(CBoxHandle *handle,
                                                 CBoxMetrics *out_metrics,
                                                 CBoxliteError *out_error);
enum BoxliteErrorCode boxlite_list_info_struct(CBoxliteRuntime *runtime,
                                               CBoxInfoList **out_list,
                                               CBoxliteError *out_error);

// ── Execution ──
enum BoxliteErrorCode boxlite_execute(CBoxHandle *handle,
                                      const char *command,
                                      const char *args_json,
                                      void (*callback)(const char*, int, void*),
                                      void *user_data,
                                      int *out_exit_code,
                                      CBoxliteError *out_error);
enum BoxliteErrorCode boxlite_execute_cmd(CBoxHandle *handle,
                                          const BoxliteCommand *cmd,
                                          void (*callback)(const char*, int, void*),
                                          void *user_data,
                                          int *out_exit_code,
                                          CBoxliteError *out_error);

// ── File Copy ──
enum BoxliteErrorCode boxlite_copy_into(CBoxHandle *handle,
                                        const char *host_src,
                                        const char *guest_dst,
                                        CBoxliteError *out_error);
enum BoxliteErrorCode boxlite_copy_out(CBoxHandle *handle,
                                       const char *guest_src,
                                       const char *host_dst,
                                       CBoxliteError *out_error);

// ── Images ──
enum BoxliteErrorCode boxlite_image_pull(CBoxliteRuntime *runtime,
                                         const char *image_ref,
                                         CBoxliteError *out_error);
enum BoxliteErrorCode boxlite_image_list_struct(CBoxliteRuntime *runtime,
                                                CImageInfoList **out_list,
                                                CBoxliteError *out_error);

// ── Memory Management ──
void boxlite_box_free(CBoxHandle *handle);
void boxlite_runtime_free(CBoxliteRuntime *runtime);
void boxlite_free_string(char *s);
void boxlite_error_free(CBoxliteError *error);
void boxlite_free_box_info(CBoxInfo *info);
void boxlite_free_box_info_list(CBoxInfoList *list);
void boxlite_free_image_info_list(CImageInfoList *list);

// ── Simple Runner API ──
enum BoxliteErrorCode boxlite_simple_new(const char *image, int cpus, int memory_mib,
                                         CBoxliteSimple **out_box, CBoxliteError *out_error);
enum BoxliteErrorCode boxlite_simple_run(CBoxliteSimple *box_runner, const char *command,
                                         const char *const *args, int argc,
                                         CBoxliteExecResult **out_result, CBoxliteError *out_error);
void boxlite_result_free(CBoxliteExecResult *result);
void boxlite_simple_free(CBoxliteSimple *box_runner);

#ifdef __cplusplus
}
#endif

#endif /* BOXLITE_H */
