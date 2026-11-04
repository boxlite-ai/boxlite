// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

/* Freestanding KVM qualification init: no shell, libc, or guest service. */
typedef unsigned long word;
static long call(long n, long a, long b, long c, long d, long e, long f) {
    register long r10 __asm__("r10") = d;
    register long r8 __asm__("r8") = e;
    register long r9 __asm__("r9") = f;
    long result;
    __asm__ volatile("syscall" : "=a"(result) : "a"(n), "D"(a), "S"(b), "d"(c),
                     "r"(r10), "r"(r8), "r"(r9) : "rcx", "r11", "memory");
    return result;
}
static void print(const char *text, word count) {
    call(1, 1, (long)text, count, 0, 0, 0);
}
static void number(word value) {
    char text[19] = "0x0000000000000000\n";
    for (unsigned i = 0; i < 16; i++)
        text[17-i] = "0123456789abcdef"[(value >> (4*i)) & 15];
    print(text, sizeof(text));
}
__attribute__((noreturn)) static void finish(unsigned error) {
    if (error) { print("BALLOON_FAIL ", 13); number(error); }
    else print("BALLOON_GUEST_OK\n", 17);
    call(16, 1, 0x5409, 1, 0, 0, 0); /* drain tty */
    call(169, 0xfee1dead, 0x28121969, 0x01234567, 0, 0, 0);
    for (;;) call(34, 0, 0, 0, 0, 0, 0);
}
static void check(long value, unsigned error) { if (value < 0) finish(error); }
static void sleep_seconds(word seconds) {
    word time[2] = {seconds, 0};
    check(call(35, (long)time, 0, 0, 0, 0, 0), 1);
}
static word capacity(void) {
    word info[16];
    check(call(99, (long)info, 0, 0, 0, 0, 0), 2);
    return info[4]; /* sysinfo.totalram; compare in the same guest */
}
static word *allocate(word bytes) {
    long address = call(9, 0, bytes, 3, 0x22, -1, 0);
    check(address, 3);
    return (word *)address;
}
static void fill(word *memory, word bytes, word seed) {
    for (word i = 0; i < bytes / sizeof(word); i++) memory[i] = seed ^ i;
}
static void verify(word *memory, word bytes, word seed) {
    for (word i = 0; i < bytes / sizeof(word); i++)
        if (memory[i] != (seed ^ i)) finish(4);
}
static void driver_file(const char *path, unsigned error) {
    long fd = call(2, (long)path, 1, 0, 0, 0, 0);
    check(fd, error);
    if (call(1, fd, (long)"virtio0", 7, 0, 0, 0) != 7) finish(error);
    check(call(3, fd, 0, 0, 0, 0, 0), error);
}
__attribute__((used,noreturn)) void run(void) {
    const word scratch_bytes = 64UL << 20, live_bytes = 16UL << 20;
    check(call(83, (long)"/proc", 0755, 0, 0, 0, 0), 8);
    check(call(165, (long)"proc", (long)"/proc", (long)"proc", 0, 0, 0), 9);
    check(call(83, (long)"/sys", 0755, 0, 0, 0, 0), 10);
    check(call(165, (long)"sysfs", (long)"/sys", (long)"sysfs", 0, 0, 0), 11);
    sleep_seconds(4); /* allow initial reporting to settle */
    word before = capacity();
    print("BALLOON_CAPACITY ", 17); number(before);
    word *scratch = allocate(scratch_bytes), *live = allocate(live_bytes);
    fill(scratch, scratch_bytes, 0xa5a55a5a);
    fill(live, live_bytes, 0x3cc3c33c);
    /* Hold every touched page resident long enough for the host's sampler. */
    print("BALLOON_TOUCHED\n", 16);
    sleep_seconds(2);
    check(call(11, (long)scratch, scratch_bytes, 0, 0, 0, 0), 14);
    print("BALLOON_FREED\n", 14);
    /* Long enough for the guest to report and the host to sample the result; */
    /* no handshake is needed, so a slow host cannot turn into a failure. */
    sleep_seconds(6);
    verify(live, live_bytes, 0x3cc3c33c);
    if (capacity() != before) finish(16);
    verify(live, live_bytes, 0x3cc3c33c);
    scratch = allocate(scratch_bytes);
    /* Anonymous pages must be reusable, and initialized again by Linux. */
    for (word i = 0; i < scratch_bytes / sizeof(word); i++)
        if (scratch[i] != 0) finish(17);
    fill(scratch, scratch_bytes, 0xdeadbeef);
    verify(scratch, scratch_bytes, 0xdeadbeef);
    verify(live, live_bytes, 0x3cc3c33c);
    print("BALLOON_REUSED\n", 15);
    driver_file("/sys/bus/virtio/drivers/virtio_balloon/unbind", 18);
    driver_file("/sys/bus/virtio/drivers/virtio_balloon/bind", 19);
    sleep_seconds(3);
    if (capacity() != before) finish(20);
    verify(live, live_bytes, 0x3cc3c33c);
    verify(scratch, scratch_bytes, 0xdeadbeef);
    finish(0);
}
__asm__(".global _start\n_start:\n xor %rbp,%rbp\n and $-16,%rsp\n call run\n");
