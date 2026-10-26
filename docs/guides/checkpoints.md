# Checkpoints: pause, export and resume a running box elsewhere

## TL;DR

On Linux x86_64 with KVM, a box created with `--enable-checkpoint` can be paused, written to one
checkpoint file and imported as a new box whose guest processes continue after `resume`. CLI and
Rust only. Running on real KVM is **UNVERIFIED**.

```bash
boxlite create --enable-checkpoint --name web -v /srv/data:/data alpine:latest \
  sh -c 'while :; do date >> /data/log; sleep 1; done'
boxlite start web
boxlite pause --host-writers-stopped web     # stop every host writer of /srv/data first
boxlite checkpoint export web web.boxckpt    # the box stays paused
boxlite stop web                             # or resume it; the file is self-contained
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

## Support

| | Supported | Refused (`Unsupported`, before the box runs) |
|---|---|---|
| Host | Linux x86_64 with KVM | every other OS or architecture |
| Entry points | Rust `BoxliteRuntime`/`LiteBox`, `boxlite` CLI (embedded runtime) | Python, Node.js, Go and C SDKs (no checkpoint API); REST runtimes and `boxlite serve` |
| Isolation | default sandbox (`--security enable`) | `--security disable`, `advanced.isolate_mounts` |
| Network | gvproxy network or `--network disabled` | TSI networking |
| Options | up to 5 directory volumes, up to 128 vCPUs | custom kernel, nested virtualization, secrets, single-file volumes |
| Old disk operations | — | disk snapshots, `clone_box` and the disk `export` on a checkpoint-enabled box; importing a legacy `.boxlite` archive whose options enable checkpoints |

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
| x86_64 guest agent (static musl build) and its unit tests | built with `make guest`; unit tests pass in an emulated amd64 container except two that need `openat2`, which the emulator lacks |
| Real guest continuation (`make test:checkpoint:acceptance`) | written and compiled for Linux x86_64; **UNVERIFIED**: not run on KVM |
| x86_64 VMM seccomp filter with the checkpoint syscalls | **UNVERIFIED** at runtime: the filter is compiled and its decisions checked, but not installed on an x86_64 host |
| virtio-fs DAX mappings in a real Linux guest, and FUSE DAX in the bundled guest kernel | **UNVERIFIED** |

The acceptance test runs one box with a long-lived process holding a heap-only random marker, a
counter, open and unlinked files on the disk and a volume, and a DAX mapping; it pauses, exports,
destroys the box and its home, imports into an empty runtime and requires the same PID, marker and
execution to continue. It needs `/dev/kvm`, `make runtime:debug` and registry access for
`alpine:latest`.
