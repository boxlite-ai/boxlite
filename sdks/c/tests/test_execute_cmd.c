/**
 * BoxLite C SDK - Execute Cmd Tests
 *
 * Tests the boxlite_execute_cmd() function with BoxliteCommand struct,
 * covering workdir, env, user, and timeout options.
 */

#include "boxlite.h"
#include "test_runtime.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── Helpers ─────────────────────────────────────────────────────────── */

static char captured_stdout[4096];
static int captured_stdout_len;

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
static void setup_box(const char *test_name, CBoxliteRuntime **out_runtime,
                      CBoxHandle **out_box) {
  CBoxliteError error = {0};
  const char *prefix = "/tmp/boxlite-test-cmd-";
  char temp_dir[256];
  size_t i = 0;
  while (prefix[i] != '\0' && i < sizeof(temp_dir) - 1) {
    temp_dir[i] = prefix[i];
    i++;
  }
  size_t j = 0;
  while (test_name[j] != '\0' && i < sizeof(temp_dir) - 1) {
    temp_dir[i++] = test_name[j++];
  }
  temp_dir[i] = '\0';

  reset_test_home(temp_dir);
  *out_runtime = new_test_runtime(temp_dir, &error);

  const char *options =
      "{\"rootfs\":{\"Image\":\"alpine:3.19\"},\"env\":[],\"volumes\":[],"
      "\"network\":{\"mode\":\"enabled\",\"allow_net\":[]},\"ports\":[],\"auto_"
      "remove\":false}";

  BoxliteErrorCode code =
      boxlite_create_box(*out_runtime, options, out_box, &error);
  if (code != Ok) {
    printf("  ✗ Failed to create box: code=%d, message=%s\n", error.code,
           error.message ? error.message : "(null)");
    boxlite_error_free(&error);
  }
  assert(code == Ok && "Failed to create box");
}

static void cleanup_box(CBoxliteRuntime *runtime, CBoxHandle *box) {
  CBoxliteError error = {0};
  char *id = boxlite_box_id(box);
  boxlite_remove(runtime, id, 1, &error);
  boxlite_free_string(id);
  boxlite_runtime_free(runtime);
}

/* ── Tests ───────────────────────────────────────────────────────────── */

void test_execute_cmd_basic(void) {
  printf("\nTEST: boxlite_execute_cmd basic (command + args)\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxHandle *box = NULL;
  setup_box("basic", &runtime, &box);

  BoxliteCommand cmd = {.command = "/bin/echo",
                        .args_json = "[\"hello\"]",
                        .env_json = NULL,
                        .workdir = NULL,
                        .user = NULL,
                        .timeout_secs = 0.0};

  reset_capture();
  int exit_code = -1;
  CBoxliteError error = {0};
  BoxliteErrorCode code = boxlite_execute_cmd(
      box, &cmd, capture_stdout_callback, NULL, &exit_code, &error);

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
  printf("\nTEST: boxlite_execute_cmd with workdir\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxHandle *box = NULL;
  setup_box("workdir", &runtime, &box);

  BoxliteCommand cmd = {.command = "/bin/pwd",
                        .args_json = NULL,
                        .env_json = NULL,
                        .workdir = "/tmp",
                        .user = NULL,
                        .timeout_secs = 0.0};

  reset_capture();
  int exit_code = -1;
  CBoxliteError error = {0};
  BoxliteErrorCode code = boxlite_execute_cmd(
      box, &cmd, capture_stdout_callback, NULL, &exit_code, &error);

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
  printf("\nTEST: boxlite_execute_cmd with env\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxHandle *box = NULL;
  setup_box("env", &runtime, &box);

  BoxliteCommand cmd = {.command = "/usr/bin/env",
                        .args_json = NULL,
                        .env_json = "[[\"FOO\",\"bar\"]]",
                        .workdir = NULL,
                        .user = NULL,
                        .timeout_secs = 0.0};

  reset_capture();
  int exit_code = -1;
  CBoxliteError error = {0};
  BoxliteErrorCode code = boxlite_execute_cmd(
      box, &cmd, capture_stdout_callback, NULL, &exit_code, &error);

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
  printf("\nTEST: boxlite_execute_cmd with user\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxHandle *box = NULL;
  setup_box("user", &runtime, &box);

  BoxliteCommand cmd = {.command = "/usr/bin/whoami",
                        .args_json = NULL,
                        .env_json = NULL,
                        .workdir = NULL,
                        .user = "nobody",
                        .timeout_secs = 0.0};

  reset_capture();
  int exit_code = -1;
  CBoxliteError error = {0};
  BoxliteErrorCode code = boxlite_execute_cmd(
      box, &cmd, capture_stdout_callback, NULL, &exit_code, &error);

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
  printf("\nTEST: boxlite_execute_cmd with timeout\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxHandle *box = NULL;
  setup_box("timeout", &runtime, &box);

  BoxliteCommand cmd = {.command = "/bin/sleep",
                        .args_json = "[\"60\"]",
                        .env_json = NULL,
                        .workdir = NULL,
                        .user = NULL,
                        .timeout_secs = 2.0};

  int exit_code = 0;
  CBoxliteError error = {0};
  BoxliteErrorCode code =
      boxlite_execute_cmd(box, &cmd, NULL, NULL, &exit_code, &error);

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
  printf("\nTEST: boxlite_execute_cmd with all optional fields NULL\n");

  CBoxliteRuntime *runtime = NULL;
  CBoxHandle *box = NULL;
  setup_box("nullopts", &runtime, &box);

  BoxliteCommand cmd = {.command = "/bin/echo",
                        .args_json = NULL,
                        .env_json = NULL,
                        .workdir = NULL,
                        .user = NULL,
                        .timeout_secs = 0.0};

  reset_capture();
  int exit_code = -1;
  CBoxliteError error = {0};
  BoxliteErrorCode code = boxlite_execute_cmd(
      box, &cmd, capture_stdout_callback, NULL, &exit_code, &error);

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

  test_execute_cmd_basic();
  test_execute_cmd_with_workdir();
  test_execute_cmd_with_env();
  test_execute_cmd_with_user();
  test_execute_cmd_with_timeout();
  test_execute_cmd_null_optional_fields();

  printf("\n═══════════════════════════════════════\n");
  printf("  ✅ ALL TESTS PASSED (6 tests)\n");
  printf("═══════════════════════════════════════\n");

  return 0;
}
