/**
 * Runtime shutdown example.
 */

#include "example_common.h"
#include <stdio.h>

int main(void) {
  printf("=== Runtime Shutdown Example ===\n\n");

  CBoxliteRuntime *runtime = create_runtime_or_exit();
  if (runtime == NULL) {
    return 1;
  }

  CBoxliteError error = {0};
  CBoxHandle *boxes[3] = {0};
  for (int i = 0; i < 3; i++) {
    boxes[i] = create_alpine_box_or_exit(runtime);
    if (boxes[i] == NULL) {
      continue;
    }
    char *id = boxlite_box_id(boxes[i]);
    printf("Created box %d: %s\n", i + 1, id);
    boxlite_free_string(id);
  }

  CRuntimeMetrics metrics = {0};
  BoxliteErrorCode code = boxlite_runtime_metrics(runtime, &metrics, &error);
  if (code == Ok) {
    printf("\nBefore shutdown: running=%d created=%d\n",
           metrics.num_running_boxes, metrics.boxes_created_total);
  } else {
    print_error("runtime metrics", &error);
    boxlite_error_free(&error);
  }

  printf("\nShutting down all boxes (5 second timeout)...\n");
  error = (CBoxliteError){0};
  code = boxlite_runtime_shutdown(runtime, 5, &error);
  if (code != Ok) {
    print_error("shutdown", &error);
    boxlite_error_free(&error);
  } else {
    printf("Shutdown complete\n");
  }

  printf("\nTrying to create a new box after shutdown...\n");
  CBoxliteOptions *opts = new_alpine_options_or_exit();
  CBoxHandle *new_box = NULL;
  error = (CBoxliteError){0};
  code = boxlite_create_box(runtime, opts, &new_box, &error);
  if (code == Ok && new_box != NULL) {
    printf("unexpected success\n");
  } else {
    printf("Expected error (code %d): %s\n", error.code,
           error.message ? error.message : "unknown");
    boxlite_error_free(&error);
  }

  boxlite_runtime_free(runtime);
  return 0;
}
