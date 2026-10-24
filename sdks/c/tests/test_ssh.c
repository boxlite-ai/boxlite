/**
 * BoxLite C SDK - guest SSH control through a box handle.
 *
 * Unit-level (no VM): a REST runtime is pointed at a loopback server forked
 * here, so configure, status, repeated disable, reconfigure, and the refusal
 * path all cross the real FFI and HTTP boundary. Argument validation needs no
 * server at all.
 */

#include "boxlite.h"

#include <arpa/inet.h>
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#define HOST_KEY_SENTINEL "C-HOST-KEY-SENTINEL"
#define CONFIG_JSON                                                            \
  "{\"listen_address\":\"0.0.0.0:2222\","                                      \
  "\"host_private_key\":\"C-HOST-KEY-SENTINEL\",\"accounts\":[{"               \
  "\"login\":\"alice\",\"authorized_keys\":[\"ssh-ed25519 AAAAalice\"],"       \
  "\"ca\":{\"public_key\":\"CA-SENTINEL\",\"principal\":\"alice\"}}]}"

typedef struct Response {
  const char *request_line;
  const char *status;
  const char *body;
} Response;

/* The server answers connections in this order; a request line out of order
 * receives a 404, so a mis-sequenced call fails instead of passing silently. */
static const Response ROUTES[] = {
    {"GET /v1/boxes/b1 HTTP/1.1", "200 OK",
     "{\"box_id\":\"b1\",\"name\":\"b1\",\"status\":\"Running\","
     "\"created_at\":\"2026-01-01T00:00:00Z\","
     "\"updated_at\":\"2026-01-01T00:00:00Z\",\"pid\":1,"
     "\"image\":\"alpine:3.19\",\"cpus\":1,\"memory_mib\":256}"},
    {"POST /v1/boxes/b1/ssh HTTP/1.1", "200 OK",
     "{\"enabled\":true,\"generation\":1,\"listen_address\":\"127.0.0.1:2222\","
     "\"host_public_key\":\"ssh-ed25519 AAAAhost\","
     "\"host_key_fingerprint\":\"SHA256:hostfp\"}"},
    {"GET /v1/boxes/b1/ssh HTTP/1.1", "200 OK",
     "{\"enabled\":true,\"generation\":1,\"listen_address\":\"127.0.0.1:2222\","
     "\"host_public_key\":\"ssh-ed25519 AAAAhost\","
     "\"host_key_fingerprint\":\"SHA256:hostfp\"}"},
    {"DELETE /v1/boxes/b1/ssh HTTP/1.1", "200 OK",
     "{\"enabled\":false,\"generation\":1,\"listen_address\":\"\","
     "\"host_public_key\":\"\",\"host_key_fingerprint\":\"\"}"},
    {"DELETE /v1/boxes/b1/ssh HTTP/1.1", "200 OK",
     "{\"enabled\":false,\"generation\":1,\"listen_address\":\"\","
     "\"host_public_key\":\"\",\"host_key_fingerprint\":\"\"}"},
    {"POST /v1/boxes/b1/ssh HTTP/1.1", "200 OK",
     "{\"enabled\":true,\"generation\":2,\"listen_address\":\"0.0.0.0:2223\","
     "\"host_public_key\":\"ssh-ed25519 AAAAother\","
     "\"host_key_fingerprint\":\"SHA256:otherfp\"}"},
    {"POST /v1/boxes/b1/ssh HTTP/1.1", "409 Conflict",
     "{\"error\":{\"message\":\"box b1 is stopped and auto_resume is off\","
     "\"type\":\"InvalidStateError\",\"code\":\"invalid_state\"}}"},
};
static const size_t ROUTE_COUNT = sizeof(ROUTES) / sizeof(ROUTES[0]);

static const char NOT_FOUND_BODY[] =
    "{\"error\":{\"message\":\"unexpected request\",\"type\":\"NotFoundError\","
    "\"code\":\"not_found\"}}";

typedef struct Seen {
  int done;
  BoxliteErrorCode code;
  char message[256];
  /* Copied status fields; enabled and generation as-is. */
  int enabled;
  uint64_t generation;
  char listen_address[64];
  char host_public_key[128];
  char host_key_fingerprint[64];
} Seen;

typedef struct BoxSeen {
  int done;
  BoxliteErrorCode code;
  CBoxHandle *box;
} BoxSeen;

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

static void record(Seen *seen, const CBoxliteError *error) {
  seen->code = error->code;
  copy_str(seen->message, sizeof(seen->message), error->message);
}

static void on_ssh(CSshStatus *status, CBoxliteError *error, void *user_data) {
  Seen *seen = user_data;
  record(seen, error);
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
  seen->done = 1;
}

static void on_box(CBoxHandle *box, CBoxliteError *error, void *user_data) {
  BoxSeen *seen = user_data;
  seen->code = error->code;
  seen->box = box;
  seen->done = 1;
}

static void write_all(int fd, const char *data, size_t len) {
  while (len > 0) {
    ssize_t written = write(fd, data, len);
    if (written <= 0) {
      _exit(10);
    }
    data += written;
    len -= (size_t)written;
  }
}

/* Answers one request; returns 1 when it matched its route and the body
 * carries the host key sentinel. */
static int serve_one(int listener) {
  int client = accept(listener, NULL, NULL);
  if (client < 0) {
    _exit(11);
  }

  char request[4096] = {0};
  size_t used = 0;
  while (used < sizeof(request) - 1 && strstr(request, "\r\n\r\n") == NULL) {
    ssize_t got = read(client, request + used, sizeof(request) - 1 - used);
    if (got <= 0) {
      close(client);
      _exit(12);
    }
    used += (size_t)got;
  }
  /* Read the body, if any; the HTTP stack writes lowercase header names. */
  char *length_header = strstr(request, "content-length:");
  if (length_header != NULL) {
    size_t length = (size_t)strtoul(length_header + 15, NULL, 10);
    size_t have = used - (size_t)(strstr(request, "\r\n\r\n") + 4 - request);
    while (have < length && used < sizeof(request) - 1) {
      ssize_t got = read(client, request + used, sizeof(request) - 1 - used);
      if (got <= 0) {
        break;
      }
      used += (size_t)got;
      have += (size_t)got;
    }
  }

  static size_t next_route = 0;
  const Response *route = &ROUTES[next_route++];
  size_t line_len = strlen(route->request_line);
  int matched = strncmp(request, route->request_line, line_len) == 0 &&
                strncmp(request + line_len, "\r\n", 2) == 0;
  const char *status = matched ? route->status : "404 Not Found";
  const char *body = matched ? route->body : NOT_FOUND_BODY;

  char header[256];
  // snprintf is bounded here and Annex K's snprintf_s is unavailable on
  // glibc, so keep the explicit truncation check below.
  // NOLINTNEXTLINE(clang-analyzer-security.insecureAPI.DeprecatedOrUnsafeBufferHandling)
  int header_len = snprintf(header, sizeof(header),
                            "HTTP/1.1 %s\r\n"
                            "Content-Type: application/json\r\n"
                            "Content-Length: %lu\r\n"
                            "Connection: close\r\n\r\n",
                            status, (unsigned long)strlen(body));
  if (header_len <= 0 || (size_t)header_len >= sizeof(header)) {
    close(client);
    _exit(14);
  }
  write_all(client, header, (size_t)header_len);
  write_all(client, body, strlen(body));
  shutdown(client, SHUT_WR);
  while (used < sizeof(request) - 1) {
    ssize_t got = read(client, request + used, sizeof(request) - 1 - used);
    if (got <= 0) {
      break;
    }
    used += (size_t)got;
  }
  close(client);
  return matched && strstr(request, HOST_KEY_SENTINEL) != NULL;
}

/* Serves one request per route, then exits 0 only if each matched with the
 * sentinel body present on the three configures. */
static pid_t start_ssh_server(uint16_t *port) {
  int listener = socket(AF_INET, SOCK_STREAM, 0);
  assert(listener >= 0);

  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(0x7f000001U);
  address.sin_port = 0;
  assert(bind(listener, (struct sockaddr *)&address, sizeof(address)) == 0);
  assert(listen(listener, 4) == 0);

  socklen_t address_len = sizeof(address);
  assert(getsockname(listener, (struct sockaddr *)&address, &address_len) == 0);
  *port = ntohs(address.sin_port);

  pid_t child = fork();
  assert(child >= 0);
  if (child == 0) {
    alarm(15);
    int sentineled = 0;
    for (size_t idx = 0; idx < ROUTE_COUNT; idx++) {
      sentineled += serve_one(listener);
    }
    close(listener);
    _exit(sentineled == 3 ? 0 : 20);
  }

  close(listener);
  return child;
}

static void drain_until_done(CBoxliteRuntime *runtime, const int *done) {
  for (int attempt = 0; attempt < 20 && !*done; attempt++) {
    CBoxliteError error = {0};
    int dispatched = boxlite_runtime_drain(runtime, 500, &error);
    if (dispatched < 0) {
      boxlite_error_free(&error);
      assert(dispatched >= 0);
    }
    boxlite_error_free(&error);
  }
  assert(*done);
}

static CBoxHandle *attach_box(CBoxliteRuntime *runtime) {
  BoxSeen seen = {0, Ok, NULL};
  CBoxliteError error = {0};
  assert(boxlite_get(runtime, "b1", on_box, &seen, &error) == Ok);
  boxlite_error_free(&error);
  drain_until_done(runtime, &seen.done);
  assert(seen.box != NULL);
  return seen.box;
}

static Seen configure(CBoxliteRuntime *runtime, CBoxHandle *box,
                      const char *json) {
  Seen seen = {0};
  CBoxliteError error = {0};
  assert(boxlite_box_ssh_configure(box, json, on_ssh, &seen, &error) == Ok);
  boxlite_error_free(&error);
  drain_until_done(runtime, &seen.done);
  return seen;
}

static Seen status_of(CBoxliteRuntime *runtime, CBoxHandle *box) {
  Seen seen = {0};
  CBoxliteError error = {0};
  assert(boxlite_box_ssh_status(box, on_ssh, &seen, &error) == Ok);
  boxlite_error_free(&error);
  drain_until_done(runtime, &seen.done);
  return seen;
}

static Seen disable(CBoxliteRuntime *runtime, CBoxHandle *box) {
  Seen seen = {0};
  CBoxliteError error = {0};
  assert(boxlite_box_ssh_disable(box, on_ssh, &seen, &error) == Ok);
  boxlite_error_free(&error);
  drain_until_done(runtime, &seen.done);
  return seen;
}

static void assert_configured(const Seen *seen) {
  assert(seen->code == Ok);
  assert(seen->enabled == 1);
  assert(seen->generation == 1);
  assert(strcmp(seen->listen_address, "127.0.0.1:2222") == 0);
  assert(strcmp(seen->host_public_key, "ssh-ed25519 AAAAhost") == 0);
  assert(strcmp(seen->host_key_fingerprint, "SHA256:hostfp") == 0);
}

static void test_rest_ssh_lifecycle(void) {
  printf("\nTEST: SSH control over a REST runtime\n");
  uint16_t port = 0;
  pid_t server = start_ssh_server(&port);

  char base_url[64];
  /* snprintf is bounded here and Annex K's snprintf_s is unavailable on
   * glibc, so keep the explicit truncation check below. */
  int url_len =
      snprintf( // NOLINT(clang-analyzer-security.insecureAPI.DeprecatedOrUnsafeBufferHandling)
          base_url, sizeof(base_url), "http://127.0.0.1:%u", port);
  assert(url_len > 0 && (size_t)url_len < sizeof(base_url));

  CBoxliteError error = {0};
  CBoxliteRestOptions *options = NULL;
  assert(boxlite_rest_options_new(base_url, &options, &error) == Ok);
  CBoxliteRuntime *runtime = NULL;
  assert(boxlite_rest_runtime_new_with_options(options, &runtime, &error) ==
         Ok);
  boxlite_rest_options_free(options);
  CBoxHandle *box = attach_box(runtime);

  Seen configured = configure(runtime, box, CONFIG_JSON);
  assert_configured(&configured);
  printf("  ok: configure reads the enabled listener status\n");

  Seen status = status_of(runtime, box);
  assert_configured(&status);
  printf("  ok: status observes the same listener\n");

  Seen disabled = disable(runtime, box);
  /* A running guest keeps the last generation when its listener stops. */
  assert(disabled.code == Ok && disabled.enabled == 0 &&
         disabled.generation == 1);
  assert(disabled.listen_address[0] == '\0' &&
         disabled.host_public_key[0] == '\0' &&
         disabled.host_key_fingerprint[0] == '\0');
  Seen disabled_again = disable(runtime, box);
  assert(disabled_again.code == Ok && disabled_again.enabled == 0 &&
         disabled_again.generation == 1);
  printf("  ok: disable is idempotent and reports the disabled status\n");

  Seen reconfigured = configure(runtime, box, CONFIG_JSON);
  assert(reconfigured.code == Ok && reconfigured.generation == 2);
  assert(strcmp(reconfigured.listen_address, "0.0.0.0:2223") == 0);
  printf("  ok: reconfigure after disable reports the new generation\n");

  Seen refused = configure(runtime, box, CONFIG_JSON);
  assert(refused.code == InvalidState);
  assert(strstr(refused.message, "auto_resume is off") != NULL);
  assert(strstr(refused.message, HOST_KEY_SENTINEL) == NULL);
  printf(
      "  ok: a refused startup surfaces InvalidState without key material\n");

  boxlite_box_free(box);
  boxlite_runtime_free(runtime);

  int server_status = 0;
  assert(waitpid(server, &server_status, 0) == server);
  assert(WIFEXITED(server_status));
  assert(WEXITSTATUS(server_status) == 0);
}

static void test_argument_validation(void) {
  printf("\nTEST: SSH argument validation\n");
  CBoxliteError error = {0};
  Seen seen = {0};

  assert(boxlite_box_ssh_configure(NULL, CONFIG_JSON, on_ssh, &seen, &error) ==
         InvalidArgument);
  assert(error.code == InvalidArgument);
  boxlite_error_free(&error);
  assert(boxlite_box_ssh_status(NULL, on_ssh, &seen, &error) ==
         InvalidArgument);
  boxlite_error_free(&error);
  assert(boxlite_box_ssh_disable(NULL, on_ssh, &seen, &error) ==
         InvalidArgument);
  boxlite_error_free(&error);
  printf("  ok: a null handle is refused before queueing\n");

  assert(boxlite_box_ssh_configure(NULL, NULL, on_ssh, &seen, &error) ==
         InvalidArgument);
  boxlite_error_free(&error);
  printf("  ok: a null config body is refused before queueing\n");

  assert(boxlite_box_ssh_configure(NULL, CONFIG_JSON, NULL, &seen, &error) ==
         InvalidArgument);
  boxlite_error_free(&error);
  assert(boxlite_box_ssh_status(NULL, NULL, &seen, &error) == InvalidArgument);
  boxlite_error_free(&error);
  assert(boxlite_box_ssh_disable(NULL, NULL, &seen, &error) == InvalidArgument);
  boxlite_error_free(&error);
  printf("  ok: a null callback is refused without invoking it\n");

  /* Malformed bodies report a constant message; the sentinel names and values
   * inside them must never reach the error. */
  const char *bad_bodies[] = {
      "{\"unknown_field_C-HOST-KEY-SENTINEL\":1}",
      "{\"listen_address\":\"C-HOST-KEY-SENTINEL\"}",
      "not json at all",
  };
  for (size_t idx = 0; idx < sizeof(bad_bodies) / sizeof(bad_bodies[0]);
       idx++) {
    CBoxliteError bad = {0};
    assert(boxlite_box_ssh_configure(NULL, bad_bodies[idx], on_ssh, &seen,
                                     &bad) == InvalidArgument);
    assert(bad.message != NULL);
    assert(strcmp(bad.message, "invalid argument: invalid SSH configuration") ==
           0);
    assert(strstr(bad.message, HOST_KEY_SENTINEL) == NULL);
    boxlite_error_free(&bad);
  }
  printf("  ok: malformed bodies fail with the sanitized constant message\n");

  boxlite_free_ssh_status(NULL);
  printf("  ok: freeing a null status is a no-op\n");
}

int main(void) {
  printf("=== BoxLite C SDK: SSH control tests ===\n");
  test_argument_validation();
  test_rest_ssh_lifecycle();
  printf("\nAll SSH control tests passed.\n");
  return 0;
}
