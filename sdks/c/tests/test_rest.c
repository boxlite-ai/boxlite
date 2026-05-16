/**
 * BoxLite C SDK - REST runtime construction tests.
 *
 * Unit-level: REST runtime construction performs no I/O (the HTTP
 * connection is lazy, on first operation), so these run without a VM
 * or network. They exercise the opaque credential + options FFI
 * (boxlite_api_key_credential_new / boxlite_rest_options_new /
 * _set_credential / _set_prefix / boxlite_rest_runtime_new_with_options)
 * and that the resulting runtime frees via the shared
 * boxlite_runtime_free.
 */

#include "boxlite.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

static void test_rest_options_null_out_rejected(void) {
  printf("\nTEST: REST - null out_options is rejected\n");
  CBoxliteError error = {0};

  BoxliteErrorCode code =
      boxlite_rest_options_new("https://api.example.com", NULL, &error);

  assert(code == InvalidArgument);
  boxlite_error_free(&error);
  printf("  ✓ null out_options -> InvalidArgument\n");
}

static void test_credential_null_out_rejected(void) {
  printf("\nTEST: REST - null out_credential is rejected\n");
  CBoxliteError error = {0};

  BoxliteErrorCode code =
      boxlite_api_key_credential_new("blk_live_example", NULL, &error);

  assert(code == InvalidArgument);
  boxlite_error_free(&error);
  printf("  ✓ null out_credential -> InvalidArgument\n");
}

static void test_runtime_null_options_rejected(void) {
  printf("\nTEST: REST - null options is rejected\n");
  CBoxliteRuntime *rt = NULL;
  CBoxliteError error = {0};

  BoxliteErrorCode code =
      boxlite_rest_runtime_new_with_options(NULL, &rt, &error);

  assert(code == InvalidArgument);
  assert(rt == NULL);
  boxlite_error_free(&error);
  printf("  ✓ null options -> InvalidArgument\n");
}

static void test_rest_url_only(void) {
  printf("\nTEST: REST - url only (unauthenticated) constructs\n");
  CBoxliteRestOptions *opts = NULL;
  CBoxliteRuntime *rt = NULL;
  CBoxliteError error = {0};

  BoxliteErrorCode code =
      boxlite_rest_options_new("http://localhost:8100", &opts, &error);
  assert(code == Ok);
  assert(opts != NULL);

  code = boxlite_rest_runtime_new_with_options(opts, &rt, &error);
  assert(code == Ok);
  assert(rt != NULL);

  boxlite_rest_options_free(opts);
  boxlite_runtime_free(rt);
  printf("  ✓ constructed + freed via boxlite_runtime_free\n");
}

static void test_rest_credential_and_prefix(void) {
  printf("\nTEST: REST - credential + prefix constructs\n");
  CBoxliteCredential *cred = NULL;
  CBoxliteRestOptions *opts = NULL;
  CBoxliteRuntime *rt = NULL;
  CBoxliteError error = {0};

  BoxliteErrorCode code =
      boxlite_api_key_credential_new("blk_live_example", &cred, &error);
  assert(code == Ok);
  assert(cred != NULL);

  code = boxlite_rest_options_new("https://api.example.com", &opts, &error);
  assert(code == Ok);
  assert(opts != NULL);

  boxlite_rest_options_set_credential(opts, cred);
  boxlite_rest_options_set_prefix(opts, "v1");

  code = boxlite_rest_runtime_new_with_options(opts, &rt, &error);
  assert(code == Ok);
  assert(rt != NULL);

  /* Options/credential are owned by the caller and freed independently;
   * the runtime keeps its own cloned reference. */
  boxlite_rest_options_free(opts);
  boxlite_credential_free(cred);
  boxlite_runtime_free(rt);
  printf("  ✓ constructed with credential + prefix + freed\n");
}

int main(void) {
  printf("=== BoxLite C SDK: REST runtime tests ===\n");
  test_rest_options_null_out_rejected();
  test_credential_null_out_rejected();
  test_runtime_null_options_rejected();
  test_rest_url_only();
  test_rest_credential_and_prefix();
  printf("\nAll REST runtime tests passed.\n");
  return 0;
}
