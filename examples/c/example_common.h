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

#endif
