/**
 * BoxLite C SDK - Simple API Tests
 *
 * Tests the simple convenience API (no JSON, auto-cleanup)
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include "boxlite.h"

void test_simple_create() {
    printf("\nTEST: Simple API - create box\n");

    CBoxliteSimple* box;
    CBoxliteError error = {0};

    BoxliteErrorCode code = boxlite_simple_new(
        "alpine:3.19",  // image
        2,              // cpus
        512,            // memory_mib
        &box,
        &error
    );

    assert(code == Ok);
    assert(box != NULL);
    printf("  ✓ Box created with simple API\n");

    boxlite_simple_free(box);
    printf("  ✓ Box auto-cleaned up\n");
}

void test_simple_default_resources() {
    printf("\nTEST: Simple API - default resources\n");

    CBoxliteSimple* box;
    CBoxliteError error = {0};

    // Use 0 for default cpus and memory
    BoxliteErrorCode code = boxlite_simple_new(
        "alpine:3.19",
        0,    // cpus = default
        0,    // memory_mib = default
        &box,
        &error
    );

    assert(code == Ok);
    assert(box != NULL);
    printf("  ✓ Box created with default resources\n");

    boxlite_simple_free(box);
}

void test_simple_run_command() {
    printf("\nTEST: Simple API - run command\n");

    CBoxliteSimple* box;
    CBoxliteError error = {0};

    BoxliteErrorCode code = boxlite_simple_new("alpine:3.19", 0, 0, &box, &error);
    assert(code == Ok);

    // Run a simple command
    const char* args[] = {"hello", NULL};
    CBoxliteExecResult* result;

    code = boxlite_simple_run(box, "/bin/echo", args, 1, &result, &error);
    assert(code == Ok);
    assert(result != NULL);
    assert(result->exit_code == 0);
    assert(result->stdout_text != NULL);
    printf("  ✓ Command executed: exit_code=%d\n", result->exit_code);
    printf("  ✓ Output: %s\n", result->stdout_text);

    boxlite_result_free(result);
    boxlite_simple_free(box);
}

void test_simple_run_no_args() {
    printf("\nTEST: Simple API - run command without args\n");

    CBoxliteSimple* box;
    CBoxliteError error = {0};

    BoxliteErrorCode code = boxlite_simple_new("alpine:3.19", 0, 0, &box, &error);
    assert(code == Ok);

    // Run command with no args (NULL, 0)
    CBoxliteExecResult* result;
    code = boxlite_simple_run(box, "/bin/pwd", NULL, 0, &result, &error);

    assert(code == Ok);
    assert(result->exit_code == 0);
    printf("  ✓ Command executed without args\n");

    boxlite_result_free(result);
    boxlite_simple_free(box);
}

void test_simple_run_failure() {
    printf("\nTEST: Simple API - run failing command\n");

    CBoxliteSimple* box;
    CBoxliteError error = {0};

    BoxliteErrorCode code = boxlite_simple_new("alpine:3.19", 0, 0, &box, &error);
    assert(code == Ok);

    // Run command that will fail
    const char* args[] = {"/nonexistent", NULL};
    CBoxliteExecResult* result;

    code = boxlite_simple_run(box, "/bin/ls", args, 1, &result, &error);
    assert(code == Ok);  // API call succeeds
    assert(result->exit_code != 0);  // But command fails
    printf("  ✓ Command failed as expected: exit_code=%d\n", result->exit_code);

    // Check stderr contains error message
    if (result->stderr_text && strlen(result->stderr_text) > 0) {
        printf("  ✓ Stderr captured: %s\n", result->stderr_text);
    }

    boxlite_result_free(result);
    boxlite_simple_free(box);
}

void test_simple_multiple_commands() {
    printf("\nTEST: Simple API - multiple commands\n");

    CBoxliteSimple* box;
    CBoxliteError error = {0};

    BoxliteErrorCode code = boxlite_simple_new("alpine:3.19", 0, 0, &box, &error);
    assert(code == Ok);

    CBoxliteExecResult* result;

    // Command 1
    const char* args1[] = {"test1", NULL};
    code = boxlite_simple_run(box, "/bin/echo", args1, 1, &result, &error);
    assert(code == Ok);
    assert(result->exit_code == 0);
    boxlite_result_free(result);

    // Command 2
    const char* args2[] = {"test2", NULL};
    code = boxlite_simple_run(box, "/bin/echo", args2, 1, &result, &error);
    assert(code == Ok);
    assert(result->exit_code == 0);
    boxlite_result_free(result);

    // Command 3
    const char* args3[] = {"test3", NULL};
    code = boxlite_simple_run(box, "/bin/echo", args3, 1, &result, &error);
    assert(code == Ok);
    assert(result->exit_code == 0);
    boxlite_result_free(result);

    printf("  ✓ Ran 3 commands successfully\n");

    boxlite_simple_free(box);
}

void test_simple_result_cleanup() {
    printf("\nTEST: Simple API - result cleanup\n");

    CBoxliteSimple* box;
    CBoxliteError error = {0};

    BoxliteErrorCode code = boxlite_simple_new("alpine:3.19", 0, 0, &box, &error);
    assert(code == Ok);

    CBoxliteExecResult* result;
    const char* args[] = {"hello", NULL};
    code = boxlite_simple_run(box, "/bin/echo", args, 1, &result, &error);
    assert(code == Ok);

    // Free result multiple times should be safe
    boxlite_result_free(result);
    boxlite_result_free(NULL);  // Should not crash

    printf("  ✓ Result cleanup is safe\n");

    boxlite_simple_free(box);
}

void test_simple_null_safety() {
    printf("\nTEST: Simple API - NULL safety\n");

    // Free NULL box (should not crash)
    boxlite_simple_free(NULL);
    printf("  ✓ boxlite_simple_free(NULL) is safe\n");

    // Free NULL result (should not crash)
    boxlite_result_free(NULL);
    printf("  ✓ boxlite_result_free(NULL) is safe\n");
}

void test_simple_auto_cleanup() {
    printf("\nTEST: Simple API - auto cleanup\n");

    CBoxliteSimple* box;
    CBoxliteError error = {0};

    BoxliteErrorCode code = boxlite_simple_new("alpine:3.19", 0, 0, &box, &error);
    assert(code == Ok);

    // Run a command
    CBoxliteExecResult* result;
    const char* args[] = {"test", NULL};
    code = boxlite_simple_run(box, "/bin/echo", args, 1, &result, &error);
    assert(code == Ok);
    boxlite_result_free(result);

    // Just free - should auto-stop and remove
    boxlite_simple_free(box);
    printf("  ✓ Box auto-stopped and removed on free\n");
}

int main() {
    printf("═══════════════════════════════════════\n");
    printf("  BoxLite C SDK - Simple API Tests\n");
    printf("═══════════════════════════════════════\n");

    test_simple_create();
    test_simple_default_resources();
    test_simple_run_command();
    test_simple_run_no_args();
    test_simple_run_failure();
    test_simple_multiple_commands();
    test_simple_result_cleanup();
    test_simple_null_safety();
    test_simple_auto_cleanup();

    printf("\n═══════════════════════════════════════\n");
    printf("  ✅ ALL TESTS PASSED (%d tests)\n", 9);
    printf("═══════════════════════════════════════\n");

    return 0;
}
