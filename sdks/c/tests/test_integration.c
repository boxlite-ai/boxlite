/**
 * BoxLite C SDK - Integration Tests
 *
 * Tests complex scenarios: multi-box, reattachment, metrics
 */

#include "test_runtime.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void test_multiple_boxes() {
  printf("\nTEST: Create and manage multiple boxes\n");

  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-integration-multiple";
  reset_test_home(temp_dir);
  CBoxliteRuntime *runtime = new_test_runtime(temp_dir, &error);
  BoxliteErrorCode code = Ok;

  // Create 3 boxes
  CBoxHandle *box1 = create_test_box(runtime, &error);
  CBoxHandle *box2 = create_test_box(runtime, &error);
  CBoxHandle *box3 = create_test_box(runtime, &error);

  printf("  ✓ Created 3 boxes\n");

  // Execute command in each box
  const char *const args[] = {"test"};
  int exit_code = 0;

  code = boxlite_execute(box1, "/bin/echo", args, 1, NULL, NULL, &exit_code,
                         &error);
  assert(code == Ok);
  assert(exit_code == 0);

  code = boxlite_execute(box2, "/bin/echo", args, 1, NULL, NULL, &exit_code,
                         &error);
  assert(code == Ok);
  assert(exit_code == 0);

  code = boxlite_execute(box3, "/bin/echo", args, 1, NULL, NULL, &exit_code,
                         &error);
  assert(code == Ok);
  assert(exit_code == 0);

  printf("  ✓ Executed commands in all boxes\n");

  // List should show 3+ boxes
  CBoxInfoList *list = NULL;
  code = boxlite_list_info(runtime, &list, &error);
  assert(code == Ok);
  assert(list != NULL);
  assert(list->count >= 3);
  printf("  ✓ Listed %d boxes\n", list->count);
  boxlite_free_box_info_list(list);

  // Cleanup
  char *id1 = boxlite_box_id(box1);
  char *id2 = boxlite_box_id(box2);
  char *id3 = boxlite_box_id(box3);

  boxlite_remove(runtime, id1, 1, &error);
  boxlite_remove(runtime, id2, 1, &error);
  boxlite_remove(runtime, id3, 1, &error);

  boxlite_free_string(id1);
  boxlite_free_string(id2);
  boxlite_free_string(id3);
  boxlite_runtime_free(runtime);
}

void test_reattach_box() {
  printf("\nTEST: Reattach to existing box\n");

  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-integration-reattach";
  reset_test_home(temp_dir);
  CBoxliteRuntime *runtime = new_test_runtime(temp_dir, &error);
  BoxliteErrorCode code = Ok;

  // Create box and get ID
  CBoxHandle *box1 = create_test_box(runtime, &error);

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

  const char *const args[] = {"reattached"};
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

void test_runtime_metrics() {
  printf("\nTEST: Runtime metrics\n");

  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-integration-metrics";
  reset_test_home(temp_dir);
  CBoxliteRuntime *runtime = new_test_runtime(temp_dir, &error);
  BoxliteErrorCode code = Ok;

  // Get initial metrics
  CRuntimeMetrics metrics1 = {0};
  code = boxlite_runtime_metrics(runtime, &metrics1, &error);
  assert(code == Ok);
  printf("  ✓ Initial metrics: running=%d\n", metrics1.num_running_boxes);

  // Create a box
  CBoxHandle *box = create_test_box(runtime, &error);

  // Execute command
  const char *const args[] = {"test"};
  int exit_code = 0;
  boxlite_execute(box, "/bin/echo", args, 1, NULL, NULL, &exit_code, &error);

  // Get updated metrics
  CRuntimeMetrics metrics2 = {0};
  code = boxlite_runtime_metrics(runtime, &metrics2, &error);
  assert(code == Ok);
  printf("  ✓ Updated metrics: commands=%d\n",
         metrics2.total_commands_executed);

  // Cleanup
  char *id = boxlite_box_id(box);
  boxlite_remove(runtime, id, 1, &error);
  boxlite_free_string(id);
  boxlite_runtime_free(runtime);
}

void test_box_metrics() {
  printf("\nTEST: Box metrics\n");

  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-integration-boxmetrics";
  reset_test_home(temp_dir);
  CBoxliteRuntime *runtime = new_test_runtime(temp_dir, &error);
  BoxliteErrorCode code = Ok;

  CBoxHandle *box = create_test_box(runtime, &error);

  // Execute some commands
  const char *const args[] = {"test"};
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
  CBoxMetrics metrics = {0};
  code = boxlite_box_metrics(box, &metrics, &error);
  if (code != Ok) {
    printf("  ✗ Box metrics failed: code=%d, message=%s\n", code,
           error.message ? error.message : "(null)");
    fflush(stdout);
  }
  assert(code == Ok);
  printf("  ✓ Box metrics: commands=%d\n", metrics.commands_executed);

  // Cleanup
  char *id = boxlite_box_id(box);
  boxlite_remove(runtime, id, 1, &error);
  boxlite_free_string(id);
  boxlite_runtime_free(runtime);
}

void test_concurrent_execution() {
  printf("\nTEST: Concurrent command execution\n");

  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-integration-concurrent";
  reset_test_home(temp_dir);
  CBoxliteRuntime *runtime = new_test_runtime(temp_dir, &error);
  BoxliteErrorCode code = Ok;

  CBoxHandle *box = create_test_box(runtime, &error);

  // Execute multiple commands sequentially (true concurrency would need
  // threads)
  const char *const args1[] = {"cmd1"};
  const char *const args2[] = {"cmd2"};
  const char *const args3[] = {"cmd3"};

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

  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-integration-shutdown";
  reset_test_home(temp_dir);
  CBoxliteRuntime *runtime = new_test_runtime(temp_dir, &error);
  BoxliteErrorCode code = Ok;

  // Create multiple boxes
  CBoxHandle *box1 = create_test_box(runtime, &error);
  CBoxHandle *box2 = create_test_box(runtime, &error);
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

  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-integration-prefix";
  reset_test_home(temp_dir);
  CBoxliteRuntime *runtime = new_test_runtime(temp_dir, &error);
  BoxliteErrorCode code = Ok;

  CBoxHandle *box = create_test_box(runtime, &error);

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

void test_allow_net_typed_config() {
  printf("\nTEST: allow_net typed config\n");

  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-integration-allow-net";
  reset_test_home(temp_dir);
  CBoxliteRuntime *runtime = new_test_runtime(temp_dir, &error);
  BoxliteErrorCode code = Ok;

  CBoxliteOptions *opts = new_alpine_options(&error);
  boxlite_options_add_network_allow(opts, "example.com");
  CBoxHandle *box = create_box_with_options(runtime, opts, &error);

  const char *const args[] = {"-c",
                              "wget -q -O - http://example.com >/dev/null"};
  int exit_code = 0;
  code =
      boxlite_execute(box, "/bin/sh", args, 2, NULL, NULL, &exit_code, &error);
  assert(code == Ok);
  assert(exit_code == 0);
  printf(
      "  ✓ allow_net typed options accepted and outbound request succeeded\n");

  char *id = boxlite_box_id(box);
  boxlite_remove(runtime, id, 1, &error);
  boxlite_free_string(id);
  boxlite_runtime_free(runtime);
}

void test_null_options_rejected() {
  printf("\nTEST: NULL options are rejected\n");

  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-integration-null-options";
  reset_test_home(temp_dir);
  CBoxliteRuntime *runtime = new_test_runtime(temp_dir, &error);
  BoxliteErrorCode code = Ok;

  CBoxHandle *box = NULL;
  code = boxlite_create_box(runtime, NULL, &box, &error);
  assert(code == InvalidArgument);
  assert(box == NULL);
  assert(error.message != NULL);
  printf("  ✓ NULL options rejected: %s\n", error.message);

  boxlite_error_free(&error);
  boxlite_runtime_free(runtime);
}

void test_secrets_typed_config() {
  printf("\nTEST: secrets typed config\n");

  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-integration-secrets";
  reset_test_home(temp_dir);
  CBoxliteRuntime *runtime = new_test_runtime(temp_dir, &error);
  BoxliteErrorCode code = Ok;

  CBoxliteOptions *opts = new_alpine_options(&error);
  const char *const hosts[] = {"api.openai.com"};
  boxlite_options_add_secret(opts, "openai", "sk-test",
                             "<BOXLITE_SECRET:openai>", hosts, 1);
  CBoxHandle *box = create_box_with_options(runtime, opts, &error);

  const char *const args[] = {
      "-c", "test \"$BOXLITE_SECRET_OPENAI\" = \"<BOXLITE_SECRET:openai>\""};
  int exit_code = 0;
  code =
      boxlite_execute(box, "/bin/sh", args, 2, NULL, NULL, &exit_code, &error);
  assert(code == Ok);
  assert(exit_code == 0);
  printf("  ✓ secrets typed options accepted and placeholder env var is "
         "available\n");

  char *id = boxlite_box_id(box);
  boxlite_remove(runtime, id, 1, &error);
  boxlite_free_string(id);
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
  test_allow_net_typed_config();
  test_null_options_rejected();
  test_secrets_typed_config();

  printf("\n═══════════════════════════════════════\n");
  printf("  ✅ ALL TESTS PASSED (%d tests)\n", 10);
  printf("═══════════════════════════════════════\n");

  return 0;
}
