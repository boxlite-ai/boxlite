#ifndef BOXLITE_C_TEST_RUNTIME_H
#define BOXLITE_C_TEST_RUNTIME_H

#include "boxlite.h"
#include <assert.h>
#include <ftw.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

static const char *TEST_REGISTRIES =
    "[\"docker.m.daocloud.io\",\"docker.xuanyuan.me\",\"docker.1ms.run\","
    "\"docker.io\"]";

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
  BoxliteErrorCode code =
      boxlite_runtime_new(temp_dir, TEST_REGISTRIES, &runtime, error);
  assert(code == Ok);
  assert(runtime != NULL);
  return runtime;
}

#endif
