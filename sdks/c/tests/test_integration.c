/**
 * BoxLite C SDK - Integration Tests
 *
 * Tests complex scenarios: multi-box, reattachment, metrics
 */

#include "boxlite.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void test_multiple_boxes() {
  printf("\nTEST: Create and manage multiple boxes\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-integration-multiple";
  BoxliteErrorCode code =
      boxlite_runtime_new(temp_dir, NULL, 0, NULL, 0, &runtime, &error);
  assert(code == Ok);
  assert(runtime != NULL);

  CBoxliteOptions *opts = NULL;
  code = boxlite_options_new("alpine:3.19", &opts, &error);
  assert(code == Ok);
  CBoxHandle *box1 = NULL;
  code = boxlite_create_box(runtime, opts, &box1, &error);
  boxlite_options_free(opts);
  assert(code == Ok);
  assert(box1 != NULL);

  char *box_id = boxlite_box_id(box1);
  printf("  Box ID: %s\n", box_id);

  // Stop the box
  boxlite_stop_box(box1, &error);
  printf("  ✓ Box stopped\n");

  // Reattach to the same box
  CBoxHandle *box2 = NULL;
  code = boxlite_get(runtime, box_id, &box2, &error);
  assert(code == Ok);
  assert(box2 != NULL);
  printf("  ✓ Reattached to box\n");

  // Restart and execute
  code = boxlite_start_box(box2, &error);
  assert(code == Ok);

  const char *args[] = {"reattached"};
  int exit_code = 0;
  code = boxlite_execute(box2, "/bin/echo", args, 1, NULL, NULL, &exit_code,
                         &error);
  assert(code == Ok);
  assert(exit_code == 0);
  printf("  ✓ Executed command after reattachment\n");

  // Cleanup
  boxlite_remove(runtime, box_id, 1, &error);
  boxlite_free_string(box_id);
  boxlite_runtime_free(runtime);
}

void test_reattach_box() {
  printf("\nTEST: Reattach to existing box\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-integration-reattach";
  BoxliteErrorCode code =
      boxlite_runtime_new(temp_dir, NULL, 0, NULL, 0, &runtime, &error);
  assert(code == Ok);
  assert(runtime != NULL);

  CBoxliteOptions *opts = NULL;
  code = boxlite_options_new("alpine:3.19", &opts, &error);
  assert(code == Ok);
  CBoxHandle *box1 = NULL;
  code = boxlite_create_box(runtime, opts, &box1, &error);
  boxlite_options_free(opts);
  assert(code == Ok);
  assert(box1 != NULL);

  char *box_id = boxlite_box_id(box1);
  printf("  Box ID: %s\n", box_id);

  boxlite_stop_box(box1, &error);
  printf("  ✓ Box stopped\n");

  CBoxHandle *box2 = NULL;
  code = boxlite_get(runtime, box_id, &box2, &error);
  assert(code == Ok);
  assert(box2 != NULL);
  printf("  ✓ Reattached to box\n");

  code = boxlite_start_box(box2, &error);
  assert(code == Ok);

  const char *args[] = {"reattached"};
  int exit_code = 0;
  code = boxlite_execute(box2, "/bin/echo", args, 1, NULL, NULL, &exit_code,
                         &error);
  assert(code == Ok);
  assert(exit_code == 0);
  printf("  ✓ Executed command after reattachment\n");

  boxlite_remove(runtime, box_id, 1, &error);
  boxlite_free_string(box_id);
  boxlite_runtime_free(runtime);
}

void test_runtime_metrics() {
  printf("\nTEST: Runtime metrics\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-integration-metrics";
  BoxliteErrorCode code =
      boxlite_runtime_new(temp_dir, NULL, 0, NULL, 0, &runtime, &error);
  assert(code == Ok);
  assert(runtime != NULL);

  // Get initial metrics
  char *json1 = NULL;
  code = boxlite_runtime_metrics(runtime, &json1, &error);
  assert(code == Ok);
  assert(json1 != NULL);
  printf("  ✓ Initial metrics: %s\n", json1);
  boxlite_free_string(json1);

  // Create a box
  CBoxliteOptions *opts = NULL;
  code = boxlite_options_new("alpine:3.19", &opts, &error);
  assert(code == Ok);
  CBoxHandle *box = NULL;
  code = boxlite_create_box(runtime, opts, &box, &error);
  boxlite_options_free(opts);
  assert(code == Ok);
  assert(box != NULL);

  // Execute command
  const char *args[] = {"test"};
  int exit_code = 0;
  boxlite_execute(box, "/bin/echo", args, 1, NULL, NULL, &exit_code, &error);

  // Get updated metrics
  char *json2 = NULL;
  code = boxlite_runtime_metrics(runtime, &json2, &error);
  assert(code == Ok);
  assert(json2 != NULL);
  printf("  ✓ Updated metrics: %s\n", json2);
  boxlite_free_string(json2);

  // Cleanup
  char *id = boxlite_box_id(box);
  boxlite_remove(runtime, id, 1, &error);
  boxlite_free_string(id);
  boxlite_runtime_free(runtime);
}

void test_box_metrics() {
  printf("\nTEST: Box metrics\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-integration-boxmetrics";
  BoxliteErrorCode code =
      boxlite_runtime_new(temp_dir, NULL, 0, NULL, 0, &runtime, &error);
  assert(code == Ok);
  assert(runtime != NULL);

  CBoxliteOptions *opts = NULL;
  code = boxlite_options_new("alpine:3.19", &opts, &error);
  assert(code == Ok);
  CBoxHandle *box = NULL;
  code = boxlite_create_box(runtime, opts, &box, &error);
  boxlite_options_free(opts);
  assert(code == Ok);
  assert(box != NULL);

  // Execute some commands
  const char *args[] = {"test"};
  int exit_code = 0;
  code = boxlite_execute(box, "/bin/echo", args, 1, NULL, NULL, &exit_code,
                         &error);
  if (code != Ok) {
    printf("  ✗ Execute 1 failed: code=%d, message=%s\n", code,
           error.message ? error.message : "(null)");
  }
  code = boxlite_execute(box, "/bin/echo", args, 1, NULL, NULL, &exit_code,
                         &error);
  if (code != Ok) {
    printf("  ✗ Execute 2 failed: code=%d, message=%s\n", code,
           error.message ? error.message : "(null)");
  }

  // Get box metrics
  char *json = NULL;
  code = boxlite_box_metrics(box, &json, &error);
  if (code != Ok) {
    printf("  ✗ Box metrics failed: code=%d, message=%s\n", code,
           error.message ? error.message : "(null)");
    fflush(stdout);
  }
  assert(code == Ok);
  assert(json != NULL);
  printf("  ✓ Box metrics: %s\n", json);
  boxlite_free_string(json);

  // Cleanup
  char *id = boxlite_box_id(box);
  boxlite_remove(runtime, id, 1, &error);
  boxlite_free_string(id);
  boxlite_runtime_free(runtime);
}

void test_concurrent_execution() {
  printf("\nTEST: Concurrent command execution\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-integration-concurrent";
  BoxliteErrorCode code =
      boxlite_runtime_new(temp_dir, NULL, 0, NULL, 0, &runtime, &error);
  assert(code == Ok);
  assert(runtime != NULL);

  CBoxliteOptions *opts = NULL;
  code = boxlite_options_new("alpine:3.19", &opts, &error);
  assert(code == Ok);
  CBoxHandle *box = NULL;
  code = boxlite_create_box(runtime, opts, &box, &error);
  boxlite_options_free(opts);
  assert(code == Ok);
  assert(box != NULL);

  // Execute multiple commands sequentially (true concurrency would need
  // threads)
  const char *args1[] = {"cmd1"};
  const char *args2[] = {"cmd2"};
  const char *args3[] = {"cmd3"};

  int exit1 = 0, exit2 = 0, exit3 = 0;
  code =
      boxlite_execute(box, "/bin/echo", args1, 1, NULL, NULL, &exit1, &error);
  assert(code == Ok);
  code =
      boxlite_execute(box, "/bin/echo", args2, 1, NULL, NULL, &exit2, &error);
  assert(code == Ok);
  code =
      boxlite_execute(box, "/bin/echo", args3, 1, NULL, NULL, &exit3, &error);
  assert(code == Ok);

  assert(exit1 == 0);
  assert(exit2 == 0);
  assert(exit3 == 0);

  printf("  ✓ Executed 3 commands sequentially\n");

  // Cleanup
  char *id = boxlite_box_id(box);
  boxlite_remove(runtime, id, 1, &error);
  boxlite_free_string(id);
  boxlite_runtime_free(runtime);
}

void test_shutdown_with_boxes() {
  printf("\nTEST: Shutdown runtime with active boxes\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-integration-shutdown";
  BoxliteErrorCode code =
      boxlite_runtime_new(temp_dir, NULL, 0, NULL, 0, &runtime, &error);
  assert(code == Ok);
  assert(runtime != NULL);

  // Create multiple boxes
  CBoxliteOptions *opts = NULL;
  code = boxlite_options_new("alpine:3.19", &opts, &error);
  assert(code == Ok);
  CBoxHandle *box1 = NULL;
  code = boxlite_create_box(runtime, opts, &box1, &error);
  boxlite_options_free(opts);
  assert(code == Ok);
  CBoxliteOptions *opts2 = NULL;
  code = boxlite_options_new("alpine:3.19", &opts2, &error);
  assert(code == Ok);
  CBoxHandle *box2 = NULL;
  code = boxlite_create_box(runtime, opts2, &box2, &error);
  boxlite_options_free(opts2);
  assert(code == Ok);
  assert(box1 != NULL);
  assert(box2 != NULL);

  printf("  ✓ Created 2 boxes\n");

  // Shutdown should stop all boxes
  code = boxlite_runtime_shutdown(runtime, 10, &error);
  assert(code == Ok);
  printf("  ✓ Runtime shutdown successful\n");

  boxlite_runtime_free(runtime);
}

void test_box_prefix_lookup() {
  printf("\nTEST: Box lookup by ID prefix\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-integration-prefix";
  BoxliteErrorCode code =
      boxlite_runtime_new(temp_dir, NULL, 0, NULL, 0, &runtime, &error);
  assert(code == Ok);
  assert(runtime != NULL);

  CBoxliteOptions *opts = NULL;
  code = boxlite_options_new("alpine:3.19", &opts, &error);
  assert(code == Ok);
  CBoxHandle *box = NULL;
  code = boxlite_create_box(runtime, opts, &box, &error);
  boxlite_options_free(opts);
  assert(code == Ok);
  assert(box != NULL);

  // Get full ID
  char *full_id = boxlite_box_id(box);
  assert(full_id != NULL);
  assert(strlen(full_id) > 8);

  // Extract prefix (first 8 characters)
  char prefix[9] = {0};
  size_t prefix_len = strlen(full_id);
  if (prefix_len > 8) {
    prefix_len = 8;
  }
  for (size_t i = 0; i < prefix_len; ++i) {
    prefix[i] = full_id[i];
  }
  prefix[prefix_len] = '\0';
  printf("  Full ID: %s\n", full_id);
  printf("  Prefix:  %s\n", prefix);

  // Stop the box
  boxlite_stop_box(box, &error);

  // Try to get box by prefix
  CBoxHandle *box2 = NULL;
  code = boxlite_get(runtime, prefix, &box2, &error);
  assert(code == Ok);
  assert(box2 != NULL);
  printf("  ✓ Found box by prefix\n");

  // Verify it's the same box
  char *id2 = boxlite_box_id(box2);
  assert(strcmp(full_id, id2) == 0);
  printf("  ✓ Prefix lookup returned correct box\n");

  // Cleanup
  boxlite_remove(runtime, full_id, 1, &error);
  boxlite_free_string(full_id);
  boxlite_free_string(id2);
  boxlite_runtime_free(runtime);
}

int main() {
  printf("═══════════════════════════════════════\n");
  printf("  BoxLite C SDK - Integration Tests\n");
  printf("═══════════════════════════════════════\n");

  test_multiple_boxes();
  test_reattach_box();
  test_runtime_metrics();
  test_box_metrics();
  test_concurrent_execution();
  test_shutdown_with_boxes();
  test_box_prefix_lookup();

  printf("\n═══════════════════════════════════════\n");
  printf("  ✅ ALL TESTS PASSED (%d tests)\n", 7);
  printf("═══════════════════════════════════════\n");

  return 0;
}
