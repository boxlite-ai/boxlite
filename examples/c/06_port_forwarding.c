/**
 * BoxLite C SDK - Example 6: host->guest port forwarding + read-only volume.
 *
 * Demonstrates the previously-uncovered option API:
 *   - boxlite_options_add_port (host:8080 -> guest:80, TCP, bind 127.0.0.1)
 *   - boxlite_options_add_volume (/tmp/host_share -> /shared, read-only)
 *
 * Uses example_common.h, which is ported to the post-and-drain callback API.
 * Needs a real BoxLite VM (macOS Hypervisor.framework / Linux KVM).
 *
 * Build & run:
 *   cd examples/c && mkdir -p build && cd build && cmake .. && make && ./06_port_forwarding
 */

#include "example_common.h"
#include <stdio.h>

static void on_output(const char *text, int is_stderr, void *user_data) {
  (void)user_data;
  fputs(text, is_stderr ? stderr : stdout);
}

int main(void) {
  printf("=== BoxLite Example: Port Forwarding + Volume ===\n\n");

  CBoxliteRuntime *runtime = create_runtime_or_exit();
  if (runtime == NULL) return 1;

  // new_alpine_options_or_exit() already enables networking + auto_remove=0.
  CBoxliteOptions *opts = new_alpine_options_or_exit();
  if (opts == NULL) { boxlite_runtime_free(runtime); return 1; }

  // Forward host 127.0.0.1:8080 -> guest :80 (TCP). host_port 0 would auto-pick.
  BoxliteErrorCode code = boxlite_options_add_port(
      opts, /*host*/ 8080, /*guest*/ 80, BoxlitePortProtocolTcp, "127.0.0.1");
  if (code != Ok) {
    fprintf(stderr, "add_port failed (code %d)\n", code);
    boxlite_options_free(opts);
    boxlite_runtime_free(runtime);
    return 1;
  }

  // Read-only host directory mounted at /shared inside the guest.
  boxlite_options_add_volume(opts, "/tmp/host_share", "/shared", /*read_only*/ 1);

  // create_box_with_options_or_exit consumes `opts`.
  CBoxHandle *box = create_box_with_options_or_exit(runtime, opts);
  if (box == NULL) { boxlite_runtime_free(runtime); return 1; }

  char *box_id = boxlite_box_id(box);
  printf("Box %s: host 127.0.0.1:8080 -> guest:80, /shared (ro)\n\n",
         box_id ? box_id : "?");

  int exit_code = 0;
  CBoxliteError error = {0};
  code = execute_and_wait(box, "/bin/hostname", NULL, 0, on_output, NULL,
                          &exit_code, &error);
  if (code != Ok) { print_error("hostname", &error); boxlite_error_free(&error); }
  printf("\n[exit %d]\n", exit_code);

  boxlite_free_string(box_id);
  boxlite_runtime_free(runtime);  // auto-frees the box
  printf("\n=== Done ===\n");
  return 0;
}
