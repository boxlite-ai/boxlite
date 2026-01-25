/**
 * BoxLite C SDK - Integration Tests
 *
 * Tests complex scenarios: multi-box, reattachment, metrics
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include "boxlite.h"

void test_multiple_boxes() {
    printf("\nTEST: Create and manage multiple boxes\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-integration-multiple";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";

    // Create 3 boxes
    CBoxHandle* box1 = NULL;
    code = boxlite_create_box(runtime, options, &box1, &error);
    assert(code == Ok);
    assert(box1 != NULL);

    CBoxHandle* box2 = NULL;
    code = boxlite_create_box(runtime, options, &box2, &error);
    assert(code == Ok);
    assert(box2 != NULL);

    CBoxHandle* box3 = NULL;
    code = boxlite_create_box(runtime, options, &box3, &error);
    assert(code == Ok);
    assert(box3 != NULL);

    printf("  ✓ Created 3 boxes\n");

    // Execute command in each box
    const char* args = "[\"test\"]";
    int exit_code = 0;

    code = boxlite_execute(box1, "/bin/echo", args, NULL, NULL, &exit_code, &error);
    assert(code == Ok);
    assert(exit_code == 0);

    code = boxlite_execute(box2, "/bin/echo", args, NULL, NULL, &exit_code, &error);
    assert(code == Ok);
    assert(exit_code == 0);

    code = boxlite_execute(box3, "/bin/echo", args, NULL, NULL, &exit_code, &error);
    assert(code == Ok);
    assert(exit_code == 0);

    printf("  ✓ Executed commands in all boxes\n");

    // List should show 3+ boxes
    char* json = NULL;
    code = boxlite_list_info(runtime, &json, &error);
    assert(code == Ok);
    assert(json != NULL);
    printf("  ✓ Listed boxes: %s\n", json);
    boxlite_free_string(json);

    // Cleanup
    char* id1 = boxlite_box_id(box1);
    char* id2 = boxlite_box_id(box2);
    char* id3 = boxlite_box_id(box3);

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

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-integration-reattach";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    // Create box and get ID
    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box1 = NULL;
    code = boxlite_create_box(runtime, options, &box1, &error);
    assert(code == Ok);
    assert(box1 != NULL);

    char* box_id = boxlite_box_id(box1);
    printf("  Box ID: %s\n", box_id);

    // Stop the box
    boxlite_stop_box(box1, &error);
    printf("  ✓ Box stopped\n");

    // Reattach to the same box
    CBoxHandle* box2 = NULL;
    code = boxlite_get(runtime, box_id, &box2, &error);
    assert(code == Ok);
    assert(box2 != NULL);
    printf("  ✓ Reattached to box\n");

    // Restart and execute
    code = boxlite_start_box(box2, &error);
    assert(code == Ok);

    const char* args = "[\"reattached\"]";
    int exit_code = 0;
    code = boxlite_execute(box2, "/bin/echo", args, NULL, NULL, &exit_code, &error);
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

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-integration-metrics";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    // Get initial metrics
    char* json1 = NULL;
    code = boxlite_runtime_metrics(runtime, &json1, &error);
    assert(code == Ok);
    assert(json1 != NULL);
    printf("  ✓ Initial metrics: %s\n", json1);
    boxlite_free_string(json1);

    // Create a box
    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    // Execute command
    const char* args = "[\"test\"]";
    int exit_code = 0;
    boxlite_execute(box, "/bin/echo", args, NULL, NULL, &exit_code, &error);

    // Get updated metrics
    char* json2 = NULL;
    code = boxlite_runtime_metrics(runtime, &json2, &error);
    assert(code == Ok);
    assert(json2 != NULL);
    printf("  ✓ Updated metrics: %s\n", json2);
    boxlite_free_string(json2);

    // Cleanup
    char* id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
    boxlite_runtime_free(runtime);
}

void test_box_metrics() {
    printf("\nTEST: Box metrics\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-integration-boxmetrics";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    // Execute some commands
    const char* args = "[\"test\"]";
    int exit_code = 0;
    boxlite_execute(box, "/bin/echo", args, NULL, NULL, &exit_code, &error);
    boxlite_execute(box, "/bin/echo", args, NULL, NULL, &exit_code, &error);

    // Get box metrics
    char* json = NULL;
    code = boxlite_box_metrics(box, &json, &error);
    assert(code == Ok);
    assert(json != NULL);
    printf("  ✓ Box metrics: %s\n", json);
    boxlite_free_string(json);

    // Cleanup
    char* id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
    boxlite_runtime_free(runtime);
}

void test_concurrent_execution() {
    printf("\nTEST: Concurrent command execution\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-integration-concurrent";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    // Execute multiple commands sequentially (true concurrency would need threads)
    const char* args1 = "[\"cmd1\"]";
    const char* args2 = "[\"cmd2\"]";
    const char* args3 = "[\"cmd3\"]";

    int exit1 = 0, exit2 = 0, exit3 = 0;
    code = boxlite_execute(box, "/bin/echo", args1, NULL, NULL, &exit1, &error);
    assert(code == Ok);
    code = boxlite_execute(box, "/bin/echo", args2, NULL, NULL, &exit2, &error);
    assert(code == Ok);
    code = boxlite_execute(box, "/bin/echo", args3, NULL, NULL, &exit3, &error);
    assert(code == Ok);

    assert(exit1 == 0);
    assert(exit2 == 0);
    assert(exit3 == 0);

    printf("  ✓ Executed 3 commands sequentially\n");

    // Cleanup
    char* id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
    boxlite_runtime_free(runtime);
}

void test_shutdown_with_boxes() {
    printf("\nTEST: Shutdown runtime with active boxes\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-integration-shutdown";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    // Create multiple boxes
    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box1 = NULL;
    code = boxlite_create_box(runtime, options, &box1, &error);
    assert(code == Ok);
    CBoxHandle* box2 = NULL;
    code = boxlite_create_box(runtime, options, &box2, &error);
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

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-integration-prefix";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    // Get full ID
    char* full_id = boxlite_box_id(box);
    assert(full_id != NULL);
    assert(strlen(full_id) > 8);

    // Extract prefix (first 8 characters)
    char prefix[9] = {0};
    strncpy(prefix, full_id, 8);
    printf("  Full ID: %s\n", full_id);
    printf("  Prefix:  %s\n", prefix);

    // Stop the box
    boxlite_stop_box(box, &error);

    // Try to get box by prefix
    CBoxHandle* box2 = NULL;
    code = boxlite_get(runtime, prefix, &box2, &error);
    assert(code == Ok);
    assert(box2 != NULL);
    printf("  ✓ Found box by prefix\n");

    // Verify it's the same box
    char* id2 = boxlite_box_id(box2);
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
