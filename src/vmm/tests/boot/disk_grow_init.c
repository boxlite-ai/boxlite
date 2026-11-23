// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

/* Freestanding init for the online disk grow test: it prints the size of vda
 * in sectors, waits until the host grows the disk, prints the new size, and
 * reboots. The host reads both lines from the console. */
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
__attribute__((noreturn)) static void finish(const char *line, word count) {
    print(line, count);
    call(16, 1, 0x5409, 1, 0, 0, 0); /* drain tty */
    call(169, 0xfee1dead, 0x28121969, 0x01234567, 0, 0, 0);
    for (;;) call(34, 0, 0, 0, 0, 0, 0);
}
/* Reads /sys/block/vda/size into text and returns its length. */
static word size(char *text) {
    long fd = call(2, (long)"/sys/block/vda/size", 0, 0, 0, 0, 0);
    if (fd < 0) finish("GROW_FAIL open\n", 15);
    long count = call(0, fd, (long)text, 31, 0, 0, 0);
    call(3, fd, 0, 0, 0, 0, 0);
    if (count <= 0) finish("GROW_FAIL read\n", 15);
    return (word)count;
}
static int same(const char *a, const char *b, word count) {
    for (word i = 0; i < count; i++)
        if (a[i] != b[i]) return 0;
    return 1;
}
__attribute__((used,noreturn)) void run(void) {
    char before[32], after[32];
    call(83, (long)"/sys", 0755, 0, 0, 0, 0);
    if (call(165, (long)"sysfs", (long)"/sys", (long)"sysfs", 0, 0, 0) < 0)
        finish("GROW_FAIL mount\n", 16);
    word first = size(before);
    print("GROW_BEFORE ", 12);
    print(before, first);
    word time[2] = {0, 20000000}; /* 20 ms */
    for (int i = 0; i < 1000; i++) { /* at most 20 s */
        word now = size(after);
        if (now != first || !same(before, after, now)) {
            print("GROW_AFTER ", 11);
            print(after, now);
            finish("GROW_OK\n", 8);
        }
        call(35, (long)time, 0, 0, 0, 0, 0);
    }
    finish("GROW_FAIL timeout\n", 18);
}
__asm__(".global _start\n_start:\n xor %rbp,%rbp\n and $-16,%rsp\n call run\n");
