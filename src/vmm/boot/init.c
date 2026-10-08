// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

#include <stdio.h>
#include <sys/reboot.h>
#include <unistd.h>

_Noreturn static void fail(const char *operation) {
    perror(operation);
    // Returning from PID 1 panics Linux. Leave failures for the host's timeout.
    for (;;) {
        pause();
    }
}

int main(void) {
    const char marker[] = "BOXLITE_M1_OK\n";

    if (getpid() != 1) {
        fputs("boot test init must run as PID 1\n", stderr);
        return 1;
    }
    if (write(STDOUT_FILENO, marker, sizeof(marker) - 1) != (ssize_t)(sizeof(marker) - 1)) {
        fail("write boot marker");
    }
    sync();
    reboot(RB_AUTOBOOT);
    fail("reboot");
}
