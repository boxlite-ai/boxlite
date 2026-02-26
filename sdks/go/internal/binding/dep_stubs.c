// Weak symbol stubs for native dependencies (libkrun, libgvproxy).
//
// When building with BOXLITE_DEPS_STUB=1, the Rust static library references
// these symbols but they are not linked in. These weak definitions satisfy the
// linker; they are overridden by strong definitions from real libraries in
// production builds.

#include <stdint.h>
#include <stdlib.h>

#ifdef __APPLE__
#define WEAK __attribute__((weak))
#else
#define WEAK __attribute__((weak))
#endif

// libkrun
WEAK int32_t krun_create_ctx(void) { return -1; }
WEAK int32_t krun_free_ctx(uint32_t ctx) { return -1; }
WEAK int32_t krun_set_vm_config(uint32_t ctx, uint8_t cpus, uint32_t mem) { return -1; }
WEAK int32_t krun_set_root(uint32_t ctx, const char* path) { return -1; }
WEAK int32_t krun_set_exec(uint32_t ctx, const char* exec, const char** argv, const char** env) { return -1; }
WEAK int32_t krun_set_env(uint32_t ctx, const char* env) { return -1; }
WEAK int32_t krun_set_workdir(uint32_t ctx, const char* path) { return -1; }
WEAK int32_t krun_set_kernel(uint32_t ctx, const char* path) { return -1; }
WEAK int32_t krun_start_enter(uint32_t ctx) { return -1; }
WEAK int32_t krun_set_console_output(uint32_t ctx, int fd) { return -1; }
WEAK int32_t krun_init_log(uint32_t ctx) { return -1; }
WEAK int32_t krun_add_disk2(uint32_t ctx, const char* path, int ro) { return -1; }
WEAK int32_t krun_add_net_unixgram(uint32_t ctx, const char* path) { return -1; }
WEAK int32_t krun_add_net_unixstream(uint32_t ctx, const char* path) { return -1; }
WEAK int32_t krun_add_virtiofs(uint32_t ctx, const char* tag, const char* path) { return -1; }
WEAK int32_t krun_add_vsock_port2(uint32_t ctx, uint32_t port, const char* path) { return -1; }
WEAK int32_t krun_set_gpu_options(uint32_t ctx, uint32_t opts) { return -1; }
WEAK int32_t krun_set_nested_virt(uint32_t ctx, int nested) { return -1; }
WEAK int32_t krun_set_port_map(uint32_t ctx, const char* map) { return -1; }
WEAK int32_t krun_set_rlimits(uint32_t ctx, const char* rlimits) { return -1; }
WEAK int32_t krun_set_root_disk_remount(uint32_t ctx, int remount) { return -1; }
WEAK int32_t krun_setgid(uint32_t ctx, uint32_t gid) { return -1; }
WEAK int32_t krun_setuid(uint32_t ctx, uint32_t uid) { return -1; }
WEAK int32_t krun_split_irqchip(uint32_t ctx) { return -1; }

// libgvproxy
WEAK void* gvproxy_create(const char* config) { return NULL; }
WEAK void gvproxy_destroy(void* handle) {}
WEAK char* gvproxy_get_stats(void* handle) { return NULL; }
WEAK char* gvproxy_get_version(void) { return NULL; }
WEAK void gvproxy_free_string(char* s) {}
WEAK void gvproxy_set_log_callback(void* cb) {}
