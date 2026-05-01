/**
 * BoxLite C SDK - Example 4: Structured error handling.
 */

#include "example_common.h"
#include <stdio.h>
#include <string.h>

static void show_error(const char *context, CBoxliteError *error) {
  printf("%s failed\n", context);
  printf("  code=%d\n", error->code);
  printf("  message=%s\n", error->message ? error->message : "unknown");
}

int main(void) {
  printf("=== BoxLite Example: Error Handling ===\n\n");

  printf("1. InvalidArgument error\n");
  CBoxliteSimple *box = NULL;
  CBoxliteError error = {0};
  BoxliteErrorCode code = boxlite_simple_new(NULL, 0, 0, &box, &error);
  if (code != Ok) {
    show_error("boxlite_simple_new", &error);
    boxlite_error_free(&error);
  }
  printf("\n");

  printf("2. NotFound error\n");
  CBoxliteRuntime *runtime = create_runtime_or_exit();
  if (runtime == NULL) {
    return 1;
  }
  CBoxHandle *handle = NULL;
  code = boxlite_get(runtime, "nonexistent-box-id", &handle, &error);
  if (code != Ok) {
    show_error("boxlite_get", &error);
    boxlite_error_free(&error);
  }
  printf("\n");

  printf("3. Recovery after an error\n");
  code = boxlite_simple_new("alpine:3.19", 0, 0, &box, &error);
  if (code != Ok) {
    show_error("boxlite_simple_new", &error);
    boxlite_error_free(&error);
    boxlite_runtime_free(runtime);
    return 1;
  }
  printf("created simple box after previous error\n\n");

  printf("4. Command exit failures are reported separately\n");
  const char *const missing_args[] = {"/nonexistent"};
  CBoxliteExecResult *result = NULL;
  code = boxlite_simple_run(box, "/bin/ls", missing_args, 1, &result, &error);
  if (code == Ok) {
    printf("API call succeeded, process exit code=%d\n", result->exit_code);
    if (result->stderr_text != NULL && strlen(result->stderr_text) > 0) {
      printf("stderr: %s\n", result->stderr_text);
    }
    boxlite_result_free(result);
  } else {
    show_error("boxlite_simple_run", &error);
    boxlite_error_free(&error);
  }
  printf("\n");

  printf("5. Branch on error code\n");
  code = boxlite_get(runtime, "still-missing", &handle, &error);
  if (code == NotFound) {
    printf("handled NotFound specifically: %s\n", error.message);
  } else if (code != Ok) {
    show_error("boxlite_get", &error);
  }
  boxlite_error_free(&error);

  boxlite_simple_free(box);
  boxlite_runtime_free(runtime);
  printf("\n=== Error Handling Demo Complete ===\n");
  return 0;
}
