#!/usr/bin/env bash
# Runs only inside the pinned builder, at fixed source and output paths.
set -euo pipefail
# shellcheck source=src/vmm/boot/kernel.lock
source /input/kernel.lock
export SOURCE_DATE_EPOCH
export LC_ALL=C TZ=UTC
KBUILD_BUILD_TIMESTAMP="$(date -u -d "@$SOURCE_DATE_EPOCH" '+%Y-%m-%d %H:%M:%S UTC')"
export KBUILD_BUILD_TIMESTAMP
export KBUILD_BUILD_USER=boxlite KBUILD_BUILD_HOST=builder KBUILD_BUILD_VERSION=1
export ARCH=x86 CROSS_COMPILE=x86_64-linux-gnu-
export KCFLAGS='-fdebug-prefix-map=/kernel=/usr/src/linux -fdebug-prefix-map=/build=/usr/src/build'
export KAFLAGS="$KCFLAGS"
umask 022

mkdir /build /artifacts
make -C /kernel O=/build KCONFIG_ALLCONFIG=/input/kernel.config allnoconfig
# Kconfig can silently drop a requested option when a dependency is absent.
while IFS= read -r setting; do
    case "$setting" in
        CONFIG_*=*)
            grep -Fxq "$setting" /build/.config || {
                echo "ERROR: kernel configuration did not retain: $setting" >&2
                exit 1
            }
            ;;
        '# CONFIG_'*' is not set')
            # Invisible disabled symbols are omitted from .config entirely.
            symbol="${setting#\# }"
            symbol="${symbol% is not set}"
            if grep -q "^${symbol}=" /build/.config; then
                echo "ERROR: kernel configuration enabled: $symbol" >&2
                exit 1
            fi
            ;;
    esac
done < /input/kernel.config

make -C /kernel O=/build -j"$(nproc)" vmlinux bzImage
x86_64-linux-gnu-gcc -static -Os -Wall -Wextra -Werror \
    -ffile-prefix-map=/input=. -Wl,--build-id=none -o /build/test-init /input/init.c
x86_64-linux-gnu-readelf -l /build/test-init > /build/init.program-headers
if grep -q INTERP /build/init.program-headers; then
    echo 'ERROR: test init requires a dynamic loader' >&2
    exit 1
fi

cat > /build/initramfs.list <<'EOF'
dir /dev 0755 0 0
nod /dev/console 0600 0 0 c 5 1
file /init /build/test-init 0755 0 0
EOF
touch -d "@$SOURCE_DATE_EPOCH" /build/test-init
/build/usr/gen_init_cpio -t "$SOURCE_DATE_EPOCH" /build/initramfs.list > /artifacts/test-initramfs.cpio
cp /build/vmlinux /artifacts/vmlinux
# QEMU uses bzImage for artifact qualification; the native VMM will load vmlinux.
cp /build/arch/x86/boot/bzImage /artifacts/bzImage
cp /build/.config /artifacts/kernel.config
{
    cat /input/kernel.lock
    printf 'BUILDER_ARCH=%s\n' "$(uname -m)"
    x86_64-linux-gnu-gcc --version | head -1
    dpkg-query -W -f='${Package}=${Version}\n' | sort
    sha256sum /input/kernel.config /input/init.c /input/build.sh /input/Dockerfile
} > /artifacts/build-info.txt
cd /artifacts
sha256sum build-info.txt bzImage kernel.config test-initramfs.cpio vmlinux > SHA256SUMS
