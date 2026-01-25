/**
 * BoxLite C SDK - Basic Tests
 *
 * Tests runtime creation, version, and shutdown functionality.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include "boxlite.h"

void test_version() {
    printf("TEST: Version string\n");
    const char* version = boxlite_version();
    assert(version != NULL);
    assert(strlen(version) > 0);
    assert(strchr(version, '.') != NULL);  // Should contain '.' (e.g., "0.5.7")
    printf("  ✓ Version: %s\n", version);
}

void test_runtime_creation() {
    printf("\nTEST: Runtime creation\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    BoxliteErrorCode code = boxlite_runtime_new(NULL, NULL, &runtime, &error);

    assert(code == Ok);
    assert(runtime != NULL);
    printf("  ✓ Runtime created successfully\n");

    boxlite_runtime_free(runtime);
    printf("  ✓ Runtime freed\n");
}

void test_runtime_with_custom_home() {
    printf("\nTEST: Runtime with custom home directory\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* home_dir = "/tmp/boxlite-test";

    BoxliteErrorCode code = boxlite_runtime_new(home_dir, NULL, &runtime, &error);

    assert(code == Ok);
    assert(runtime != NULL);
    printf("  ✓ Runtime created with custom home: %s\n", home_dir);

    boxlite_runtime_free(runtime);
}

void test_runtime_with_registries() {
    printf("\nTEST: Runtime with custom registries\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* registries = "[\"ghcr.io\", \"docker.io\"]";

    BoxliteErrorCode code = boxlite_runtime_new(NULL, registries, &runtime, &error);

    assert(code == Ok);
    assert(runtime != NULL);
    printf("  ✓ Runtime created with custom registries\n");

    boxlite_runtime_free(runtime);
}

void test_runtime_shutdown() {
    printf("\nTEST: Runtime shutdown\n");

    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    BoxliteErrorCode code = boxlite_runtime_new(NULL, NULL, &runtime, &error);
    assert(code == Ok);
    assert(runtime != NULL);

    // Shutdown with default timeout (0 = 10 seconds)
    code = boxlite_runtime_shutdown(runtime, 0, &error);
    assert(code == Ok);
    printf("  ✓ Runtime shutdown successful\n");

    boxlite_runtime_free(runtime);
}

void test_error_string_cleanup() {
    printf("\nTEST: Error string cleanup\n");

    // Trigger an error with invalid JSON
    CBoxliteRuntime* runtime = NULL;
    CBoxliteError error = {0};
    const char* invalid_json = "{invalid json";

    BoxliteErrorCode code = boxlite_runtime_new(NULL, invalid_json, &runtime, &error);

    assert(code != Ok);
    assert(runtime == NULL);
    assert(error.message != NULL);
    printf("  ✓ Error code: %d, message: %s\n", error.code, error.message);

    // Must free error
    boxlite_error_free(&error);
    printf("  ✓ Error freed\n");
}

void test_null_safety() {
    printf("\nTEST: NULL pointer safety\n");

    // These should not crash
    boxlite_runtime_free(NULL);
    boxlite_error_free(NULL);

    printf("  ✓ NULL pointer handling works\n");
}

int main() {
    printf("═══════════════════════════════════════\n");
    printf("  BoxLite C SDK - Basic Tests\n");
    printf("═══════════════════════════════════════\n\n");

    test_version();
    test_runtime_creation();
    test_runtime_with_custom_home();
    test_runtime_with_registries();
    test_runtime_shutdown();
    test_error_string_cleanup();
    test_null_safety();

    printf("\n═══════════════════════════════════════\n");
    printf("  ✅ ALL TESTS PASSED (%d tests)\n", 7);
    printf("═══════════════════════════════════════\n");

    return 0;
}
