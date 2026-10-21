#!/usr/bin/env bash
# Invoked inside the pinned Linux builder by make kernel:dind.
set -euo pipefail

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential bc bison flex curl xz-utils cpio libelf-dev libssl-dev \
    python3 python3-pyelftools ca-certificates

source_dir=/src/src/deps/libkrun-sys/vendor/libkrunfw
build_dir=/root/kernel-build
mkdir -p "$build_dir"
cd "$build_dir"
if [[ ! -f linux.tar.xz ]]; then
    curl -fL --retry 2 --connect-timeout 30 --max-time 600 \
        https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.12.87.tar.xz \
        -o linux.tar.xz.part
    mv linux.tar.xz.part linux.tar.xz
fi
printf '%s\n' 'cc12a7644b4cef9e06627b29de8753e22b3d076703a9b52be84263e05c8b9830  linux.tar.xz' | sha256sum -c -
if [[ ! -f linux-6.12.87/.boxlite-patched ]]; then
    tar xf linux.tar.xz
    for patch in "$source_dir"/patches/0*.patch; do
        patch -p1 -d linux-6.12.87 < "$patch"
    done
    touch linux-6.12.87/.boxlite-patched
fi
cp "$source_dir/config-libkrunfw_aarch64" linux-6.12.87/.config
cd linux-6.12.87
while read -r symbol; do
    [[ -z "$symbol" || "$symbol" == \#* ]] && continue
    scripts/config --enable "$symbol"
done < /src/scripts/build/dind-kernel.config
scripts/config --set-str LOCALVERSION '-boxlite-dind'
make olddefconfig
invalid_config=0
while read -r symbol; do
    [[ -z "$symbol" || "$symbol" == \#* ]] && continue
    grep -qx "CONFIG_${symbol}=y" .config || { echo "Kconfig refused $symbol"; invalid_config=1; }
done < /src/scripts/build/dind-kernel.config
[[ "$invalid_config" == 0 ]]
make -j4 KBUILD_BUILD_TIMESTAMP='Fri May 8 14:25:15 UTC 2026' \
    KBUILD_BUILD_USER=boxlite KBUILD_BUILD_HOST=builder Image
python3 "$source_dir/bin2cbundle.py" --os Darwin -t Image arch/arm64/boot/Image /out/kernel.c
cp .config /out/kernel.config
cp "$source_dir/Makefile" /out/Makefile
cp arch/arm64/boot/Image /out/Image
cd /out
sha256sum Image kernel.c kernel.config Makefile > SHA256SUMS
