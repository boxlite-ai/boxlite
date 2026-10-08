/**
 * BoxLite C SDK - registry logins through the registry handle.
 *
 * Unit-level (no VM): a local runtime refuses the handle, and a REST runtime
 * is pointed at a loopback server forked here, so every value checked below
 * crossed the FFI from a real response.
 */

#include "boxlite.h"

#include <arpa/inet.h>
#include <assert.h>
#include <ftw.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define LOGIN_ID "0aaa0000-0000-4000-8000-000000000001"
#define PASSWORD "not-a-real-token"
/* 2026-09-01T00:00:00Z in Unix seconds. */
#define CREATED_AT 1788220800LL

#define LOGIN_JSON                                                             \
  "{\"id\":\"" LOGIN_ID "\",\"registry_host\":\"ghcr.io\","                    \
  "\"repository_prefix\":\"acme/\",\"username\":\"acme-bot\","                 \
  "\"created_by\":null,\"created_at\":\"2026-09-01T00:00:00Z\"}"

typedef struct Response {
  const char *request_line;
  /* Text the request body must contain, or NULL. */
  const char *body_contains;
  const char *status;
  const char *body;
} Response;

/* Served in this order, one connection each. */
static const Response ROUTES[] = {
    {"GET /v1/registries HTTP/1.1", NULL, "200 OK",
     "{\"registries\":[" LOGIN_JSON "]}"},
    {"POST /v1/registries HTTP/1.1",
     "\"registry_host\":\"ghcr.io\",\"repository_prefix\":\"acme/\","
     "\"username\":\"acme-bot\",\"password\":\"" PASSWORD "\"",
     "201 Created", LOGIN_JSON},
    {"POST /v1/registries HTTP/1.1", NULL, "409 Conflict",
     "{\"statusCode\":409,\"message\":\"A credential for ghcr.io/acme/ "
     "already exists\",\"code\":\"already_exists\"}"},
    {"DELETE /v1/registries/" LOGIN_ID " HTTP/1.1", NULL, "409 Conflict",
     "{\"statusCode\":409,\"message\":\"cannot be removed while 1 box(es) "
     "pull through it: box-1\"}"},
    {"DELETE /v1/registries/" LOGIN_ID " HTTP/1.1", NULL, "204 No Content", ""},
};
static const size_t ROUTE_COUNT = sizeof(ROUTES) / sizeof(ROUTES[0]);

typedef struct Request {
  /* Set by the caller: text the error message must contain, or NULL. */
  const char *expect_in_message;
  int done;
  BoxliteErrorCode code;
  int message_has_expected;
} Request;

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

/* Reads one whole request and answers it; returns 1 if it was the expected
 * one, with the expected body. */
static int serve_one(int listener, const Response *route) {
  int client = accept(listener, NULL, NULL);
  if (client < 0) {
    _exit(11);
  }

  char request[8192] = {0};
  size_t used = 0;
  char *head_end = NULL;
  while (used < sizeof(request) - 1 &&
         (head_end = strstr(request, "\r\n\r\n")) == NULL) {
    ssize_t got = read(client, request + used, sizeof(request) - 1 - used);
    if (got <= 0) {
      _exit(12);
    }
    used += (size_t)got;
  }
  if (head_end == NULL) {
    _exit(13);
  }
  const char *length_header = strstr(request, "content-length: ");
  size_t body_len =
      length_header && length_header < head_end
          ? (size_t)strtoul(length_header + strlen("content-length: "), NULL,
                            10)
          : 0;
  size_t body_start = (size_t)(head_end - request) + 4;
  while (used < body_start + body_len && used < sizeof(request) - 1) {
    ssize_t got = read(client, request + used, sizeof(request) - 1 - used);
    if (got <= 0) {
      _exit(14);
    }
    used += (size_t)got;
  }

  size_t line_len = strlen(route->request_line);
  int matched = strncmp(request, route->request_line, line_len) == 0 &&
                strncmp(request + line_len, "\r\n", 2) == 0 &&
                (route->body_contains == NULL ||
                 strstr(request + body_start, route->body_contains) != NULL);

  char header[256];
  /* snprintf is bounded here and Annex K's snprintf_s is unavailable on
   * glibc, so keep the explicit truncation check below. */
  // NOLINTNEXTLINE(clang-analyzer-security.insecureAPI.DeprecatedOrUnsafeBufferHandling)
  int header_len = snprintf(header, sizeof(header),
                            "HTTP/1.1 %s\r\n"
                            "Content-Type: application/json\r\n"
                            "Content-Length: %lu\r\n"
                            "Connection: close\r\n\r\n",
                            route->status, (unsigned long)strlen(route->body));
  if (header_len <= 0 || (size_t)header_len >= sizeof(header)) {
    _exit(15);
  }
  write_all(client, header, (size_t)header_len);
  write_all(client, route->body, strlen(route->body));
  close(client);
  return matched;
}

/* Serves the routes in order, then exits 0 only if each matched. */
static pid_t start_server(uint16_t *port) {
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
    int matched = 0;
    for (size_t idx = 0; idx < ROUTE_COUNT; idx++) {
      matched += serve_one(listener, &ROUTES[idx]);
    }
    close(listener);
    _exit(matched == (int)ROUTE_COUNT ? 0 : 20);
  }

  close(listener);
  return child;
}

static void drain_until_done(CBoxliteRuntime *runtime, const int *done) {
  for (int attempt = 0; attempt < 20 && !*done; attempt++) {
    CBoxliteError error = {0};
    int dispatched = boxlite_runtime_drain(runtime, 500, &error);
    boxlite_error_free(&error);
    assert(dispatched >= 0);
  }
  assert(*done);
}

static void record(Request *request, const CBoxliteError *error) {
  request->code = error->code;
  request->message_has_expected =
      request->expect_in_message != NULL && error->message != NULL &&
      strstr(error->message, request->expect_in_message) != NULL;
  request->done = 1;
}

static void assert_is_the_login(const CRegistryCredential *login) {
  assert(strcmp(login->id, LOGIN_ID) == 0);
  assert(strcmp(login->registry_host, "ghcr.io") == 0);
  assert(strcmp(login->repository_prefix, "acme/") == 0);
  assert(strcmp(login->username, "acme-bot") == 0);
  assert(login->created_by == NULL);
  assert(login->created_at == CREATED_AT);
}

static void on_list(CRegistryCredentialList *list, CBoxliteError *error,
                    void *user_data) {
  record(user_data, error);
  if (list == NULL) {
    return;
  }
  assert(list->count == 1);
  assert_is_the_login(&list->items[0]);
  boxlite_free_registry_credential_list(list);
}

static void on_created(CRegistryCredential *login, CBoxliteError *error,
                       void *user_data) {
  record(user_data, error);
  if (login == NULL) {
    return;
  }
  assert_is_the_login(login);
  boxlite_free_registry_credential(login);
}

static void on_removed(CBoxliteError *error, void *user_data) {
  record(user_data, error);
}

static Request list_logins(CBoxliteRuntime *runtime,
                           CBoxliteRegistryHandle *registries) {
  Request request = {0};
  CBoxliteError error = {0};
  assert(boxlite_registry_list(registries, on_list, &request, &error) == Ok);
  drain_until_done(runtime, &request.done);
  return request;
}

static Request create_login(CBoxliteRuntime *runtime,
                            CBoxliteRegistryHandle *registries) {
  Request request = {0};
  CBoxliteError error = {0};
  assert(boxlite_registry_create(registries, "ghcr.io", "acme/", "acme-bot",
                                 PASSWORD, on_created, &request, &error) == Ok);
  drain_until_done(runtime, &request.done);
  return request;
}

static Request remove_login(CBoxliteRuntime *runtime,
                            CBoxliteRegistryHandle *registries, const char *id,
                            const char *expect_in_message) {
  Request request = {.expect_in_message = expect_in_message};
  CBoxliteError error = {0};
  assert(boxlite_registry_remove(registries, id, on_removed, &request,
                                 &error) == Ok);
  drain_until_done(runtime, &request.done);
  return request;
}

/* A create refused synchronously for its password: InvalidArgument, with a
 * message that names the argument and holds none of `secret`. */
static void assert_refused_naming_password(CBoxliteRegistryHandle *registries,
                                           const char *password,
                                           const char *secret) {
  CBoxliteError error = {0};
  assert(boxlite_registry_create(registries, "ghcr.io", NULL, "acme-bot",
                                 password, on_created, NULL,
                                 &error) == InvalidArgument);
  assert(error.code == InvalidArgument);
  assert(error.message != NULL);
  assert(strstr(error.message, "password") != NULL);
  assert(strstr(error.message, secret) == NULL);
  boxlite_error_free(&error);
}

static void test_rest_runtime(void) {
  printf("\nTEST: registry logins on a REST runtime\n");
  uint16_t port = 0;
  pid_t server = start_server(&port);

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
  CBoxliteRegistryHandle *registries = NULL;
  assert(boxlite_runtime_registries(runtime, &registries, &error) == Ok);

  assert(list_logins(runtime, registries).code == Ok);
  printf("  ok: list reads each login\n");
  assert(create_login(runtime, registries).code == Ok);
  printf("  ok: create sends the login in the body and reads it back\n");
  assert(create_login(runtime, registries).code == AlreadyExists);
  printf("  ok: a second login for a held prefix is AlreadyExists\n");
  Request in_use = remove_login(runtime, registries, LOGIN_ID, "box-1");
  assert(in_use.code == InvalidState && in_use.message_has_expected);
  printf("  ok: removing a login in use is InvalidState naming the box\n");
  assert(remove_login(runtime, registries, LOGIN_ID, NULL).code == Ok);
  printf("  ok: remove sends DELETE with the id\n");

  /* Refused before a request: the server has no route left to answer it. */
  assert(remove_login(runtime, registries, "../images", NULL).code ==
         InvalidArgument);
  printf("  ok: an id that is not a UUID is refused without a request\n");

  assert_refused_naming_password(registries, NULL, "(null)");
  /* Not UTF-8: a refusal that echoed it would show the password's bytes. */
  assert_refused_naming_password(registries, "hunter2-\xff\xfe", "hunter2");
  assert(boxlite_registry_remove(registries, LOGIN_ID, NULL, NULL, &error) ==
         InvalidArgument);
  boxlite_error_free(&error);
  printf("  ok: a NULL or non-UTF-8 password and a NULL callback are refused "
         "before queueing, naming the argument without its bytes\n");

  boxlite_registry_free(registries);
  boxlite_runtime_free(runtime);

  int server_status = 0;
  assert(waitpid(server, &server_status, 0) == server);
  assert(WIFEXITED(server_status));
  assert(WEXITSTATUS(server_status) == 0);
}

static int remove_entry(const char *path, const struct stat *statbuf,
                        int typeflag, struct FTW *ftwbuf) {
  (void)statbuf;
  (void)typeflag;
  (void)ftwbuf;
  return remove(path);
}

static void test_local_runtime(void) {
  printf("\nTEST: registry logins on a local runtime\n");
  char home[64];
  /* snprintf is bounded and Annex K's snprintf_s is unavailable on glibc. */
  int home_len =
      snprintf( // NOLINT(clang-analyzer-security.insecureAPI.DeprecatedOrUnsafeBufferHandling)
          home, sizeof(home), "/tmp/boxlite-c-registries-%ld", (long)getpid());
  assert(home_len > 0 && (size_t)home_len < sizeof(home));

  CBoxliteError error = {0};
  CBoxliteRuntime *runtime = NULL;
  assert(boxlite_runtime_new(home, NULL, 0, &runtime, &error) == Ok);

  CBoxliteRegistryHandle *registries = NULL;
  assert(boxlite_runtime_registries(runtime, &registries, &error) ==
         Unsupported);
  assert(registries == NULL);
  assert(error.message != NULL &&
         strstr(error.message, "image_registries") != NULL);
  boxlite_error_free(&error);
  printf("  ok: the handle is Unsupported and names the local option\n");

  boxlite_runtime_free(runtime);
  assert(nftw(home, remove_entry, 32, FTW_DEPTH | FTW_PHYS) == 0);
}

int main(void) {
  printf("=== BoxLite C SDK: registry handle tests ===\n");
  test_rest_runtime();
  test_local_runtime();
  printf("\nAll registry handle tests passed.\n");
  return 0;
}
