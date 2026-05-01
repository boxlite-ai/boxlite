/**
 * BoxLite C SDK - Execute Cmd Tests
 *
 * Tests the test_execute_cmd() function with BoxliteCommand struct,
 * covering workdir, env, user, and timeout options.
 */

#include "test_runtime.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── Helpers ─────────────────────────────────────────────────────────── */

static char captured_stdout[4096];
static int captured_stdout_len;
static const char *const COMMAND_TEST_HOME = "/tmp/boxlite-test-cmd";

static void capture_stdout_callback(const char *text, int is_stderr,
                                    void *user_data) {
  (void)user_data;
  if (!is_stderr && text) {
    size_t i = 0;
    while (text[i] != '\0' &&
           captured_stdout_len < (int)sizeof(captured_stdout) - 1) {
      captured_stdout[captured_stdout_len++] = text[i++];
    }
    captured_stdout[captured_stdout_len] = '\0';
  }
}

static void reset_capture(void) {
  captured_stdout[0] = '\0';
  captured_stdout_len = 0;
}

/**
 * Create a runtime + box for a test. Caller must clean up via cleanup_box().
 */
static void setup_box(CBoxliteRuntime **out_runtime, CBoxHandle **out_box) {
  CBoxliteError error = {0};
  *out_runtime = new_test_runtime(COMMAND_TEST_HOME, &error);

  *out_box = create_test_box(*out_runtime, &error);
}

static void cleanup_box(CBoxliteRuntime *runtime, CBoxHandle *box) {
  CBoxliteError error = {0};
  char *id = boxlite_box_id(box);
  boxlite_remove(runtime, id, 1, &error);
  boxlite_free_string(id);
  boxlite_box_free(box);
  boxlite_runtime_free(runtime);
}

/* ── Tests ───────────────────────────────────────────────────────────── */

void test_execute_cmd_basic(void) {
  printf("\nTEST: boxlite_execute basic (command + args)\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxHandle *box = NULL;
  setup_box(&runtime, &box);

  const char *args[] = {"hello"};
  BoxliteCommand cmd = {.command = "/bin/echo",
                        .args = args,
                        .argc = 1,
                        .env_pairs = NULL,
                        .env_count = 0,
                        .workdir = NULL,
                        .user = NULL,
                        .timeout_secs = 0.0};

  reset_capture();
  int exit_code = -1;
  CBoxliteError error = {0};
  BoxliteErrorCode code = test_execute_cmd(box, &cmd, capture_stdout_callback,
                                           NULL, &exit_code, &error);

  if (code != Ok) {
    printf("  ✗ Error executing command: code=%d, message=%s\n", error.code,
           error.message ? error.message : "(null)");
    boxlite_error_free(&error);
  }
  assert(code == Ok);
  assert(exit_code == 0);
  assert(strstr(captured_stdout, "hello") != NULL);
  printf("  ✓ Basic command executed (exit code: %d, stdout: '%s')\n",
         exit_code, captured_stdout);

  cleanup_box(runtime, box);
}

void test_execute_cmd_with_workdir(void) {
  printf("\nTEST: boxlite_execute with workdir\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxHandle *box = NULL;
  setup_box(&runtime, &box);

  BoxliteCommand cmd = {.command = "/bin/pwd",
                        .args = NULL,
                        .argc = 0,
                        .env_pairs = NULL,
                        .env_count = 0,
                        .workdir = "/tmp",
                        .user = NULL,
                        .timeout_secs = 0.0};

  reset_capture();
  int exit_code = -1;
  CBoxliteError error = {0};
  BoxliteErrorCode code = test_execute_cmd(box, &cmd, capture_stdout_callback,
                                           NULL, &exit_code, &error);

  if (code != Ok) {
    printf("  ✗ Error executing command: code=%d, message=%s\n", error.code,
           error.message ? error.message : "(null)");
    boxlite_error_free(&error);
  }
  assert(code == Ok);
  assert(exit_code == 0);
  assert(strstr(captured_stdout, "/tmp") != NULL);
  printf("  ✓ workdir=/tmp verified (stdout: '%s')\n", captured_stdout);

  cleanup_box(runtime, box);
}

void test_execute_cmd_with_env(void) {
  printf("\nTEST: boxlite_execute with env\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxHandle *box = NULL;
  setup_box(&runtime, &box);

  const char *env[] = {"FOO", "bar"};
  BoxliteCommand cmd = {.command = "/usr/bin/env",
                        .args = NULL,
                        .argc = 0,
                        .env_pairs = env,
                        .env_count = 2,
                        .workdir = NULL,
                        .user = NULL,
                        .timeout_secs = 0.0};

  reset_capture();
  int exit_code = -1;
  CBoxliteError error = {0};
  BoxliteErrorCode code = test_execute_cmd(box, &cmd, capture_stdout_callback,
                                           NULL, &exit_code, &error);

  if (code != Ok) {
    printf("  ✗ Error executing command: code=%d, message=%s\n", error.code,
           error.message ? error.message : "(null)");
    boxlite_error_free(&error);
  }
  assert(code == Ok);
  assert(exit_code == 0);
  assert(strstr(captured_stdout, "FOO=bar") != NULL);
  printf("  ✓ env FOO=bar verified (stdout contains FOO=bar)\n");

  cleanup_box(runtime, box);
}

void test_execute_cmd_with_user(void) {
  printf("\nTEST: boxlite_execute with user\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxHandle *box = NULL;
  setup_box(&runtime, &box);

  BoxliteCommand cmd = {.command = "/usr/bin/whoami",
                        .args = NULL,
                        .argc = 0,
                        .env_pairs = NULL,
                        .env_count = 0,
                        .workdir = NULL,
                        .user = "nobody",
                        .timeout_secs = 0.0};

  reset_capture();
  int exit_code = -1;
  CBoxliteError error = {0};
  BoxliteErrorCode code = test_execute_cmd(box, &cmd, capture_stdout_callback,
                                           NULL, &exit_code, &error);

  if (code != Ok) {
    printf("  ✗ Error executing command: code=%d, message=%s\n", error.code,
           error.message ? error.message : "(null)");
    boxlite_error_free(&error);
  }
  assert(code == Ok);
  assert(exit_code == 0);
  assert(strstr(captured_stdout, "nobody") != NULL);
  printf("  ✓ user=nobody verified (stdout: '%s')\n", captured_stdout);

  cleanup_box(runtime, box);
}

void test_execute_cmd_with_timeout(void) {
  printf("\nTEST: boxlite_execute with timeout\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxHandle *box = NULL;
  setup_box(&runtime, &box);

  const char *args[] = {"60"};
  BoxliteCommand cmd = {.command = "/bin/sleep",
                        .args = args,
                        .argc = 1,
                        .env_pairs = NULL,
                        .env_count = 0,
                        .workdir = NULL,
                        .user = NULL,
                        .timeout_secs = 2.0};

  int exit_code = 0;
  CBoxliteError error = {0};
  BoxliteErrorCode code =
      test_execute_cmd(box, &cmd, NULL, NULL, &exit_code, &error);

  /* Timeout may cause non-zero exit or an execution error */
  if (code == Ok) {
    assert(exit_code != 0);
    printf("  ✓ Timeout killed command (exit code: %d)\n", exit_code);
  } else {
    printf("  ✓ Timeout caused execution error (code: %d)\n", code);
    boxlite_error_free(&error);
  }

  cleanup_box(runtime, box);
}

void test_execute_cmd_null_optional_fields(void) {
  printf("\nTEST: boxlite_execute with all optional fields NULL\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxHandle *box = NULL;
  setup_box(&runtime, &box);

  BoxliteCommand cmd = {.command = "/bin/echo",
                        .args = NULL,
                        .argc = 0,
                        .env_pairs = NULL,
                        .env_count = 0,
                        .workdir = NULL,
                        .user = NULL,
                        .timeout_secs = 0.0};

  reset_capture();
  int exit_code = -1;
  CBoxliteError error = {0};
  BoxliteErrorCode code = test_execute_cmd(box, &cmd, capture_stdout_callback,
                                           NULL, &exit_code, &error);

  if (code != Ok) {
    printf("  ✗ Error executing command: code=%d, message=%s\n", error.code,
           error.message ? error.message : "(null)");
    boxlite_error_free(&error);
  }
  assert(code == Ok);
  assert(exit_code == 0);
  printf("  ✓ All-NULL optional fields works (exit code: %d)\n", exit_code);

  cleanup_box(runtime, box);
}

/* ── Main ────────────────────────────────────────────────────────────── */

int main(void) {
  printf("═══════════════════════════════════════\n");
  printf("  BoxLite C SDK - Execute Cmd Tests\n");
  printf("═══════════════════════════════════════\n");

  reset_test_home(COMMAND_TEST_HOME);

  test_execute_cmd_basic();
  test_execute_cmd_with_workdir();
  test_execute_cmd_with_env();
  test_execute_cmd_with_user();
  test_execute_cmd_with_timeout();
  test_execute_cmd_null_optional_fields();

  printf("\n═══════════════════════════════════════\n");
  printf("  ✅ ALL TESTS PASSED (6 tests)\n");
  printf("═══════════════════════════════════════\n");

  reset_test_home(COMMAND_TEST_HOME);

  return 0;
}
