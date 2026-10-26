/**
 * BoxLite C SDK - guest SSH control against a real VM.
 *
 * Integration: pulls alpine through the same registry mirrors the Python and
 * Node suites use, boots real guests, and walks the full SSH journey on two
 * boxes: cold observers without a VM, configure/status/reconfigure/repeated
 * disable, and the explicit-main-command refusal that a native start lifts.
 * Everything runs in an isolated /tmp runtime home and disposable ssh-keygen
 * keys; the shared ~/.boxlite database is never touched.
 */

/* mkdtemp is a Darwin extension; expose it alongside the _XOPEN_SOURCE the
 * test binaries are built with. */
#ifndef _DARWIN_C_SOURCE
// System feature-test macro; its reserved spelling is required by Darwin.
// NOLINTNEXTLINE(bugprone-reserved-identifier,cert-dcl37-c,cert-dcl51-cpp)
#define _DARWIN_C_SOURCE
#endif

#include "boxlite.h"

#include <arpa/inet.h>
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#define MIRROR_IMAGE "alpine:3.19"

typedef struct Seen {
  int done;
  BoxliteErrorCode code;
  char message[512];
  int enabled;
  uint64_t generation;
  char listen_address[64];
  char host_public_key[160];
  char host_key_fingerprint[80];
} Seen;

static pthread_t g_cb_thread;
static int g_cb_thread_recorded;

static void report_error(const char *context, const char *message) {
  fputs(context, stderr);
  fputs(": ", stderr);
  fputs(message, stderr);
  fputc('\n', stderr);
}

/* Bounded copy: truncates long sources and always NUL-terminates. */
static void copy_str(char *dst, size_t cap, const char *src) {
  if (src == NULL) {
    dst[0] = '\0';
    return;
  }
  size_t used = 0;
  while (used + 1 < cap && src[used] != '\0') {
    dst[used] = src[used];
    used++;
  }
  dst[used] = '\0';
}

static void on_ssh(CSshStatus *status, CBoxliteError *error, void *user_data) {
  Seen *seen = user_data;
  seen->code = error->code;
  copy_str(seen->message, sizeof(seen->message), error->message);
  if (status != NULL) {
    seen->enabled = status->enabled;
    seen->generation = status->generation;
    copy_str(seen->listen_address, sizeof(seen->listen_address),
             status->listen_address);
    copy_str(seen->host_public_key, sizeof(seen->host_public_key),
             status->host_public_key);
    copy_str(seen->host_key_fingerprint, sizeof(seen->host_key_fingerprint),
             status->host_key_fingerprint);
    boxlite_free_ssh_status(status);
  }
  if (!g_cb_thread_recorded) {
    g_cb_thread = pthread_self();
    g_cb_thread_recorded = 1;
  }
  seen->done = 1;
}

typedef struct BoxSeen {
  int done;
  BoxliteErrorCode code;
  char message[512];
  CBoxHandle *box;
} BoxSeen;

static void on_box(CBoxHandle *box, CBoxliteError *error, void *user_data) {
  BoxSeen *seen = user_data;
  seen->code = error->code;
  copy_str(seen->message, sizeof(seen->message), error->message);
  seen->box = box;
  seen->done = 1;
}

static void on_unit(CBoxliteError *error, void *user_data) {
  BoxSeen *seen = user_data;
  seen->code = error->code;
  copy_str(seen->message, sizeof(seen->message), error->message);
  seen->done = 1;
}

/* Drains on this (the caller's) thread until the slot's callback ran. */
static void drain_until_done(CBoxliteRuntime *runtime, const int *done,
                             const char *what) {
  for (int attempt = 0; attempt < 360 && !*done; attempt++) {
    CBoxliteError error = {0};
    int dispatched = boxlite_runtime_drain(runtime, 500, &error);
    if (dispatched < 0) {
      boxlite_error_free(&error);
      assert(dispatched >= 0);
    }
    boxlite_error_free(&error);
  }
  if (!*done) {
    report_error("timeout waiting for", what);
  }
  assert(*done);
}

typedef struct InfoSeen {
  int done;
  BoxliteErrorCode code;
  char message[512];
  int running;
  int pid;
  char status[32];
} InfoSeen;

static void on_info(CBoxInfo *info, CBoxliteError *error, void *user_data) {
  InfoSeen *seen = user_data;
  seen->code = error->code;
  copy_str(seen->message, sizeof(seen->message), error->message);
  if (info != NULL) {
    seen->running = info->running;
    seen->pid = info->pid;
    copy_str(seen->status, sizeof(seen->status), info->status);
    boxlite_free_box_info(info);
  }
  seen->done = 1;
}

/* Reads a box's info and asserts the VM never started for it. */
static void assert_box_never_started(CBoxliteRuntime *runtime, CBoxHandle *box,
                                     const char *what) {
  InfoSeen seen = {0};
  CBoxliteError error = {0};
  if (boxlite_box_info(box, on_info, &seen, &error) != Ok) {
    boxlite_error_free(&error);
    assert(!"box info was not queued");
  }
  boxlite_error_free(&error);
  drain_until_done(runtime, &seen.done, what);
  if (seen.code != Ok) {
    report_error(what, seen.message);
  }
  assert(seen.code == Ok);
  assert(seen.running == 0);
  assert(seen.pid == 0);
  assert(strcmp(seen.status, "configured") == 0);
}

/* Creates a box and waits for its callback. On Ok the library consumes the
 * options handle (ownership transfers at queue time), so it is freed here
 * only when queueing itself failed. */
static CBoxHandle *create_box(CBoxliteRuntime *runtime, const char *image,
                              const char *const *cmd, int argc) {
  CBoxliteError error = {0};
  CBoxliteOptions *opts = NULL;
  assert(boxlite_options_new(image, &opts, &error) == Ok);
  if (argc > 0) {
    boxlite_options_set_cmd(opts, cmd, argc);
  }
  BoxSeen seen = {0, Ok, {0}, NULL};
  if (boxlite_create_box(runtime, opts, on_box, &seen, &error) != Ok) {
    boxlite_options_free(opts);
    boxlite_error_free(&error);
    assert(!"box create was not queued");
  }
  boxlite_error_free(&error);
  drain_until_done(runtime, &seen.done, "box create");
  if (seen.code != Ok) {
    report_error("box create failed", seen.message);
  }
  assert(seen.code == Ok);
  return seen.box;
}

static void start_box(CBoxliteRuntime *runtime, CBoxHandle *box) {
  BoxSeen seen = {0, Ok, {0}, NULL};
  CBoxliteError error = {0};
  assert(boxlite_start_box(box, on_unit, &seen, &error) == Ok);
  boxlite_error_free(&error);
  drain_until_done(runtime, &seen.done, "box start");
  if (seen.code != Ok) {
    report_error("box start failed", seen.message);
  }
  assert(seen.code == Ok);
}

static Seen ssh_call(CBoxliteRuntime *runtime, CBoxHandle *box, int op,
                     const char *json) {
  Seen seen = {0};
  CBoxliteError error = {0};
  int queued;
  if (op == 0) {
    queued = boxlite_box_ssh_configure(box, json, on_ssh, &seen, &error);
  } else if (op == 1) {
    queued = boxlite_box_ssh_status(box, on_ssh, &seen, &error);
  } else {
    queued = boxlite_box_ssh_disable(box, on_ssh, &seen, &error);
  }
  if (queued != Ok) {
    report_error("queueing failed",
                 error.message ? error.message : "(no message)");
  }
  assert(queued == Ok);
  boxlite_error_free(&error);
  const char *what = op == 0   ? "ssh configure"
                     : op == 1 ? "ssh status"
                               : "ssh disable";
  drain_until_done(runtime, &seen.done, what);
  return seen;
}

static void assert_cold_disabled(const Seen *seen) {
  assert(seen->code == Ok);
  assert(seen->enabled == 0);
  assert(seen->generation == 0);
  assert(seen->listen_address[0] == '\0');
  assert(seen->host_public_key[0] == '\0');
  assert(seen->host_key_fingerprint[0] == '\0');
}

static void assert_enabled(const Seen *seen, uint64_t generation) {
  assert(seen->code == Ok);
  assert(seen->enabled == 1);
  assert(seen->generation == generation);
  assert(strstr(seen->listen_address, ":2222") != NULL);
  assert(strstr(seen->host_public_key, "ssh-") == seen->host_public_key);
  assert(strncmp(seen->host_key_fingerprint, "SHA256:", 7) == 0);
}

static void assert_disabled_keeps_generation(const Seen *seen,
                                             uint64_t generation) {
  assert(seen->code == Ok);
  assert(seen->enabled == 0);
  assert(seen->generation == generation);
  assert(seen->listen_address[0] == '\0');
  assert(seen->host_public_key[0] == '\0');
  assert(seen->host_key_fingerprint[0] == '\0');
}

/* JSON-escapes src into dst (backslash, quote, and control newlines). */
static void json_escape(char *dst, size_t cap, const char *src) {
  size_t out = 0;
  for (const char *p = src; *p != '\0' && out + 7 < cap; p++) {
    if (*p == '\\' || *p == '"') {
      dst[out++] = '\\';
      dst[out++] = *p;
    } else if (*p == '\n') {
      dst[out++] = '\\';
      dst[out++] = 'n';
    } else if (*p == '\r') {
      dst[out++] = '\\';
      dst[out++] = 'r';
    } else if (*p == '\t') {
      dst[out++] = '\\';
      dst[out++] = 't';
    } else {
      dst[out++] = *p;
    }
  }
  dst[out] = '\0';
}

static void read_file(char *dst, size_t cap, const char *path) {
  int fd = open(path, O_RDONLY);
  assert(fd >= 0);
  ssize_t got = read(fd, dst, cap - 1);
  assert(got > 0);
  dst[got] = '\0';
  close(fd);
}

/* Runs ssh-keygen -q -t ed25519 -N "" -C comment -f path. */
static void generate_key(const char *path, const char *comment) {
  pid_t child = fork();
  assert(child >= 0);
  if (child == 0) {
    execlp("ssh-keygen", "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C",
           comment, "-f", path, (char *)NULL);
    _exit(127);
  }
  int status = 0;
  assert(waitpid(child, &status, 0) == child);
  assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
}

static int remove_entry(const char *path, const struct stat *statbuf,
                        int typeflag, struct FTW *ftwbuf) {
  (void)statbuf;
  (void)typeflag;
  (void)ftwbuf;
  return remove(path);
}

static void remove_tree(const char *path) {
  nftw(path, remove_entry, 32, FTW_DEPTH | FTW_PHYS);
}

int main(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
  printf("=== BoxLite C SDK: SSH integration (real VM) ===\n");

  /* Disposable fixtures under /tmp: mkdtemp hands over exclusively created
   * roots, so no preexisting path is ever deleted before it is owned. */
  char keys_dir[] = "/tmp/boxlite-c-ssh-keys-XXXXXX";
  assert(mkdtemp(keys_dir) != NULL);
  char home_dir[] = "/tmp/boxlite-c-ssh-home-XXXXXX";
  assert(mkdtemp(home_dir) != NULL);
  char host_key_path[128], user_key_path[128];
  /* snprintf is bounded here and Annex K's snprintf_s is unavailable on
   * glibc, so keep the explicit truncation checks below. */
  int host_key_len =
      snprintf( // NOLINT(clang-analyzer-security.insecureAPI.DeprecatedOrUnsafeBufferHandling)
          host_key_path, sizeof(host_key_path), "%s/host", keys_dir);
  int user_key_len =
      snprintf( // NOLINT(clang-analyzer-security.insecureAPI.DeprecatedOrUnsafeBufferHandling)
          user_key_path, sizeof(user_key_path), "%s/user", keys_dir);
  assert(host_key_len > 0 && (size_t)host_key_len < sizeof(host_key_path));
  assert(user_key_len > 0 && (size_t)user_key_len < sizeof(user_key_path));
  generate_key(host_key_path, "c-host");
  generate_key(user_key_path, "c-user");
  char host_key[4096] = {0}, user_pub[2048] = {0};
  read_file(host_key, sizeof(host_key), host_key_path);
  char user_pub_path[132];
  int user_pub_len =
      snprintf( // NOLINT(clang-analyzer-security.insecureAPI.DeprecatedOrUnsafeBufferHandling)
          user_pub_path, sizeof(user_pub_path), "%s.pub", user_key_path);
  assert(user_pub_len > 0 && (size_t)user_pub_len < sizeof(user_pub_path));
  read_file(user_pub, sizeof(user_pub), user_pub_path);
  char host_json[8192], user_json[4096];
  json_escape(host_json, sizeof(host_json), host_key);
  json_escape(user_json, sizeof(user_json), user_pub);
  char config_json[13312];
  int config_len =
      snprintf( // NOLINT(clang-analyzer-security.insecureAPI.DeprecatedOrUnsafeBufferHandling)
          config_json, sizeof(config_json),
          "{\"listen_address\":\"0.0.0.0:2222\",\"host_private_key\":\"%s\","
          "\"accounts\":[{\"login\":\"root\",\"authorized_keys\":[\"%s\"]}]}",
          host_json, user_json);
  assert(config_len > 0 && (size_t)config_len < sizeof(config_json));

  /* Same mirrors the Python and Node integration suites use on this host. */
  BoxliteImageRegistry registries[4] = {0};
  const char *hosts[4] = {"docker.m.daocloud.io", "docker.xuanyuan.me",
                          "docker.1ms.run", "docker.io"};
  for (int idx = 0; idx < 4; idx++) {
    registries[idx].host = hosts[idx];
    registries[idx].search = 1;
  }

  printf("keys ready, building runtime\n");
  CBoxliteError error = {0};
  CBoxliteRuntime *runtime = NULL;
  assert(boxlite_runtime_new(home_dir, registries, 4, &runtime, &error) == Ok);
  boxlite_error_free(&error);
  printf("runtime ready, creating box A\n");

  /* Journey A: default command box — observers stay cold, configure boots. */
  CBoxHandle *box = create_box(runtime, MIRROR_IMAGE, NULL, 0);
  printf("box A created, cold observers\n");

  Seen cold_status = ssh_call(runtime, box, 1, NULL);
  assert_cold_disabled(&cold_status);
  printf("  ok: cold status is disabled without a VM\n");
  Seen cold_disable = ssh_call(runtime, box, 2, NULL);
  assert_cold_disabled(&cold_disable);
  printf("  ok: cold disable is disabled and never starts the VM\n");
  assert_box_never_started(runtime, box, "cold observers left the VM stopped");
  printf("  ok: cold observers left the box configured with no VM\n");

  Seen configured = ssh_call(runtime, box, 0, config_json);
  if (configured.code != Ok) {
    report_error("configure failed", configured.message);
  }
  assert_enabled(&configured, 1);
  assert(g_cb_thread_recorded);
  assert(pthread_equal(g_cb_thread, pthread_self()));
  printf(
      "  ok: configure enabled the listener and fired on the drain thread\n");

  Seen status = ssh_call(runtime, box, 1, NULL);
  assert_enabled(&status, 1);
  assert(strcmp(status.host_public_key, configured.host_public_key) == 0);
  printf("  ok: status reports the same listener identity\n");

  Seen reconfigured = ssh_call(runtime, box, 0, config_json);
  assert_enabled(&reconfigured, 2);
  printf("  ok: reconfigure restarted the listener at generation 2\n");

  Seen disabled = ssh_call(runtime, box, 2, NULL);
  assert_disabled_keeps_generation(&disabled, 2);
  Seen disabled_again = ssh_call(runtime, box, 2, NULL);
  assert_disabled_keeps_generation(&disabled_again, 2);
  printf("  ok: disable stopped the listener and stayed idempotent\n");

  boxlite_box_free(box);

  /* Journey B: explicit main command — configure is refused until the
   * native start has a VM to configure. */
  const char *cmd[] = {"sleep", "300", NULL};
  CBoxHandle *guarded = create_box(runtime, MIRROR_IMAGE, cmd, 2);

  Seen refused = ssh_call(runtime, guarded, 0, config_json);
  assert(refused.code == InvalidState);
  assert_box_never_started(runtime, guarded,
                           "refused configure left the VM stopped");
  printf("  ok: configure on an unstarted explicit-cmd box is InvalidState\n");

  start_box(runtime, guarded);
  Seen allowed = ssh_call(runtime, guarded, 0, config_json);
  if (allowed.code != Ok) {
    report_error("configure after start failed", allowed.message);
  }
  assert_enabled(&allowed, 1);
  printf("  ok: configure after a native start enabled the listener\n");

  boxlite_box_free(guarded);
  boxlite_runtime_free(runtime);

  remove_tree(keys_dir);
  remove_tree(home_dir);
  printf("\nAll SSH integration tests passed.\n");
  return 0;
}
