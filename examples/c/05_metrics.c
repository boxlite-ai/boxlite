/**
 * BoxLite C SDK - Example 5: Performance metrics.
 */

#include "example_common.h"
#include <stdio.h>
#include <unistd.h>

static void print_runtime_metrics(CBoxliteRuntime *runtime) {
  CBoxliteError error = {0};
  CRuntimeMetrics metrics = {0};
  BoxliteErrorCode code = boxlite_runtime_metrics(runtime, &metrics, &error);
  if (code != Ok) {
    print_error("runtime metrics", &error);
    boxlite_error_free(&error);
    return;
  }
  printf("created=%d failed=%d running=%d commands=%d exec_errors=%d\n",
         metrics.boxes_created_total, metrics.boxes_failed_total,
         metrics.num_running_boxes, metrics.total_commands_executed,
         metrics.total_exec_errors);
}

static void print_box_metrics(CBoxHandle *box) {
  CBoxliteError error = {0};
  CBoxMetrics metrics = {0};
  BoxliteErrorCode code = boxlite_box_metrics(box, &metrics, &error);
  if (code != Ok) {
    print_error("box metrics", &error);
    boxlite_error_free(&error);
    return;
  }
  printf("commands=%d exec_errors=%d memory=%lld cpu=%.2f\n",
         metrics.commands_executed, metrics.exec_errors,
         (long long)metrics.memory_bytes, metrics.cpu_percent);
}

int main(void) {
  printf("=== BoxLite Example: Performance Metrics ===\n\n");

  CBoxliteRuntime *runtime = create_runtime_or_exit();
  if (runtime == NULL) {
    return 1;
  }

  printf("Initial runtime metrics:\n");
  print_runtime_metrics(runtime);
  printf("\n");

  CBoxHandle *box = create_alpine_box_or_exit(runtime);
  if (box == NULL) {
    boxlite_runtime_free(runtime);
    return 1;
  }

  CBoxliteError error = {0};
  const char *const echo_args[] = {"test"};
  int exit_code = 0;
  for (int i = 0; i < 5; i++) {
    boxlite_execute(box, "/bin/echo", echo_args, 1, NULL, NULL, &exit_code,
                    &error);
  }

  printf("Runtime metrics after commands:\n");
  print_runtime_metrics(runtime);
  printf("\nBox metrics:\n");
  print_box_metrics(box);

  printf("\nMetric samples:\n");
  const char *const uname_args[] = {"-a"};
  for (int i = 0; i < 3; i++) {
    boxlite_execute(box, "/bin/uname", uname_args, 1, NULL, NULL, &exit_code,
                    &error);
    printf("sample %d: ", i + 1);
    print_box_metrics(box);
    sleep(1);
  }

  char *id = boxlite_box_id(box);
  boxlite_remove(runtime, id, 1, &error);
  boxlite_free_string(id);
  boxlite_runtime_free(runtime);

  printf("\n=== Metrics Demo Complete ===\n");
  return 0;
}
