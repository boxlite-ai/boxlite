#ifndef BOXLITE_EXAMPLE_COMMON_H
#define BOXLITE_EXAMPLE_COMMON_H

// NOTE: this is the version ported to the post-and-drain callback API.
// It replaces the repo's examples/c/example_common.h, which used the old
// direct out-param signatures (boxlite_create_box(runtime,opts,&box,&err) and
// boxlite_execute(...)) that no longer exist in boxlite.h.

#include "boxlite.h"
#include <stdio.h>
#include <string.h>

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

// The post-and-drain API delivers the new handle via a callback.
typedef struct { CBoxHandle *box; } CreateBoxCtx;
static void on_box_created(CBoxHandle *box, CBoxliteError *err, void *ud) {
  (void)err;  // failures are also reported through boxlite_create_box's out_error
  ((CreateBoxCtx *)ud)->box = box;
}

// Create a box from already-built options. Takes ownership of `opts`.
static CBoxHandle *create_box_with_options_or_exit(CBoxliteRuntime *runtime,
                                                    CBoxliteOptions *opts) {
  CreateBoxCtx ctx = {0};
  CBoxliteError error = {0};
  BoxliteErrorCode code =
      boxlite_create_box(runtime, opts, on_box_created, &ctx, &error);
  boxlite_options_free(opts);
  if (code != Ok || ctx.box == NULL) {
    print_error("box creation", &error);
    boxlite_error_free(&error);
    return NULL;
  }
  return ctx.box;
}

static CBoxHandle *create_alpine_box_or_exit(CBoxliteRuntime *runtime) {
  CBoxliteOptions *opts = new_alpine_options_or_exit();
  if (opts == NULL) return NULL;
  return create_box_with_options_or_exit(runtime, opts);
}

// Bridge the new byte-stream callbacks to the examples' (text, is_stderr, ud) contract.
typedef struct {
  void (*cb)(const char *, int, void *);
  void *user_data;
  int exit_code;
} ExecCtx;

static void forward(const uint8_t *data, size_t len, int is_stderr, ExecCtx *c) {
  if (c->cb == NULL || len == 0) return;
  char buf[4096];
  size_t n = len < sizeof(buf) - 1 ? len : sizeof(buf) - 1;
  memcpy(buf, data, n);
  buf[n] = '\0';
  c->cb(buf, is_stderr, c->user_data);
}
static void on_stdout_chunk(const uint8_t *data, size_t len, void *ud) {
  forward(data, len, 0, (ExecCtx *)ud);
}
static void on_stderr_chunk(const uint8_t *data, size_t len, void *ud) {
  forward(data, len, 1, (ExecCtx *)ud);
}
static void on_wait_done(int exit_code, CBoxliteError *err, void *ud) {
  (void)err;
  ((ExecCtx *)ud)->exit_code = exit_code;
}

static BoxliteErrorCode
execute_and_wait(CBoxHandle *box, const char *command,
                 const char *const *args, int argc,
                 void (*callback)(const char *, int, void *), void *user_data,
                 int *out_exit_code, CBoxliteError *error) {
  BoxliteCommand cmd = {.command = command, .args = args, .argc = argc,
                        .env_pairs = NULL, .env_count = 0,
                        .workdir = NULL, .user = NULL,
                        .timeout_secs = 0.0, .tty = 0};
  ExecCtx ctx = {.cb = callback, .user_data = user_data, .exit_code = 0};

  CExecutionHandle *execution = NULL;
  BoxliteErrorCode code = boxlite_box_exec(box, &cmd, &execution, error);
  if (code != Ok) return code;

  if (callback != NULL) {
    code = boxlite_execution_on_stdout(execution, on_stdout_chunk, &ctx, error);
    if (code != Ok) { boxlite_execution_free(execution); return code; }
    code = boxlite_execution_on_stderr(execution, on_stderr_chunk, &ctx, error);
    if (code != Ok) { boxlite_execution_free(execution); return code; }
  }

  code = boxlite_execution_wait(execution, on_wait_done, &ctx, error);
  boxlite_execution_free(execution);
  if (code == Ok && out_exit_code != NULL) *out_exit_code = ctx.exit_code;
  return code;
}

#endif
