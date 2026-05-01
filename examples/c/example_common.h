#ifndef BOXLITE_EXAMPLE_COMMON_H
#define BOXLITE_EXAMPLE_COMMON_H

#include "boxlite.h"
#include <stdio.h>

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

static CBoxHandle *create_alpine_box_or_exit(CBoxliteRuntime *runtime) {
  CBoxliteOptions *opts = new_alpine_options_or_exit();
  if (opts == NULL) {
    return NULL;
  }

  CBoxHandle *box = NULL;
  CBoxliteError error = {0};
  BoxliteErrorCode code = boxlite_create_box(runtime, opts, &box, &error);
  if (code != Ok) {
    print_error("box creation", &error);
    boxlite_error_free(&error);
    return NULL;
  }
  return box;
}

static BoxliteErrorCode
execute_and_wait(CBoxHandle *box, const char *command,
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
  BoxliteErrorCode code =
      boxlite_execute(box, &cmd, callback, user_data, &execution, error);
  if (code != Ok) {
    return code;
  }

  code = boxlite_execution_wait(execution, out_exit_code, error);
  boxlite_execution_free(execution);
  return code;
}

#endif
