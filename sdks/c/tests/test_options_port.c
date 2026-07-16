// VM-free FFI test for `boxlite_options_add_port` argument validation.
//
// Mirrors `test_null_callback`: it exercises ONLY the option-builder path —
// no runtime/box is created and no KVM is required — so it runs under
// `ctest -L ffi` without a real VM.
//
// Build & run (after `make dev:c`):
//   cd sdks/c/tests && mkdir -p build && cd build && cmake .. && make && ctest -L ffi -V

#include <stdio.h>
#include "boxlite.h"

static int failures = 0;

#define CHECK(cond, msg) do {                                     \
    if (!(cond)) { fprintf(stderr, "FAIL: %s\n", (msg)); failures++; } \
    else          { printf("ok  : %s\n", (msg)); }                  \
} while (0)

// Free `err` only when a call failed; matches the README convention and keeps
// the test free of double-free concerns across successive assertions.
#define FREE_IF_ERR(code, err) do { if ((code) != Ok) boxlite_error_free(&(err)); } while (0)

int main(void) {
    CBoxliteOptions *opts = NULL;
    CBoxliteError err = {0};

    // Build an options object — no runtime, no VM, no I/O.
    BoxliteErrorCode c = boxlite_options_new("alpine:3.19", &opts, &err);
    CHECK(c == Ok, "boxlite_options_new succeeds");
    if (c != Ok) { boxlite_error_free(&err); return 1; }

    // host_port = 0 means "same as guest_port" (per boxlite.h) — valid.
    err = (CBoxliteError){0};
    c = boxlite_options_add_port(opts, /*host_port*/ 0, /*guest_port*/ 8080,
                                 BoxlitePortProtocolTcp, /*host_ip*/ NULL);
    CHECK(c == Ok, "add_port(host=0, guest=8080, Tcp, NULL) -> Ok");
    FREE_IF_ERR(c, err);

    // Explicit host bind + UDP — valid.
    err = (CBoxliteError){0};
    c = boxlite_options_add_port(opts, 9090, 90, BoxlitePortProtocolUdp, "127.0.0.1");
    CHECK(c == Ok, "add_port(9090, 90, Udp, 127.0.0.1) -> Ok");
    FREE_IF_ERR(c, err);

    // guest_port == 0 is invalid (guest_port required, 1..65535).
    err = (CBoxliteError){0};
    c = boxlite_options_add_port(opts, 0, 0, BoxlitePortProtocolTcp, NULL);
    CHECK(c == InvalidArgument, "add_port guest_port=0 -> InvalidArgument");
    FREE_IF_ERR(c, err);

    // NULL opts must be rejected, not crash.
    err = (CBoxliteError){0};
    c = boxlite_options_add_port(NULL, 8080, 80, BoxlitePortProtocolTcp, NULL);
    CHECK(c == InvalidArgument, "add_port NULL opts -> InvalidArgument");
    FREE_IF_ERR(c, err);

    // Non-UTF-8 host_ip must be rejected (header contract).
    const char bad_utf8[] = { (char)0xff, (char)0xfe, 0 };
    err = (CBoxliteError){0};
    c = boxlite_options_add_port(opts, 8080, 80, BoxlitePortProtocolTcp, bad_utf8);
    CHECK(c == InvalidArgument, "add_port non-UTF-8 host_ip -> InvalidArgument");
    FREE_IF_ERR(c, err);

    // boxlite_options_add_volume returns void; just must not crash on valid input.
    boxlite_options_add_volume(opts, "/tmp/host_share", "/shared", /*read_only*/ 1);
    CHECK(1, "add_volume valid input does not crash");

    boxlite_options_free(opts);
    // `err` is already cleaned up on every failing branch above.

    if (failures) {
        fprintf(stderr, "%d check(s) failed\n", failures);
        return 1;
    }
    printf("all checks passed\n");
    return 0;
}
