/**
 * Runtime Shutdown Example - Graceful cleanup of all boxes.
 *
 * Demonstrates the boxlite_runtime_shutdown() function:
 * - Graceful shutdown of all running boxes
 * - Custom timeout configuration
 * - Behavior after shutdown (operations fail)
 */

#include <stdio.h>
#include <stdlib.h>
#include "boxlite.h"

int main() {
    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    BoxliteErrorCode code;

    printf("=== Runtime Shutdown Example ===\n\n");

    // Create runtime with default settings
    code = boxlite_runtime_new(NULL, NULL, &runtime, &error);
    if (code != Ok) {
        fprintf(stderr, "Failed to create runtime (code %d): %s\n",
                error.code, error.message ? error.message : "unknown");
        boxlite_error_free(&error);
        return 1;
    }

    // Create a few boxes
    const char* opts = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[]}";

    CBoxHandle* boxes[3];
    for (int i = 0; i < 3; i++) {
        boxes[i] = NULL;
        error = (CBoxliteError){0};
        code = boxlite_create_box(runtime, opts, &boxes[i], &error);
        if (code != Ok) {
            fprintf(stderr, "Failed to create box %d (code %d): %s\n",
                    i + 1, error.code, error.message ? error.message : "unknown");
            boxlite_error_free(&error);
            continue;
        }
        char* id = boxlite_box_id(boxes[i]);
        printf("Created box %d: %s\n", i + 1, id);
        boxlite_free_string(id);
    }

    // Get metrics before shutdown
    char* metrics_json = NULL;
    error = (CBoxliteError){0};
    code = boxlite_runtime_metrics(runtime, &metrics_json, &error);
    if (code == Ok) {
        printf("\nBefore shutdown:\n");
        printf("  Metrics: %s\n", metrics_json);
        boxlite_free_string(metrics_json);
    } else {
        fprintf(stderr, "Failed to get metrics (code %d): %s\n",
                error.code, error.message ? error.message : "unknown");
        boxlite_error_free(&error);
    }

    // Shutdown with custom timeout (5 seconds)
    printf("\nShutting down all boxes (5 second timeout)...\n");
    error = (CBoxliteError){0};
    code = boxlite_runtime_shutdown(runtime, 5, &error);
    if (code != Ok) {
        fprintf(stderr, "Shutdown failed (code %d): %s\n",
                error.code, error.message ? error.message : "unknown");
        boxlite_error_free(&error);
    } else {
        printf("Shutdown complete!\n");
    }

    // After shutdown, new operations will fail
    printf("\nTrying to create a new box after shutdown...\n");
    CBoxHandle* new_box = NULL;
    error = (CBoxliteError){0};
    code = boxlite_create_box(runtime, opts, &new_box, &error);
    if (code == Ok && new_box) {
        printf("ERROR: Expected this to fail!\n");
        CBoxliteError stop_error = {0};
        boxlite_stop_box(new_box, &stop_error);
        boxlite_error_free(&stop_error);
    } else {
        printf("Expected error (code %d): %s\n",
               error.code, error.message ? error.message : "unknown");
        boxlite_error_free(&error);
    }

    // Clean up
    boxlite_runtime_free(runtime);

    printf("\nDone!\n");
    return 0;
}
