#!/bin/bash
# Validate the minimal rootfs produced by make guest.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
target=""; profile=release
while [ "$#" -gt 0 ]; do
    case "$1" in
        --target) [ "$#" -ge 2 ] || exit 2; target="$2"; shift 2 ;;
        --profile) [ "$#" -ge 2 ] || exit 2; profile="$2"; shift 2 ;;
        --help|-h) echo "Usage: $0 [--target TARGET] [--profile release|debug]"; exit 0 ;;
        *) echo "ERROR: unknown option: $1" >&2; exit 2 ;;
    esac
done
case "$profile" in release|debug) ;; *) echo "ERROR: unsupported profile: $profile" >&2; exit 2 ;; esac
if [ -z "$target" ]; then target=$(bash "$root/scripts/util.sh" --target); fi
case "$target" in x86_64-unknown-linux-musl|aarch64-unknown-linux-musl) ;; *) echo "ERROR: unsupported target: $target" >&2; exit 2 ;; esac

util="$root/scripts/util.sh"
output_parent="$root/target/$target/$profile"
artifact="$output_parent/guest-rootfs"
rootfs="$artifact/rootfs"
guest="$rootfs/boxlite/bin/boxlite-guest"
mke2fs="$rootfs/boxlite/bin/mke2fs"
resize2fs="$rootfs/boxlite/bin/resize2fs"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/boxlite-guest-rootfs-test.XXXXXX")
cleanup_test() {
    local status=$?
    trap - EXIT HUP INT TERM
    set +e
    if ! rm -rf -- "$tmp"; then
        echo "ERROR: failed to remove test directory: $tmp" >&2
        if [ "$status" -eq 0 ]; then status=1; fi
    fi
    exit "$status"
}
trap cleanup_test EXIT
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
fail() { echo "ERROR: $*" >&2; exit 1; }
mode() { if stat -c '%a' "$1" >/dev/null 2>&1; then stat -c '%a' "$1"; else stat -f '%Lp' "$1"; fi; }
reject() {
    local label="$1" expected="$2"; shift 2
    if "$@" >"$tmp/reject.out" 2>"$tmp/reject.err"; then fail "verifier accepted $label"; fi
    grep -Fq "$expected" "$tmp/reject.err" || fail "verifier rejected $label for the wrong reason"
}

[ -d "$artifact" ] && [ ! -L "$artifact" ] || fail "missing guest-rootfs directory"
[ -d "$rootfs" ] && [ ! -L "$rootfs" ] || fail "missing rootfs directory"
[ "$(mode "$artifact")" = 755 ] || fail "invalid guest-rootfs directory mode"
top_expected=rootfs
top_actual=$(cd "$artifact" && find . ! -name . -prune -print | sed 's#^./##' | LC_ALL=C sort)
[ "$top_actual" = "$top_expected" ] || fail "guest-rootfs must contain only rootfs"
inventory_expected=$(printf '%s\n' \
    boxlite \
    boxlite/bin \
    boxlite/bin/boxlite-guest \
    boxlite/bin/mke2fs \
    boxlite/bin/resize2fs \
    dev proc run sys tmp var var/tmp)
inventory_actual=$(cd "$rootfs" && find . ! -name . -print | sed 's#^./##' | LC_ALL=C sort)
[ "$inventory_actual" = "$inventory_expected" ] || fail "unexpected rootfs inventory"
symlinks=$(find "$artifact" -type l -print) || fail "failed to inspect guest rootfs for symlinks"
[ -z "$symlinks" ] || fail "guest rootfs contains a symlink"
for path in \
    "$rootfs" \
    "$rootfs/boxlite" \
    "$rootfs/boxlite/bin" \
    "$rootfs/dev" \
    "$rootfs/proc" \
    "$rootfs/run" \
    "$rootfs/sys" \
    "$rootfs/tmp" \
    "$rootfs/var" \
    "$rootfs/var/tmp"
do
    [ -d "$path" ] && [ ! -L "$path" ] && [ "$(mode "$path")" = 755 ] || fail "invalid rootfs directory: $path"
done
for path in "$guest" "$mke2fs" "$resize2fs"; do
    [ -f "$path" ] && [ ! -L "$path" ] && [ -s "$path" ] && [ "$(mode "$path")" = 755 ] || fail "invalid rootfs executable: $path"
done
cmp -s "$output_parent/boxlite-guest" "$guest" || fail "rootfs guest differs from standalone guest"
bash "$util" --verify-guest-elf "$target" "$mke2fs"
bash "$util" --verify-guest-elf "$target" "$resize2fs"

if [ "$(uname -s):$(uname -m):$target:$profile" = Linux:x86_64:x86_64-unknown-linux-musl:release ]; then
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

readelf_tool="${READELF:-}"
if [ -z "$readelf_tool" ]; then
    for candidate in "${target%%-*}-linux-musl-readelf" llvm-readelf /opt/homebrew/opt/llvm/bin/llvm-readelf /usr/local/opt/llvm/bin/llvm-readelf readelf; do
        command -v "$candidate" >/dev/null 2>&1 || continue; readelf_tool="$candidate"; break
    done
fi
[ -n "$readelf_tool" ] || fail "readelf is required"
guest_header=$(LC_ALL=C "$readelf_tool" -hW "$guest")
guest_programs=$(LC_ALL=C "$readelf_tool" -lW "$guest")
guest_dynamic=$(LC_ALL=C "$readelf_tool" -dW "$guest")
case "$target" in x86_64-*) guest_machine='Advanced Micro Devices X86-64|AMD x86-64|X86-64|x86-64' ;; aarch64-*) guest_machine=AArch64 ;; esac
printf '%s\n' "$guest_header" | grep -Eq 'Class:[[:space:]]+ELF64([[:space:]]|$)' || fail "guest is not ELF64"
printf '%s\n' "$guest_header" | grep -Eiq 'Data:[[:space:]]+2.s complement,[[:space:]]+little([ -])endian' || fail "guest is not little-endian"
printf '%s\n' "$guest_header" | grep -Eq 'Type:[[:space:]]+(EXEC|DYN)([[:space:]]|$)' || fail "guest is not ET_EXEC/static PIE"
printf '%s\n' "$guest_header" | grep -Eq "Machine:[[:space:]]+($guest_machine)([[:space:]]|$)" || fail "guest architecture mismatch"
printf '%s\n' "$guest_programs" | grep -Eq '(^|[[:space:]])LOAD([[:space:]]|$)' || fail "guest has no loadable segment"
! printf '%s\n' "$guest_programs" | grep -Eq '(^|[[:space:]])INTERP([[:space:]]|$)' || fail "guest has PT_INTERP"
! printf '%s\n' "$guest_dynamic" | grep -Eq '(\(NEEDED\)|(^|[[:space:]])NEEDED([[:space:]]|$))' || fail "guest has DT_NEEDED"

echo "Guest rootfs structural checks passed"
