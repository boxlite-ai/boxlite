/**
 * Simple BoxLite C API example
 *
 * Demonstrates creating a container and executing commands.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "boxlite.h"

// Callback for streaming command output
void output_callback(const char* text, int is_stderr, void* user_data) {
    FILE* stream = is_stderr ? stderr : stdout;
    fprintf(stream, "%s", text);
}

int main() {
    CBoxliteRuntime* runtime = NULL;
    CBoxHandle* box = NULL;
    CBoxliteError error = {0};
    BoxliteErrorCode code;

    printf("🚀 BoxLite C API Example\n");
    printf("Version: %s\n\n", boxlite_version());

    // Create runtime with default home directory
    code = boxlite_runtime_new(NULL, NULL, &runtime, &error);
    if (code != Ok) {
        fprintf(stderr, "Failed to create runtime (code %d): %s\n",
                error.code, error.message ? error.message : "unknown");
        boxlite_error_free(&error);
        return 1;
    }

    // Create a box with Alpine Linux
    const char* options_json = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[]}";
    code = boxlite_create_box(runtime, options_json, &box, &error);
    if (code != Ok) {
        fprintf(stderr, "Failed to create box (code %d): %s\n",
                error.code, error.message ? error.message : "unknown");
        boxlite_error_free(&error);
        boxlite_runtime_free(runtime);
        return 1;
    }

    printf("📦 Created container, executing commands...\n\n");

    // Execute first command: list root directory
    printf("Command 1: ls -alrt /\n");
    printf("---\n");
    const char* args1 = "[\"-alrt\", \"/\"]";
    int exit_code = 0;
    error = (CBoxliteError){0};
    code = boxlite_execute(box, "/bin/ls", args1, output_callback, NULL, &exit_code, &error);
    if (code != Ok) {
        fprintf(stderr, "Execute failed (code %d): %s\n", error.code, error.message);
        boxlite_error_free(&error);
    } else if (exit_code != 0) {
        fprintf(stderr, "Command failed with exit code %d\n", exit_code);
    }
    printf("\n");

    // Execute second command: show network interfaces
    printf("Command 2: ip addr\n");
    printf("---\n");
    const char* args2 = "[\"addr\"]";
    exit_code = 0;
    error = (CBoxliteError){0};
    code = boxlite_execute(box, "ip", args2, output_callback, NULL, &exit_code, &error);
    if (code != Ok) {
        fprintf(stderr, "Execute failed (code %d): %s\n", error.code, error.message);
        boxlite_error_free(&error);
    } else if (exit_code != 0) {
        fprintf(stderr, "Command failed with exit code %d\n", exit_code);
    }
    printf("\n");

    // Execute third command: show environment
    printf("Command 3: env\n");
    printf("---\n");
    const char* args3 = "[]";
    exit_code = 0;
    error = (CBoxliteError){0};
    code = boxlite_execute(box, "/usr/bin/env", args3, output_callback, NULL, &exit_code, &error);
    if (code != Ok) {
        fprintf(stderr, "Execute failed (code %d): %s\n", error.code, error.message);
        boxlite_error_free(&error);
    } else if (exit_code != 0) {
        fprintf(stderr, "Command failed with exit code %d\n", exit_code);
    }
    printf("\n");

    printf("✅ Execution completed!\n");

    // Cleanup
    error = (CBoxliteError){0};
    code = boxlite_stop_box(box, &error);
    if (code != Ok) {
        fprintf(stderr, "Warning: Failed to stop box (code %d): %s\n",
                error.code, error.message ? error.message : "unknown");
        boxlite_error_free(&error);
    }

    boxlite_runtime_free(runtime);

    return 0;
}
