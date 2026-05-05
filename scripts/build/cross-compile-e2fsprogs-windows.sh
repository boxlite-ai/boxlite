#!/usr/bin/env bash
# Cross-compile e2fsprogs (mke2fs + debugfs) for Windows x86_64.
#
# Requires: x86_64-w64-mingw32-gcc (MinGW-w64 cross-compiler)
#   Ubuntu/Debian: sudo apt-get install gcc-mingw-w64-x86-64
#
# Usage:
#   ./scripts/build/cross-compile-e2fsprogs-windows.sh [output_dir]
#
# Output:
#   <output_dir>/mke2fs.exe
#   <output_dir>/debugfs.exe
#
# The produced binaries are statically linked and self-contained.
# BoxLite only uses these non-interactively (commands piped via stdin),
# so the interactive shell stubs in the compat layer are safe.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
E2FS_SRC="$REPO_ROOT/src/deps/e2fsprogs-sys/vendor/e2fsprogs"
OUTPUT_DIR="${1:-$REPO_ROOT/target/e2fsprogs-windows-x86_64}"

# Cross-compiler prefix
CROSS=x86_64-w64-mingw32

# Verify prerequisites
if ! command -v "${CROSS}-gcc" &>/dev/null; then
    echo "ERROR: ${CROSS}-gcc not found."
    echo "Install: sudo apt-get install gcc-mingw-w64-x86-64"
    exit 1
fi

if [ ! -f "$E2FS_SRC/configure" ]; then
    echo "ERROR: e2fsprogs source not found at $E2FS_SRC"
    echo "Run: git submodule update --init --recursive"
    exit 1
fi

# Build in a temp directory
BUILD_DIR=$(mktemp -d)
trap 'rm -rf "$BUILD_DIR"' EXIT

echo "=== Cross-compiling e2fsprogs for Windows (x86_64) ==="
echo "Source:  $E2FS_SRC"
echo "Build:   $BUILD_DIR"
echo "Output:  $OUTPUT_DIR"
echo "Cross:   ${CROSS}-gcc ($(${CROSS}-gcc --version | head -1))"
echo ""

# ── POSIX compat layer for MinGW ────────────────────────────────────────
# libss (used by debugfs for command parsing) uses POSIX signals, fork,
# wait, and pipe. These are only needed for the interactive shell loop.
# BoxLite invokes debugfs non-interactively, so these stubs are safe.
COMPAT_DIR="$BUILD_DIR/compat"
mkdir -p "$COMPAT_DIR/sys"

cat > "$COMPAT_DIR/mingw_posix_compat.h" << 'COMPAT'
#ifndef _MINGW_POSIX_COMPAT_H
#define _MINGW_POSIX_COMPAT_H

#include <signal.h>

/* Missing signals — MinGW only defines a subset */
#ifndef SIGCONT
#define SIGCONT 0
#endif
#ifndef SIGALRM
#define SIGALRM 0
#endif
#ifndef SIGPIPE
#define SIGPIPE 0
#endif

/* MinGW lacks sigset_t and POSIX signal mask functions entirely.
 * These are used by libss/listen.c for its interactive shell loop.
 * BoxLite invokes debugfs non-interactively, so these stubs are safe. */
typedef unsigned long long sigset_t;

#ifndef SIG_BLOCK
#define SIG_BLOCK   1
#define SIG_SETMASK 2
#endif

static inline int sigemptyset(sigset_t *set) { if (set) *set = 0; return 0; }
static inline int sigaddset(sigset_t *set, int sig) { (void)sig; if (set) *set |= 1; return 0; }
static inline int sigdelset(sigset_t *set, int sig) { (void)sig; if (set) *set &= ~1ULL; return 0; }
static inline int sigprocmask(int how, const sigset_t *set, sigset_t *old) {
    (void)how; (void)set; if (old) *old = 0; return 0;
}

/* fork/wait — interactive shell not used */
#ifndef fork
static inline int fork(void) { return -1; }
#endif

/* pipe — interactive pager not used */
#ifndef pipe
static inline int pipe(int fd[2]) { (void)fd; return -1; }
#endif

/* POSIX functions unavailable on Windows — stubs for debugfs.
 * These are only used by interactive commands (dump, rdump, mknod)
 * which BoxLite never invokes (only write/mkdir/cd are used). */
static inline int fchmod(int fd, int mode) { (void)fd; (void)mode; return -1; }
static inline int chown(const char *path, int uid, int gid) { (void)path; (void)uid; (void)gid; return -1; }
static inline int symlink(const char *target, const char *linkpath) { (void)target; (void)linkpath; return -1; }
static inline int readlink(const char *path, char *buf, int sz) { (void)path; (void)buf; (void)sz; return -1; }

#endif /* _MINGW_POSIX_COMPAT_H */
COMPAT

# sys/wait.h stub — libss/list_rqs.c includes it
cat > "$COMPAT_DIR/sys/wait.h" << 'WAIT_H'
#ifndef _SYS_WAIT_H
#define _SYS_WAIT_H
/* Stub for MinGW: wait/waitpid not available on Windows.
 * debugfs is used non-interactively — these are never called. */
#include <stdlib.h>
#define WIFEXITED(s)   1
#define WEXITSTATUS(s) 0
static inline int waitpid(int pid, int *status, int opts) {
    (void)pid; (void)status; (void)opts; return -1;
}
#ifndef wait
static inline int wait(int *status) { (void)status; return -1; }
#endif
#endif
WAIT_H

# Configure for Windows cross-compilation
echo "--- Configuring ---"
(
    cd "$BUILD_DIR"
    "$E2FS_SRC/configure" \
        --host="$CROSS" \
        --disable-nls \
        --disable-tdb \
        --disable-imager \
        --disable-resizer \
        --disable-defrag \
        --disable-fsck \
        --disable-e2initrd-helper \
        --disable-fuse2fs \
        --disable-uuidd \
        --enable-verbose-makecmds \
        CFLAGS="-O2 -static -I$COMPAT_DIR -include $COMPAT_DIR/mingw_posix_compat.h -Dunix_io_manager=windows_io_manager" \
        LDFLAGS="-static"
)

JOBS=$(nproc 2>/dev/null || echo 4)

# Build libraries first
echo ""
echo "--- Building libraries ---"
make -C "$BUILD_DIR" -j"$JOBS" libs

# ── Patch create_inode.c for MinGW before building mke2fs ─────────────
# MinGW's readdir() does not populate d_reclen in struct dirent.
# The _WIN32 scandir() implementation in create_inode.c uses d_reclen
# for malloc/memcpy size, which results in zero-size copies and empty
# d_name fields. Fix: use sizeof(struct dirent) instead.
echo ""
echo "--- Patching create_inode.c for MinGW ---"
cp "$E2FS_SRC/misc/create_inode.c" "$BUILD_DIR/misc/create_inode_patched.c"
sed -i 's/(dent->d_reclen + 3) & ~3/sizeof(struct dirent)/g' "$BUILD_DIR/misc/create_inode_patched.c"
sed -i 's/memcpy(temp_list\[num_dent\], dent, dent->d_reclen)/memcpy(temp_list[num_dent], dent, sizeof(struct dirent))/g' "$BUILD_DIR/misc/create_inode_patched.c"

# Pre-compile patched create_inode.c so make doesn't overwrite it
MKE2FS_CFLAGS="-I. -I../lib -I$E2FS_SRC/lib -I$E2FS_SRC/include/mingw \
    -I$E2FS_SRC/misc \
    -O2 -static -I$COMPAT_DIR -include $COMPAT_DIR/mingw_posix_compat.h \
    -Dunix_io_manager=windows_io_manager -pthread -DHAVE_CONFIG_H"
(cd "$BUILD_DIR/misc" && \
    ${CROSS}-gcc -c $MKE2FS_CFLAGS create_inode_patched.c -o create_inode.o)
echo "  Compiled patched create_inode.o"

# Build mke2fs (will use pre-compiled create_inode.o)
echo ""
echo "--- Building mke2fs ---"
make -C "$BUILD_DIR/misc" -j"$JOBS" mke2fs

# ── Patch sources for MinGW before building debugfs ──────────────────────
echo ""
echo "--- Patching debugfs sources for MinGW ---"

# 1. dump.c: MinGW mkdir() takes 1 arg; POSIX takes 2
cp "$E2FS_SRC/debugfs/dump.c" "$BUILD_DIR/debugfs/dump_patched.c"
sed -i 's/mkdir(fullname, S_IRWXU)/mkdir(fullname)/g' "$BUILD_DIR/debugfs/dump_patched.c"

# 2. Stub for do_mknod_internal — defined in create_inode.c inside #ifndef _WIN32,
#    but debugfs.c calls it unconditionally. BoxLite never uses the mknod command.
cat > "$BUILD_DIR/debugfs/win32_stubs.c" << 'WIN32_STUBS'
#include "config.h"
#include <ext2fs/ext2fs.h>
errcode_t do_mknod_internal(ext2_filsys fs, ext2_ino_t cwd, const char *name,
                            unsigned int st_mode, unsigned int st_rdev) {
    (void)fs; (void)cwd; (void)name; (void)st_mode; (void)st_rdev;
    return EXT2_ET_INVALID_ARGUMENT;
}
WIN32_STUBS

# Build debugfs
echo ""
echo "--- Building debugfs ---"
DEBUGFS_CFLAGS="-I. -I../lib -I$E2FS_SRC/lib -I$E2FS_SRC/include/mingw \
    -I$E2FS_SRC/debugfs \
    -O2 -static -I$COMPAT_DIR -include $COMPAT_DIR/mingw_posix_compat.h \
    -Dunix_io_manager=windows_io_manager -pthread -DHAVE_CONFIG_H \
    -I$E2FS_SRC/debugfs/../e2fsck -DDEBUGFS"

# Compile patched dump.c and win32 stubs
(cd "$BUILD_DIR/debugfs" && \
    ${CROSS}-gcc -c $DEBUGFS_CFLAGS dump_patched.c -o dump.o && \
    ${CROSS}-gcc -c $DEBUGFS_CFLAGS win32_stubs.c -o win32_stubs.o)

# Let make compile everything except dump.o (already pre-compiled)
# The link step will fail due to missing do_mknod_internal — we re-link below
make -C "$BUILD_DIR/debugfs" -j"$JOBS" debugfs 2>/dev/null || true

# Re-link debugfs with win32_stubs.o included
echo "  Re-linking debugfs with win32 stubs..."
(cd "$BUILD_DIR/debugfs" && \
    ${CROSS}-gcc -pthread -static -o debugfs \
        debug_cmds.o debugfs.o util.o ncheck.o icheck.o ls.o lsdel.o dump.o \
        set_fields.o logdump.o htree.o unused.o e2freefrag.o filefrag.o \
        extent_cmds.o extent_inode.o zap.o create_inode.o \
        create_inode_libarchive.o quota.o xattrs.o journal.o revoke.o \
        recovery.o do_journal.o do_orphan.o \
        win32_stubs.o \
        ../lib/libsupport.a ../lib/libext2fs.a ../lib/libe2p.a ../lib/libss.a \
        ../lib/libcom_err.a -lpthread ../lib/libblkid.a ../lib/libuuid.a \
        ../lib/libuuid.a -lpthread)

# Copy and strip output
mkdir -p "$OUTPUT_DIR"

echo ""
echo "--- Copying and stripping binaries ---"

for bin_dir_name in misc/mke2fs debugfs/debugfs; do
    # Cross-compiler may produce with or without .exe suffix
    if [ -f "$BUILD_DIR/${bin_dir_name}.exe" ]; then
        src="$BUILD_DIR/${bin_dir_name}.exe"
    elif [ -f "$BUILD_DIR/${bin_dir_name}" ]; then
        src="$BUILD_DIR/${bin_dir_name}"
    else
        echo "ERROR: ${bin_dir_name}[.exe] not found in $BUILD_DIR"
        exit 1
    fi

    name="$(basename "$bin_dir_name").exe"
    dst="$OUTPUT_DIR/$name"

    cp "$src" "$dst"
    "${CROSS}-strip" "$dst"
    size=$(du -h "$dst" | cut -f1)
    echo "  $name  ($size)"
done

echo ""
echo "=== Done ==="
echo "Binaries: $OUTPUT_DIR/mke2fs.exe"
echo "          $OUTPUT_DIR/debugfs.exe"
