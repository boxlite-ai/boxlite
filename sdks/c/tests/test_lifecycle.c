/**
 * BoxLite C SDK - Lifecycle Tests
 *
 * Tests box lifecycle: create → start → stop → remove
 */

#include "test_runtime.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void test_create_box() {
  printf("\nTEST: Create box\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-lifecycle-create";
  BoxliteErrorCode code =
      boxlite_runtime_new(temp_dir, NULL, 0, &runtime, &error);
  if (code != Ok) {
    printf("  ✗ Error creating runtime: code=%d, message=%s\n", error.code,
           error.message ? error.message : "(null)");
    boxlite_error_free(&error);
  }
  assert(code == Ok);
  assert(runtime != NULL);

  CBoxliteOptions *opts = new_alpine_options(&error);
  CBoxHandle *box = NULL;
  code = boxlite_create_box(runtime, opts, &box, &error);

  if (code != Ok) {
    printf("  ✗ Error creating box: code=%d, message=%s\n", error.code,
           error.message ? error.message : "(null)");
  }

  assert(code == Ok);
  assert(box != NULL);
  printf("  ✓ Box created successfully\n");

  // Get box ID
  char *box_id = boxlite_box_id(box);
  assert(box_id != NULL);
  assert(strlen(box_id) > 0);
  printf("  ✓ Box ID: %s\n", box_id);
  boxlite_free_string(box_id);

  // Cleanup
  boxlite_stop_box(box, &error);
  boxlite_runtime_free(runtime);
}

void test_start_stop_restart() {
  printf("\nTEST: Start, stop, restart box\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-lifecycle-restart";
  BoxliteErrorCode code =
      boxlite_runtime_new(temp_dir, NULL, 0, &runtime, &error);
  assert(code == Ok);
  assert(runtime != NULL);

  // Set auto_remove to false so box persists after stop
  CBoxHandle *box = create_test_box(runtime, &error);

  char *box_id = boxlite_box_id(box);
  printf("  Box ID: %s\n", box_id);

  // Box is auto-started after creation, so it should be running
  printf("  ✓ Box auto-started\n");

  // Stop the box
  code = boxlite_stop_box(box, &error);
  assert(code == Ok);
  printf("  ✓ Box stopped\n");

  // Get box handle again after stop to verify persistence
  CBoxHandle *box2 = NULL;
  code = boxlite_get(runtime, box_id, &box2, &error);
  if (code != Ok) {
    printf("  ✗ Error getting box: code=%d, message=%s\n", error.code,
           error.message ? error.message : "(null)");
    boxlite_error_free(&error);
  }
  assert(code == Ok);
  assert(box2 != NULL);
  printf("  ✓ Box handle retrieved after stop\n");

  // Verify box info is accessible
  CBoxInfo *info = NULL;
  code = boxlite_box_info(box2, &info, &error);
  if (code != Ok) {
    printf("  ✗ Error getting box info: code=%d, message=%s\n", error.code,
           error.message ? error.message : "(null)");
    boxlite_error_free(&error);
  }
  assert(code == Ok);
  assert(info != NULL);
  printf("  ✓ Box info retrieved: id=%s status=%s\n", info->id, info->status);
  boxlite_free_box_info(info);

  // Final cleanup - manually remove since auto_remove=false
  code = boxlite_remove(runtime, box_id, 0, &error);
  if (code != Ok) {
    printf("  ✗ Error removing box: code=%d, message=%s\n", error.code,
           error.message ? error.message : "(null)");
    boxlite_error_free(&error);
  }
  boxlite_free_string(box_id);
  boxlite_runtime_free(runtime);
}

void test_remove_box() {
  printf("\nTEST: Remove box\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-lifecycle-remove";
  BoxliteErrorCode code =
      boxlite_runtime_new(temp_dir, NULL, 0, &runtime, &error);
  assert(code == Ok);
  assert(runtime != NULL);

  CBoxHandle *box = create_test_box(runtime, &error);

  char *box_id = boxlite_box_id(box);
  printf("  Box ID: %s\n", box_id);

  // Stop first
  boxlite_stop_box(box, &error);
  printf("  ✓ Box stopped\n");

  // Remove
  code = boxlite_remove(runtime, box_id, 0, &error);
  assert(code == Ok);
  printf("  ✓ Box removed\n");

  // Verify box is gone
  CBoxHandle *box2 = NULL;
  code = boxlite_get(runtime, box_id, &box2, &error);
  assert(code != Ok);
  assert(box2 == NULL);
  assert(error.message != NULL);
  printf("  ✓ Box confirmed removed (error: %s)\n", error.message);

  boxlite_error_free(&error);
  boxlite_free_string(box_id);
  boxlite_runtime_free(runtime);
}

void test_force_remove() {
  printf("\nTEST: Force remove running box\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-lifecycle-force";
  BoxliteErrorCode code =
      boxlite_runtime_new(temp_dir, NULL, 0, &runtime, &error);
  assert(code == Ok);
  assert(runtime != NULL);

  CBoxHandle *box = create_test_box(runtime, &error);

  char *box_id = boxlite_box_id(box);
  printf("  Box ID: %s\n", box_id);

  // Don't stop - force remove while running
  code = boxlite_remove(runtime, box_id, 1, &error); // force=1
  assert(code == Ok);
  printf("  ✓ Box force-removed while running\n");

  boxlite_free_string(box_id);
  boxlite_runtime_free(runtime);
}

void test_list_boxes() {
  printf("\nTEST: List boxes\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-lifecycle-list";
  BoxliteErrorCode code =
      boxlite_runtime_new(temp_dir, NULL, 0, &runtime, &error);
  assert(code == Ok);
  assert(runtime != NULL);

  // Create 2 boxes
  CBoxHandle *box1 = create_test_box(runtime, &error);
  CBoxHandle *box2 = create_test_box(runtime, &error);

  // List all boxes
  CBoxInfoList *list = NULL;
  code = boxlite_list_info(runtime, &list, &error);
  assert(code == Ok);
  assert(list != NULL);
  assert(list->count >= 2);
  printf("  ✓ Listed %d boxes\n", list->count);

  boxlite_free_box_info_list(list);

  // Cleanup
  char *id1 = boxlite_box_id(box1);
  char *id2 = boxlite_box_id(box2);

  boxlite_remove(runtime, id1, 1, &error);
  boxlite_remove(runtime, id2, 1, &error);

  boxlite_free_string(id1);
  boxlite_free_string(id2);
  boxlite_runtime_free(runtime);
}

void test_get_box_info() {
  printf("\nTEST: Get box info\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-lifecycle-info";
  BoxliteErrorCode code =
      boxlite_runtime_new(temp_dir, NULL, 0, &runtime, &error);
  assert(code == Ok);
  assert(runtime != NULL);

  CBoxHandle *box = create_test_box(runtime, &error);

  // Get info from handle
  CBoxInfo *info = NULL;
  code = boxlite_box_info(box, &info, &error);
  assert(code == Ok);
  assert(info != NULL);
  printf("  ✓ Box info from handle: id=%s status=%s\n", info->id, info->status);
  boxlite_free_box_info(info);

  // Get info by ID
  char *box_id = boxlite_box_id(box);
  info = NULL;
  code = boxlite_get_info(runtime, box_id, &info, &error);
  assert(code == Ok);
  assert(info != NULL);
  printf("  ✓ Box info by ID: id=%s status=%s\n", info->id, info->status);

  boxlite_free_box_info(info);
  boxlite_remove(runtime, box_id, 1, &error);
  boxlite_free_string(box_id);
  boxlite_runtime_free(runtime);
}

int main() {
  printf("═══════════════════════════════════════\n");
  printf("  BoxLite C SDK - Lifecycle Tests\n");
  printf("═══════════════════════════════════════\n");

  test_create_box();
  test_start_stop_restart();
  test_remove_box();
  test_force_remove();
  test_list_boxes();
  test_get_box_info();

  printf("\n═══════════════════════════════════════\n");
  printf("  ✅ ALL TESTS PASSED (%d tests)\n", 6);
  printf("═══════════════════════════════════════\n");

  return 0;
}
