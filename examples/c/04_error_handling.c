/**
 * BoxLite C SDK - Example 4: Error Handling
 *
 * Demonstrates structured error handling with error codes and recovery
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "boxlite.h"

void print_error(const char* context, CBoxliteError* error) {
    printf("❌ Error in %s\n", context);
    printf("   Code: %d\n", error->code);
    if (error->message) {
        printf("   Message: %s\n", error->message);
    }
}

int main() {
    printf("=== BoxLite Example: Error Handling ===\n\n");

    // Example 1: Handling InvalidArgument errors
    printf("1. InvalidArgument Error (NULL parameter)\n");
    printf("─────────────────────────────────────────\n");

    CBoxliteSimple* box;
    CBoxliteError error = {0};

    BoxliteErrorCode code = boxlite_simple_new(NULL, 0, 0, &box, &error);
    if (code != Ok) {
        print_error("box creation", &error);
        printf("   ✓ Error handled gracefully\n");
        boxlite_error_free(&error);
    }
    printf("\n");

    // Example 2: Handling NotFound errors
    printf("2. NotFound Error (non-existent box)\n");
    printf("─────────────────────────────────────────\n");

    char* str_error = NULL;
    CBoxliteRuntime* runtime = boxlite_runtime_new(NULL, NULL, &str_error);
    if (!runtime) {
        fprintf(stderr, "Failed to create runtime: %s\n", str_error);
        boxlite_free_string(str_error);
        return 1;
    }

    CBoxHandle* handle = boxlite_get(runtime, "nonexistent-box-id", &str_error);
    if (!handle) {
        printf("❌ Error: %s\n", str_error);
        printf("   ✓ NotFound error handled\n");
        boxlite_free_string(str_error);
    }
    printf("\n");

    // Example 3: Error recovery - retry logic
    printf("3. Error Recovery (retry on failure)\n");
    printf("─────────────────────────────────────────\n");

    int retries = 3;
    int success = 0;

    for (int i = 0; i < retries; i++) {
        printf("Attempt %d/%d...\n", i + 1, retries);

        code = boxlite_simple_new("alpine:3.19", 0, 0, &box, &error);
        if (code == Ok) {
            printf("✓ Success!\n");
            success = 1;
            break;
        } else {
            printf("  Failed (code %d): %s\n", error.code, error.message);
            boxlite_error_free(&error);

            // Wait before retry (in real app, use exponential backoff)
            if (i < retries - 1) {
                printf("  Retrying...\n");
            }
        }
    }

    if (!success) {
        printf("❌ All retries failed\n");
        boxlite_runtime_free(runtime);
        return 1;
    }
    printf("\n");

    // Example 4: Programmatic error handling
    printf("4. Programmatic Error Handling\n");
    printf("─────────────────────────────────────────\n");

    const char* args[] = {"/nonexistent", NULL};
    CBoxliteExecResult* result;

    code = boxlite_simple_run(box, "/bin/ls", args, 1, &result, &error);

    if (code != Ok) {
        switch (error.code) {
            case InvalidArgument:
                printf("Invalid argument provided\n");
                break;
            case NotFound:
                printf("Box not found\n");
                break;
            case InvalidState:
                printf("Box in invalid state\n");
                break;
            default:
                printf("Unknown error: %d\n", error.code);
        }
        boxlite_error_free(&error);
    } else {
        // API call succeeded, but command may have failed
        if (result->exit_code != 0) {
            printf("Command failed with exit code: %d\n", result->exit_code);
            if (result->stderr_text && strlen(result->stderr_text) > 0) {
                printf("Stderr: %s\n", result->stderr_text);
            }
        }
        boxlite_result_free(result);
    }
    printf("\n");

    // Example 5: Graceful degradation
    printf("5. Graceful Degradation\n");
    printf("─────────────────────────────────────────\n");

    const char* preferred_args[] = {"-alh", "/", NULL};
    const char* fallback_args[] = {"/", NULL};

    // Try preferred command
    code = boxlite_simple_run(box, "/bin/ls", preferred_args, 2, &result, &error);

    if (code != Ok) {
        printf("Preferred command failed, trying fallback...\n");
        boxlite_error_free(&error);

        // Try fallback
        code = boxlite_simple_run(box, "/bin/ls", fallback_args, 1, &result, &error);
    }

    if (code == Ok) {
        printf("✓ Command succeeded (exit code: %d)\n", result->exit_code);
        boxlite_result_free(result);
    } else {
        printf("❌ Both commands failed\n");
        boxlite_error_free(&error);
    }
    printf("\n");

    // Example 6: Multiple error cleanup
    printf("6. Multiple Error Cleanup\n");
    printf("─────────────────────────────────────────\n");

    CBoxliteError error1 = {0};
    CBoxliteError error2 = {0};
    CBoxliteError error3 = {0};

    // Trigger multiple errors
    boxlite_simple_new(NULL, 0, 0, &box, &error1);
    boxlite_simple_new(NULL, 0, 0, &box, &error2);
    boxlite_simple_new(NULL, 0, 0, &box, &error3);

    printf("Cleaning up multiple errors...\n");
    boxlite_error_free(&error1);
    boxlite_error_free(&error2);
    boxlite_error_free(&error3);
    printf("✓ All errors freed\n\n");

    // Cleanup
    boxlite_simple_free(box);
    boxlite_runtime_free(runtime);

    printf("=== Error Handling Demo Complete ===\n");
    return 0;
}
