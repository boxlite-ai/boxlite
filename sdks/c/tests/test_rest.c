/**
 * BoxLite C SDK - REST runtime construction tests.
 *
 * Unit-level: REST runtime construction performs no I/O (the HTTP
 * connection is lazy, on first operation), so these run without a VM
 * or network. They exercise the FFI argument-validation + construction
 * path of boxlite_rest_runtime_new and that the resulting handle frees
 * via the shared boxlite_runtime_free.
 */

#include "boxlite.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

static void test_rest_null_url_rejected(void) {
  printf("\nTEST: REST - null url is rejected\n");
  CBoxliteRuntime *rt = NULL;
  CBoxliteError error = {0};

  BoxliteErrorCode code =
      boxlite_rest_runtime_new(NULL, NULL, NULL, &rt, &error);

  assert(code == InvalidArgument);
  assert(rt == NULL);
  boxlite_error_free(&error);
  printf("  ✓ null url -> InvalidArgument\n");
}

static void test_rest_null_out_rejected(void) {
  printf("\nTEST: REST - null out_runtime is rejected\n");
  CBoxliteError error = {0};

  BoxliteErrorCode code = boxlite_rest_runtime_new("http://localhost:8100",
                                                   NULL, NULL, NULL, &error);

  assert(code == InvalidArgument);
  boxlite_error_free(&error);
  printf("  ✓ null out_runtime -> InvalidArgument\n");
}

static void test_rest_url_only(void) {
  printf("\nTEST: REST - url only (unauthenticated) constructs\n");
  CBoxliteRuntime *rt = NULL;
  CBoxliteError error = {0};

  BoxliteErrorCode code = boxlite_rest_runtime_new("http://localhost:8100",
                                                   NULL, NULL, &rt, &error);

  assert(code == Ok);
  assert(rt != NULL);
  boxlite_runtime_free(rt);
  printf("  ✓ constructed + freed via boxlite_runtime_free\n");
}

static void test_rest_url_key_prefix(void) {
  printf("\nTEST: REST - url + api_key + prefix constructs\n");
  CBoxliteRuntime *rt = NULL;
  CBoxliteError error = {0};

  BoxliteErrorCode code = boxlite_rest_runtime_new(
      "https://api.example.com", "blk_live_example", "v1", &rt, &error);

  assert(code == Ok);
  assert(rt != NULL);
  boxlite_runtime_free(rt);
  printf("  ✓ constructed with credential + prefix + freed\n");
}

int main(void) {
  printf("=== BoxLite C SDK: REST runtime tests ===\n");
  test_rest_null_url_rejected();
  test_rest_null_out_rejected();
  test_rest_url_only();
  test_rest_url_key_prefix();
  printf("\nAll REST runtime tests passed.\n");
  return 0;
}
