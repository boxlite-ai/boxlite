/**
 * BoxLite C SDK - Memory Tests
 *
 * Tests memory management and leak detection.
 * Run with valgrind: valgrind --leak-check=full ./test_memory
 */

#include "test_runtime.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *cleanup_temp_dirs[10] = {
    "/tmp/boxlite-test-memory-cleanup-0", "/tmp/boxlite-test-memory-cleanup-1",
    "/tmp/boxlite-test-memory-cleanup-2", "/tmp/boxlite-test-memory-cleanup-3",
    "/tmp/boxlite-test-memory-cleanup-4", "/tmp/boxlite-test-memory-cleanup-5",
    "/tmp/boxlite-test-memory-cleanup-6", "/tmp/boxlite-test-memory-cleanup-7",
    "/tmp/boxlite-test-memory-cleanup-8", "/tmp/boxlite-test-memory-cleanup-9",
};

static const char *error_temp_dirs[10] = {
    "/tmp/boxlite-test-memory-error-0", "/tmp/boxlite-test-memory-error-1",
    "/tmp/boxlite-test-memory-error-2", "/tmp/boxlite-test-memory-error-3",
    "/tmp/boxlite-test-memory-error-4", "/tmp/boxlite-test-memory-error-5",
    "/tmp/boxlite-test-memory-error-6", "/tmp/boxlite-test-memory-error-7",
    "/tmp/boxlite-test-memory-error-8", "/tmp/boxlite-test-memory-error-9",
};

void test_runtime_cleanup() {
  printf("\nTEST: Runtime memory cleanup\n");

  for (int i = 0; i < 10; i++) {
    CBoxliteRuntime *runtime = NULL;
    CBoxliteError error = {0};
    const char *temp_dir = cleanup_temp_dirs[i];
    BoxliteErrorCode code =
        boxlite_runtime_new(temp_dir, NULL, 0, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);
    boxlite_runtime_free(runtime);
  }

  printf("  ✓ Created and freed 10 runtimes (no leaks)\n");
}

void test_error_string_cleanup() {
  printf("\nTEST: Error string memory cleanup\n");

  for (int i = 0; i < 10; i++) {
    CBoxliteRuntime *runtime = NULL;
    CBoxliteError error = {0};
    const char *temp_dir = error_temp_dirs[i];
    (void)temp_dir;
    CBoxliteOptions *opts = NULL;
    BoxliteErrorCode code = boxlite_options_new(NULL, &opts, &error);
    assert(code != Ok);
    assert(runtime == NULL);
    assert(opts == NULL);
    assert(error.message != NULL);
    boxlite_error_free(&error);
  }

  printf("  ✓ Created and freed 10 error strings (no leaks)\n");
}

void test_box_id_cleanup() {
  printf("\nTEST: Box ID string cleanup\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-memory-boxid";
  BoxliteErrorCode code =
      boxlite_runtime_new(temp_dir, NULL, 0, &runtime, &error);
  assert(code == Ok);
  assert(runtime != NULL);

  for (int i = 0; i < 5; i++) {
    CBoxHandle *box = create_test_box(runtime, &error);

    char *id = boxlite_box_id(box);
    assert(id != NULL);
    boxlite_free_string(id);

    id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
  }

  boxlite_runtime_free(runtime);
  printf("  ✓ Created and freed 5 box IDs (no leaks)\n");
}

void test_box_info_cleanup() {
  printf("\nTEST: Box info cleanup\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-memory-info";
  BoxliteErrorCode code =
      boxlite_runtime_new(temp_dir, NULL, 0, &runtime, &error);
  assert(code == Ok);
  assert(runtime != NULL);

  CBoxHandle *box = create_test_box(runtime, &error);

  // Get info multiple times and free
  for (int i = 0; i < 5; i++) {
    CBoxInfo *info = NULL;
    code = boxlite_box_info(box, &info, &error);
    assert(code == Ok);
    assert(info != NULL);
    boxlite_free_box_info(info);
  }

  printf("  ✓ Created and freed 5 box info structs (no leaks)\n");

  // Cleanup
  char *id = boxlite_box_id(box);
  boxlite_remove(runtime, id, 1, &error);
  boxlite_free_string(id);
  boxlite_runtime_free(runtime);
}

void test_simple_api_cleanup() {
  printf("\nTEST: Simple API memory cleanup\n");

  for (int i = 0; i < 5; i++) {
    CBoxliteSimple *box;
    CBoxliteError error = {0};

    BoxliteErrorCode code =
        boxlite_simple_new("alpine:3.19", 0, 0, &box, &error);
    assert(code == Ok);

    const char *args[] = {"hello", NULL};
    CBoxliteExecResult *result;
    code = boxlite_simple_run(box, "/bin/echo", args, 1, &result, &error);
    assert(code == Ok);

    boxlite_result_free(result);
    boxlite_simple_free(box);
  }

  printf("  ✓ Created and freed 5 simple boxes (no leaks)\n");
}

void test_error_struct_cleanup() {
  printf("\nTEST: Error struct cleanup\n");

  for (int i = 0; i < 10; i++) {
    CBoxliteSimple *box = NULL;
    CBoxliteError error = {0};

    // Trigger error
    BoxliteErrorCode code = boxlite_simple_new(NULL, 0, 0, &box, &error);
    assert(code == InvalidArgument);
    assert(error.message != NULL);

    boxlite_error_free(&error);
    assert(error.message == NULL);
    assert(error.code == Ok);
  }

  printf("  ✓ Created and freed 10 error structs (no leaks)\n");
}

void test_exec_result_cleanup() {
  printf("\nTEST: Execution result cleanup\n");

  CBoxliteSimple *box = NULL;
  CBoxliteError error = {0};

  BoxliteErrorCode code = boxlite_simple_new("alpine:3.19", 0, 0, &box, &error);
  assert(code == Ok);

  for (int i = 0; i < 5; i++) {
    const char *args[] = {"test", NULL};
    CBoxliteExecResult *result = NULL;
    code = boxlite_simple_run(box, "/bin/echo", args, 1, &result, &error);
    assert(code == Ok);
    assert(result->stdout_text != NULL);
    boxlite_result_free(result);
  }

  boxlite_simple_free(box);
  printf("  ✓ Created and freed 5 exec results (no leaks)\n");
}

void test_null_free_safety() {
  printf("\nTEST: NULL pointer free safety\n");

  // These should not crash
  for (int i = 0; i < 100; i++) {
    boxlite_runtime_free(NULL);
    boxlite_free_string(NULL);
    boxlite_simple_free(NULL);
    boxlite_result_free(NULL);
    boxlite_error_free(NULL);
  }

  printf("  ✓ NULL pointer frees are safe (100 iterations)\n");
}

void test_mixed_operations() {
  printf("\nTEST: Mixed operations memory safety\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-memory-mixed";
  BoxliteErrorCode code =
      boxlite_runtime_new(temp_dir, NULL, 0, &runtime, &error);
  assert(code == Ok);
  assert(runtime != NULL);

  for (int i = 0; i < 3; i++) {
    // Create box
    CBoxHandle *box = create_test_box(runtime, &error);

    // Get info
    CBoxInfo *info = NULL;
    boxlite_box_info(box, &info, &error);
    boxlite_free_box_info(info);

    // Execute command
    const char *const args[] = {"test"};
    int exit_code = 0;
    boxlite_execute(box, "/bin/echo", args, 1, NULL, NULL, &exit_code, &error);

    // Get ID and remove
    char *id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
  }

  boxlite_runtime_free(runtime);
  printf("  ✓ Mixed operations completed (no leaks)\n");
}

int main() {
  printf("═══════════════════════════════════════\n");
  printf("  BoxLite C SDK - Memory Tests\n");
  printf("═══════════════════════════════════════\n");
  printf("\nRun with valgrind for leak detection:\n");
  printf("  valgrind --leak-check=full ./test_memory\n");
  printf("\n");

  test_runtime_cleanup();
  test_error_string_cleanup();
  test_box_id_cleanup();
  test_box_info_cleanup();
  test_simple_api_cleanup();
  test_error_struct_cleanup();
  test_exec_result_cleanup();
  test_null_free_safety();
  test_mixed_operations();

  printf("\n═══════════════════════════════════════\n");
  printf("  ✅ ALL TESTS PASSED (%d tests)\n", 9);
  printf("═══════════════════════════════════════\n");
  printf("\n⚠️  To verify no memory leaks, run:\n");
  printf("  valgrind --leak-check=full --show-leak-kinds=all ./test_memory\n");

  return 0;
}
