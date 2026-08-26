/**
 * BoxLite C SDK — managed-volume FFI surface.
 *
 * Covers the three ABI breaks recorded in the README migration guide, from a
 * real C consumer rather than from Rust:
 *
 *   1. `boxlite_options_add_volume` split into `boxlite_options_add_host_path`
 *      (a path on this machine) and `boxlite_options_add_managed_volume`
 *      (a server-side volume, by id or name).
 *   2. `boxlite_volume_create` gained a `const char *name` second parameter.
 *   3. `CVolumeInfo` gained a `name` member, changing the struct layout.
 *
 * Compiling this file is itself most of the test: a consumer built against the
 * old header would not link. The runtime assertions cover the argument
 * validation that a signature change alone cannot prove.
 */

#include "boxlite.h"
#include <assert.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

static void on_volume_created(struct CVolumeInfo *info, CBoxliteError *error,
                              void *user_data) {
  (void)info;
  (void)error;
  (void)user_data;
}

/* (3) The struct carries a name, and it sits between id and created_at. */
static void test_volume_info_layout(void) {
  struct CVolumeInfo info;
  memset(&info, 0, sizeof(info));

  info.id = NULL;
  info.name = NULL;
  info.created_at = NULL;

  assert(offsetof(struct CVolumeInfo, id) < offsetof(struct CVolumeInfo, name));
  assert(offsetof(struct CVolumeInfo, name) <
         offsetof(struct CVolumeInfo, created_at));
  printf("  ok: CVolumeInfo carries a name field\n");
}

/* (1) Both mount origins are reachable, and neither crashes on a NULL handle.
 */
static void test_mount_origin_entrypoints(void) {
  boxlite_options_add_host_path(NULL, "/host/data", "/data", 0);
  boxlite_options_add_managed_volume(NULL, "my-data", "/data", 0);
  printf(
      "  ok: host-path and managed-volume entrypoints accept a NULL handle\n");
}

/* (2) The name parameter exists, and a NULL handle is still rejected
 * synchronously rather than queueing work against nothing. */
static void test_volume_create_rejects_null_handle(void) {
  CBoxliteError error;
  memset(&error, 0, sizeof(error));

  enum BoxliteErrorCode named =
      boxlite_volume_create(NULL, "my-data", on_volume_created, NULL, &error);
  assert(named == InvalidArgument);

  memset(&error, 0, sizeof(error));
  enum BoxliteErrorCode unnamed =
      boxlite_volume_create(NULL, NULL, on_volume_created, NULL, &error);
  assert(unnamed == InvalidArgument);

  printf(
      "  ok: boxlite_volume_create takes a name and rejects a NULL handle\n");
}

int main(void) {
  printf("test_volume_ffi\n");
  test_volume_info_layout();
  test_mount_origin_entrypoints();
  test_volume_create_rejects_null_handle();
  printf("PASS\n");
  return 0;
}
