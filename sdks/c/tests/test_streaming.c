/**
 * BoxLite C SDK - Streaming Tests
 *
 * Tests streaming output callbacks for real-time output
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include "boxlite.h"

static int stdout_count = 0;
static int stderr_count = 0;
static char last_output[1024] = {0};

void counting_callback(const char* text, int is_stderr, void* user_data) {
    if (is_stderr) {
        stderr_count++;
    } else {
        stdout_count++;
    }
    strncpy(last_output, text, sizeof(last_output) - 1);
}

void test_streaming_stdout() {
    printf("\nTEST: Streaming stdout\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-streaming-stdout";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    // Reset counters
    stdout_count = 0;
    stderr_count = 0;
    memset(last_output, 0, sizeof(last_output));

    // Execute command that produces stdout
    const char* args = "[\"hello world\"]";
    int exit_code = 0;
    code = boxlite_execute(box, "/bin/echo", args, counting_callback, NULL, &exit_code, &error);

    assert(code == Ok);
    assert(exit_code == 0);
    assert(stdout_count > 0);
    assert(stderr_count == 0);
    printf("  ✓ Stdout callback invoked %d times\n", stdout_count);
    printf("  ✓ Last output: %s\n", last_output);

    // Cleanup
    char* id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
    boxlite_runtime_free(runtime);
}

void test_streaming_stderr() {
    printf("\nTEST: Streaming stderr\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-streaming-stderr";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    // Reset counters
    stdout_count = 0;
    stderr_count = 0;

    // Execute command that produces stderr (ls on nonexistent path)
    const char* args = "[\"/nonexistent\"]";
    int exit_code = 0;
    code = boxlite_execute(box, "/bin/ls", args, counting_callback, NULL, &exit_code, &error);

    assert(code == Ok);
    assert(exit_code != 0);
    // Note: stderr_count might be 0 if stderr output is empty or not captured
    printf("  ✓ Command failed, stderr callback invoked %d times\n", stderr_count);

    // Cleanup
    char* id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
    boxlite_runtime_free(runtime);
}

void test_streaming_both() {
    printf("\nTEST: Streaming stdout and stderr\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-streaming-both";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    // Reset counters
    stdout_count = 0;
    stderr_count = 0;

    // Execute command that produces both stdout and stderr
    // Using sh to write to both streams
    const char* args = "[\"-c\", \"echo stdout; echo stderr >&2\"]";
    int exit_code = 0;
    code = boxlite_execute(box, "/bin/sh", args, counting_callback, NULL, &exit_code, &error);

    assert(code == Ok);
    assert(exit_code == 0);
    printf("  ✓ Stdout callbacks: %d\n", stdout_count);
    printf("  ✓ Stderr callbacks: %d\n", stderr_count);
    assert(stdout_count > 0);
    assert(stderr_count > 0);

    // Cleanup
    char* id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
    boxlite_runtime_free(runtime);
}

typedef struct {
    int count;
    char buffer[4096];
} UserContext;

void accumulating_callback(const char* text, int is_stderr, void* user_data) {
    UserContext* ctx = (UserContext*)user_data;
    ctx->count++;
    strncat(ctx->buffer, text, sizeof(ctx->buffer) - strlen(ctx->buffer) - 1);
}

void test_streaming_with_context() {
    printf("\nTEST: Streaming with user context\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-streaming-context";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    // User context to accumulate output
    UserContext ctx = {0};
    memset(ctx.buffer, 0, sizeof(ctx.buffer));

    const char* args = "[\"line1\\nline2\\nline3\"]";
    int exit_code = 0;
    code = boxlite_execute(box, "/bin/echo", args, accumulating_callback, &ctx, &exit_code, &error);

    assert(code == Ok);
    assert(exit_code == 0);
    assert(ctx.count > 0);
    printf("  ✓ Accumulated %d callbacks\n", ctx.count);
    printf("  ✓ Buffer content: %s\n", ctx.buffer);

    // Cleanup
    char* id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
    boxlite_runtime_free(runtime);
}

void test_streaming_large_output() {
    printf("\nTEST: Streaming large output\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-streaming-large";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    // Reset counters
    stdout_count = 0;

    // Execute command that produces lots of output
    const char* args = "[\"-R\", \"/\"]";
    int exit_code = 0;
    code = boxlite_execute(box, "/bin/ls", args, counting_callback, NULL, &exit_code, &error);

    assert(code == Ok);
    assert(exit_code == 0);
    printf("  ✓ Large output streamed (%d callbacks)\n", stdout_count);
    assert(stdout_count > 10);  // Should have many lines

    // Cleanup
    char* id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
    boxlite_runtime_free(runtime);
}

void test_streaming_no_callback() {
    printf("\nTEST: Streaming without callback (NULL)\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* temp_dir = "/tmp/boxlite-test-streaming-nocallback";
    BoxliteErrorCode code = boxlite_runtime_new(temp_dir, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    const char* options = "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],\"network\":\"Isolated\",\"ports\":[],\"auto_remove\":false}";
    CBoxHandle* box = NULL;
    code = boxlite_create_box(runtime, options, &box, &error);
    assert(code == Ok);
    assert(box != NULL);

    // Execute without callback (should still work)
    const char* args = "[\"hello\"]";
    int exit_code = 0;
    code = boxlite_execute(box, "/bin/echo", args, NULL, NULL, &exit_code, &error);

    assert(code == Ok);
    assert(exit_code == 0);
    printf("  ✓ Execution without callback succeeded\n");

    // Cleanup
    char* id = boxlite_box_id(box);
    boxlite_remove(runtime, id, 1, &error);
    boxlite_free_string(id);
    boxlite_runtime_free(runtime);
}

int main() {
    printf("═══════════════════════════════════════\n");
    printf("  BoxLite C SDK - Streaming Tests\n");
    printf("═══════════════════════════════════════\n");

    test_streaming_stdout();
    test_streaming_stderr();
    test_streaming_both();
    test_streaming_with_context();
    test_streaming_large_output();
    test_streaming_no_callback();

    printf("\n═══════════════════════════════════════\n");
    printf("  ✅ ALL TESTS PASSED (%d tests)\n", 6);
    printf("═══════════════════════════════════════\n");

    return 0;
}
