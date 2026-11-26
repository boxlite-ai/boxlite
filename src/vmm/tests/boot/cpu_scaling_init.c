// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

/* Freestanding CPU scaling init: no shell, libc, or guest service.
 * It plays the guest agent's part through sysfs and prints one marker per
 * step; the host test answers CPU_WAIT_GRANT and CPU_OFFLINED. */
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
static word length(const char *text) { word n = 0; while (text[n]) n++; return n; }
static void print(const char *text) { call(1, 1, (long)text, length(text), 0, 0, 0); }
static void decimal(long value) {
    char text[24]; int at = 23; text[at] = 0;
    int negative = value < 0; word v = negative ? -value : value;
    do { text[--at] = '0' + v % 10; v /= 10; } while (v);
    if (negative) text[--at] = '-';
    print(text + at);
}
__attribute__((noreturn)) static void finish(const char *failure) {
    if (failure) { print("CPU_SCALING_FAIL "); print(failure); print("\n"); }
    else print("CPU_SCALING_OK\n");
    call(16, 1, 0x5409, 1, 0, 0, 0); /* drain tty */
    call(169, 0xfee1dead, 0x28121969, 0x01234567, 0, 0, 0); /* restart */
    for (;;) call(34, 0, 0, 0, 0, 0, 0);
}
static word millis(void) {
    word time[2];
    if (call(228, 1 /* CLOCK_MONOTONIC */, (long)time, 0, 0, 0, 0) < 0) finish("clock");
    return time[0] * 1000 + time[1] / 1000000;
}
static void sleep_millis(word ms) {
    word time[2] = {ms / 1000, (ms % 1000) * 1000000};
    call(35, (long)time, 0, 0, 0, 0, 0);
}
static char path[] = "/sys/devices/system/cpu/cpuN/online";
/* Writes `value` to cpu<cpu>/online; returns 0 or the negative errno. */
static long set_cpu(int cpu, const char *value) {
    path[sizeof("/sys/devices/system/cpu/cpu") - 1] = '0' + cpu;
    long fd = call(2, (long)path, 1 /* O_WRONLY */, 0, 0, 0, 0);
    if (fd < 0) return fd;
    long written = call(1, fd, (long)value, 1, 0, 0, 0);
    call(3, fd, 0, 0, 0, 0, 0);
    return written < 0 ? written : 0;
}
static void show_online(const char *marker) {
    char text[64];
    long fd = call(2, (long)"/sys/devices/system/cpu/online", 0, 0, 0, 0, 0);
    if (fd < 0) finish("open online");
    long count = call(0, fd, (long)text, sizeof(text) - 1, 0, 0, 0);
    call(3, fd, 0, 0, 0, 0, 0);
    if (count <= 0) finish("read online");
    text[count] = 0;
    print(marker); print(" "); print(text);
}
/* Onlines an ungranted CPU as guest root would, and reports how it failed. */
static void bypass(const char *marker, int cpu) {
    word start = millis();
    long result = set_cpu(cpu, "1");
    print(marker); print(" "); decimal(result); print(" "); decimal(millis() - start); print("\n");
}
__attribute__((noreturn)) void run(void) {
    call(83, (long)"/sys", 0755, 0, 0, 0, 0);
    if (call(165, (long)"sysfs", (long)"/sys", (long)"sysfs", 0, 0, 0) < 0) finish("mount");
    show_online("CPU_BOOT");
    bypass("CPU_BYPASS", 3);
    print("CPU_WAIT_GRANT\n");
    for (int cpu = 1; cpu <= 3; cpu++) {
        long result = -1;
        /* The host grants on the marker; retry in case the grant is late. */
        for (int attempt = 0; attempt < 3 && result != 0; attempt++) {
            sleep_millis(1000);
            result = set_cpu(cpu, "1");
        }
        if (result != 0) finish("online after grant");
    }
    show_online("CPU_GROWN");
    for (int cpu = 3; cpu >= 2; cpu--)
        if (set_cpu(cpu, "0") != 0) finish("offline");
    show_online("CPU_OFFLINED");
    sleep_millis(2000); /* the host revokes on the marker */
    bypass("CPU_BYPASS_REVOKED", 3);
    finish(0);
}
/* The kernel enters with a 16-byte aligned stack; align it as a call expects. */
__asm__(".global _start\n_start:\n xor %rbp,%rbp\n and $-16,%rsp\n call run\n");
