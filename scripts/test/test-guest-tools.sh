#!/bin/bash
# Validate the static e2fsprogs guest tools produced by make guest-tools.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
target=""
profile=release
while [ "$#" -gt 0 ]; do
    case "$1" in
        --target) [ "$#" -ge 2 ] || exit 2; target="$2"; shift 2 ;;
        --profile) [ "$#" -ge 2 ] || exit 2; profile="$2"; shift 2 ;;
        --help|-h) echo "Usage: $0 [--target TARGET] [--profile release|debug]"; exit 0 ;;
        *) echo "ERROR: unknown option: $1" >&2; exit 2 ;;
    esac
done
case "$profile" in release|debug) ;; *) echo "ERROR: unsupported profile: $profile" >&2; exit 2 ;; esac
if [ -z "$target" ]; then
    case "$(uname -m)" in
        x86_64|amd64) target=x86_64-unknown-linux-musl ;;
        arm64|aarch64) target=aarch64-unknown-linux-musl ;;
        *) echo "ERROR: unsupported host architecture: $(uname -m)" >&2; exit 2 ;;
    esac
fi
case "$target" in
    x86_64-unknown-linux-musl|aarch64-unknown-linux-musl) ;;
    *) echo "ERROR: unsupported guest target: $target" >&2; exit 2 ;;
esac

util="$root/scripts/util.sh"
tools="$root/target/$target/$profile/guest-tools"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/boxlite-guest-tools-test.XXXXXX")
trap 'status=$?; trap - EXIT HUP INT TERM; rm -rf "$tmp"; exit "$status"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
fail() { echo "ERROR: $*" >&2; exit 1; }
mode() {
    if stat -c '%a' "$1" >/dev/null 2>&1; then stat -c '%a' "$1"
    else stat -f '%Lp' "$1"; fi
}
reject() {
    local label="$1" expected="$2"; shift 2
    if "$@" >"$tmp/reject.out" 2>"$tmp/reject.err"; then fail "verifier accepted $label"; fi
    grep -Fq "$expected" "$tmp/reject.err" || fail "verifier rejected $label for the wrong reason"
}

[ -d "$tools" ] && [ ! -L "$tools" ] || fail "missing or unsafe guest-tools output"
shopt -s nullglob dotglob
entries=("$tools"/*)
[ "${#entries[@]}" -eq 2 ] || fail "guest-tools output must contain exactly two files"
actual=$(printf '%s\n' "${entries[@]##*/}" | LC_ALL=C sort)
expected=$(printf '%s\n' mke2fs resize2fs | LC_ALL=C sort)
[ "$actual" = "$expected" ] || fail "guest-tools output contains unexpected files"
for tool in mke2fs resize2fs; do
    path="$tools/$tool"
    [ -f "$path" ] && [ ! -L "$path" ] || fail "unsafe guest tool: $tool"
    [ "$(mode "$path")" = 755 ] || fail "$tool mode is not 0755"
    bash "$util" --verify-guest-elf "$target" "$path"
done
mke2fs="$tools/mke2fs"
resize2fs="$tools/resize2fs"

if [ "$(uname -s):$(uname -m):$target:$profile" = \
    Linux:x86_64:x86_64-unknown-linux-musl:release ]; then
    patch_elf() {
        python3 - "$1" "$2" <<'PY'
import struct, sys
path, kind = sys.argv[1:]
with open(path, "r+b") as stream:
    elf = bytearray(stream.read())
    if elf[:6] != b"\x7fELF\x02\x01": raise SystemExit("fixture is not ELF64 little-endian")
    if kind == "et-dyn": struct.pack_into("<H", elf, 16, 3)
    elif kind.startswith("ph-"):
        off, size, count = struct.unpack_from("<Q", elf, 32)[0], struct.unpack_from("<H", elf, 54)[0], struct.unpack_from("<H", elf, 56)[0]
        loads = [off + i * size for i in range(count) if struct.unpack_from("<I", elf, off + i * size)[0] == 1]
        if len(loads) < 2: raise SystemExit("fixture needs two PT_LOAD entries")
        struct.pack_into("<I", elf, loads[-1], 3 if kind == "ph-interp" else 2)
    elif kind == "sh-dynamic":
        off, size, count = struct.unpack_from("<Q", elf, 40)[0], struct.unpack_from("<H", elf, 58)[0], struct.unpack_from("<H", elf, 60)[0]
        entries = [off + i * size for i in range(1, count) if struct.unpack_from("<I", elf, off + i * size + 4)[0] == 1]
        if not entries: raise SystemExit("fixture has no SHT_PROGBITS entry")
        struct.pack_into("<I", elf, entries[0] + 4, 6)
    else: raise SystemExit("unknown fixture mutation")
    stream.seek(0); stream.write(elf); stream.truncate()
PY
    }
    for spec in et-dyn:ET_EXEC ph-interp:PT_INTERP ph-dynamic:PT_DYNAMIC sh-dynamic:SHT_DYNAMIC; do
        kind=${spec%%:*}; error=${spec#*:}; fixture="$tmp/$kind"
        cp "$mke2fs" "$fixture"; patch_elf "$fixture" "$kind"
        reject "$kind" "$error" bash "$util" --verify-guest-elf "$target" "$fixture"
    done
    reject "wrong architecture" "machine does not match" \
        bash "$util" --verify-guest-elf aarch64-unknown-linux-musl "$mke2fs"
    real_readelf=$(command -v readelf)
    needed_readelf="$tmp/needed-readelf"
    printf '%s\n' '#!/bin/sh' \
        'if [ "$1" = -dW ]; then echo " 0x1 (NEEDED) Shared library: [fixture.so]"; exit 0; fi' \
        'exec "$REAL_READELF" "$@"' > "$needed_readelf"
    chmod 0755 "$needed_readelf"
    reject DT_NEEDED DT_NEEDED env REAL_READELF="$real_readelf" READELF="$needed_readelf" \
        bash "$util" --verify-guest-elf "$target" "$mke2fs"
fi

case "$(uname -s):$(uname -m):$target" in
    Linux:x86_64:x86_64-unknown-linux-musl|Linux:aarch64:aarch64-unknown-linux-musl|Linux:arm64:aarch64-unknown-linux-musl) ;;
    *) echo "Static guest tools passed structural checks; runtime smoke skipped"; exit 0 ;;
esac
version_header="$root/src/deps/e2fsprogs-sys/vendor/e2fsprogs/version.h"
expected_version=$(awk -F '"' '
    $1 ~ /^[[:space:]]*#[[:space:]]*define[[:space:]]+E2FSPROGS_VERSION[[:space:]]*$/ &&
        NF >= 3 && $2 != "" {
        print $2
        found = 1
        exit
    }
    END { if (!found) exit 1 }
' "$version_header") || fail "failed to read E2FSPROGS_VERSION from $version_header"
mke2fs_version=$("$mke2fs" -V 2>&1 || true)
resize2fs_version=$("$resize2fs" -V 2>&1 || true)
grep -Fq "mke2fs $expected_version " <<< "$mke2fs_version" || fail "mke2fs version mismatch"
grep -Fq "resize2fs $expected_version " <<< "$resize2fs_version" || fail "resize2fs version mismatch"
image="$tmp/ext4.img"
truncate -s 32M "$image"
MKE2FS_CONFIG="$tmp/missing.conf" "$mke2fs" -q -t ext4 -F "$image"
u16() { od -An -t u2 -N 2 -j "$2" "$1" | tr -d ' '; }
u32() { od -An -t u4 -N 4 -j "$2" "$1" | tr -d ' '; }
before=$(u32 "$image" 1028); compat=$(u32 "$image" 1116); incompat=$(u32 "$image" 1120)
[ "$(u16 "$image" 1080)" -eq 61267 ] && [ $((compat & 4)) -ne 0 ] && \
    [ $((incompat & 64)) -ne 0 ] || fail "mke2fs did not create ext4 with journal and extents"
truncate -s 64M "$image"
"$resize2fs" -f "$image" >/dev/null
after=$(u32 "$image" 1028)
[ "$after" -gt "$before" ] || fail "resize2fs did not grow the filesystem"
echo "Guest tools checks passed ($before -> $after blocks)"
