/* Snapshot ABI contracts against a loopback REST server; no VM is started. */
#include "boxlite.h"

#include <arpa/inet.h>
#include <assert.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#define SNAPSHOT                                                               \
  "{\"id\":\"snap-1\",\"box_id\":\"source\",\"name\":\"saved\","               \
  "\"status\":\"ready\",\"created_at\":1,\"container_disk_bytes\":1024,"       \
  "\"size_bytes\":256}"
#define BOX(ID, STATE)                                                         \
  "{\"box_id\":\"" ID "\",\"name\":\"worker\",\"status\":\"" STATE             \
  "\",\"created_at\":\"2026-01-01T00:00:00Z\","                                \
  "\"updated_at\":\"2026-01-01T00:00:00Z\",\"image\":\"base\","                \
  "\"cpus\":2,\"memory_mib\":512}"

typedef struct {
  const char *request;
  int status;
  const char *body;
  const char *required;
  const char *forbidden;
} Route;

static const Route ROUTES[] = {
    {"GET /v1/config HTTP/1.1", 200,
     "{\"capabilities\":{\"snapshots_enabled\":true,"
     "\"create_from_snapshot_enabled\":true}}"},
    {"GET /v1/boxes/source HTTP/1.1", 200, BOX("source", "stopped")},
    {"GET /v1/boxes/child HTTP/1.1", 200, BOX("child", "running")},
    {"GET /v1/snapshots HTTP/1.1", 200, "{\"snapshots\":[" SNAPSHOT "]}"},
    {"GET /v1/snapshots/empty HTTP/1.1", 200,
     "{\"id\":\"empty\",\"box_id\":\"source\",\"name\":\"failed\","
     "\"status\":\"failed\",\"error\":\"disk full\",\"created_at\":2,"
     "\"container_disk_bytes\":1024,\"size_bytes\":0}"},
    {"GET /v1/snapshots/saved HTTP/1.1", 200, SNAPSHOT},
    {"GET /v1/boxes/source/snapshots HTTP/1.1", 200,
     "{\"snapshots\":[" SNAPSHOT "]}"},
    {"GET /v1/boxes/source/snapshots/saved HTTP/1.1", 200, SNAPSHOT},
    {"POST /v1/boxes/source/snapshots HTTP/1.1", 201, SNAPSHOT, "\"name\":"},
    {"POST /v1/boxes/source/snapshots/saved/restore HTTP/1.1", 202,
     "{\"id\":\"restore-1\",\"status\":\"pending\"}"},
    {"GET /v1/boxes/source/restores/restore-1 HTTP/1.1", 200,
     "{\"id\":\"restore-1\",\"status\":\"succeeded\"}"},
    {"DELETE /v1/snapshots/saved HTTP/1.1", 204, ""},
    {"DELETE /v1/boxes/source/snapshots/saved HTTP/1.1", 204, ""},
    {"DELETE /v1/snapshots/protected HTTP/1.1", 403,
     "{\"message\":\"permission denied\"}"},
    {"POST /v1/snapshots/saved/boxes HTTP/1.1", 201, BOX("child", "configured"),
     "\"cpus\":2", "\"image\":"},
};

typedef struct {
  int calls;
  BoxliteErrorCode code;
  CSnapshotInfo *info;
  CSnapshotInfoList *list;
  CBoxHandle *box;
} Seen;

static void record(Seen *seen, const CBoxliteError *error) {
  seen->calls++;
  seen->code = error == NULL ? Ok : error->code;
}

static void on_info(CSnapshotInfo *info, CBoxliteError *error, void *data) {
  Seen *seen = data;
  record(seen, error);
  seen->info = info;
}

static void on_list(CSnapshotInfoList *list, CBoxliteError *error, void *data) {
  Seen *seen = data;
  record(seen, error);
  seen->list = list;
}

static void on_op(CBoxliteError *error, void *data) { record(data, error); }

static void on_box(CBoxHandle *box, CBoxliteError *error, void *data) {
  Seen *seen = data;
  record(seen, error);
  seen->box = box;
}

static void drain(CBoxliteRuntime *runtime, Seen *seen) {
  CBoxliteError error = {0};
  for (int attempt = 0; attempt < 20 && seen->calls == 0; attempt++) {
    assert(boxlite_runtime_drain(runtime, 500, &error) >= 0);
  }
  assert(seen->calls == 1);
  boxlite_error_free(&error);
}

static void write_all(int fd, const char *data, size_t size) {
  while (size > 0) {
    ssize_t written = write(fd, data, size);
    if (written <= 0)
      _exit(10);
    data += written;
    size -= (size_t)written;
  }
}

static int serve_one(int listener) {
  int client = accept(listener, NULL, NULL);
  if (client < 0)
    _exit(11);
  char request[16384] = {0};
  size_t used = 0;
  char *body = NULL;
  size_t content_length = 0;
  while (used < sizeof(request) - 1) {
    ssize_t got = read(client, request + used, sizeof(request) - 1 - used);
    if (got <= 0)
      _exit(12);
    used += (size_t)got;
    body = strstr(request, "\r\n\r\n");
    if (body != NULL) {
      body += 4;
      const char *length = strstr(request, "content-length:");
      if (length == NULL)
        length = strstr(request, "Content-Length:");
      if (length != NULL)
        content_length = strtoul(length + 15, NULL, 10);
      if (used - (size_t)(body - request) >= content_length)
        break;
    }
  }
  if (body == NULL || used - (size_t)(body - request) < content_length)
    _exit(13);
  const Route *route = NULL;
  for (size_t index = 0; index < sizeof(ROUTES) / sizeof(ROUTES[0]); index++) {
    size_t length = strlen(ROUTES[index].request);
    if (strncmp(request, ROUTES[index].request, length) == 0 &&
        strncmp(request + length, "\r\n", 2) == 0)
      route = &ROUTES[index];
  }
  int stop = strncmp(request, "GET /__stop HTTP/1.1\r\n", 22) == 0;
  int status = stop ? 204 : route == NULL ? 404 : route->status;
  const char *reply = stop            ? ""
                      : route == NULL ? "{\"message\":\"missing\"}"
                                      : route->body;
  if (route != NULL &&
      ((route->required != NULL && strstr(body, route->required) == NULL) ||
       (route->forbidden != NULL && strstr(body, route->forbidden) != NULL))) {
    status = 400;
    reply = "{\"message\":\"unexpected snapshot request body\"}";
  }
  if (dprintf(client,
              "HTTP/1.1 %d Response\r\nContent-Type: application/json\r\n"
              "Content-Length: %zu\r\nConnection: close\r\n\r\n",
              status, strlen(reply)) < 0)
    _exit(14);
  write_all(client, reply, strlen(reply));
  close(client);
  return stop;
}

static pid_t start_server(uint16_t *port) {
  int listener = socket(AF_INET, SOCK_STREAM, 0);
  assert(listener >= 0);
  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(0x7f000001U);
  assert(bind(listener, (struct sockaddr *)&address, sizeof(address)) == 0);
  assert(listen(listener, 8) == 0);
  socklen_t length = sizeof(address);
  assert(getsockname(listener, (struct sockaddr *)&address, &length) == 0);
  *port = ntohs(address.sin_port);
  pid_t child = fork();
  assert(child >= 0);
  if (child == 0) {
    alarm(120);
    while (!serve_one(listener)) {
    }
    close(listener);
    _exit(0);
  }
  close(listener);
  return child;
}

static void stop_server(pid_t child, uint16_t port) {
  int client = socket(AF_INET, SOCK_STREAM, 0);
  assert(client >= 0);
  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(0x7f000001U);
  address.sin_port = htons(port);
  assert(connect(client, (struct sockaddr *)&address, sizeof(address)) == 0);
  const char stop[] = "GET /__stop HTTP/1.1\r\nHost: localhost\r\n\r\n";
  write_all(client, stop, sizeof(stop) - 1);
  char response[512];
  while (read(client, response, sizeof(response)) > 0) {
  }
  close(client);
  int status = 0;
  assert(waitpid(child, &status, 0) == child);
  assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
}

static void assert_snapshot(const CSnapshotInfo *info) {
  assert(info != NULL);
  assert(strcmp(info->id, "snap-1") == 0);
  assert(strcmp(info->box_id, "source") == 0);
  assert(strcmp(info->name, "saved") == 0);
  assert(strcmp(info->status, "ready") == 0);
  assert(info->error == NULL);
  assert(info->created_at == 1);
  assert(info->container_disk_bytes == 1024 && info->size_bytes == 256);
}

#define REFUSED(EXPRESSION, EXPECTED)                                          \
  do {                                                                         \
    CBoxliteError refusal = {0};                                               \
    assert((EXPRESSION) == (EXPECTED));                                        \
    assert(refusal.code == (EXPECTED));                                        \
    boxlite_error_free(&refusal);                                              \
  } while (0)

int main(void) {
  assert(setenv("NO_PROXY", "127.0.0.1,localhost", 1) == 0);
  assert(setenv("no_proxy", "127.0.0.1,localhost", 1) == 0);
  uint16_t port = 0;
  pid_t server = start_server(&port);
  /* A uint16_t port fits five decimal digits; leading zeroes are valid. */
  char url[] = "http://127.0.0.1:00000";
  uint16_t digits = port;
  for (size_t position = sizeof(url) - 2; digits > 0; position--) {
    url[position] = (char)('0' + digits % 10);
    digits /= 10;
  }
  CBoxliteError error = {0};
  CBoxliteRestOptions *options = NULL;
  CBoxliteRuntime *runtime = NULL;
  assert(boxlite_rest_options_new(url, &options, &error) == Ok);
  assert(boxlite_rest_runtime_new_with_options(options, &runtime, &error) ==
         Ok);
  boxlite_rest_options_free(options);
  CBoxliteSnapshotHandle *catalog = NULL;
  assert(boxlite_runtime_snapshots(runtime, &catalog, &error) == Ok);
  assert(catalog != NULL);

  Seen source = {0};
  assert(boxlite_get(runtime, "source", on_box, &source, &error) == Ok);
  drain(runtime, &source);
  assert(source.code == Ok && source.box != NULL);
  assert(boxlite_box_name(NULL) == NULL);
  char *source_name = boxlite_box_name(source.box);
  assert(source_name != NULL && strcmp(source_name, "worker") == 0);
  boxlite_free_string(source_name);
  CBoxliteSnapshotHandle *scoped = NULL;
  assert(boxlite_box_snapshots(source.box, &scoped, &error) == Ok);
  assert(scoped != NULL);

  for (int scope = 0; scope < 2; scope++) {
    CBoxliteSnapshotHandle *handle = scope == 0 ? catalog : scoped;
    Seen listed = {0};
    assert(boxlite_snapshot_list(handle, on_list, &listed, &error) == Ok);
    drain(runtime, &listed);
    assert(listed.code == Ok && listed.list != NULL && listed.list->count == 1);
    assert_snapshot(&listed.list->items[0]);
    boxlite_free_snapshot_info_list(listed.list);

    Seen found = {0};
    assert(boxlite_snapshot_get(handle, "saved", on_info, &found, &error) ==
           Ok);
    drain(runtime, &found);
    assert(found.code == Ok);
    assert_snapshot(found.info);
    boxlite_free_snapshot_info(found.info);

    Seen missing = {0};
    assert(boxlite_snapshot_get(handle, "missing", on_info, &missing, &error) ==
           Ok);
    drain(runtime, &missing);
    assert(missing.info == NULL);
    assert(missing.code == (scope == 0 ? NotFound : Ok));

    Seen removed = {0};
    assert(boxlite_snapshot_remove(handle, "missing", 1, on_op, &removed,
                                   &error) == Ok);
    drain(runtime, &removed);
    assert(removed.code == Ok);
    removed = (Seen){0};
    assert(boxlite_snapshot_remove(handle, "missing", 0, on_op, &removed,
                                   &error) == Ok);
    drain(runtime, &removed);
    assert(removed.code == NotFound);
    removed = (Seen){0};
    assert(boxlite_snapshot_remove(handle, "saved", 0, on_op, &removed,
                                   &error) == Ok);
    drain(runtime, &removed);
    assert(removed.code == Ok);
  }

  Seen failed = {0};
  assert(boxlite_snapshot_get(catalog, "empty", on_info, &failed, &error) ==
         Ok);
  drain(runtime, &failed);
  assert(failed.code == Ok && failed.info != NULL);
  assert(strcmp(failed.info->error, "disk full") == 0);
  boxlite_free_snapshot_info(failed.info);
  Seen denied = {0};
  assert(boxlite_snapshot_remove(catalog, "protected", 1, on_op, &denied,
                                 &error) == Ok);
  drain(runtime, &denied);
  assert(denied.code != Ok);

  for (int named = 0; named < 2; named++) {
    Seen created = {0};
    assert(boxlite_snapshot_create(scoped, named ? "saved" : NULL, on_info,
                                   &created, &error) == Ok);
    drain(runtime, &created);
    assert(created.code == Ok);
    assert_snapshot(created.info);
    boxlite_free_snapshot_info(created.info);
  }
  Seen restored = {0};
  assert(boxlite_snapshot_restore(scoped, "saved", on_op, &restored, &error) ==
         Ok);
  drain(runtime, &restored);
  assert(restored.code == Ok);

  Seen local_restore = {0};
  assert(boxlite_box_restore_from_archive(source.box, "/unused.boxlite", on_op,
                                          &local_restore, &error) == Ok);
  drain(runtime, &local_restore);
  assert(local_restore.code == Unsupported);

  CBoxliteOptions *child_options = NULL;
  assert(boxlite_options_new("", &child_options, &error) == Ok);
  boxlite_options_set_cpus(child_options, 2);
  Seen child = {0};
  assert(boxlite_create_box_from_snapshot(runtime, "saved", child_options,
                                          on_box, &child, &error) == Ok);
  drain(runtime, &child);
  assert(child.code == Ok && child.box != NULL);
  char *id = boxlite_box_id(child.box);
  assert(strcmp(id, "child") == 0);
  boxlite_free_string(id);
  boxlite_box_free(child.box);

  CBoxliteSnapshotHandle *invalid = NULL;
  REFUSED(boxlite_runtime_snapshots(NULL, &invalid, &refusal), InvalidArgument);
  REFUSED(boxlite_runtime_snapshots(runtime, NULL, &refusal), InvalidArgument);
  REFUSED(boxlite_box_snapshots(NULL, &invalid, &refusal), InvalidArgument);
  REFUSED(boxlite_box_snapshots(source.box, NULL, &refusal), InvalidArgument);
  REFUSED(boxlite_snapshot_list(NULL, on_list, NULL, &refusal),
          InvalidArgument);
  REFUSED(boxlite_snapshot_list(catalog, NULL, NULL, &refusal),
          InvalidArgument);
  REFUSED(boxlite_snapshot_get(catalog, NULL, on_info, NULL, &refusal),
          InvalidArgument);
  const char invalid_utf8[] = {(char)0xff, 0};
  REFUSED(boxlite_snapshot_get(catalog, invalid_utf8, on_info, NULL, &refusal),
          InvalidArgument);
  REFUSED(
      boxlite_snapshot_create(scoped, invalid_utf8, on_info, NULL, &refusal),
      InvalidArgument);
  REFUSED(boxlite_snapshot_create(catalog, NULL, on_info, NULL, &refusal),
          Unsupported);
  REFUSED(boxlite_snapshot_restore(catalog, "saved", on_op, NULL, &refusal),
          Unsupported);
  REFUSED(boxlite_create_box_from_snapshot(NULL, "saved", NULL, on_box, NULL,
                                           &refusal),
          InvalidArgument);
  REFUSED(boxlite_create_box_from_snapshot(runtime, "saved", NULL, on_box, NULL,
                                           &refusal),
          InvalidArgument);
  assert(boxlite_options_new("", &child_options, &error) == Ok);
  REFUSED(boxlite_create_box_from_snapshot(runtime, "saved", child_options,
                                           NULL, NULL, &refusal),
          InvalidArgument);
  REFUSED(boxlite_create_box_from_snapshot(runtime, NULL, child_options, on_box,
                                           NULL, &refusal),
          InvalidArgument);
  boxlite_options_free(child_options);

  boxlite_runtime_free(runtime);
  REFUSED(boxlite_snapshot_list(catalog, on_list, NULL, &refusal), Stopped);
  REFUSED(boxlite_box_snapshots(source.box, &invalid, &refusal), Stopped);
  boxlite_box_free(source.box);
  boxlite_snapshot_free(scoped);
  boxlite_snapshot_free(catalog);
  boxlite_snapshot_free(NULL);
  boxlite_free_snapshot_info(NULL);
  boxlite_free_snapshot_info_list(NULL);
  stop_server(server, port);
  puts("snapshot native ABI contracts passed");
  return 0;
}
