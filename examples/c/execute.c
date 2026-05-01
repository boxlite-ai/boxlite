/**
 * BoxLite C SDK - Command execution with streaming output.
 */

#include "example_common.h"
#include <stdio.h>

static void output_callback(const char *text, int is_stderr, void *user_data) {
  (void)user_data;
  FILE *stream = is_stderr ? stderr : stdout;
  fprintf(stream, "%s", text ? text : "");
}

int main(void) {
  printf("BoxLite C API Example\n");
  printf("Version: %s\n\n", boxlite_version());

  CBoxliteRuntime *runtime = create_runtime_or_exit();
  if (runtime == NULL) {
    return 1;
  }

  CBoxHandle *box = create_alpine_box_or_exit(runtime);
  if (box == NULL) {
    boxlite_runtime_free(runtime);
    return 1;
  }

  const char *const ls_args[] = {"-alrt", "/"};
  const char *const ip_args[] = {"addr"};
  int exit_code = 0;
  CBoxliteError error = {0};

  printf("Command 1: ls -alrt /\n---\n");
  BoxliteErrorCode code = execute_and_wait(
      box, "/bin/ls", ls_args, 2, output_callback, NULL, &exit_code, &error);
  if (code != Ok) {
    print_error("ls", &error);
    boxlite_error_free(&error);
  }
  printf("\nExit code: %d\n\n", exit_code);

  printf("Command 2: ip addr\n---\n");
  error = (CBoxliteError){0};
  exit_code = 0;
  code = execute_and_wait(box, "ip", ip_args, 1, output_callback, NULL,
                          &exit_code, &error);
  if (code != Ok) {
    print_error("ip addr", &error);
    boxlite_error_free(&error);
  }
  printf("\nExit code: %d\n\n", exit_code);

  printf("Command 3: env\n---\n");
  error = (CBoxliteError){0};
  exit_code = 0;
  code = execute_and_wait(box, "/usr/bin/env", NULL, 0, output_callback, NULL,
                          &exit_code, &error);
  if (code != Ok) {
    print_error("env", &error);
    boxlite_error_free(&error);
  }
  printf("\nExit code: %d\n", exit_code);

  char *id = boxlite_box_id(box);
  boxlite_remove(runtime, id, 1, &error);
  boxlite_free_string(id);
  boxlite_runtime_free(runtime);
  return 0;
}
