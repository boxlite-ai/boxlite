/**
 * BoxLite C SDK — NULL-callback rejection (Codex finding #3 reproducer)
 *
 * The async FFI entrypoints take callback parameters that, on the Rust side,
 * are typed as `Option<extern "C" fn(...)>`. Passing NULL from C must yield
 * a synchronous BoxliteErrorCode_InvalidArgument, never UB.
 *
 * BEFORE FIX: typedefs were bare `extern "C" fn(...)` (non-null by Rust ABI).
 * Passing NULL invoked UB the moment Rust tried to load/store the parameter,
 * and dispatch eventually called a NULL fn pointer → segfault.
 * AFTER FIX: typedefs are `Option<extern "C" fn(...)>`; cbindgen still emits
 * `void (*cb)(...)` in the C header so this file compiles unchanged. Rust
 * receives `None` via NPO and the entrypoint returns InvalidArgument.
 */

#include "boxlite.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *temp_home_dir(void) {
  /* Fixed path is fine for a single-process test; concurrent test runs are
   * not part of the supported workflow for this suite. */
  return "/tmp/boxlite-c-null-cb";
}

static CBoxliteRuntime *new_runtime(void) {
  CBoxliteRuntime *rt = NULL;
  CBoxliteError err = (CBoxliteError){0};
  BoxliteErrorCode code =
      boxlite_runtime_new(temp_home_dir(), NULL, 0, &rt, &err);
  if (code != Ok) {
    printf("runtime_new failed: code=%d msg=%s\n", code,
           err.message ? err.message : "<none>");
    boxlite_error_free(&err);
    exit(1);
  }
  return rt;
}

static void assert_null_cb_rejected(BoxliteErrorCode code, CBoxliteError *err,
                                    const char *which) {
  if (code != InvalidArgument) {
    printf("%s: expected InvalidArgument (5), got code=%d msg=%s\n", which,
           code, err->message ? err->message : "<none>");
    exit(1);
  }
  if (err->message == NULL || strstr(err->message, "cb") == NULL) {
    printf("%s: error message should mention 'cb' but was: %s\n", which,
           err->message ? err->message : "<none>");
    exit(1);
  }
  printf("  [ok] %s -> InvalidArgument: %s\n", which, err->message);
  boxlite_error_free(err);
}

static void test_create_box_null_cb(CBoxliteRuntime *rt) {
  CBoxliteOptions *opts = NULL;
  CBoxliteError err = (CBoxliteError){0};
  BoxliteErrorCode oc = boxlite_options_new("alpine:latest", &opts, &err);
  assert(oc == Ok);

  err = (CBoxliteError){0};
  BoxliteErrorCode code = boxlite_create_box(rt, opts, NULL, NULL, &err);
  assert_null_cb_rejected(code, &err, "boxlite_create_box(cb=NULL)");

  /* opts is only consumed by boxlite_create_box on success — free here. */
  boxlite_options_free(opts);
}

static void test_runtime_metrics_null_cb(CBoxliteRuntime *rt) {
  CBoxliteError err = (CBoxliteError){0};
  BoxliteErrorCode code = boxlite_runtime_metrics(rt, NULL, NULL, &err);
  assert_null_cb_rejected(code, &err, "boxlite_runtime_metrics(cb=NULL)");
}

static void test_list_info_null_cb(CBoxliteRuntime *rt) {
  CBoxliteError err = (CBoxliteError){0};
  BoxliteErrorCode code = boxlite_list_info(rt, NULL, NULL, &err);
  assert_null_cb_rejected(code, &err, "boxlite_list_info(cb=NULL)");
}

static void test_runtime_shutdown_null_cb(CBoxliteRuntime *rt) {
  CBoxliteError err = (CBoxliteError){0};
  BoxliteErrorCode code = boxlite_runtime_shutdown(rt, 0, NULL, NULL, &err);
  assert_null_cb_rejected(code, &err, "boxlite_runtime_shutdown(cb=NULL)");
}

int main(void) {
  printf("\n═══════════════════════════════════════\n");
  printf("  BoxLite C SDK - NULL callback rejection\n");
  printf("═══════════════════════════════════════\n\n");

  CBoxliteRuntime *rt = new_runtime();

  test_create_box_null_cb(rt);
  test_runtime_metrics_null_cb(rt);
  test_list_info_null_cb(rt);
  test_runtime_shutdown_null_cb(rt);

  boxlite_runtime_free(rt);

  printf("\n═══════════════════════════════════════\n");
  printf("  ✅ ALL NULL-CB TESTS PASSED (4 tests)\n");
  printf("═══════════════════════════════════════\n");
  return 0;
}
