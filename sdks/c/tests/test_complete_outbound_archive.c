#ifndef _DARWIN_C_SOURCE
// NOLINTNEXTLINE(bugprone-reserved-identifier,cert-dcl37-c,cert-dcl51-cpp)
#define _DARWIN_C_SOURCE
#endif

#include "boxlite.h"

#include <assert.h>
#include <ftw.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct Result {
  int done;
  BoxliteErrorCode code;
  CBoxHandle *box;
  char *path;
} Result;

static void on_done(CBoxliteError *error, void *data) {
  Result *result = data;
  if (error->code != Ok) {
    fputs("Archive operation failed: ", stderr);
    fputs(error->message ? error->message : "no details", stderr);
    fputc('\n', stderr);
  }
  result->code = error->code;
  result->done = 1;
}

static void on_box(CBoxHandle *box, CBoxliteError *error, void *data) {
  Result *result = data;
  result->box = box;
  on_done(error, data);
}

static void on_archive(char *path, CBoxliteError *error, void *data) {
  Result *result = data;
  result->path = path;
  on_done(error, data);
}

static void finish(CBoxliteRuntime *runtime, const Result *result) {
  CBoxliteError error = {0};
  for (int attempt = 0; !result->done && attempt < 1800; ++attempt) {
    assert(boxlite_runtime_drain(runtime, 100, &error) >= 0);
    boxlite_error_free(&error);
  }
  assert(result->done && result->code == Ok);
}

static int remove_entry(const char *path, const struct stat *statbuf, int type,
                        struct FTW *walk) {
  (void)statbuf;
  (void)type;
  (void)walk;
  return remove(path);
}

int main(void) {
  char home[] = "/tmp/boxlite-c-outbound-archive-XXXXXX";
  assert(mkdtemp(home) != NULL);
  CBoxliteError error = {0};
  CBoxliteRuntime *runtime = NULL;
  BoxliteImageRegistry mirrors[] = {
      {.host = "docker.m.daocloud.io", .search = 1},
      {.host = "docker.1ms.run", .search = 1},
      {.host = "docker.io", .search = 1}};
  assert(boxlite_runtime_new(home, mirrors, 3, &runtime, &error) == Ok);

  CBoxliteOptions *options = NULL;
  assert(boxlite_options_new("alpine:latest", &options, &error) == Ok);
  boxlite_options_set_auto_remove(options, 0);
  Result created = {0};
  const char *initial = "{\"mode\":\"enabled\",\"deny_net\":[]}";
  assert(boxlite_create_box_with_outbound_policy(
             runtime, options, initial, on_box, &created, &error) == Ok);
  finish(runtime, &created);
  Result started = {0};
  assert(boxlite_start_box(created.box, on_done, &started, &error) == Ok);
  finish(runtime, &started);

  CBoxNetworkHandle *network = NULL;
  assert(boxlite_box_network(created.box, &network, &error) == Ok);
  const char *policy =
      "{\"mode\":\"enabled\",\"allow_net\":[\"api.example.test:443\"],"
      "\"deny_net\":[\"blocked.example.test\"]}";
  char *updated = NULL;
  assert(boxlite_network_replace_outbound_policy(network, NULL, policy,
                                                 &updated, &error) == Ok);
  assert(strstr(updated, "blocked.example.test") != NULL);
  boxlite_free_string(updated);
  boxlite_network_free(network);
  Result stopped = {0};
  assert(boxlite_stop_box(created.box, on_done, &stopped, &error) == Ok);
  finish(runtime, &stopped);

  Result exported = {0}, imported = {0};
  assert(boxlite_box_export(created.box, home, on_archive, &exported, &error) ==
         Ok);
  finish(runtime, &exported);
  assert(boxlite_runtime_import(runtime, exported.path, NULL, on_box, &imported,
                                &error) == Ok);
  finish(runtime, &imported);
  char *source_id = boxlite_box_id(created.box);
  char *restored_id = boxlite_box_id(imported.box);
  assert(strcmp(source_id, restored_id) != 0);
  CBoxNetworkHandle *restored = NULL;
  assert(boxlite_box_network(imported.box, &restored, &error) == Ok);
  char *persisted = NULL;
  assert(boxlite_network_outbound_policy_status(restored, &persisted, &error) ==
         Ok);
  assert(strstr(persisted, "\"allow_net\":[\"api.example.test:443\"]") != NULL);
  assert(strstr(persisted, "\"deny_net\":[\"blocked.example.test\"]") != NULL);
  Result restored_start = {0};
  assert(boxlite_start_box(imported.box, on_done, &restored_start, &error) ==
         Ok);
  finish(runtime, &restored_start);
  char *live = NULL;
  assert(boxlite_network_outbound_policy_status(restored, &live, &error) == Ok);
  assert(strstr(live, "\"application_state\":\"confirmed\"") != NULL);
  assert(strstr(live, "\"deny_net\":[\"blocked.example.test\"]") != NULL);

  Result removed = {0};
  assert(boxlite_remove(runtime, restored_id, 1, on_done, &removed, &error) ==
         Ok);
  finish(runtime, &removed);
  boxlite_free_string(source_id);
  boxlite_free_string(restored_id);
  boxlite_free_string(exported.path);
  boxlite_free_string(persisted);
  boxlite_free_string(live);
  boxlite_network_free(restored);
  boxlite_box_free(created.box);
  boxlite_box_free(imported.box);
  boxlite_runtime_free(runtime);
  assert(nftw(home, remove_entry, 32, FTW_DEPTH | FTW_PHYS) == 0);
  return 0;
}
