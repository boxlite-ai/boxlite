// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

/* Freestanding virtio-mem init: grow, use the new RAM, then shrink. */
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
    if (error) { print("HOTPLUG_FAIL ", 13); number(error); }
    else print("HOTPLUG_GUEST_OK\n", 17);
    call(16, 1, 0x5409, 1, 0, 0, 0); /* drain tty */
    if (error) call(169, 0xfee1dead, 0x28121969, 0x01234567, 0, 0, 0);
    /* On success the host takes a live status sample before stopping the VM. */
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
    return info[4]; /* sysinfo.totalram with mem_unit 1 on x86_64 */
}
/* Waits up to `seconds` for `ready` and returns the last capacity. */
static word wait_for(int (*ready)(word, word), word base, word seconds) {
    word now = capacity();
    for (word i = 0; i < seconds && !ready(now, base); i++) {
        sleep_seconds(1);
        now = capacity();
    }
    return now;
}
static const word MIB = 1UL << 20;
static int grown(word now, word base) { return now >= base + 896 * MIB; }
static int shrunk(word now, word base) { return now <= base + 384 * MIB; }

/* x86_64 pagemap: 4 KiB pages with the PFN in bits 0–54 and present in bit 63. */
static void check_written_gpa(word address, word length) {
    const word page = 4096, pfn_mask = (1UL << 55) - 1;
    check(call(83, (long)"/proc", 0755, 0, 0, 0, 0), 8);
    check(call(165, (long)"proc", (long)"/proc", (long)"proc", 0, 0, 0), 9);
    long fd = call(2, (long)"/proc/self/pagemap", 0, 0, 0, 0, 0);
    check(fd, 10);
    word entries[128], highest = 0, offset = 0;
    for (word first = 0; first < length / page; first += 128) {
        long read = call(17, fd, (long)entries, sizeof(entries),
                         (address / page + first) * sizeof(word), 0, 0);
        if (read != sizeof(entries)) finish(11);
        for (word i = 0; i < 128; i++) {
            word pfn = entries[i] & pfn_mask;
            if ((entries[i] >> 63) && pfn > highest) {
                highest = pfn;
                offset = (first + i) * page;
            }
        }
    }
    if (!highest) finish(12);
    volatile word *sample = (volatile word *)(address + offset);
    *sample = 0xb07117e;
    if (*sample != 0xb07117e) finish(13);
    long read = call(17, fd, (long)entries, sizeof(word),
                     (address + offset) / page * sizeof(word), 0, 0);
    if (read != sizeof(word) || !(entries[0] >> 63) ||
        (entries[0] & pfn_mask) != highest) finish(14);
    check(call(3, fd, 0, 0, 0, 0, 0), 15);
    print("HOTPLUG_GPA ", 12); number(highest * page);
}

__attribute__((used,noreturn)) void run(word argc, const char *const *argv) {
    const char expected[] = "--hotplug-test";
    /* A kernel option after the separator would arrive as an extra argument. */
    if (argc != 2) finish(16);
    for (word i = 0; i < sizeof(expected); i++)
        if (argv[1][i] != expected[i]) finish(16);

    const word use_bytes = 640 * MIB;
    word base = capacity();
    print("HOTPLUG_BASE ", 13); number(base);
    /* The host requests +1024 MiB once it reads the base line. */
    word now = wait_for(grown, base, 30);
    print("HOTPLUG_GROWN ", 14); number(now);
    if (!grown(now, base)) finish(3);
    /* Exercise allocation after the new RAM comes online. */
    long address = call(9, 0, use_bytes, 3, 0x22, -1, 0);
    check(address, 4);
    word *memory = (word *)address;
    for (word i = 0; i < use_bytes / sizeof(word); i++) memory[i] = i ^ 0x5a5a;
    for (word i = 0; i < use_bytes / sizeof(word); i++)
        if (memory[i] != (i ^ 0x5a5a)) finish(5);
    check_written_gpa(address, use_bytes);
    check(call(11, address, use_bytes, 0, 0, 0, 0), 6);
    print("HOTPLUG_USED\n", 13);
    /* The host lowers the target to +256 MiB once it reads the line above. */
    now = wait_for(shrunk, base, 60);
    print("HOTPLUG_SHRUNK ", 15); number(now);
    finish(shrunk(now, base) ? 0 : 7);
}
__asm__(".global _start\n_start:\n xor %rbp,%rbp\n"
        " mov (%rsp),%rdi\n lea 8(%rsp),%rsi\n and $-16,%rsp\n call run\n");
