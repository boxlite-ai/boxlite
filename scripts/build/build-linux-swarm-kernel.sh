#!/usr/bin/env bash
# Build the public DinD recipe plus Swarm features; never modify the vendored tree.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
vendor="$root/src/deps/libkrun-sys/vendor/libkrunfw"
state="$root/.apps-local/runner-acceptance"
work=${BOXLITE_KERNEL_BUILD_DIR:-$state/kernel-swarm-build}
output=${BOXLITE_KERNEL_OUTPUT:-$state/firmware-swarm}
downloads=${BOXLITE_KERNEL_DOWNLOADS:-$state/kernel-downloads}
jobs=${BOXLITE_KERNEL_JOBS:-2}
revision=7e20dfa01919685c0a60a4b0b853805330131e8f
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail 'Linux x86_64 required'
[[ $jobs =~ ^[1-9][0-9]*$ ]] || fail 'BOXLITE_KERNEL_JOBS must be a positive integer'
[[ $(git -C "$vendor" rev-parse HEAD) == e0647fa7a3932c4570fb2c0fd483b9f7a382ebdd ]] || fail 'unexpected libkrunfw revision'
git -C "$vendor" diff --quiet HEAD -- patches bin2cbundle.py config-libkrunfw_x86_64 || fail 'modified firmware inputs'
python=${BOXLITE_KERNEL_PYTHON:-$root/.venv/bin/python}
[[ -x $python ]] || fail 'set BOXLITE_KERNEL_PYTHON to a Python with pyelftools'
for tool in make gcc cc ld readelf bc bison flex patch tar curl flock realpath sha256sum; do
    command -v "$tool" >/dev/null || fail "missing build prerequisite: $tool"
done
"$python" -c 'from elftools.elf.elffile import ELFFile'
mkdir -p "$work/inputs" "$output" "$downloads"
work=$(realpath "$work"); output=$(realpath "$output"); downloads=$(realpath "$downloads")
exec 9>"$work/build.lock"
flock -w 30 9 || fail "kernel build is already using $work"
exec > >(tee -a "$work/build.log") 2>&1
compiler=$(gcc --version; ld --version)
if [[ -f $work/compiler.txt ]]; then
    [[ $(cat "$work/compiler.txt") == "$compiler" ]] || fail 'compiler changed; use a fresh BOXLITE_KERNEL_BUILD_DIR'
else
    printf '%s\n' "$compiler" > "$work/compiler.txt"
fi
fetch() {
    local file=$1 digest=$2 url=$3
    if [[ ! -f $file ]]; then
        curl -fL --retry 2 --connect-timeout 30 --max-time 600 "$url" -o "$file.part"
        printf '%s  %s\n' "$digest" "$file.part" | sha256sum -c -
        mv "$file.part" "$file"
    fi
    printf '%s  %s\n' "$digest" "$file" | sha256sum -c -
}
archive="$downloads/linux-6.12.87.tar.xz"
public_patch="$downloads/0001-dind-kernel-config.patch"
fetch "$archive" cc12a7644b4cef9e06627b29de8753e22b3d076703a9b52be84263e05c8b9830 \
    https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.12.87.tar.xz
fetch "$public_patch" 9212efec650b8732aedc78fe4818db860ee495b83e8f39af2d7816442cffad0d \
    "https://raw.githubusercontent.com/boxlite-ai/libkrunfw/$revision/config-patches/0001-dind-kernel-config.patch"
printf '%s  %s\n' a6d6376c417a6a3b2df21284dbc0db2b76c53382e56e281454883f5294101454 \
    "$vendor/config-libkrunfw_x86_64" | sha256sum -c -
if [[ ! -f $work/inputs/SHA256SUMS ]]; then
    cp "$public_patch" "$work/inputs/"
    cp "$vendor/config-libkrunfw_x86_64" "$work/inputs/config-libkrunfw-dind_x86_64"
    cp "$root/scripts/build/dind-kernel.config" "$vendor/bin2cbundle.py" "$work/inputs/"
    mkdir -p "$work/inputs/patches"
    cp "$vendor"/patches/0*.patch "$work/inputs/patches/"
    patch -p1 -d "$work/inputs" < "$public_patch"
    (cd "$work/inputs" && sha256sum *.patch config-libkrunfw-dind_x86_64 dind-kernel.config bin2cbundle.py patches/0*.patch > SHA256SUMS)
fi
(cd "$work/inputs" && sha256sum -c SHA256SUMS)
cmp "$public_patch" "$work/inputs/0001-dind-kernel-config.patch"
cmp "$root/scripts/build/dind-kernel.config" "$work/inputs/dind-kernel.config" || fail 'config changed; use a fresh BOXLITE_KERNEL_BUILD_DIR'
cmp "$vendor/bin2cbundle.py" "$work/inputs/bin2cbundle.py"
for file in "$vendor"/patches/0*.patch; do cmp "$file" "$work/inputs/patches/${file##*/}"; done
kernel="$work/linux-6.12.87"
if [[ ! -f $kernel/.boxlite-patched ]]; then
    [[ ! -e $kernel ]] || fail "incomplete extraction at $kernel; use a fresh build directory"
    tar -xf "$archive" -C "$work"
    for file in "$work"/inputs/patches/0*.patch; do patch -p1 -d "$kernel" < "$file"; done
    touch "$kernel/.boxlite-patched"
fi
cp "$work/inputs/config-libkrunfw-dind_x86_64" "$kernel/.config"
while read -r symbol; do
    [[ -z $symbol || $symbol == \#* ]] && continue
    "$kernel/scripts/config" --file "$kernel/.config" --enable "$symbol"
done < "$work/inputs/dind-kernel.config"
"$kernel/scripts/config" --file "$kernel/.config" --set-str LOCALVERSION '-boxlite-dind-swarm'
make -C "$kernel" ARCH=x86 CROSS_COMPILE= CC=gcc HOSTCC=gcc LD=ld olddefconfig
while read -r symbol; do
    [[ -z $symbol || $symbol == \#* ]] && continue
    grep -qx "CONFIG_${symbol}=y" "$kernel/.config" || fail "Kconfig refused $symbol"
done < "$work/inputs/dind-kernel.config"
for symbol in VETH TUN NET_NS CGROUPS VIRTIO_NET VIRTIO_FS; do
    grep -qx "CONFIG_${symbol}=y" "$kernel/.config" || fail "missing DinD feature $symbol"
done
export LC_ALL=C TZ=UTC KBUILD_BUILD_USER=boxlite KBUILD_BUILD_HOST=swarm-builder KBUILD_BUILD_VERSION=1
export KBUILD_BUILD_TIMESTAMP='Fri May 8 14:25:15 UTC 2026'
make -C "$kernel" ARCH=x86 CROSS_COMPILE= CC=gcc HOSTCC=gcc LD=ld -j"$jobs" vmlinux
readelf -hW "$kernel/vmlinux" | tee "$output/elf-header.txt"
grep -q 'Advanced Micro Devices X86-64' "$output/elf-header.txt" || fail 'expected x86_64 ELF'
"$kernel/scripts/extract-ikconfig" "$kernel/vmlinux" > "$output/kernel.embedded.config"
cmp "$kernel/.config" "$output/kernel.embedded.config"
cp "$kernel/.config" "$output/kernel.config"
cp "$kernel/vmlinux" "$output/libkrunfw-kernel-dind-swarm-x86_64.bin"
cp "$kernel/System.map" "$output/System.map"
"$python" "$work/inputs/bin2cbundle.py" --os Linux -t vmlinux \
    "$output/libkrunfw-kernel-dind-swarm-x86_64.bin" "$output/kernel.c"
cat > "$output/Makefile" <<'MAKEFILE'
.PHONY: all install
all:
	$(CC) -fPIC -shared -nostdlib -DABI_VERSION=5 -Wl,-soname,libkrunfw.so.5 -o libkrunfw.so.5 kernel.c
install:
	mkdir -p "$(PREFIX)/lib64"
	cp libkrunfw.so.5 "$(PREFIX)/lib64/"
MAKEFILE
make -C "$output"
{
    printf 'variant=local public-DinD-recipe derivative; not the published binary\n'
    printf 'libkrunfw_source=%s\npublic_dind_recipe=%s\n' "$(git -C "$vendor" rev-parse HEAD)" "$revision"
    printf 'legacy_tables_enabled=yes; public recipe uses nftables only\n'
    gcc --version | head -1
    ld --version | head -1
    sha256sum "$archive" "$public_patch" "$root/scripts/build/dind-kernel.config" "$0"
} > "$output/build-info.txt"
(cd "$output" && sha256sum libkrunfw-kernel-dind-swarm-x86_64.bin kernel.c kernel.config kernel.embedded.config \
    Makefile libkrunfw.so.5 System.map elf-header.txt build-info.txt > SHA256SUMS)
printf 'Swarm firmware: %s\nUse BOXLITE_LIBKRUNFW_SOURCE=%s for runtime builds.\n' "$output" "$output"
