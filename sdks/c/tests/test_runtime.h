#ifndef BOXLITE_C_TEST_RUNTIME_H
#define BOXLITE_C_TEST_RUNTIME_H

#include "boxlite.h"
#include <assert.h>
#include <ftw.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

static const char *const TEST_REGISTRIES[] = {
    "docker.m.daocloud.io", "docker.xuanyuan.me", "docker.1ms.run",
    "docker.io"};

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

#endif
