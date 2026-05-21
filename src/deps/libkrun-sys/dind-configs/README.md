# DinD kernel config overlay

This directory holds `--privileged` (DinD) kernel config overlays
applied on top of the upstream libkrunfw lean configs (at
`../vendor/libkrunfw/config-libkrunfw_<arch>`). They turn on the
networking subsystems Docker needs for bridge networks, NAT, and
iptables rule installation — i.e. everything required by the workflows
issue #276 calls out as broken under the lean profile (`docker compose
up` with custom bridge networks, port publishing, container-to-
container DNS).

The overlays do NOT touch any unrelated config knob. The resulting
"fat" libkrunfw is shipped alongside the lean one as a second `.so`
blob, opt-in via the per-box `privileged` flag. The default profile
remains the lean libkrunfw, byte-for-byte identical to today.

## How the overlay is applied

`make libkrunfw-dind` does:

1. Copy `vendor/libkrunfw/config-libkrunfw_<arch>` → `vendor/libkrunfw/.config`
2. Append the relevant overlay file (this dir, `overlay-dind_<arch>`)
   to `.config`
3. Run `make olddefconfig` inside `vendor/libkrunfw/<kernel-src>` so the
   Kconfig dependency resolver fills in any newly-required parent
   options (e.g. `CONFIG_NETFILTER_ADVANCED=y` once `CONFIG_NF_TABLES=y`)
4. Build libkrunfw as usual
5. Stamp the SONAME to a distinct filename
   (`libkrunfw-dind.so.5`) so it can sit next to the lean one

The boxlite runtime stages both blobs and selects between them at VM
spawn time based on `BoxOptions::privileged`.

## Why not modify the upstream lean config

Two reasons. First, every CONFIG flag we add to lean grows the kernel
binary embedded in every box on the planet — that defeats the lean
profile's whole purpose (small footprint, fast boot, smaller attack
surface). Second, keeping the overlay external means upstream libkrunfw
updates (config refreshes, version bumps) merge cleanly without
conflicts in the file we maintain ourselves.

## Adding a new arch

`overlay-dind_aarch64` is currently a copy of the x86_64 overlay since
the same CONFIG_* knobs apply. If a new arch needs different settings,
add a per-arch overlay here.
