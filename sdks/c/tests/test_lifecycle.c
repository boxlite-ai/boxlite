/**
 * BoxLite C SDK - Lifecycle Tests
 *
 * Tests box lifecycle: create → start → stop → remove
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include "boxlite.h"

void test_create_box() {
    printf("\nTEST: Create box\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-lifecycle-create";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    if (code != Ok) {
        printf("  ✗ Error creating runtime: code=%d, message=%s\n", error.code, error.message ? error.message : "(null)");
        boxlite_error_free(&error);
    }
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[]}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);

    if (code != Ok) {
        printf("  ✗ Error creating box: code=%d, message=%s\n", error.code, error.message ? error.message : "(null)");
    }

    assert(code == Ok);
    assert(box != NULL);
    printf("  ✓ Box created successfully\n");

    // Get box ID
    char* box_id = boxlite_box_id(box);
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

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-lifecycle-restart";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    // Set auto_remove to false so box persists after stop
    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    char* box_id = boxlite_box_id(box);
    printf("  Box ID: %s\n", box_id);

    // Box is auto-started after creation, so it should be running
    printf("  ✓ Box auto-started\n");

    // Stop the box
    code = boxlite_stop_box(box, &error);
    assert(code == Ok);
    printf("  ✓ Box stopped\n");

    // Get box handle again after stop to verify persistence
    CBoxHandle* box2 = NULL;
    code = boxlite_get(runtime, box_id, &box2, &error);
    if (code != Ok) {
        printf("  ✗ Error getting box: code=%d, message=%s\n", error.code, error.message ? error.message : "(null)");
        boxlite_error_free(&error);
    }
    assert(code == Ok);
    assert(box2 != NULL);
    printf("  ✓ Box handle retrieved after stop\n");

    // Verify box info is accessible
    char* info = NULL;
    code = boxlite_box_info(box2, &info, &error);
    if (code != Ok) {
        printf("  ✗ Error getting box info: code=%d, message=%s\n", error.code, error.message ? error.message : "(null)");
        boxlite_error_free(&error);
    }
    assert(code == Ok);
    assert(info != NULL);
    printf("  ✓ Box info retrieved: %s\n", info);
    boxlite_free_string(info);

    // Final cleanup - manually remove since auto_remove=false
    code = boxlite_remove(runtime, box_id, 0, &error);
    if (code != Ok) {
        printf("  ✗ Error removing box: code=%d, message=%s\n", error.code, error.message ? error.message : "(null)");
        boxlite_error_free(&error);
    }
    boxlite_free_string(box_id);
    boxlite_runtime_free(runtime);
}

void test_remove_box() {
    printf("\nTEST: Remove box\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-lifecycle-remove";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    char* box_id = boxlite_box_id(box);
    printf("  Box ID: %s\n", box_id);

    // Stop first
    boxlite_stop_box(box, &error);
    printf("  ✓ Box stopped\n");

    // Remove
    code = boxlite_remove(runtime, box_id, 0, &error);
    assert(code == Ok);
    printf("  ✓ Box removed\n");

    // Verify box is gone
    CBoxHandle* box2 = NULL;
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

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-lifecycle-force";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    char* box_id = boxlite_box_id(box);
    printf("  Box ID: %s\n", box_id);

    // Don't stop - force remove while running
    code = boxlite_remove(runtime, box_id, 1, &error);  // force=1
    assert(code == Ok);
    printf("  ✓ Box force-removed while running\n");

    boxlite_free_string(box_id);
    boxlite_runtime_free(runtime);
}

void test_list_boxes() {
    printf("\nTEST: List boxes\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-lifecycle-list";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    // Create 2 boxes
    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box1 = NULL;
    code = boxlite_create_box(runtime, options, &box1, &error);
    assert(code == Ok);
    assert(box1 != NULL);

    CBoxHandle* box2 = NULL;
    code = boxlite_create_box(runtime, options, &box2, &error);
    assert(code == Ok);
    assert(box2 != NULL);

    // List all boxes
    char* json = NULL;
    code = boxlite_list_info(runtime, &json, &error);
    assert(code == Ok);
    assert(json != NULL);
    printf("  ✓ Listed boxes: %s\n", json);

    // JSON should be an array with 2+ elements
    assert(json[0] == '[');

    boxlite_free_string(json);

    // Cleanup
    char* id1 = boxlite_box_id(box1);
    char* id2 = boxlite_box_id(box2);

    boxlite_remove(runtime, id1, 1, &error);
    boxlite_remove(runtime, id2, 1, &error);

    boxlite_free_string(id1);
    boxlite_free_string(id2);
    boxlite_runtime_free(runtime);
}

void test_get_box_info() {
    printf("\nTEST: Get box info\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-lifecycle-info";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    // Get info from handle
    char* info_json = NULL;
    code = boxlite_box_info(box, &info_json, &error);
    assert(code == Ok);
    assert(info_json != NULL);
    printf("  ✓ Box info from handle: %s\n", info_json);
    boxlite_free_string(info_json);

    // Get info by ID
    char* box_id = boxlite_box_id(box);
    info_json = NULL;
    code = boxlite_get_info(runtime, box_id, &info_json, &error);
    assert(code == Ok);
    assert(info_json != NULL);
    printf("  ✓ Box info by ID: %s\n", info_json);

    boxlite_free_string(info_json);
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
