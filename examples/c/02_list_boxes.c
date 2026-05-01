/**
 * BoxLite C SDK - Example 2: List and inspect boxes.
 */

#include "example_common.h"
#include <stdio.h>
#include <string.h>

static void print_box_info(const CBoxInfo *info) {
  printf("id=%s image=%s status=%s running=%d pid=%d\n",
         info->id ? info->id : "", info->image ? info->image : "",
         info->status ? info->status : "", info->running, info->pid);
}

int main(void) {
  printf("=== BoxLite Example: List and Inspect Boxes ===\n\n");

  CBoxliteRuntime *runtime = create_runtime_or_exit();
  if (runtime == NULL) {
    return 1;
  }

  CBoxHandle *box1 = create_alpine_box_or_exit(runtime);
  CBoxHandle *box2 = create_alpine_box_or_exit(runtime);
  CBoxHandle *box3 = create_alpine_box_or_exit(runtime);
  if (box1 == NULL || box2 == NULL || box3 == NULL) {
    boxlite_runtime_free(runtime);
    return 1;
  }

  char *id1 = boxlite_box_id(box1);
  char *id2 = boxlite_box_id(box2);
  char *id3 = boxlite_box_id(box3);
  printf("Created boxes:\n  %s\n  %s\n  %s\n\n", id1, id2, id3);

  CBoxliteError error = {0};
  CBoxInfoList *list = NULL;
  BoxliteErrorCode code = boxlite_list_info(runtime, &list, &error);
  if (code == Ok) {
    printf("All boxes (%d):\n", list->count);
    for (int i = 0; i < list->count; i++) {
      print_box_info(&list->items[i]);
    }
    boxlite_free_box_info_list(list);
  } else {
    print_error("list boxes", &error);
    boxlite_error_free(&error);
  }
  printf("\n");

  CBoxInfo *info = NULL;
  code = boxlite_get_info(runtime, id1, &info, &error);
  if (code == Ok) {
    printf("Box 1 info:\n");
    print_box_info(info);
    boxlite_free_box_info(info);
  } else {
    print_error("get box info", &error);
    boxlite_error_free(&error);
  }
  printf("\n");

  char prefix[9] = {0};
  strncpy(prefix, id3, 8);
  code = boxlite_get_info(runtime, prefix, &info, &error);
  if (code == Ok) {
    printf("Prefix lookup (%s):\n", prefix);
    print_box_info(info);
    boxlite_free_box_info(info);
  } else {
    print_error("prefix lookup", &error);
    boxlite_error_free(&error);
  }
  printf("\n");

  CRuntimeMetrics metrics = {0};
  code = boxlite_runtime_metrics(runtime, &metrics, &error);
  if (code == Ok) {
    printf("Runtime metrics: created=%d running=%d commands=%d\n",
           metrics.boxes_created_total, metrics.num_running_boxes,
           metrics.total_commands_executed);
  } else {
    print_error("runtime metrics", &error);
    boxlite_error_free(&error);
  }

  boxlite_remove(runtime, id1, 1, &error);
  boxlite_remove(runtime, id2, 1, &error);
  boxlite_remove(runtime, id3, 1, &error);
  boxlite_free_string(id1);
  boxlite_free_string(id2);
  boxlite_free_string(id3);
  boxlite_runtime_free(runtime);

  printf("\n=== List and Inspect Demo Complete ===\n");
  return 0;
}
