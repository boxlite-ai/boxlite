# Checkpoints: pause, export and resume a running box elsewhere

## TL;DR

On Linux x86_64 with KVM, a box created with `--enable-checkpoint` can be paused, written to one
checkpoint file and imported as a new box whose guest processes continue after `resume`. CLI and
Rust only. Guest continuation, with the VMM seccomp filter on every shim thread, passed on one
real Intel KVM host ([Verification status](#verification-status)).

```bash
boxlite create --enable-checkpoint --name web -v /srv/data:/data alpine:latest \
  sh -c 'while :; do date >> /data/log; sleep 1; done'
boxlite start web
boxlite pause --host-writers-stopped web     # stop every host writer of /srv/data first
boxlite checkpoint export web web.boxckpt    # the box stays paused
boxlite stop web                             # the file is self-contained; see "Run each checkpoint once"
boxlite checkpoint import --name web2 web.boxckpt   # prints the new box ID; paused
boxlite resume web2                          # the same guest processes continue
```

## Lifecycle

```
create --enable-checkpoint ─▶ running ──pause──▶ paused ──resume──▶ running
                                                  │
                                       checkpoint export  (stays paused)
                                                  ▼
                                         one checkpoint file
                                                  │
                                       checkpoint import  (new box, paused)
                                                  ▼
                                    paused ──resume──▶ same processes continue
```

| Step | What happens | Fails when |
|---|---|---|
| `pause` | Every vCPU and device stops at one consistent cut. No SIGSTOP, no guest filesystem freeze. | The box is not running, or has a volume and `--host-writers-stopped` was not given |
| `checkpoint export BOX FILE` | Writes memory, devices, both disks and every share's files to `FILE`, published atomically. | The box is not paused, `FILE` exists, or its directory does not |
| `checkpoint import FILE` | Creates a new box: new ID and host paths, same guest container, process and execution IDs. Status `paused`. | The file is not a valid checkpoint, or the host cannot run it |
| `resume` | Lets the guest run, reconnects, and checks it is the guest that was paused. | The guest is not the one paused: the VM is then stopped |

While paused, the box refuses `exec`, attach, `cp`, metrics, SSH and network changes; health probes
are skipped and nothing resumes it implicitly. `resume`, `stop` and `checkpoint export` act on it.
Host connections to the guest, including open exec output streams, may end at the pause; the
guest processes keep running after `resume`, and attaching by execution ID reconnects to them.

## Host writers of volumes

Pausing stops the guest, not the host. A host process that writes a volume of a paused box would
change it under the guest and tear the checkpoint.

| Box has | `pause` needs |
|---|---|
| No volumes | nothing |
| Any volume (`-v` host directory or managed volume) | `--host-writers-stopped`: you stopped every host process that writes those directories |

The assertion holds until `boxlite resume` or `boxlite stop`; keep the writers stopped until then.
Directories the box owns itself are coordinated by the runtime.

## What a checkpoint holds and needs

- **Self-contained:** the importing host needs only the file and a compatible BoxLite runtime (its
  bundled kernel and shim). No image, image cache or source box is read. Volumes are restored as
  copies inside the new box's home; the original host paths are not used.
- **Same identity:** import must run as the same user (effective UID/GID) as the export.
- **Size:** the file holds the box's RAM, both disks at their full virtual size and every share's
  files. A checkpoint-enabled box may write files up to twice its disk size plus its RAM plus 4 GiB;
  an export that would not fit fails before writing, and the box stays paused.
- **Shares use DAX.** Every share of a checkpoint-enabled box gets a 512 MiB DAX window and the guest
  mounts it with `dax=always`, so file mappings are part of the checkpoint. A guest kernel without
  FUSE DAX fails the box at start; there is no fallback to a mount without DAX. Boxes without
  `--enable-checkpoint` mount shares without DAX, as before.
- **Shares are archived as the guest sees them.** Every file and directory under the box's shares must
  be:

  | Requirement | Otherwise |
  |---|---|
  | Owned by the user running BoxLite | export fails |
  | Readable (files) or listable and searchable (directories) | export fails |
  | Free of xattrs other than `user.*` and POSIX ACLs naming only that user/group | export fails |
  | A regular file, directory or symlink (no FIFO, socket or device) | export fails |

  `trusted.*` attributes hidden from the unprivileged runtime are not captured. Export never drops
  something it cannot restore; it fails instead.
- **Trusted input.** Import only checkpoints you or a party you trust wrote. The file is checked
  for structure and size limits, not for its origin; it carries the guest's whole memory.

## Run each checkpoint once

A checkpoint is a moment of a running guest. Every copy that runs from it starts with the same
memory, so random-number state, generated IDs, session tokens and keys are repeated in each copy.
BoxLite does not reseed the guest.

| Use | Result |
|---|---|
| Export, `stop` the source, import once, resume | one guest continues |
| Export, then `resume` the source **and** import | two guests share that state |
| Import the same file twice | two guests share that state |

To move a box, stop the source after export and import the file once. Once the source resumes, any
later import of that file repeats state the source already used.

## Support

| | Supported | Refused (`Unsupported`, before the box runs) |
|---|---|---|
| Host | Linux x86_64 with KVM | every other OS or architecture |
| Entry points | Rust `BoxliteRuntime`/`LiteBox`, `boxlite` CLI (embedded runtime) | Python, Node.js, Go and C SDKs (no checkpoint API); REST runtimes and `boxlite serve` |
| Isolation | default sandbox (`--security enable`) | `--security disable`, `advanced.isolate_mounts` |
| Network | gvproxy network or `--network disabled` | TSI networking |
| Options | up to 5 directory volumes, up to 128 vCPUs | custom kernel, nested virtualization, secrets, single-file volumes |
| Old disk operations | — | disk snapshots, `clone_box`, the disk `export` and `restore_from_archive` on a checkpoint-enabled box; importing a legacy `.boxlite` archive whose options enable checkpoints |

Boxes without `--enable-checkpoint` are unchanged.

## Failures

| Failure | Result |
|---|---|
| Export refused or failed with a known outcome (destination exists, disk full, unsupported share content, image larger than the box's file size limit) | Box stays paused; only files this export created are removed; retry or `resume` |
| Import fails at any step | No box, no box directory; files this attempt created are removed |
| The runtime cannot tell whether a pause, resume or export happened (the control channel broke) | The VM is stopped, never retried |
| After resume, the guest is not the paused one | The VM is stopped and `resume` fails |

After `resume` of an imported box, guest network connections that were open at the cut may break;
new connections work.

## Verification status

| Area | Status |
|---|---|
| CLI parsing, refusals and non-KVM runtime paths | unit tests |
| x86_64 guest agent and its unit tests | `make test:unit:guest` (nextest, all tests) passes natively on Linux x86_64 |
| Real guest continuation (`make test:checkpoint:acceptance`) | passed on one Linux x86_64 host with read/write `/dev/kvm` (Intel VT-x in a nested cloud VM, Ubuntu 24.04), real runtime (no `BOXLITE_DEPS_STUB`) |
| virtio-fs DAX mappings in a real Linux guest, and FUSE DAX in the bundled guest kernel | passed in the same run: the share mounts `dax=always`, the checkpoint holds a file DAX mapping, and the restored helper keeps reading through it |
| libkrun's share archive export/import, unprivileged, under bwrap and the production x86_64 VMM seccomp filter (`make test:snapshot:rootless`) | passed on the same host |
| x86_64 VMM seccomp filter on the checkpoint KVM path (pause/export/import ioctls, vCPU and device save, gvproxy networking) | passed in the same acceptance run: the networked source shim and the restored shim each have exactly one filter on every thread, installed by the shim, after the restored box made a new TCP connection and a disk discard |
| VMM seccomp on Linux aarch64 | **UNVERIFIED**; networked aarch64 VMs still run without the filter ([Security](../concepts/security.md)) |
| Other CPUs (AMD, other Intel models) and hosts | **UNVERIFIED** |

The acceptance test runs one box with a long-lived process holding a heap-only random marker, a
counter, open and unlinked files on the disk and a volume, and a DAX mapping; it pauses, exports,
destroys the box and its home, imports into an empty runtime and requires the same PID, marker and
execution to continue. It needs `/dev/kvm`, `make runtime:debug` and registry access for
`alpine:latest`.

## Run KVM acceptance in a fork

`.github/workflows/checkpoint-kvm.yml` runs on a push to the branch it names, on a GitHub-hosted
Ubuntu 22.04 runner. On your own Linux x86_64 host, run the same make targets in this order:

```bash
make setup:build                    # then `source ~/.profile` if it just installed Go
make runtime:debug                  # real dependencies: BOXLITE_DEPS_STUB must be unset
make test:checkpoint:acceptance:build
NEXTEST_PROFILE=ci make test:unit:guest   # the ci profile reports every failure, not only the first
make -C src/deps/libkrun-sys/vendor/libkrun snapshot-test SNAPSHOT_FILTER=<test>   # with RUSTFLAGS=''
BOXLITE_TEST_BWRAP=<bundled bwrap> make test:snapshot:rootless
make test:checkpoint:acceptance SETUP_DONE=1
```

| Host prerequisite | Without it |
|---|---|
| Read/write `/dev/kvm` | `_ensure-kvm` fails |
| `cargo-nextest` | `test:unit:guest` runs only three pure-logic modules |
| `libseccomp-dev` (GitHub's runner image has it; `make setup:build` does not install it) | the guest test binary fails to link: `unable to find library -lseccomp` |
| User namespaces for the bundled bwrap | with `kernel.apparmor_restrict_unprivileged_userns=1` (Ubuntu 24.04 default), both bwrap tests fail with `setting up uid map: Permission denied`. Load an AppArmor profile that allows `userns` for that bwrap path only (BoxLite prints one under `~/.boxlite/apparmor/`), point `BOXLITE_TEST_BWRAP` at the same path, and unload it afterwards |
