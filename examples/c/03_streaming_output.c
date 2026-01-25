/**
 * BoxLite C SDK - Example 3: Streaming Output
 *
 * Demonstrates real-time command output streaming with callbacks
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "boxlite.h"

// Simple callback that prints output in real-time
void realtime_output(const char* text, int is_stderr, void* user_data) {
    FILE* stream = is_stderr ? stderr : stdout;
    fprintf(stream, "%s", text);
}

// Callback that tracks statistics
typedef struct {
    int stdout_lines;
    int stderr_lines;
    size_t total_bytes;
} OutputStats;

void stats_callback(const char* text, int is_stderr, void* user_data) {
    OutputStats* stats = (OutputStats*)user_data;

    if (is_stderr) {
        stats->stderr_lines++;
    } else {
        stats->stdout_lines++;
    }

    stats->total_bytes += strlen(text);

    // Also print the output
    FILE* stream = is_stderr ? stderr : stdout;
    fprintf(stream, "%s", text);
}

// Callback that filters output
void filter_callback(const char* text, int is_stderr, void* user_data) {
    // Only print lines containing "bin" (for demo purposes)
    if (strstr(text, "bin") != NULL) {
        printf("[FILTERED] %s", text);
    }
}

int main() {
    printf("=== BoxLite Example: Streaming Output ===\n\n");

    char* error = NULL;

    // Create runtime and box
    CBoxliteRuntime* runtime = boxlite_runtime_new(NULL, NULL, &error);
    if (!runtime) {
        fprintf(stderr, "Failed to create runtime: %s\n", error);
        boxlite_free_string(error);
        return 1;
    }

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"}}";
    CBoxHandle* box = boxlite_create_box(runtime, options, &error);
    if (!box) {
        fprintf(stderr, "Failed to create box: %s\n", error);
        boxlite_free_string(error);
        boxlite_runtime_free(runtime);
        return 1;
    }

    printf("✓ Box created\n\n");

    // Example 1: Simple real-time output
    printf("1. Simple real-time output (ls /bin)\n");
    printf("───────────────────────────────────────\n");

    const char* args1 = "[\"/bin\"]";
    int exit_code = boxlite_execute(box, "/bin/ls", args1, realtime_output, NULL, &error);

    printf("\n✓ Exit code: %d\n\n", exit_code);

    // Example 2: Capturing output with statistics
    printf("2. Capturing output with statistics (ls -R /)\n");
    printf("───────────────────────────────────────\n");

    OutputStats stats = {0};
    const char* args2 = "[\"-R\", \"/\"]";
    exit_code = boxlite_execute(box, "/bin/ls", args2, stats_callback, &stats, &error);

    printf("\n✓ Exit code: %d\n", exit_code);
    printf("  Stdout lines: %d\n", stats.stdout_lines);
    printf("  Stderr lines: %d\n", stats.stderr_lines);
    printf("  Total bytes: %zu\n\n", stats.total_bytes);

    // Example 3: Filtered output
    printf("3. Filtered output (only lines with 'bin')\n");
    printf("───────────────────────────────────────\n");

    const char* args3 = "[\"-la\", \"/\"]";
    exit_code = boxlite_execute(box, "/bin/ls", args3, filter_callback, NULL, &error);

    printf("\n✓ Exit code: %d\n\n", exit_code);

    // Example 4: Command that outputs to both stdout and stderr
    printf("4. Command with both stdout and stderr\n");
    printf("───────────────────────────────────────\n");

    const char* args4 = "[\"-c\", \"echo 'This is stdout'; echo 'This is stderr' >&2\"]";
    exit_code = boxlite_execute(box, "/bin/sh", args4, realtime_output, NULL, &error);

    printf("\n✓ Exit code: %d\n\n", exit_code);

    // Example 5: No callback (output is discarded)
    printf("5. Executing without callback (output discarded)\n");
    printf("───────────────────────────────────────\n");

    const char* args5 = "[\"-la\", \"/\"]";
    exit_code = boxlite_execute(box, "/bin/ls", args5, NULL, NULL, &error);

    printf("✓ Command executed, output discarded (exit code: %d)\n\n", exit_code);

    // Cleanup
    char* id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
    boxlite_runtime_free(runtime);

    printf("=== Streaming Output Demo Complete ===\n");
    return 0;
}
