/**
 * BoxLite C SDK - Error Handling Tests
 *
 * Tests error code handling and recovery
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include "boxlite.h"

void test_error_codes() {
    printf("\nTEST: Error code enumeration\n");

    // Verify error codes are defined correctly
    assert(Ok == 0);
    assert(Internal == 1);
    assert(NotFound == 2);
    assert(AlreadyExists == 3);
    assert(InvalidState == 4);
    assert(InvalidArgument == 5);

    printf("  ✓ Error codes defined correctly\n");
}

void test_error_struct_default() {
    printf("\nTEST: Error struct default state\n");

    CBoxliteError error = {0};
    assert(error.code == Ok);
    assert(error.message == NULL);

    printf("  ✓ Default error struct is OK with NULL message\n");
}

void test_invalid_json_error() {
    printf("\nTEST: Invalid JSON error\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* invalid_json = "{invalid}";

    BoxliteErrorCode code = boxlite_runtime_new(NULL, invalid_json, &runtime, &error);

    assert(code != Ok);
    assert(runtime == NULL);
    assert(error.message != NULL);
    assert(strlen(error.message) > 0);
    printf("  ✓ Invalid JSON error: %s\n", error.message);

    boxlite_error_free(&error);
}

void test_not_found_error() {
    printf("\nTEST: NotFound error\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-errors-notfound";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    // Try to get non-existent box
    CBoxHandle* box = NULL;
    code = boxlite_get(runtime, "nonexistent-box-id", &box, &error);

    assert(code != Ok);
    assert(box == NULL);
    assert(error.message != NULL);
    printf("  ✓ NotFound error: %s\n", error.message);

    boxlite_error_free(&error);
    boxlite_runtime_free(runtime);
}

void test_invalid_argument_simple_api() {
    printf("\nTEST: InvalidArgument error (simple API)\n");

    CBoxliteSimple* box = NULL;
    CBoxliteError error = {0};

    // Try to create box with NULL image
    BoxliteErrorCode code = boxlite_simple_new(NULL, 0, 0, &box, &error);

    assert(code == InvalidArgument);
    assert(error.code == InvalidArgument);
    assert(error.message != NULL);
    printf("  ✓ InvalidArgument error: %s\n", error.message);

    boxlite_error_free(&error);
}

void test_invalid_argument_null_output() {
    printf("\nTEST: InvalidArgument error (NULL output parameter)\n");

    CBoxliteError error = {0};

    // Try to create box with NULL output parameter
    BoxliteErrorCode code = boxlite_simple_new("alpine:3.19", 0, 0, NULL, &error);

    assert(code == InvalidArgument);
    assert(error.code == InvalidArgument);
    assert(error.message != NULL);
    printf("  ✓ NULL output error: %s\n", error.message);

    boxlite_error_free(&error);
}

void test_error_free_safety() {
    printf("\nTEST: Error free safety\n");

    // Free NULL error (should not crash)
    boxlite_error_free(NULL);
    printf("  ✓ boxlite_error_free(NULL) is safe\n");

    // Free error with NULL message (should not crash)
    CBoxliteError error = {0};
    error.code = Ok;
    error.message = NULL;
    boxlite_error_free(&error);
    printf("  ✓ Freeing error with NULL message is safe\n");

    // Free error with message
    CBoxliteSimple* box = NULL;
    CBoxliteError error2 = {0};
    boxlite_simple_new(NULL, 0, 0, &box, &error2);
    assert(error2.message != NULL);
    boxlite_error_free(&error2);
    assert(error2.message == NULL);  // Should be set to NULL
    assert(error2.code == Ok);        // Should be reset
    printf("  ✓ Error properly freed and reset\n");
}

void test_error_recovery() {
    printf("\nTEST: Error recovery\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-errors-recovery";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    // First attempt: try to get non-existent box (will fail)
    CBoxHandle* box = NULL;
    code = boxlite_get(runtime, "nonexistent", &box, &error);
    assert(code != Ok);
    assert(box == NULL);
    assert(error.message != NULL);
    boxlite_error_free(&error);
    error = (CBoxliteError){0};
    printf("  ✓ First attempt failed as expected\n");

    // Second attempt: create a real box (should succeed)
    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);
    printf("  ✓ Recovery successful - box created\n");

    // Cleanup
    char* id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
    boxlite_runtime_free(runtime);
}

void test_multiple_errors() {
    printf("\nTEST: Multiple error handling\n");

    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-errors-multiple";

    // Error 1: Invalid JSON
    CBoxliteRuntime* runtime1 = NULL;
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, "{bad", &runtime1, &error);
    assert(code != Ok);
    assert(runtime1 == NULL);
    assert(error.message != NULL);
    boxlite_error_free(&error);
    error = (CBoxliteError){0};

    // Error 2: NotFound
    CBoxliteRuntime* runtime2 = NULL;
    code = boxlite_runtime_new(temp_dir, NULL, &runtime2, &error);
    assert(code == Ok);
    assert(runtime2 != NULL);
    CBoxHandle* box = NULL;
    code = boxlite_get(runtime2, "missing", &box, &error);
    assert(code != Ok);
    assert(box == NULL);
    assert(error.message != NULL);
    boxlite_error_free(&error);
    error = (CBoxliteError){0};

    // Success: Normal operation
    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    box = NULL;
    code = boxlite_create_box(runtime2, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    printf("  ✓ Multiple errors handled correctly\n");

    // Cleanup
    char* id = boxlite_box_id(box);
    boxlite_remove(runtime2, id, 1, &error);
    boxlite_free_string(id);
    boxlite_runtime_free(runtime2);
}

int main() {
    printf("═══════════════════════════════════════\n");
    printf("  BoxLite C SDK - Error Tests\n");
    printf("═══════════════════════════════════════\n");

    test_error_codes();
    test_error_struct_default();
    test_invalid_json_error();
    test_not_found_error();
    test_invalid_argument_simple_api();
    test_invalid_argument_null_output();
    test_error_free_safety();
    test_error_recovery();
    test_multiple_errors();

    printf("\n═══════════════════════════════════════\n");
    printf("  ✅ ALL TESTS PASSED (%d tests)\n", 9);
    printf("═══════════════════════════════════════\n");

    return 0;
}
