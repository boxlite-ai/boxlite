#!/usr/bin/env bash
# Invoked inside the ARM Linux builder by make kernel:dind.
set -euo pipefail

jobs=${1:-2}
[[ $jobs =~ ^[1-9][0-9]*$ ]] || { echo 'jobs must be a positive integer' >&2; exit 1; }
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential bc bison flex curl xz-utils cpio libelf-dev libssl-dev \
    python3 python3-pyelftools ca-certificates

source_dir=/src/src/deps/libkrun-sys/vendor/libkrunfw
build_dir=/root/kernel-build
mkdir -p "$build_dir"
cd "$build_dir"
curl -fL --retry 2 --connect-timeout 30 --max-time 600 \
    https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.12.87.tar.xz \
    -o linux.tar.xz
printf '%s\n' 'cc12a7644b4cef9e06627b29de8753e22b3d076703a9b52be84263e05c8b9830  linux.tar.xz' | sha256sum -c -
tar xf linux.tar.xz
for patch in "$source_dir"/patches/0*.patch; do
    patch -p1 -d linux-6.12.87 < "$patch"
done
cp "$source_dir/config-libkrunfw_aarch64" linux-6.12.87/.config
cd linux-6.12.87
while read -r symbol; do
    [[ -z $symbol || $symbol == \#* ]] && continue
    scripts/config --enable "$symbol"
done < /src/scripts/build/dind-kernel.config
scripts/config --set-str LOCALVERSION '-boxlite-dind'
make olddefconfig
while read -r symbol; do
    [[ -z $symbol || $symbol == \#* ]] && continue
    grep -qx "CONFIG_${symbol}=y" .config || { echo "Kconfig refused $symbol" >&2; exit 1; }
done < /src/scripts/build/dind-kernel.config
make -j"$jobs" KBUILD_BUILD_TIMESTAMP='Fri May 8 14:25:15 UTC 2026' \
    KBUILD_BUILD_USER=boxlite KBUILD_BUILD_HOST=builder Image
python3 "$source_dir/bin2cbundle.py" --os Darwin -t Image arch/arm64/boot/Image /out/kernel.c
cp .config /out/kernel.config
cp arch/arm64/boot/Image /out/Image
