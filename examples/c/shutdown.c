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
    char* error = NULL;

    printf("=== Runtime Shutdown Example ===\n\n");

    // Create runtime with default settings
    CBoxliteRuntime* runtime = boxlite_runtime_new(NULL, NULL, &error);
    if (!runtime) {
        fprintf(stderr, "Failed to create runtime: %s\n", error);
        boxlite_free_string(error);
        return 1;
    }

    // Create a few boxes
    const char* opts = "{\"rootfs\":{\"Image\":\"alpine:3.19\"}}";

    CBoxHandle* boxes[3];
    for (int i = 0; i < 3; i++) {
        boxes[i] = boxlite_create_box(runtime, opts, &error);
        if (!boxes[i]) {
            fprintf(stderr, "Failed to create box %d: %s\n", i + 1, error);
            boxlite_free_string(error);
            error = NULL;
            continue;
        }
        char* id = boxlite_box_id(boxes[i]);
        printf("Created box %d: %s\n", i + 1, id);
        boxlite_free_string(id);
    }

    // Get metrics before shutdown
    char* metrics_json = NULL;
    if (boxlite_runtime_metrics(runtime, &metrics_json, &error) == 0) {
        printf("\nBefore shutdown:\n");
        printf("  Metrics: %s\n", metrics_json);
        boxlite_free_string(metrics_json);
    }

    // Shutdown with custom timeout (5 seconds)
    printf("\nShutting down all boxes (5 second timeout)...\n");
    if (boxlite_runtime_shutdown(runtime, 5, &error) != 0) {
        fprintf(stderr, "Shutdown failed: %s\n", error);
        boxlite_free_string(error);
        error = NULL;
    } else {
        printf("Shutdown complete!\n");
    }

    // After shutdown, new operations will fail
    printf("\nTrying to create a new box after shutdown...\n");
    CBoxHandle* new_box = boxlite_create_box(runtime, opts, &error);
    if (new_box) {
        printf("ERROR: Expected this to fail!\n");
        boxlite_stop_box(new_box, NULL);
    } else {
        printf("Expected error: %s\n", error);
        boxlite_free_string(error);
    }

    // Clean up
    boxlite_runtime_free(runtime);

    printf("\nDone!\n");
    return 0;
}
