/**
 * BoxLite C SDK - Memory Tests
 *
 * Tests memory management and leak detection.
 * Run with valgrind: valgrind --leak-check=full ./test_memory
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include "boxlite.h"

void test_runtime_cleanup() {
    printf("\nTEST: Runtime memory cleanup\n");

    for (int i = 0; i < 10; i++) {
        CBoxliteRuntime* runtime = NULL;
        CBoxliteError error = {0};
        char temp_dir[256];
        snprintf(temp_dir, sizeof(temp_dir), "/tmp/boxlite-test-memory-cleanup-%d", i);
        BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
        assert(code == Ok);
        assert(runtime != NULL);
        boxlite_runtime_free(runtime);
    }

    printf("  ✓ Created and freed 10 runtimes (no leaks)\n");
}

void test_error_string_cleanup() {
    printf("\nTEST: Error string memory cleanup\n");

    for (int i = 0; i < 10; i++) {
        CBoxliteRuntime* runtime = NULL;
        CBoxliteError error = {0};
        char temp_dir[256];
        snprintf(temp_dir, sizeof(temp_dir), "/tmp/boxlite-test-memory-error-%d", i);
        const char* bad_json = "{invalid}";
        BoxliteErrorCode code = boxlite_runtime_new(temp_dir, bad_json, &runtime, &error);
        assert(code != Ok);
        assert(runtime == NULL);
        assert(error.message != NULL);
        boxlite_error_free(&error);
    }

    printf("  ✓ Created and freed 10 error strings (no leaks)\n");
}

void test_box_id_cleanup() {
    printf("\nTEST: Box ID string cleanup\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-memory-boxid";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";

    for (int i = 0; i < 5; i++) {
        CBoxHandle* box = NULL;
        code = boxlite_create_box(runtime, options, &box, &error);
        assert(code == Ok);
        assert(box != NULL);

        char* id = boxlite_box_id(box);
        assert(id != NULL);
        boxlite_free_string(id);

        id = boxlite_box_id(box);
        boxlite_remove(runtime, id, 1, &error);
        boxlite_free_string(id);
    }

    boxlite_runtime_free(runtime);
    printf("  ✓ Created and freed 5 box IDs (no leaks)\n");
}

void test_json_output_cleanup() {
    printf("\nTEST: JSON output cleanup\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-memory-json";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    // Get info multiple times and free
    for (int i = 0; i < 5; i++) {
        char* json = NULL;
        code = boxlite_box_info(box, &json, &error);
        assert(code == Ok);
        assert(json != NULL);
        boxlite_free_string(json);
    }

    printf("  ✓ Created and freed 5 JSON outputs (no leaks)\n");

    // Cleanup
    char* id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
    boxlite_runtime_free(runtime);
}

void test_simple_api_cleanup() {
    printf("\nTEST: Simple API memory cleanup\n");

    for (int i = 0; i < 5; i++) {
        CBoxliteSimple* box;
        CBoxliteError error = {0};

        BoxliteErrorCode code = boxlite_simple_new("alpine:3.19", 0, 0, &box, &error);
        assert(code == Ok);

        const char* args[] = {"hello", NULL};
        CBoxliteExecResult* result;
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
        CBoxliteSimple* box = NULL;
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

    CBoxliteSimple* box = NULL;
    CBoxliteError error = {0};

    BoxliteErrorCode code = boxlite_simple_new("alpine:3.19", 0, 0, &box, &error);
    assert(code == Ok);

    for (int i = 0; i < 5; i++) {
        const char* args[] = {"test", NULL};
        CBoxliteExecResult* result = NULL;
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

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-memory-mixed";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";

    for (int i = 0; i < 3; i++) {
        // Create box
        CBoxHandle* box = NULL;
        code = boxlite_create_box(runtime, options, &box, &error);
        assert(code == Ok);
        assert(box != NULL);

        // Get info
        char* json = NULL;
        boxlite_box_info(box, &json, &error);
        boxlite_free_string(json);

        // Execute command
        const char* args = "[\"test\"]";
        int exit_code = 0;
        boxlite_execute(box, "/bin/echo", args, NULL, NULL, &exit_code, &error);

        // Get ID and remove
        char* id = boxlite_box_id(box);
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
    test_json_output_cleanup();
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
