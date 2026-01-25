/**
 * BoxLite C SDK - Example 1: Box Lifecycle
 *
 * Demonstrates complete box lifecycle: create → stop → restart → remove
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "boxlite.h"

int main() {
    printf("=== BoxLite Example: Box Lifecycle ===\n\n");

    char* error = NULL;

    // Create runtime
    printf("1. Creating runtime...\n");
    CBoxliteRuntime* runtime = boxlite_runtime_new(NULL, NULL, &error);
    if (!runtime) {
        fprintf(stderr, "Failed to create runtime: %s\n", error);
        boxlite_free_string(error);
        return 1;
    }
    printf("   ✓ Runtime created\n\n");

    // Create box with Alpine Linux
    printf("2. Creating box...\n");
    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"}}";
    CBoxHandle* box = boxlite_create_box(runtime, options, &error);
    if (!box) {
        fprintf(stderr, "Failed to create box: %s\n", error);
        boxlite_free_string(error);
        boxlite_runtime_free(runtime);
        return 1;
    }

    char* box_id = boxlite_box_id(box);
    printf("   ✓ Box created (ID: %s)\n", box_id);
    printf("   ✓ Box is auto-started and ready\n\n");

    // Execute a command in the running box
    printf("3. Executing command in running box...\n");
    const char* args = "[]";
    int exit_code = boxlite_execute(box, "/bin/hostname", args, NULL, NULL, &error);
    if (exit_code == 0) {
        printf("   ✓ Command executed successfully\n\n");
    } else {
        fprintf(stderr, "   ✗ Command failed\n\n");
    }

    // Stop the box
    printf("4. Stopping box...\n");
    if (boxlite_stop_box(box, &error) != 0) {
        fprintf(stderr, "Failed to stop box: %s\n", error);
        boxlite_free_string(error);
    } else {
        printf("   ✓ Box stopped\n\n");
    }

    // Get box handle for restart
    printf("5. Reattaching to stopped box...\n");
    CBoxHandle* box2 = boxlite_get(runtime, box_id, &error);
    if (!box2) {
        fprintf(stderr, "Failed to get box: %s\n", error);
        boxlite_free_string(error);
        boxlite_free_string(box_id);
        boxlite_runtime_free(runtime);
        return 1;
    }
    printf("   ✓ Box handle retrieved\n\n");

    // Restart the box
    printf("6. Restarting box...\n");
    if (boxlite_start_box(box2, &error) != 0) {
        fprintf(stderr, "Failed to restart box: %s\n", error);
        boxlite_free_string(error);
    } else {
        printf("   ✓ Box restarted\n\n");
    }

    // Execute another command after restart
    printf("7. Executing command after restart...\n");
    exit_code = boxlite_execute(box2, "/bin/uname", "[\"-a\"]", NULL, NULL, &error);
    if (exit_code == 0) {
        printf("   ✓ Command executed successfully\n\n");
    }

    // Stop again for removal
    printf("8. Stopping box for removal...\n");
    boxlite_stop_box(box2, &error);
    printf("   ✓ Box stopped\n\n");

    // Remove the box
    printf("9. Removing box...\n");
    if (boxlite_remove(runtime, box_id, 0, &error) != 0) {
        fprintf(stderr, "Failed to remove box: %s\n", error);
        boxlite_free_string(error);
    } else {
        printf("   ✓ Box removed\n\n");
    }

    // Verify box is gone
    printf("10. Verifying box is removed...\n");
    CBoxHandle* box3 = boxlite_get(runtime, box_id, &error);
    if (box3 == NULL) {
        printf("   ✓ Box no longer exists\n");
        boxlite_free_string(error);
    } else {
        fprintf(stderr, "   ✗ Box still exists!\n");
    }

    // Cleanup
    boxlite_free_string(box_id);
    boxlite_runtime_free(runtime);

    printf("\n=== Lifecycle Demo Complete ===\n");
    return 0;
}
