/**
 * BoxLite C SDK - Simple API Demo
 *
 * Demonstrates the new simple convenience API that doesn't require
 * JSON or manual runtime management.
 */

#include <stdio.h>
#include <stdlib.h>
#include "boxlite.h"

int main() {
    printf("🚀 BoxLite Simple API Demo\n");
    printf("Version: %s\n\n", boxlite_version());

    // Create a box using simple API (no JSON, no runtime management)
    CBoxliteSimple* box;
    CBoxliteError error = {0};

    printf("Creating Python box...\n");
    BoxliteErrorCode result = boxlite_simple_new(
        "python:slim",  // image
        0,              // cpus (0 = default)
        0,              // memory_mib (0 = default)
        &box,
        &error
    );

    if (result != Ok) {
        fprintf(stderr, "❌ Failed to create box (code %d): %s\n",
                error.code, error.message);
        boxlite_error_free(&error);
        return 1;
    }

    printf("✅ Box created successfully!\n\n");

    // Run a simple command
    printf("Command 1: python --version\n");
    printf("---\n");

    const char* args1[] = {"--version", NULL};
    CBoxliteExecResult* result1;

    result = boxlite_simple_run(box, "python", args1, 1, &result1, &error);
    if (result == Ok) {
        printf("Exit code: %d\n", result1->exit_code);
        printf("Output: %s\n", result1->stdout_text);
        boxlite_result_free(result1);
    } else {
        fprintf(stderr, "Error (code %d): %s\n", error.code, error.message);
        boxlite_error_free(&error);
    }
    printf("\n");

    // Run a Python script
    printf("Command 2: python -c 'print(\"Hello from BoxLite!\")'\n");
    printf("---\n");

    const char* args2[] = {"-c", "print('Hello from BoxLite!')", NULL};
    CBoxliteExecResult* result2;

    result = boxlite_simple_run(box, "python", args2, 2, &result2, &error);
    if (result == Ok) {
        printf("Exit code: %d\n", result2->exit_code);
        printf("Output: %s\n", result2->stdout_text);
        boxlite_result_free(result2);
    } else {
        fprintf(stderr, "Error (code %d): %s\n", error.code, error.message);
        boxlite_error_free(&error);
    }
    printf("\n");

    // Run a command that produces stderr
    printf("Command 3: ls /nonexistent (should fail)\n");
    printf("---\n");

    const char* args3[] = {"/nonexistent", NULL};
    CBoxliteExecResult* result3;

    result = boxlite_simple_run(box, "ls", args3, 1, &result3, &error);
    if (result == Ok) {
        printf("Exit code: %d\n", result3->exit_code);
        if (result3->stdout_text && result3->stdout_text[0]) {
            printf("Stdout: %s\n", result3->stdout_text);
        }
        if (result3->stderr_text && result3->stderr_text[0]) {
            printf("Stderr: %s\n", result3->stderr_text);
        }
        boxlite_result_free(result3);
    } else {
        fprintf(stderr, "Error (code %d): %s\n", error.code, error.message);
        boxlite_error_free(&error);
    }
    printf("\n");

    // Cleanup (auto-stop and remove)
    printf("🧹 Cleaning up...\n");
    boxlite_simple_free(box);

    printf("✅ Demo completed!\n");
    return 0;
}
