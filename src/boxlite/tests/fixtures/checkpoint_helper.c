/*
 * Guest workload for the checkpoint acceptance test (checkpoint_acceptance.rs).
 *
 * Usage: checkpoint_helper <disk-dir> <share-dir>
 *
 * Holds state that only a continued process has: a random marker generated at
 * start and kept only in heap memory, a counter, open files on the container
 * disk (including an unlinked file) and linked files on a virtio-fs share,
 * and a MAP_SHARED
 * mapping of a share file, which must be a DAX file. Every tick it checks that
 * each file and the mapping still hold exactly the value it wrote last, writes
 * the next value and prints
 *
 *   tick pid=<pid> marker=<hex> n=<counter> dax=0|1 state=ok|bad:<what>
 *
 * where dax is the mapped file's STATX_ATTR_DAX.
 *
 * Before printing tick n it atomically stores n as a little-endian u64 at
 * byte WATERMARK of the mapping, so the host can read a counter that no
 * printed tick exceeds from the share while the box is paused: an aligned
 * 8-byte store never tears across a pause.
 *
 * A re-executed process prints a new marker and PID; restored files that
 * carry writes the source made after the checkpoint cut (or lack ones made
 * before it) print state=bad. Build: make test:checkpoint:helper.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#ifndef STATX_ATTR_DAX
#define STATX_ATTR_DAX 0x00200000
#endif

#define SLOT 64
#define MAP_LEN (2 * 4096)
/* Past the first slot, inside the first page. */
#define WATERMARK 128

static void die(const char *what) {
    printf("fatal %s: %s\n", what, strerror(errno));
    fflush(stdout);
    exit(1);
}

static int open_file(const char *dir, const char *name, int unlink_it) {
    char path[4096];
    snprintf(path, sizeof(path), "%s/%s", dir, name);
    int fd = open(path, O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (fd < 0)
        die(path);
    if (unlink_it && unlink(path) != 0)
        die(path);
    return fd;
}

/* Each file and the mapping hold one fixed-size slot: "<tag> <counter>". */
static void format_slot(char *slot, const char *tag, unsigned long long n) {
    memset(slot, 0, SLOT);
    snprintf(slot, SLOT, "%s %llu", tag, n);
}

static int write_slot(int fd, const char *tag, unsigned long long n) {
    char slot[SLOT];
    format_slot(slot, tag, n);
    return pwrite(fd, slot, SLOT, 0) == SLOT && fdatasync(fd) == 0;
}

static int slot_matches(int fd, const char *tag, unsigned long long n) {
    char want[SLOT], got[SLOT];
    format_slot(want, tag, n);
    return pread(fd, got, SLOT, 0) == SLOT && memcmp(want, got, SLOT) == 0;
}

static int is_dax(const char *path) {
    struct statx stx;
    if (statx(AT_FDCWD, path, 0, STATX_BASIC_STATS, &stx) != 0)
        die("statx");
    return (stx.stx_attributes_mask & STATX_ATTR_DAX) && (stx.stx_attributes & STATX_ATTR_DAX);
}

/* Print the mount line that holds <dir>, so the test sees the share's options. */
static void print_mount(const char *dir) {
    FILE *f = fopen("/proc/self/mountinfo", "r");
    char line[4096], best[4096] = "";
    size_t best_len = 0;
    if (!f)
        die("mountinfo");
    while (fgets(line, sizeof(line), f)) {
        char mount_point[4096];
        if (sscanf(line, "%*s %*s %*s %*s %4095s", mount_point) != 1)
            continue;
        size_t len = strlen(mount_point);
        if (strncmp(dir, mount_point, len) == 0 && (dir[len] == '/' || dir[len] == 0 || len == 1) &&
            len >= best_len) {
            best_len = len;
            snprintf(best, sizeof(best), "%s", line);
        }
    }
    fclose(f);
    best[strcspn(best, "\n")] = 0;
    printf("mount %s\n", best);
}

/* Aligned O_DIRECT avoids the page cache. DAX setupmapping resolves an inode
 * without consulting its handle, so fsync probes the independent handle
 * table. A control file on the container disk starts probes after import. */
static int missing_orphans(const char *disk, const char *share) {
    const char *names[] = {"whole.dat", "handle.dat", "normal.dat"};
    int fds[6];
    off_t positions[2] = {4096, 8192};
    char path[4096], probe[4096];
    void *buffer = NULL;
    if (posix_memalign(&buffer, 4096, 4096) != 0)
        die("aligned buffer");
    memset(buffer, 'Q', 4096);
    for (int i = 0; i < 3; i++) {
        snprintf(path, sizeof(path), "%s/%s", share, names[i]);
        fds[i] = open(path, O_RDWR | O_DIRECT);
        if (fds[i] < 0)
            die("direct file setup");
        if (i == 2) {
            fds[3] = open(path, O_RDWR | O_DIRECT | O_DSYNC);
            if (fds[3] < 0)
                die("second independent handle");
            for (int j = 0; j < 2; j++) {
                fds[4 + j] = open(path, O_RDONLY | O_DIRECT);
                if (fds[4 + j] < 0 || lseek(fds[4 + j], positions[j], SEEK_SET) != positions[j])
                    die("independent position setup");
            }
        }
        if (i < 2 && unlink(path) != 0)
            die("unlink direct file");
    }
    int mapped = open_file(share, "mapped.dat", 0);
    if (ftruncate(mapped, MAP_LEN) != 0)
        die("mapped truncate");
    char *map = mmap(NULL, MAP_LEN, PROT_READ | PROT_WRITE, MAP_SHARED, mapped, 0);
    if (map == MAP_FAILED)
        die("mapped mmap");
    map[0] = 'M';
    uint64_t *watermark = (uint64_t *)(map + WATERMARK);
    __atomic_store_n(watermark, 0, __ATOMIC_SEQ_CST);
    if (msync(map, MAP_LEN, MS_SYNC) != 0)
        die("mapped sync");
    close(mapped);
    snprintf(probe, sizeof(probe), "%s/probe", disk);
    printf("ready pid=%d\n", getpid());
    unsigned long long n = 0;
    for (;;) {
        if (access(probe, F_OK) == 0) {
            errno = 0;
            ssize_t r = pread(fds[0], buffer, 4096, 0);
            int re = errno;
            errno = 0;
            ssize_t w = pwrite(fds[0], buffer, 4096, 0);
            int we = errno;
            printf("missing whole.dat read=%zd errno=%d write=%zd errno=%d\n", r, re, w, we);
            if (r != -1 || re != EBADF || w != -1 || we != EBADF)
                die("missing descriptor did not return EBADF");
            errno = 0;
            int sync = fsync(fds[1]);
            int se = errno;
            printf("missing handle.dat fsync=%d errno=%d\n", sync, se);
            if (sync != -1 || se != EBADF)
                die("missing handle fsync did not return EBADF");
            for (int i = 2; i < 4; i++) {
                if (pread(fds[i], buffer, 4096, 4 * 1024 * 1024) != 4096 || ((char *)buffer)[0] != 'Q' ||
                    pwrite(fds[i], buffer, 4096, 4 * 1024 * 1024) != 4096 || fsync(fds[i]) != 0)
                    die("surviving direct handle");
            }
            if ((fcntl(fds[3], F_GETFL) & (O_DIRECT | O_DSYNC)) != (O_DIRECT | O_DSYNC) ||
                (fcntl(fds[2], F_GETFL) & O_DSYNC) != 0)
                die("independent status flags");
            for (int j = 0; j < 2; j++) {
                if (lseek(fds[4 + j], 0, SEEK_CUR) != positions[j] ||
                    read(fds[4 + j], buffer, 4096) != 4096 || ((char *)buffer)[0] != 'Q')
                    die("independent guest position");
                positions[j] += 4096;
            }
            if (map[0] != 'M')
                die("surviving DAX mapping");
            __atomic_store_n(watermark, ++n, __ATOMIC_SEQ_CST);
            printf("probe pid=%d n=%llu normal=ok other-handle=ok flags=ok positions=ok dax=ok\n", getpid(), n);
        }
        struct timespec delay = {0, 200 * 1000 * 1000};
        nanosleep(&delay, NULL);
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 3 && argc != 4) {
        fprintf(stderr, "usage: %s <disk-dir> <share-dir>\n", argv[0]);
        return 2;
    }
    const char *disk = argv[1], *share = argv[2];
    setvbuf(stdout, NULL, _IOLBF, 0);
    if (argc == 4 && strcmp(argv[3], "missing") == 0)
        return missing_orphans(disk, share);

    unsigned char raw[16];
    if (getrandom(raw, sizeof(raw), 0) != sizeof(raw))
        die("getrandom");
    char *marker = malloc(2 * sizeof(raw) + 1);
    if (!marker)
        die("malloc");
    for (size_t i = 0; i < sizeof(raw); i++)
        sprintf(marker + 2 * i, "%02x", raw[i]);

    struct {
        const char *tag;
        int fd;
    } files[] = {
        {"disk", open_file(disk, "disk.dat", 0)},
        {"disk-unlinked", open_file(disk, "unlinked.dat", 1)},
        {"share", open_file(share, "share.dat", 0)},
        {"share-secondary", open_file(share, "secondary.dat", 0)},
    };
    const size_t nfiles = sizeof(files) / sizeof(files[0]);

    char map_path[4096];
    snprintf(map_path, sizeof(map_path), "%s/mapped.dat", share);
    int map_fd = open_file(share, "mapped.dat", 0);
    if (ftruncate(map_fd, MAP_LEN) != 0)
        die("ftruncate");
    char *map = mmap(NULL, MAP_LEN, PROT_READ | PROT_WRITE, MAP_SHARED, map_fd, 0);
    if (map == MAP_FAILED)
        die("mmap");
    /* The mapping must outlive its descriptor. */
    close(map_fd);

    unsigned long long n = 0;
    for (size_t i = 0; i < nfiles; i++)
        if (!write_slot(files[i].fd, files[i].tag, n))
            die(files[i].tag);
    uint64_t *watermark = (uint64_t *)(map + WATERMARK);
    __atomic_store_n(watermark, n, __ATOMIC_SEQ_CST);
    /* Second page: written once, checked every tick. */
    format_slot(map + 4096, "mapped-fixed", 0);
    format_slot(map, "mapped", n);
    if (msync(map, MAP_LEN, MS_SYNC) != 0)
        die("msync");

    printf("start pid=%d marker=%s\n", getpid(), marker);
    print_mount(share);

    for (;;) {
        const char *bad = NULL;
        char want[SLOT];
        for (size_t i = 0; i < nfiles && !bad; i++)
            if (!slot_matches(files[i].fd, files[i].tag, n))
                bad = files[i].tag;
        format_slot(want, "mapped", n);
        if (!bad && memcmp(map, want, SLOT) != 0)
            bad = "mapped";
        format_slot(want, "mapped-fixed", 0);
        if (!bad && memcmp(map + 4096, want, SLOT) != 0)
            bad = "mapped-fixed";
        if (!bad && __atomic_load_n(watermark, __ATOMIC_SEQ_CST) != n)
            bad = "watermark";

        n++;
        for (size_t i = 0; i < nfiles && !bad; i++)
            if (!write_slot(files[i].fd, files[i].tag, n))
                bad = "write";
        format_slot(map, "mapped", n);
        __atomic_store_n(watermark, n, __ATOMIC_SEQ_CST);
        if (!bad && msync(map, MAP_LEN, MS_SYNC) != 0)
            bad = "msync";

        printf("tick pid=%d marker=%s n=%llu dax=%d state=%s%s\n", getpid(), marker, n,
               is_dax(map_path), bad ? "bad:" : "ok", bad ? bad : "");
        if (bad)
            return 1;
        struct timespec delay = {0, 200 * 1000 * 1000};
        nanosleep(&delay, NULL);
    }
}
