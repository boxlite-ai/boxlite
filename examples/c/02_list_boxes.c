/**
 * BoxLite C SDK - Example 2: List and Inspect Boxes
 *
 * Demonstrates listing boxes, getting info, and parsing JSON output
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "boxlite.h"

void print_separator() {
    printf("─────────────────────────────────────────\n");
}

int main() {
    printf("=== BoxLite Example: List and Inspect Boxes ===\n\n");

    char* error = NULL;

    // Create runtime
    CBoxliteRuntime* runtime = boxlite_runtime_new(NULL, NULL, &error);
    if (!runtime) {
        fprintf(stderr, "Failed to create runtime: %s\n", error);
        boxlite_free_string(error);
        return 1;
    }

    // Create multiple boxes with different images
    printf("Creating 3 boxes...\n");
    print_separator();

    const char* opt1 = "{\"rootfs\":{\"Image\":\"alpine:3.19\"}}";
    CBoxHandle* box1 = boxlite_create_box(runtime, opt1, &error);

    const char* opt2 = "{\"rootfs\":{\"Image\":\"alpine:3.19\"}}";
    CBoxHandle* box2 = boxlite_create_box(runtime, opt2, &error);

    const char* opt3 = "{\"rootfs\":{\"Image\":\"alpine:3.19\"}}";
    CBoxHandle* box3 = boxlite_create_box(runtime, opt3, &error);

    if (!box1 || !box2 || !box3) {
        fprintf(stderr, "Failed to create boxes: %s\n", error);
        boxlite_free_string(error);
        return 1;
    }

    char* id1 = boxlite_box_id(box1);
    char* id2 = boxlite_box_id(box2);
    char* id3 = boxlite_box_id(box3);

    printf("✓ Created box 1: %s\n", id1);
    printf("✓ Created box 2: %s\n", id2);
    printf("✓ Created box 3: %s\n", id3);
    printf("\n");

    // List all boxes
    printf("Listing all boxes...\n");
    print_separator();

    char* list_json = NULL;
    if (boxlite_list_info(runtime, &list_json, &error) != 0) {
        fprintf(stderr, "Failed to list boxes: %s\n", error);
        boxlite_free_string(error);
    } else {
        printf("%s\n", list_json);
        boxlite_free_string(list_json);
    }
    printf("\n");

    // Get info for specific box
    printf("Getting info for box 1...\n");
    print_separator();

    char* info_json = NULL;
    if (boxlite_get_info(runtime, id1, &info_json, &error) != 0) {
        fprintf(stderr, "Failed to get box info: %s\n", error);
        boxlite_free_string(error);
    } else {
        printf("%s\n", info_json);
        boxlite_free_string(info_json);
    }
    printf("\n");

    // Get info from box handle
    printf("Getting info from box handle...\n");
    print_separator();

    if (boxlite_box_info(box2, &info_json, &error) != 0) {
        fprintf(stderr, "Failed to get box info: %s\n", error);
        boxlite_free_string(error);
    } else {
        printf("%s\n", info_json);
        boxlite_free_string(info_json);
    }
    printf("\n");

    // Demonstrate prefix lookup
    printf("Looking up box by ID prefix (first 8 chars)...\n");
    print_separator();

    char prefix[9] = {0};
    strncpy(prefix, id3, 8);
    printf("Using prefix: %s\n", prefix);

    char* prefix_info = NULL;
    if (boxlite_get_info(runtime, prefix, &prefix_info, &error) != 0) {
        fprintf(stderr, "Failed to lookup by prefix: %s\n", error);
        boxlite_free_string(error);
    } else {
        printf("Found box: %s\n", prefix_info);
        boxlite_free_string(prefix_info);
    }
    printf("\n");

    // Get runtime metrics
    printf("Getting runtime metrics...\n");
    print_separator();

    char* metrics_json = NULL;
    if (boxlite_runtime_metrics(runtime, &metrics_json, &error) != 0) {
        fprintf(stderr, "Failed to get metrics: %s\n", error);
        boxlite_free_string(error);
    } else {
        printf("%s\n", metrics_json);
        boxlite_free_string(metrics_json);
    }
    printf("\n");

    // Cleanup
    printf("Cleaning up...\n");
    boxlite_remove(runtime, id1, 1, &error);
    boxlite_remove(runtime, id2, 1, &error);
    boxlite_remove(runtime, id3, 1, &error);

    boxlite_free_string(id1);
    boxlite_free_string(id2);
    boxlite_free_string(id3);
    boxlite_runtime_free(runtime);

    printf("✓ All boxes removed\n");
    printf("\n=== List and Inspect Demo Complete ===\n");
    return 0;
}
