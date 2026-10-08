/**
 * BoxLite C SDK - image get, remove and usage through the image handle.
 *
 * Unit-level (no VM): a local runtime on an empty home answers from its
 * empty cache, and a REST runtime is pointed at a loopback server forked
 * here, so every value checked below crossed the FFI from a real response.
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

/* 2026-09-01T00:00:00Z and 2026-08-15T12:30:00Z in Unix seconds. */
#define NEWER_RECORDED_AT 1788220800LL
#define OLDER_RECORDED_AT 1786797000LL

typedef struct Response {
  const char *request_line;
  const char *status;
  const char *body;
} Response;

/* The server answers only these exact request lines, so a name sent as
 * three path segments instead of one would get a 404. */
static const Response ROUTES[] = {
    {"GET /v1/images/quay.io%2Facme%2Fapp HTTP/1.1", "200 OK",
     "{\"name\":\"quay.io/acme/app\",\"tags\":[\"v1\",\"v2\"],"
     "\"curated\":true,\"versions\":["
     "{\"digest\":\"sha256:bb\",\"size_bytes\":4096,"
     "\"source_ref\":\"quay.io/acme/app:v2\","
     "\"recorded_at\":\"2026-09-01T00:00:00Z\"},"
     "{\"digest\":\"sha256:aa\",\"size_bytes\":null,"
     "\"source_ref\":\"quay.io/acme/app:v1\","
     "\"recorded_at\":\"2026-08-15T12:30:00Z\"}]}"},
    {"GET /v1/images/usage HTTP/1.1", "200 OK",
     "{\"count\":3,\"limit\":20,\"known_bytes\":8192}"},
    {"DELETE /v1/images/quay.io%2Facme%2Fapp HTTP/1.1", "204 No Content", ""},
};
static const size_t ROUTE_COUNT = sizeof(ROUTES) / sizeof(ROUTES[0]);

static const char NOT_FOUND_BODY[] =
    "{\"error\":{\"message\":\"no route\",\"type\":\"NotFoundError\","
    "\"code\":\"not_found\"}}";

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

/* Reads one request's head and answers it; returns 1 if it matched a route. */
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

  const Response *route = NULL;
  for (size_t idx = 0; idx < ROUTE_COUNT; idx++) {
    size_t line_len = strlen(ROUTES[idx].request_line);
    if (strncmp(request, ROUTES[idx].request_line, line_len) == 0 &&
        strncmp(request + line_len, "\r\n", 2) == 0) {
      route = &ROUTES[idx];
    }
  }
  const char *status = route ? route->status : "404 Not Found";
  const char *body = route ? route->body : NOT_FOUND_BODY;

  char header[256];
  /* snprintf is bounded here and Annex K's snprintf_s is unavailable on
   * glibc, so keep the explicit truncation check below. */
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
  close(client);
  return route != NULL;
}

/* Serves one request per route, then exits 0 only if each matched. */
static pid_t start_catalog_server(uint16_t *port) {
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
      matched += serve_one(listener);
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
    if (dispatched < 0) {
      boxlite_error_free(&error);
      assert(dispatched >= 0);
    }
    boxlite_error_free(&error);
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

static void on_detail(CImageDetail *detail, CBoxliteError *error,
                      void *user_data) {
  Request *request = user_data;
  record(request, error);
  if (detail == NULL) {
    return;
  }

  assert(strcmp(detail->name, "quay.io/acme/app") == 0);
  assert(detail->tags_count == 2);
  assert(strcmp(detail->tags[0], "v1") == 0);
  assert(strcmp(detail->tags[1], "v2") == 0);
  assert(detail->curated == 1);
  assert(detail->versions_count == 2);

  const CImageVersion *newer = &detail->versions[0];
  assert(strcmp(newer->digest, "sha256:bb") == 0);
  assert(newer->has_size == 1 && newer->size_bytes == 4096);
  assert(strcmp(newer->source_ref, "quay.io/acme/app:v2") == 0);
  assert(newer->recorded_at == NEWER_RECORDED_AT);

  const CImageVersion *older = &detail->versions[1];
  assert(strcmp(older->digest, "sha256:aa") == 0);
  assert(older->has_size == 0 && older->size_bytes == 0);
  assert(older->recorded_at == OLDER_RECORDED_AT);

  boxlite_free_image_detail(detail);
}

static void on_usage(CImageUsage *usage, CBoxliteError *error,
                     void *user_data) {
  Request *request = user_data;
  record(request, error);
  if (usage == NULL) {
    return;
  }
  assert(usage->count == 3);
  assert(usage->limit == 20);
  assert(usage->known_bytes == 8192);
}

static void on_removed(CBoxliteError *error, void *user_data) {
  record(user_data, error);
}

static Request get_image(CBoxliteRuntime *runtime, CBoxliteImageHandle *images,
                         const char *name, const char *expect_in_message) {
  Request request = {.expect_in_message = expect_in_message};
  CBoxliteError error = {0};
  assert(boxlite_image_get(images, name, on_detail, &request, &error) == Ok);
  drain_until_done(runtime, &request.done);
  return request;
}

static Request remove_image(CBoxliteRuntime *runtime,
                            CBoxliteImageHandle *images, const char *name,
                            const char *expect_in_message) {
  Request request = {.expect_in_message = expect_in_message};
  CBoxliteError error = {0};
  assert(boxlite_image_remove(images, name, on_removed, &request, &error) ==
         Ok);
  drain_until_done(runtime, &request.done);
  return request;
}

static Request read_usage(CBoxliteRuntime *runtime,
                          CBoxliteImageHandle *images) {
  Request request = {0};
  CBoxliteError error = {0};
  assert(boxlite_image_usage(images, on_usage, &request, &error) == Ok);
  drain_until_done(runtime, &request.done);
  return request;
}

static CBoxliteImageHandle *images_of(CBoxliteRuntime *runtime) {
  CBoxliteImageHandle *images = NULL;
  CBoxliteError error = {0};
  assert(boxlite_runtime_images(runtime, &images, &error) == Ok);
  assert(images != NULL);
  return images;
}

static void test_rest_catalog(void) {
  printf("\nTEST: images on a REST runtime\n");
  uint16_t port = 0;
  pid_t server = start_catalog_server(&port);

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
  CBoxliteImageHandle *images = images_of(runtime);

  assert(get_image(runtime, images, "quay.io/acme/app", NULL).code == Ok);
  printf("  ok: get reads the name, tags, and versions newest first\n");
  assert(read_usage(runtime, images).code == Ok);
  printf("  ok: usage reads count, limit, and known bytes\n");
  assert(remove_image(runtime, images, "quay.io/acme/app", NULL).code == Ok);
  printf("  ok: remove sends DELETE with the name as one segment\n");

  boxlite_image_free(images);
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

static void test_local_cache(void) {
  printf("\nTEST: images on a local runtime with an empty cache\n");
  /* mkdtemp is a Darwin extension under _XOPEN_SOURCE, so take a per-process
   * path instead; the runtime creates the directory. snprintf is bounded and
   * Annex K's snprintf_s is unavailable on glibc. */
  char home[64];
  int home_len =
      snprintf( // NOLINT(clang-analyzer-security.insecureAPI.DeprecatedOrUnsafeBufferHandling)
          home, sizeof(home), "/tmp/boxlite-c-images-%ld", (long)getpid());
  assert(home_len > 0 && (size_t)home_len < sizeof(home));

  CBoxliteError error = {0};
  CBoxliteRuntime *runtime = NULL;
  assert(boxlite_runtime_new(home, NULL, 0, &runtime, &error) == Ok);
  CBoxliteImageHandle *images = images_of(runtime);

  Request got =
      get_image(runtime, images, "quay.io/acme/app", "quay.io/acme/app");
  assert(got.code == NotFound && got.message_has_expected);
  printf("  ok: get of a name the cache does not hold is NotFound\n");

  assert(remove_image(runtime, images, "quay.io/acme/app", NULL).code ==
         NotFound);
  printf("  ok: remove of a name the cache does not hold is NotFound\n");

  Request tagged = remove_image(runtime, images, "quay.io/acme/app:v1",
                                "such as 'quay.io/acme/app'");
  assert(tagged.code == InvalidArgument && tagged.message_has_expected);
  printf("  ok: a tagged reference is refused with the name to pass\n");

  assert(read_usage(runtime, images).code == Unsupported);
  printf("  ok: usage is Unsupported\n");

  assert(boxlite_image_get(images, NULL, on_detail, NULL, &error) ==
         InvalidArgument);
  boxlite_error_free(&error);
  assert(boxlite_image_remove(images, "quay.io/acme/app", NULL, NULL, &error) ==
         InvalidArgument);
  boxlite_error_free(&error);
  printf("  ok: a NULL name or callback is refused before queueing\n");

  boxlite_image_free(images);
  boxlite_runtime_free(runtime);
  assert(nftw(home, remove_entry, 32, FTW_DEPTH | FTW_PHYS) == 0);
}

int main(void) {
  printf("=== BoxLite C SDK: image handle tests ===\n");
  test_rest_catalog();
  test_local_cache();
  printf("\nAll image handle tests passed.\n");
  return 0;
}
