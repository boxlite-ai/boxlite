#include "boxlite.h"

#include <arpa/inet.h>
#include <assert.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/* The loopback REST server keeps this unit test VM-free. Its two distinct
 * responses prove boxlite_box_info fetches current metadata instead of
 * replaying the metadata captured when the handle was attached. */

typedef struct GetRequest {
  int done;
  CBoxHandle *box;
  BoxliteErrorCode error_code;
} GetRequest;

typedef struct InfoRequest {
  int done;
  int saw_expected_info;
  BoxliteErrorCode error_code;
} InfoRequest;

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

static void serve_box_response(int listener, const char *body) {
  int client = accept(listener, NULL, NULL);
  if (client < 0) {
    _exit(11);
  }

  char request[4096];
  if (read(client, request, sizeof(request)) <= 0) {
    close(client);
    _exit(12);
  }

  char header[256];
  /* snprintf is bounded here and Annex K's snprintf_s is unavailable on
   * glibc, so keep the explicit truncation check below. */
  // NOLINTNEXTLINE(clang-analyzer-security.insecureAPI.DeprecatedOrUnsafeBufferHandling)
  int header_len = snprintf(header, sizeof(header),
                            "HTTP/1.1 200 OK\r\n"
                            "Content-Type: application/json\r\n"
                            "Content-Length: %lu\r\n"
                            "Connection: close\r\n\r\n",
                            (unsigned long)strlen(body));
  if (header_len <= 0 || (size_t)header_len >= sizeof(header)) {
    close(client);
    _exit(14);
  }
  write_all(client, header, (size_t)header_len);
  write_all(client, body, strlen(body));
  close(client);
}

static pid_t start_info_server(uint16_t *port) {
  int listener = socket(AF_INET, SOCK_STREAM, 0);
  assert(listener >= 0);

  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(0x7f000001U);
  address.sin_port = 0;
  assert(bind(listener, (struct sockaddr *)&address, sizeof(address)) == 0);
  assert(listen(listener, 2) == 0);

  socklen_t address_len = sizeof(address);
  assert(getsockname(listener, (struct sockaddr *)&address, &address_len) == 0);
  *port = ntohs(address.sin_port);

  pid_t child = fork();
  assert(child >= 0);
  if (child == 0) {
    alarm(15);
    const char *attached =
        "{\"box_id\":\"box1\",\"name\":\"demo\",\"status\":\"running\","
        "\"created_at\":\"2026-07-14T00:00:00Z\","
        "\"updated_at\":\"2026-07-14T00:00:00Z\",\"pid\":123,"
        "\"image\":\"alpine:latest\",\"cpus\":1,\"memory_mib\":256}";
    const char *current =
        "{\"box_id\":\"box1\",\"name\":\"demo\",\"status\":\"stopped\","
        "\"created_at\":\"2026-07-14T00:00:00Z\","
        "\"updated_at\":\"2026-07-15T00:00:00Z\",\"pid\":null,"
        "\"image\":\"alpine:latest\",\"cpus\":2,\"memory_mib\":512}";
    serve_box_response(listener, attached);
    serve_box_response(listener, current);
    close(listener);
    _exit(0);
  }

  close(listener);
  return child;
}

static void on_get(CBoxHandle *box, CBoxliteError *error, void *user_data) {
  GetRequest *request = user_data;
  request->box = box;
  request->error_code = error->code;
  request->done = 1;
}

static void on_info(CBoxInfo *info, CBoxliteError *error, void *user_data) {
  InfoRequest *request = user_data;
  request->error_code = error->code;
  if (info != NULL) {
    request->saw_expected_info = strcmp(info->id, "box1") == 0 &&
                                 strcmp(info->status, "stopped") == 0 &&
                                 info->running == 0 && info->pid == 0 &&
                                 info->cpus == 2 && info->memory_mib == 512;
    boxlite_free_box_info(info);
  }
  request->done = 1;
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

int main(void) {
  uint16_t port = 0;
  pid_t server = start_info_server(&port);

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

  GetRequest get_request = {0};
  assert(boxlite_get(runtime, "box1", on_get, &get_request, &error) == Ok);
  assert(!get_request.done);
  drain_until_done(runtime, &get_request.done);
  assert(get_request.error_code == Ok);
  assert(get_request.box != NULL);

  InfoRequest info_request = {0};
  assert(boxlite_box_info(get_request.box, on_info, &info_request, &error) ==
         Ok);
  assert(!info_request.done);
  drain_until_done(runtime, &info_request.done);
  assert(info_request.error_code == Ok);
  assert(info_request.saw_expected_info);

  boxlite_box_free(get_request.box);
  boxlite_runtime_free(runtime);
  boxlite_error_free(&error);

  int server_status = 0;
  assert(waitpid(server, &server_status, 0) == server);
  assert(WIFEXITED(server_status));
  assert(WEXITSTATUS(server_status) == 0);

  printf("boxlite_box_info callback was dispatched with current metadata\n");
  return 0;
}
