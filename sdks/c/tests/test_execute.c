/**
 * BoxLite C SDK - Execute Tests
 *
 * Tests command execution and exit codes
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include "boxlite.h"

static int output_callback_called = 0;

void simple_callback(const char* text, int is_stderr, void* user_data) {
    output_callback_called++;
    // Just count calls, don't print to keep test output clean
}

void test_execute_success() {
    printf("\nTEST: Execute command (success)\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-execute-success";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    // Execute: echo hello
    const char* args = "[\"hello\"]";
    output_callback_called = 0;

    int exit_code = 0;
    code = boxlite_execute(box, "/bin/echo", args, simple_callback, NULL, &exit_code, &error);

    printf("  DEBUG: code=%d, Ok=%d, code==Ok? %d\n", code, Ok, code == Ok);
    if (code != Ok) {
        printf("  ✗ Error executing command: code=%d, message=%s\n", error.code, error.message ? error.message : "(null)");
        boxlite_error_free(&error);
    }
    assert(code == Ok);
    assert(exit_code == 0);
    assert(output_callback_called > 0);
    printf("  ✓ Command executed successfully (exit code: %d)\n", exit_code);
    printf("  ✓ Callback invoked %d times\n", output_callback_called);

    // Cleanup
    char* id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
    boxlite_runtime_free(runtime);
}

void test_execute_failure() {
    printf("\nTEST: Execute command (failure)\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-execute-failure";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    // Execute: ls /nonexistent (should fail)
    const char* args = "[\"/nonexistent\"]";
    int exit_code = 0;
    code = boxlite_execute(box, "/bin/ls", args, NULL, NULL, &exit_code, &error);

    assert(code == Ok);  // API call succeeds
    assert(exit_code != 0);  // But command fails
    printf("  ✓ Command failed as expected (exit code: %d)\n", exit_code);

    // Cleanup
    char* id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
    boxlite_runtime_free(runtime);
}

void test_execute_no_callback() {
    printf("\nTEST: Execute without callback\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-execute-nocallback";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    // Execute without callback
    const char* args = "[]";
    int exit_code = 0;
    code = boxlite_execute(box, "/bin/pwd", args, NULL, NULL, &exit_code, &error);

    assert(code == Ok);
    assert(exit_code == 0);
    printf("  ✓ Command executed without callback (exit code: %d)\n", exit_code);

    // Cleanup
    char* id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
    boxlite_runtime_free(runtime);
}

void test_execute_multiple_commands() {
    printf("\nTEST: Execute multiple commands\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-execute-multiple";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    // Execute multiple commands in sequence
    int exit_code = 0;

    code = boxlite_execute(box, "/bin/echo", "[\"test1\"]", NULL, NULL, &exit_code, &error);
    assert(code == Ok);
    assert(exit_code == 0);

    code = boxlite_execute(box, "/bin/echo", "[\"test2\"]", NULL, NULL, &exit_code, &error);
    assert(code == Ok);
    assert(exit_code == 0);

    code = boxlite_execute(box, "/bin/echo", "[\"test3\"]", NULL, NULL, &exit_code, &error);
    assert(code == Ok);
    assert(exit_code == 0);

    printf("  ✓ Executed 3 commands successfully\n");

    // Cleanup
    char* id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
    boxlite_runtime_free(runtime);
}

void test_execute_complex_args() {
    printf("\nTEST: Execute with complex arguments\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-execute-complexargs";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    // Execute with multiple arguments
    const char* args = "[\"-alh\", \"/\"]";
    int exit_code = 0;
    code = boxlite_execute(box, "/bin/ls", args, NULL, NULL, &exit_code, &error);

    assert(code == Ok);
    assert(exit_code == 0);
    printf("  ✓ Command with multiple args executed (exit code: %d)\n", exit_code);

    // Cleanup
    char* id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
    boxlite_runtime_free(runtime);
}

static int counter = 0;

void user_data_callback(const char* text, int is_stderr, void* user_data) {
    int* count = (int*)user_data;
    (*count)++;
}

void test_execute_with_user_data() {
    printf("\nTEST: Execute with user data\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-execute-userdata";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    counter = 0;
    int exit_code = 0;
    code = boxlite_execute(box, "/bin/echo", "[\"hello\"]",
                           user_data_callback, &counter, &exit_code, &error);

    assert(code == Ok);
    assert(exit_code == 0);
    assert(counter > 0);
    printf("  ✓ User data passed correctly (counter: %d)\n", counter);

    // Cleanup
    char* id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
    boxlite_runtime_free(runtime);
}

int main() {
    printf("═══════════════════════════════════════\n");
    printf("  BoxLite C SDK - Execute Tests\n");
    printf("═══════════════════════════════════════\n");

    test_execute_success();
    test_execute_failure();
    test_execute_no_callback();
    test_execute_multiple_commands();
    test_execute_complex_args();
    test_execute_with_user_data();

    printf("\n═══════════════════════════════════════\n");
    printf("  ✅ ALL TESTS PASSED (%d tests)\n", 6);
    printf("═══════════════════════════════════════\n");

    return 0;
}
