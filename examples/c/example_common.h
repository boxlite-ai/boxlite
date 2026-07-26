#ifndef BOXLITE_EXAMPLE_COMMON_H
#define BOXLITE_EXAMPLE_COMMON_H

#include "boxlite.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static void print_error(const char *context, const CBoxliteError *error) {
  fprintf(stderr, "%s failed (code %d): %s\n", context, error->code,
          error->message ? error->message : "unknown");
}

static CBoxliteRuntime *create_runtime_or_exit(void) {
  CBoxliteRuntime *runtime = NULL;
  CBoxliteError error = {0};
  BoxliteErrorCode code = boxlite_runtime_new(NULL, NULL, 0, &runtime, &error);
  if (code != Ok) {
    print_error("runtime creation", &error);
    boxlite_error_free(&error);
    return NULL;
  }
  return runtime;
}

static CBoxliteOptions *new_alpine_options_or_exit(void) {
  CBoxliteOptions *opts = NULL;
  CBoxliteError error = {0};
  BoxliteErrorCode code = boxlite_options_new("alpine:3.19", &opts, &error);
  if (code != Ok) {
    print_error("option creation", &error);
    boxlite_error_free(&error);
    return NULL;
  }
  boxlite_options_set_network_enabled(opts);
  boxlite_options_set_auto_remove(opts, 0);
  return opts;
}

typedef struct ExampleBoxRequest {
  int done;
  CBoxHandle *box;
  BoxliteErrorCode error_code;
} ExampleBoxRequest;

static int example_drain_until_done(CBoxliteRuntime *runtime, const int *done,
                                    const char *context) {
  while (!*done) {
    CBoxliteError error = {0};
    if (boxlite_runtime_drain(runtime, -1, &error) < 0) {
      print_error(context, &error);
      boxlite_error_free(&error);
      return 0;
    }
  }
  return 1;
}

static void example_on_box_created(CBoxHandle *box, CBoxliteError *error,
                                   void *user_data) {
  ExampleBoxRequest *request = user_data;
  request->box = box;
  request->error_code = error->code;
  if (error->code != Ok) {
    print_error("box creation", error);
  }
  request->done = 1;
}

static inline CBoxHandle *create_alpine_box_or_exit(CBoxliteRuntime *runtime) {
  CBoxliteOptions *opts = new_alpine_options_or_exit();
  if (opts == NULL) {
    return NULL;
  }

  ExampleBoxRequest request = {0};
  CBoxliteError error = {0};
  BoxliteErrorCode code = boxlite_create_box(
      runtime, opts, example_on_box_created, &request, &error);
  if (code != Ok) {
    print_error("box creation", &error);
    boxlite_error_free(&error);
    boxlite_options_free(opts);
    return NULL;
  }
  if (!example_drain_until_done(runtime, &request.done, "drain box creation")) {
    return NULL;
  }
  return request.error_code == Ok ? request.box : NULL;
}

typedef struct ExampleOperationRequest {
  const char *context;
  int done;
  BoxliteErrorCode error_code;
} ExampleOperationRequest;

static void example_on_operation(CBoxliteError *error, void *user_data) {
  ExampleOperationRequest *request = user_data;
  request->error_code = error->code;
  if (error->code != Ok) {
    print_error(request->context, error);
  }
  request->done = 1;
}

static BoxliteErrorCode
example_finish_operation(CBoxliteRuntime *runtime,
                         ExampleOperationRequest *request) {
  if (!example_drain_until_done(runtime, &request->done, request->context)) {
    return Internal;
  }
  return request->error_code;
}

static inline BoxliteErrorCode example_stop_box(CBoxliteRuntime *runtime,
                                                CBoxHandle *box,
                                                CBoxliteError *error) {
  ExampleOperationRequest request = {.context = "stop box"};
  BoxliteErrorCode code =
      boxlite_stop_box(box, example_on_operation, &request, error);
  if (code != Ok) {
    print_error(request.context, error);
  }
  return code == Ok ? example_finish_operation(runtime, &request) : code;
}

static inline BoxliteErrorCode example_start_box(CBoxliteRuntime *runtime,
                                                 CBoxHandle *box,
                                                 CBoxliteError *error) {
  ExampleOperationRequest request = {.context = "start box"};
  BoxliteErrorCode code =
      boxlite_start_box(box, example_on_operation, &request, error);
  if (code != Ok) {
    print_error(request.context, error);
  }
  return code == Ok ? example_finish_operation(runtime, &request) : code;
}

static inline BoxliteErrorCode example_remove_box(CBoxliteRuntime *runtime,
                                                  const char *id, int force,
                                                  CBoxliteError *error) {
  ExampleOperationRequest request = {.context = "remove box"};
  BoxliteErrorCode code =
      boxlite_remove(runtime, id, force, example_on_operation, &request, error);
  if (code != Ok) {
    print_error(request.context, error);
  }
  return code == Ok ? example_finish_operation(runtime, &request) : code;
}

static inline BoxliteErrorCode
example_shutdown_runtime(CBoxliteRuntime *runtime, int timeout_secs,
                         CBoxliteError *error) {
  ExampleOperationRequest request = {.context = "runtime shutdown"};
  BoxliteErrorCode code = boxlite_runtime_shutdown(
      runtime, timeout_secs, example_on_operation, &request, error);
  if (code != Ok) {
    print_error(request.context, error);
  }
  return code == Ok ? example_finish_operation(runtime, &request) : code;
}

typedef struct ExampleGetBoxRequest {
  int done;
  CBoxHandle *box;
  BoxliteErrorCode error_code;
} ExampleGetBoxRequest;

static void example_on_get_box(CBoxHandle *box, CBoxliteError *error,
                               void *user_data) {
  ExampleGetBoxRequest *request = user_data;
  request->box = box;
  request->error_code = error->code;
  if (error->code != Ok) {
    print_error("get box", error);
  }
  request->done = 1;
}

static inline BoxliteErrorCode example_get_box(CBoxliteRuntime *runtime,
                                               const char *id_or_name,
                                               CBoxHandle **out_box,
                                               CBoxliteError *error) {
  ExampleGetBoxRequest request = {0};
  BoxliteErrorCode code =
      boxlite_get(runtime, id_or_name, example_on_get_box, &request, error);
  if (code != Ok) {
    print_error("get box", error);
    return code;
  }
  if (!example_drain_until_done(runtime, &request.done, "get box")) {
    return Internal;
  }
  *out_box = request.box;
  return request.error_code;
}

typedef struct ExampleRuntimeMetricsRequest {
  int done;
  BoxliteErrorCode error_code;
  CRuntimeMetrics metrics;
} ExampleRuntimeMetricsRequest;

static void example_on_runtime_metrics(CRuntimeMetrics *metrics,
                                       CBoxliteError *error, void *user_data) {
  ExampleRuntimeMetricsRequest *request = user_data;
  request->error_code = error->code;
  if (error->code == Ok && metrics != NULL) {
    request->metrics = *metrics;
  } else if (error->code != Ok) {
    print_error("runtime metrics", error);
  }
  request->done = 1;
}

static inline BoxliteErrorCode
example_get_runtime_metrics(CBoxliteRuntime *runtime,
                            CRuntimeMetrics *out_metrics,
                            CBoxliteError *error) {
  ExampleRuntimeMetricsRequest request = {0};
  BoxliteErrorCode code = boxlite_runtime_metrics(
      runtime, example_on_runtime_metrics, &request, error);
  if (code != Ok) {
    print_error("runtime metrics", error);
    return code;
  }
  if (!example_drain_until_done(runtime, &request.done, "runtime metrics")) {
    return Internal;
  }
  *out_metrics = request.metrics;
  return request.error_code;
}

typedef struct ExampleBoxMetricsRequest {
  int done;
  BoxliteErrorCode error_code;
  CBoxMetrics metrics;
} ExampleBoxMetricsRequest;

static void example_on_box_metrics(CBoxMetrics *metrics, CBoxliteError *error,
                                   void *user_data) {
  ExampleBoxMetricsRequest *request = user_data;
  request->error_code = error->code;
  if (error->code == Ok && metrics != NULL) {
    request->metrics = *metrics;
  } else if (error->code != Ok) {
    print_error("box metrics", error);
  }
  request->done = 1;
}

static inline BoxliteErrorCode example_get_box_metrics(CBoxliteRuntime *runtime,
                                                       CBoxHandle *box,
                                                       CBoxMetrics *out_metrics,
                                                       CBoxliteError *error) {
  ExampleBoxMetricsRequest request = {0};
  BoxliteErrorCode code =
      boxlite_box_metrics(box, example_on_box_metrics, &request, error);
  if (code != Ok) {
    print_error("box metrics", error);
    return code;
  }
  if (!example_drain_until_done(runtime, &request.done, "box metrics")) {
    return Internal;
  }
  *out_metrics = request.metrics;
  return request.error_code;
}

typedef struct ExampleExecutionRequest {
  int done;
  int exit_code;
  void (*output_callback)(const char *, int, void *);
  void *output_user_data;
} ExampleExecutionRequest;

static void example_forward_output(const uint8_t *data, size_t len,
                                   int is_stderr,
                                   ExampleExecutionRequest *request) {
  if (request->output_callback == NULL) {
    return;
  }

  char *text = malloc(len + 1);
  if (text == NULL) {
    return;
  }
  for (size_t index = 0; index < len; index++) {
    text[index] = (char)data[index];
  }
  text[len] = '\0';
  request->output_callback(text, is_stderr, request->output_user_data);
  free(text);
}

static void example_on_stdout(const uint8_t *data, size_t len,
                              void *user_data) {
  example_forward_output(data, len, 0, user_data);
}

static void example_on_stderr(const uint8_t *data, size_t len,
                              void *user_data) {
  example_forward_output(data, len, 1, user_data);
}

static void example_on_execution_exit(int exit_code, void *user_data) {
  ExampleExecutionRequest *request = user_data;
  request->exit_code = exit_code;
  request->done = 1;
}

static inline BoxliteErrorCode
execute_and_wait(CBoxliteRuntime *runtime, CBoxHandle *box, const char *command,
                 const char *const *args, int argc,
                 void (*callback)(const char *, int, void *), void *user_data,
                 int *out_exit_code, CBoxliteError *error) {
  BoxliteCommand cmd = {.command = command,
                        .args = args,
                        .argc = argc,
                        .env_pairs = NULL,
                        .env_count = 0,
                        .workdir = NULL,
                        .user = NULL,
                        .timeout_secs = 0.0,
                        .tty = 0};
  CExecutionHandle *execution = NULL;
  BoxliteErrorCode code = boxlite_box_exec(box, &cmd, &execution, error);
  if (code != Ok) {
    return code;
  }

  ExampleExecutionRequest *request = calloc(1, sizeof(*request));
  if (request == NULL) {
    boxlite_execution_free(execution);
    return Internal;
  }
  request->output_callback = callback;
  request->output_user_data = user_data;

  code =
      boxlite_execution_on_stdout(execution, example_on_stdout, request, error);
  if (code == Ok) {
    code = boxlite_execution_on_stderr(execution, example_on_stderr, request,
                                       error);
  }
  // Register Exit even after a partial stream-registration failure. It is
  // queued after every installed pump, providing a safe lifetime boundary for
  // the heap-backed callback state before the function returns.
  BoxliteErrorCode exit_registration = boxlite_execution_on_exit(
      execution, example_on_execution_exit, request, error);
  if (exit_registration == Ok) {
    if (example_drain_until_done(runtime, &request->done,
                                 "drain execution wait")) {
      *out_exit_code = request->exit_code;
      free(request);
    } else {
      // The terminal callback may still arrive; retain its state on failure.
      code = Internal;
    }
  } else {
    // A registered stream callback may already be queued. Keep its state alive
    // rather than returning a dangling user_data pointer.
    code = exit_registration;
  }
  boxlite_execution_free(execution);
  return code;
}

#endif
