/**
 * BoxLite C SDK - Example 1: Box lifecycle.
 */

#include "example_common.h"
#include <stdio.h>

int main(void) {
  printf("=== BoxLite Example: Box Lifecycle ===\n\n");

  CBoxliteRuntime *runtime = create_runtime_or_exit();
  if (runtime == NULL) {
    return 1;
  }

  printf("1. Creating box...\n");
  CBoxHandle *box = create_alpine_box_or_exit(runtime);
  if (box == NULL) {
    boxlite_runtime_free(runtime);
    return 1;
  }

  CBoxliteError error = {0};
  char *box_id = boxlite_box_id(box);
  printf("   Box ID: %s\n\n", box_id);

  printf("2. Executing hostname...\n");
  int exit_code = 0;
  BoxliteErrorCode code = boxlite_execute(
      box, "/bin/hostname", NULL, 0, NULL, NULL, &exit_code, &error);
  if (code != Ok) {
    print_error("hostname", &error);
    boxlite_error_free(&error);
  }
  printf("   Exit code: %d\n\n", exit_code);

  printf("3. Stopping box...\n");
  code = boxlite_stop_box(box, &error);
  if (code != Ok) {
    print_error("stop", &error);
    boxlite_error_free(&error);
  }
  printf("   Stopped\n\n");

  printf("4. Reattaching and restarting...\n");
  CBoxHandle *box2 = NULL;
  code = boxlite_get(runtime, box_id, &box2, &error);
  if (code != Ok) {
    print_error("get", &error);
    boxlite_error_free(&error);
    boxlite_free_string(box_id);
    boxlite_runtime_free(runtime);
    return 1;
  }
  code = boxlite_start_box(box2, &error);
  if (code != Ok) {
    print_error("start", &error);
    boxlite_error_free(&error);
  }
  printf("   Restarted\n\n");

  printf("5. Executing uname -a...\n");
  const char *const uname_args[] = {"-a"};
  exit_code = 0;
  code = boxlite_execute(box2, "/bin/uname", uname_args, 1, NULL, NULL,
                         &exit_code, &error);
  if (code != Ok) {
    print_error("uname", &error);
    boxlite_error_free(&error);
  }
  printf("   Exit code: %d\n\n", exit_code);

  printf("6. Removing box...\n");
  code = boxlite_remove(runtime, box_id, 1, &error);
  if (code != Ok) {
    print_error("remove", &error);
    boxlite_error_free(&error);
  }

  boxlite_free_string(box_id);
  boxlite_runtime_free(runtime);

  printf("\n=== Lifecycle Demo Complete ===\n");
  return 0;
}
