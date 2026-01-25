/**
 * BoxLite C SDK - Example 5: Performance Metrics
 *
 * Demonstrates runtime and box performance monitoring
 */

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include "boxlite.h"

int main() {
    printf("=== BoxLite Example: Performance Metrics ===\n\n");

    char* error = NULL;
    CBoxliteRuntime* runtime = boxlite_runtime_new(NULL, NULL, &error);
    if (!runtime) {
        fprintf(stderr, "Failed to create runtime: %s\n", error);
        boxlite_free_string(error);
        return 1;
    }

    // Get initial runtime metrics
    printf("1. Initial Runtime Metrics\n");
    printf("─────────────────────────────────────────\n");
    char* metrics = NULL;
    boxlite_runtime_metrics(runtime, &metrics, &error);
    printf("%s\n\n", metrics);
    boxlite_free_string(metrics);

    // Create a box
    printf("2. Creating box and executing commands...\n");
    printf("─────────────────────────────────────────\n");
    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"}}";
    CBoxHandle* box = boxlite_create_box(runtime, options, &error);
    if (!box) {
        fprintf(stderr, "Failed: %s\n", error);
        boxlite_free_string(error);
        return 1;
    }

    // Execute multiple commands to generate metrics
    for (int i = 0; i < 5; i++) {
        const char* args = "[\"test\"]";
        boxlite_execute(box, "/bin/echo", args, NULL, NULL, &error);
    }
    printf("✓ Executed 5 commands\n\n");

    // Get updated runtime metrics
    printf("3. Updated Runtime Metrics\n");
    printf("─────────────────────────────────────────\n");
    boxlite_runtime_metrics(runtime, &metrics, &error);
    printf("%s\n\n", metrics);
    boxlite_free_string(metrics);

    // Get box-specific metrics
    printf("4. Box-Specific Metrics\n");
    printf("─────────────────────────────────────────\n");
    char* box_metrics = NULL;
    boxlite_box_metrics(box, &box_metrics, &error);
    printf("%s\n\n", box_metrics);
    boxlite_free_string(box_metrics);

    // Monitor metrics over time
    printf("5. Real-time Metrics Monitoring (3 samples)\n");
    printf("─────────────────────────────────────────\n");
    for (int i = 0; i < 3; i++) {
        // Execute command
        boxlite_execute(box, "/bin/uname", "[\"-a\"]", NULL, NULL, &error);

        // Get metrics
        boxlite_box_metrics(box, &box_metrics, &error);
        printf("Sample %d: %s\n", i + 1, box_metrics);
        boxlite_free_string(box_metrics);

        sleep(1);
    }

    // Cleanup
    char* id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
    boxlite_runtime_free(runtime);

    printf("\n=== Metrics Demo Complete ===\n");
    return 0;
}
