#ifndef BOXLITE_C_TEST_RUNTIME_H
#define BOXLITE_C_TEST_RUNTIME_H

#include "boxlite.h"
#include <assert.h>
#include <ftw.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

static const BoxliteImageRegistry TEST_REGISTRIES[] = {
    {.host = "docker.m.daocloud.io",
     .transport = BoxliteRegistryTransportHttps,
     .skip_verify = 0,
     .search = 1,
     .username = NULL,
     .password = NULL,
     .bearer_token = NULL},
    {.host = "docker.xuanyuan.me",
     .transport = BoxliteRegistryTransportHttps,
     .skip_verify = 0,
     .search = 1,
     .username = NULL,
     .password = NULL,
     .bearer_token = NULL},
    {.host = "docker.1ms.run",
     .transport = BoxliteRegistryTransportHttps,
     .skip_verify = 0,
     .search = 1,
     .username = NULL,
     .password = NULL,
     .bearer_token = NULL},
    {.host = "docker.io",
     .transport = BoxliteRegistryTransportHttps,
     .skip_verify = 0,
     .search = 1,
     .username = NULL,
     .password = NULL,
     .bearer_token = NULL}};

static const int TEST_REGISTRIES_COUNT = 4;

static int remove_tree_entry(const char *path, const struct stat *statbuf,
                             int typeflag, struct FTW *ftwbuf) {
  (void)statbuf;
  (void)typeflag;
  (void)ftwbuf;
  return remove(path);
}

static void reset_test_home(const char *temp_dir) {
  struct stat statbuf;
  if (lstat(temp_dir, &statbuf) != 0) {
    return;
  }

  assert(nftw(temp_dir, remove_tree_entry, 32, FTW_DEPTH | FTW_PHYS) == 0);
}

static CBoxliteRuntime *new_test_runtime(const char *temp_dir,
                                         CBoxliteError *error) {
  CBoxliteRuntime *runtime = NULL;
  BoxliteErrorCode code = boxlite_runtime_new(
      temp_dir, TEST_REGISTRIES, TEST_REGISTRIES_COUNT, &runtime, error);
  assert(code == Ok);
  assert(runtime != NULL);
  return runtime;
}

static CBoxliteOptions *new_alpine_options(CBoxliteError *error) {
  CBoxliteOptions *opts = NULL;
  BoxliteErrorCode code = boxlite_options_new("alpine:3.19", &opts, error);
  assert(code == Ok);
  assert(opts != NULL);
  boxlite_options_set_network_enabled(opts);
  boxlite_options_set_auto_remove(opts, 0);
  return opts;
}

static CBoxHandle *create_box_with_options(CBoxliteRuntime *runtime,
                                           CBoxliteOptions *opts,
                                           CBoxliteError *error) {
  CBoxHandle *box = NULL;
  BoxliteErrorCode code = boxlite_create_box(runtime, opts, &box, error);
  if (code != Ok) {
    printf("  ✗ Failed to create box: code=%d, message=%s\n", error->code,
           error->message ? error->message : "(null)");
    boxlite_error_free(error);
  }
  assert(code == Ok);
  assert(box != NULL);
  return box;
}

static CBoxHandle *create_test_box(CBoxliteRuntime *runtime,
                                   CBoxliteError *error) {
  CBoxliteOptions *opts = new_alpine_options(error);
  return create_box_with_options(runtime, opts, error);
}

static BoxliteErrorCode
test_execute_cmd(CBoxHandle *box, const BoxliteCommand *cmd,
                 void (*callback)(const char *, int, void *), void *user_data,
                 int *out_exit_code, CBoxliteError *error) {
  CExecutionHandle *execution = NULL;
  BoxliteErrorCode code =
      boxlite_execute(box, cmd, callback, user_data, &execution, error);
  if (code != Ok) {
    return code;
  }

  code = boxlite_execution_wait(execution, out_exit_code, error);
  boxlite_execution_free(execution);
  return code;
}

static BoxliteErrorCode
test_execute(CBoxHandle *box, const char *command, const char *const *args,
             int argc, void (*callback)(const char *, int, void *),
             void *user_data, int *out_exit_code, CBoxliteError *error) {
  BoxliteCommand cmd = {.command = command,
                        .args = args,
                        .argc = argc,
                        .env_pairs = NULL,
                        .env_count = 0,
                        .workdir = NULL,
                        .user = NULL,
                        .timeout_secs = 0.0,
                        .tty = 0};
  return test_execute_cmd(box, &cmd, callback, user_data, out_exit_code, error);
}

#endif
