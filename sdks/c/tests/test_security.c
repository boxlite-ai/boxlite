/**
 * BoxLite C SDK - SecurityOptions tests.
 *
 * Two categories:
 *
 * 1. Unit-level (no VM, no I/O): test that the JSON-based security option
 *    setter accepts valid preset JSON and rejects invalid inputs.  These run
 *    without a runtime.
 *
 * 2. Integration (requires VM runtime): create a box with a named preset and
 *    verify it starts and executes a command correctly.
 *
 * The C SDK uses a post-and-drain model: async callbacks are only dispatched
 * when the caller drives `boxlite_runtime_drain`.  The integration test
 * therefore runs a background drain thread for the lifetime of each VM
 * operation so the semaphore-based sync wrappers can block correctly.
 */

/* _GNU_SOURCE is required for nftw(3) on glibc Linux.
 * NOLINT: _GNU_SOURCE starts with underscore (reserved identifier per C std)
 * but it is the idiomatic POSIX/GNU way to enable extension APIs. */
#define _GNU_SOURCE // NOLINT(bugprone-reserved-identifier,cert-dcl37-c,cert-dcl51-cpp)

#include "boxlite.h"
#include <assert.h>
#include <ftw.h>
#include <pthread.h>
#include <semaphore.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* ============================================================================
 * Unit tests — no VM required
 * ========================================================================== */

static void test_security_json_development_preset_accepted(void) {
  printf("\nTEST: SecurityOptions - development preset accepted\n");

  CBoxliteError error = {0};
  CBoxliteOptions *opts = NULL;
  BoxliteErrorCode code = boxlite_options_new("alpine:3.19", &opts, &error);
  assert(code == Ok);
  assert(opts != NULL);

  bool ok =
      boxlite_options_set_security_json(opts, "{\"preset\":\"development\"}");
  assert(ok && "development preset must be accepted");
  printf("  ✓ development preset accepted\n");

  boxlite_options_free(opts);
}

static void test_security_json_standard_preset_accepted(void) {
  printf("\nTEST: SecurityOptions - standard preset accepted\n");

  CBoxliteError error = {0};
  CBoxliteOptions *opts = NULL;
  BoxliteErrorCode code = boxlite_options_new("alpine:3.19", &opts, &error);
  assert(code == Ok);
  assert(opts != NULL);

  bool ok =
      boxlite_options_set_security_json(opts, "{\"preset\":\"standard\"}");
  assert(ok && "standard preset must be accepted");
  printf("  ✓ standard preset accepted\n");

  boxlite_options_free(opts);
}

static void test_security_json_maximum_preset_accepted(void) {
  printf("\nTEST: SecurityOptions - maximum preset accepted\n");

  CBoxliteError error = {0};
  CBoxliteOptions *opts = NULL;
  BoxliteErrorCode code = boxlite_options_new("alpine:3.19", &opts, &error);
  assert(code == Ok);
  assert(opts != NULL);

  bool ok = boxlite_options_set_security_json(opts, "{\"preset\":\"maximum\"}");
  assert(ok && "maximum preset must be accepted");
  printf("  ✓ maximum preset accepted\n");

  boxlite_options_free(opts);
}

static void test_security_json_unknown_preset_rejected(void) {
  printf("\nTEST: SecurityOptions - unknown preset rejected\n");

  CBoxliteError error = {0};
  CBoxliteOptions *opts = NULL;
  BoxliteErrorCode code = boxlite_options_new("alpine:3.19", &opts, &error);
  assert(code == Ok);
  assert(opts != NULL);

  /* Typo: "maximun" instead of "maximum" — must be rejected, not silently
   * fall back to default isolation (which would be a security regression). */
  bool ok = boxlite_options_set_security_json(opts, "{\"preset\":\"maximun\"}");
  assert(!ok && "unknown preset must return false");
  printf("  ✓ typo preset 'maximun' rejected\n");

  boxlite_options_free(opts);
}

static void test_security_json_explicit_fields_accepted(void) {
  printf("\nTEST: SecurityOptions - explicit fields accepted\n");

  CBoxliteError error = {0};
  CBoxliteOptions *opts = NULL;
  BoxliteErrorCode code = boxlite_options_new("alpine:3.19", &opts, &error);
  assert(code == Ok);
  assert(opts != NULL);

  /* Explicit field set: jailer disabled, seccomp disabled, fd limit 256. */
  bool ok = boxlite_options_set_security_json(
      opts, "{\"jailer_enabled\":false,\"seccomp_enabled\":false,"
            "\"resource_limits\":{\"max_open_files\":256}}");
  assert(ok && "explicit security fields must be accepted");
  printf("  ✓ explicit fields accepted\n");

  boxlite_options_free(opts);
}

static void test_security_json_invalid_json_rejected(void) {
  printf("\nTEST: SecurityOptions - invalid JSON rejected\n");

  CBoxliteError error = {0};
  CBoxliteOptions *opts = NULL;
  BoxliteErrorCode code = boxlite_options_new("alpine:3.19", &opts, &error);
  assert(code == Ok);
  assert(opts != NULL);

  bool ok = boxlite_options_set_security_json(opts, "not-valid-json");
  assert(!ok && "invalid JSON must return false");
  printf("  ✓ invalid JSON rejected\n");

  boxlite_options_free(opts);
}

static void test_security_json_unknown_field_rejected(void) {
  printf("\nTEST: SecurityOptions - unknown JSON field rejected\n");

  CBoxliteError error = {0};
  CBoxliteOptions *opts = NULL;
  BoxliteErrorCode code = boxlite_options_new("alpine:3.19", &opts, &error);
  assert(code == Ok);
  assert(opts != NULL);

  /* SecurityOptions uses deny_unknown_fields — typo field names must fail. */
  bool ok =
      boxlite_options_set_security_json(opts, "{\"jailer_enabledXXX\":true}");
  assert(!ok && "unknown field must be rejected (deny_unknown_fields)");
  printf("  ✓ unknown field rejected\n");

  boxlite_options_free(opts);
}

/* ============================================================================
 * Background drain thread
 *
 * The C SDK post-and-drain model requires the caller to drive
 * `boxlite_runtime_drain` to dispatch callbacks.  The integration test uses
 * a dedicated drain thread so that semaphore-based sync wrappers can block
 * on the main thread while callbacks fire on the drain thread.
 * ========================================================================== */

typedef struct {
  CBoxliteRuntime *runtime;
  volatile int stop;
} DrainCtx;

static void *drain_loop(void *arg) {
  DrainCtx *ctx = (DrainCtx *)arg;
  while (!ctx->stop) {
    CBoxliteError error = {0};
    /* Block up to 100 ms waiting for events, then dispatch everything
     * available.  The short timeout ensures we notice ctx->stop promptly. */
    boxlite_runtime_drain(ctx->runtime, 100, &error);
    boxlite_error_free(&error);
  }
  return NULL;
}

/* ============================================================================
 * Integration test helpers — synchronous wrappers around the async C API.
 *
 * The native C SDK API is callback-based (async).  These helpers block the
 * calling thread using POSIX unnamed semaphores until the callback fires.
 * Callbacks are dispatched by the background drain thread (see above).
 * ========================================================================== */

/* --- boxlite_create_box wrapper --- */

typedef struct {
  sem_t done;
  CBoxHandle *box;
} BoxCreateState;

static void on_box_created(CBoxHandle *box,
                           CBoxliteError *err __attribute__((unused)),
                           void *user_data) {
  BoxCreateState *s = (BoxCreateState *)user_data;
  s->box = box;
  sem_post(&s->done);
}

static CBoxHandle *sync_create_box(CBoxliteRuntime *runtime,
                                   CBoxliteOptions *opts,
                                   CBoxliteError *error) {
  BoxCreateState state = {.box = NULL};
  sem_init(&state.done, 0, 0);
  BoxliteErrorCode code =
      boxlite_create_box(runtime, opts, on_box_created, &state, error);
  if (code != Ok) {
    sem_destroy(&state.done);
    return NULL;
  }
  sem_wait(&state.done);
  sem_destroy(&state.done);
  return state.box;
}

/* --- boxlite_start_box wrapper --- */

typedef struct {
  sem_t done;
} BoxStartState;

static void on_box_started(CBoxliteError *err __attribute__((unused)),
                           void *user_data) {
  sem_post(&((BoxStartState *)user_data)->done);
}

static BoxliteErrorCode sync_start_box(CBoxHandle *handle,
                                       CBoxliteError *error) {
  BoxStartState state;
  sem_init(&state.done, 0, 0);
  BoxliteErrorCode code =
      boxlite_start_box(handle, on_box_started, &state, error);
  if (code != Ok) {
    sem_destroy(&state.done);
    return code;
  }
  sem_wait(&state.done);
  sem_destroy(&state.done);
  return Ok;
}

/* --- stdout capture --- */

typedef struct {
  char *buf;
  size_t len;
} StdoutCapture;

static void on_stdout(const uint8_t *data, size_t len, void *user_data) {
  if (data == NULL || len == 0)
    return;
  StdoutCapture *cap = (StdoutCapture *)user_data;
  /* Use a temporary to avoid leaking the original buffer if realloc fails. */
  char *new_buf = realloc(cap->buf, cap->len + len + 1);
  assert(new_buf != NULL);
  cap->buf = new_buf;
  memcpy(cap->buf + cap->len, data, len); // NOLINT: len bytes allocated above
  cap->len += len;
  cap->buf[cap->len] = '\0';
}

/* --- boxlite_execution_wait wrapper --- */

typedef struct {
  sem_t done;
  int exit_code;
} ExecWaitState;

static void on_exec_waited(int exit_code,
                           CBoxliteError *err __attribute__((unused)),
                           void *user_data) {
  ExecWaitState *s = (ExecWaitState *)user_data;
  s->exit_code = exit_code;
  sem_post(&s->done);
}

static int sync_execution_wait(CExecutionHandle *execution,
                               CBoxliteError *error) {
  ExecWaitState state = {.exit_code = -1};
  sem_init(&state.done, 0, 0);
  BoxliteErrorCode code =
      boxlite_execution_wait(execution, on_exec_waited, &state, error);
  if (code != Ok) {
    sem_destroy(&state.done);
    return -1;
  }
  sem_wait(&state.done);
  sem_destroy(&state.done);
  return state.exit_code;
}

/* --- temp dir cleanup --- */

static int remove_tree_entry(const char *path,
                             const struct stat *statbuf __attribute__((unused)),
                             int typeflag __attribute__((unused)),
                             struct FTW *ftwbuf __attribute__((unused))) {
  return remove(path);
}

static void cleanup_dir(const char *dir) {
  struct stat statbuf;
  if (lstat(dir, &statbuf) != 0)
    return;
  nftw(dir, remove_tree_entry, 32, FTW_DEPTH | FTW_PHYS);
}

/* ============================================================================
 * Integration test — requires VM runtime
 * ========================================================================== */

static const BoxliteImageRegistry REGISTRIES[] = {
    {.host = "docker.io",
     .transport = BoxliteRegistryTransportHttps,
     .skip_verify = 0,
     .search = 1,
     .username = NULL,
     .password = NULL,
     .bearer_token = NULL},
};

static void test_security_development_preset_box_starts(void) {
  printf(
      "\nTEST: SecurityOptions - development preset box starts and executes\n");

  /* mkdtemp requires _XOPEN_SOURCE>=700; use snprintf+mkdir+PID instead so
   * the test compiles under -D_XOPEN_SOURCE=500 (clang-tidy default). */
  char temp_dir[64];
  // NOLINTBEGIN(clang-analyzer-security.insecureAPI.DeprecatedOrUnsafeBufferHandling)
  snprintf(temp_dir, sizeof(temp_dir), "/tmp/boxlite_sec_test_%d",
           (int)getpid());
  // NOLINTEND(clang-analyzer-security.insecureAPI.DeprecatedOrUnsafeBufferHandling)
  int mk = mkdir(temp_dir, 0700);
  assert(mk == 0 && "temp dir creation must succeed");
  const char *dir = temp_dir;

  CBoxliteError error = {0};
  CBoxliteRuntime *runtime = NULL;
  BoxliteErrorCode rc =
      boxlite_runtime_new(dir, REGISTRIES, 1, &runtime, &error);
  if (rc != Ok) {
    printf("  ✗ Runtime init failed (code=%d): %s\n", error.code,
           error.message ? error.message : "(null)");
    boxlite_error_free(&error);
    cleanup_dir(dir);
    assert(0 && "runtime_new must succeed");
  }

  /* Start the background drain thread.  Without it, callbacks pushed to the
   * event queue would never be dispatched and sem_wait would block forever. */
  DrainCtx drain_ctx = {.runtime = runtime, .stop = 0};
  pthread_t drain_thread;
  pthread_create(&drain_thread, NULL, drain_loop, &drain_ctx);

  CBoxliteOptions *opts = NULL;
  rc = boxlite_options_new("alpine:3.19", &opts, &error);
  assert(rc == Ok && opts != NULL);
  boxlite_options_set_auto_remove(opts, 0);
  /* Use the development preset (jailer_enabled=false) so the test runs on
   * machines without unprivileged user-namespace support.  The unit tests
   * above already verify that all three preset names are accepted by the
   * API; this integration test only needs to prove the round-trip works. */
  bool sec_ok =
      boxlite_options_set_security_json(opts, "{\"preset\":\"development\"}");
  assert(sec_ok && "development preset must be accepted");

  /* Create box (async). opts ownership transfers on success. */
  CBoxHandle *box = sync_create_box(runtime, opts, &error);
  if (box == NULL) {
    printf("  ✗ create_box failed (code=%d): %s\n", error.code,
           error.message ? error.message : "(null)");
    boxlite_error_free(&error);
    drain_ctx.stop = 1;
    pthread_join(drain_thread, NULL);
    boxlite_runtime_free(runtime);
    cleanup_dir(dir);
    assert(0 && "create_box must succeed");
  }

  /* Start box (async). */
  rc = sync_start_box(box, &error);
  if (rc != Ok) {
    printf("  ✗ start_box failed (code=%d): %s\n", error.code,
           error.message ? error.message : "(null)");
    boxlite_error_free(&error);
    boxlite_box_free(box);
    drain_ctx.stop = 1;
    pthread_join(drain_thread, NULL);
    boxlite_runtime_free(runtime);
    cleanup_dir(dir);
    assert(0 && "start_box must succeed");
  }

  /* Exec a command (sync). */
  const char *args[] = {"security-preset-test"};
  BoxliteCommand cmd = {
      .command = "/bin/echo",
      .args = args,
      .argc = 1,
      .env_pairs = NULL,
      .env_count = 0,
      .workdir = NULL,
      .user = NULL,
      .timeout_secs = 30.0,
      .tty = 0,
  };

  CExecutionHandle *execution = NULL;
  rc = boxlite_box_exec(box, &cmd, &execution, &error);
  if (rc != Ok || execution == NULL) {
    printf("  ✗ box_exec failed (code=%d): %s\n", error.code,
           error.message ? error.message : "(null)");
    boxlite_error_free(&error);
    boxlite_box_free(box);
    drain_ctx.stop = 1;
    pthread_join(drain_thread, NULL);
    boxlite_runtime_free(runtime);
    cleanup_dir(dir);
    assert(0 && "box_exec must succeed");
  }

  /* Capture stdout (dispatched via drain thread). */
  StdoutCapture cap = {.buf = NULL, .len = 0};
  error = (CBoxliteError){0};
  boxlite_execution_on_stdout(execution, on_stdout, &cap, &error);

  /* Wait for exit (async, dispatched via drain thread). */
  error = (CBoxliteError){0};
  int exit_code = sync_execution_wait(execution, &error);
  boxlite_execution_free(execution);

  assert(exit_code == 0);
  assert(cap.buf != NULL && strstr(cap.buf, "security-preset-test") != NULL);
  printf("  ✓ box started with development preset, exec returned: %s\n",
         cap.buf);

  free(cap.buf);
  boxlite_box_free(box);

  /* Stop drain thread before freeing the runtime. */
  drain_ctx.stop = 1;
  pthread_join(drain_thread, NULL);

  boxlite_runtime_free(runtime);
  cleanup_dir(dir);
}

/* ============================================================================
 * main
 * ========================================================================== */

int main(void) {
  printf("=== BoxLite C SDK - SecurityOptions Tests ===\n");

  /* Unit tests (no VM) */
  test_security_json_development_preset_accepted();
  test_security_json_standard_preset_accepted();
  test_security_json_maximum_preset_accepted();
  test_security_json_unknown_preset_rejected();
  test_security_json_explicit_fields_accepted();
  test_security_json_invalid_json_rejected();
  test_security_json_unknown_field_rejected();

  /* Integration tests (VM required) */
  test_security_development_preset_box_starts();

  printf("\n=== All SecurityOptions tests passed ===\n");
  return 0;
}
