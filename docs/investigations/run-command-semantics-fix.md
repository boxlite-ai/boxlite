# `boxlite run` COMMAND: Docker Semantics Fix

**Date:** 2026-07-14
**Status:** Implemented — CLI integration suite 317/321 (the 4 failures
reproduce at the branch point with none of this applied); fmt + clippy clean
**Root cause:** see companion analysis (short-lived image init kills tenants); verified side-by-side vs podman 5.6.1

**Two-side verification** (per CLAUDE.md), stated precisely rather than
generally:
- The three `run_init_semantics` reproducers were run against a *full* revert
  of the production tree and observed failing for the right reasons (PID 1 is
  the image default; exit code never surfaced; procfs panic), then passing
  after restore.
- `main_command_gets_a_pty_when_tty_is_set`,
  `reaper_never_reaps_the_boxs_main_session`,
  `a_stopped_no_command_box_refuses_to_serve_its_dead_vm` and
  `a_failed_attached_start_does_not_poison_the_next_start` were each verified
  against a *targeted* revert of the one thing that causes the bug
  (`.terminal(false)`; the reaper's `SessionKind::Main` guard; the
  `live_state()` spent-handle check; the boot mode as a `BoxImpl` field rather
  than a parameter). Each failed with the right signal — the last two with
  "hand back the dead VM" and `incompatible container status: 'Created'` — and
  each control kept passing. Calling that "two-side verified" without the
  qualifier would overstate it.
- One correction worth recording, because it is the kind of mistake this
  section exists to catch. The first attempt at the poison proof re-introduced
  the boot mode as a `static`, and the first version of the test started a
  *different* box. Either flaw alone would have let a re-added per-`BoxImpl`
  field pass: a `static` is not the bug, and a different box is a different
  handle with a fresh field. Both were rewritten — the flag goes back on the
  handle, and the test drives one handle through a *transient* boot failure
  (the boxes directory made briefly unwritable, since a permanent failure like
  a bad image can never expose a stranded flag: the retry dies for the same
  reason and never reaches the pipeline).

---

## Objective

Make `boxlite run IMAGE [COMMAND...]` mean what it means everywhere else:
COMMAND replaces the image CMD, ENTRYPOINT is prepended, and the result **is
the container's init (PID 1)**. Today COMMAND is silently a `docker exec` in
`docker run` clothing, running beside a throwaway init built from the image
default — the direct cause of the dead-server / zombie-init / procfs-panic
class.

## Target contract (docker parity)

| Case | Behavior after fix |
|---|---|
| `run IMAGE cmd args…` | init = `ENTRYPOINT + [cmd args…]` (OCI matrix semantics) |
| `run IMAGE` (no COMMAND) | init = `ENTRYPOINT + CMD` (image default; today the CLI also execs a stray `sh`) |
| Foreground | attach to **init's** stdio; propagate init's exit code |
| `-d` | print box id; init keeps running; no extra exec |
| init exits | container → Stopped with exit code; box auto-stops; `list` shows it |
| `exec` after exit | refused by the host, without restarting the box (see §6); never a procfs panic |

## Current wiring (what changes)

1. `src/cli/src/commands/run.rs:37,74-75` — COMMAND → `litebox.exec()` tenant;
   never touches `options.cmd`. Empty COMMAND → literal `sh` fallback
   (`parse_command_args`).
2. `src/boxlite/src/portal/interfaces/container.rs:104` — init argv =
   `image_config.final_cmd()`; `BoxOptions.{entrypoint,cmd,user}` overrides
   already applied upstream (`litebox/init/tasks/container_rootfs.rs:266-274`)
   — **the plumbing below the CLI already exists**.
3. Guest: init stdio already lands in guest-held pipes
   (`src/guest/src/container/start.rs::create_container_with_stdio`,
   `container/stdio.rs::InitStdioFds`); tenants stream via
   `service/exec/executor.rs` pipes bridged to the exec RPC. Zygote is the
   parent of **both** init and tenants (`container/zygote.rs`) — only tenants
   are ever waited (`do_wait`).

## Design

Three pieces, one coherent unit (separately reviewable commits, one PR — piece
1 without 2+3 leaves foreground `run` mute and exit-code-less):

### 1. CLI wiring (small)
- `run.rs`: non-empty COMMAND → `options.cmd = Some(command)`; delete the
  tenant-exec of COMMAND and the `("sh")` fallback.
- `create.rs`: same mapping (create stores it; start boots it).
- Non-goal: `--entrypoint` flag (SDK's `BoxOptions.entrypoint` already covers
  it; add CLI surface only when asked).

### 2. Foreground attach = bridge init's existing pipes to the exec stream
- Reuse `InitStdioFds` pipes as the stream source; expose init as a streamable
  session over the **same** RPC the CLI already consumes for exec
  (`terminal/mod.rs` stays unchanged).
- TTY: init spec sets `process.terminal=true` via the existing console-socket
  machinery (`container/console_socket.rs`) — same path tenants use today.

### 3. Init lifecycle (kills the bug class)
- Reuse the zygote wait path for the init pid (it is already the parent;
  `do_wait` works unchanged) — surfaced to the host via the same wait RPC used
  for tenants.
- On init exit: record exit code, update libcontainer state → Stopped, stop
  the box (extend the existing "Auto-stopping non-detached box" seam to the
  detached case), persist via existing `exit.previous` / crash-report seams.
- Corollaries for free: no zombie init → no stale `Running` → libcontainer's
  existing `Running` check turns the procfs panic into a clean
  "container is not running" refusal. Status becomes honest.

### 4. Who names init's session (kata parity)

The host declares it. `ContainerInitRequest.execution_id` is set to
`container_id`, exactly as the kata runtime fills
`CreateContainerRequest{ExecId: c.id}` for init and a fresh uuid for every
later exec. The guest registers init under the id it is **handed**, and
`LiteBox::attach()` addresses it with the id it **sent**.

The rejected alternative was to let the guest derive `execution_id =
container_id` on its own side of the wire (what the first cut did). That
hard-codes one convention in two processes that never state it to each
other: change either side and attach fails at runtime with "session not
found". Naming is policy and belongs to the side that later dereferences the
name.

Method names follow the client convention rather than the wire: `attach()`
for the main command, `attach_exec(id)` for an exec session — moby's
`ContainerAttach` / `ContainerExecAttach` split. kata has no second verb
because its shim is not a client API; its equivalent of `attach()` is the
line that fills in `c.id`.

### 4b. A box dies three ways, and all three must report the code

The exit code is read through one helper, `record_main_command_exit`, from every
path a box can end on:

1. **`stop()`** — a deliberate stop. Takes the code the guest recorded on its way
   down, as `docker stop` leaves ExitCode 137 rather than 0.
2. **The live watcher** — the box ended itself, its main command having exited.
3. **`shutdown_sync`** — a *non-detached* box whose runtime went away. This is the
   one the sweep first missed, and it is not exotic: it is every
   `boxlite create` + `boxlite start`, because `create` does not set `detach`.
   It marked the box Stopped with a bare `mark_stop()` and no code, and
   `recover_boxes` could not backfill afterwards — its branch only fires on a box
   still marked Running. `inspect .State.ExitCode` answered 0 for a command that
   exited 23. Caught by
   `test_init_semantics_create_stores_the_command_as_init`, which only exists
   because a reviewer asked why `create IMAGE COMMAND` had no test.

### 5. The exit file is per-run, not per-container

`{container}/exit.json` describes *one run* of the main command — named for
the record conmon/podman keep per container (`exitFilePath`); the container's
exit *is* its init's exit (docker's `State.ExitCode`), so the directory
already says whose it is and an `init-` prefix would only restate it.
`Container.Init` deletes it before `Container::start`, and the host clears
`state.exit_code` when the box goes Running (as `docker start` resets
`ExitCode`).

Without that, a box that is stopped and started again inherits the exit its
last init died with — `stop` SIGKILLs init, the watcher records
`{"exit_code":137}`, and on restart the exec guard reads the stale record and
refuses every exec against a perfectly healthy container ("container is not
running: init exited"). The file had three consumers (watcher writes, exec
guard reads, host recovery reads) and no cleaner. Caught by
`lifecycle_journey` (stop → start → restart → exec) and
`stress_disk::box_restarts_cleanly_with_full_rootfs`.

The record's schema is owned by one type, `boxlite_shared::layout::ExitRecord`
— it crosses a process boundary (guest binary → host binary), and it had been
hand-rolled three different ways: a `format!` string in the writer, a raw text
dump into the guard's user-facing error, and untyped `serde_json::Value`
key-poking in the host. That is how a dead `signal` field survived: written by
the guest, read by nobody. Only the code is stored, in docker's `128 + n`
convention (what conmon/podman keep too); the guest logs the true `ExitStatus`
where it has diagnostic value. The guard keys off the file's *presence*, never
a successful parse — a torn record still means init is gone, and falling
through on a parse failure would hand the exec back to the procfs panic.

### 6. A finished box must not be restarted behind the user's back

`exec`, `attach`, `cp` and `metrics` all boot the VM lazily via `live_state()`,
and `Stopped` maps to the full restart pipeline. That was harmless while init
was the image default — an implicit restart just re-ran a daemon. It is not
harmless now: **init is the user's command**, so an implicit restart runs their
workload a second time.

    boxlite run --name job alpine sh -c 'send-payment'   # runs, exits
    boxlite cp job:/receipt .                            # would send it again

So those operations are gated — but on the *config*, not merely the status. The
hazard is not "the box is stopped", it is "restarting it would run the user's
workload again", and only a box the user gave a command has that property: its
init *is* that command. "Gave a command" means `cmd` **or** `--entrypoint` —
init's argv is `final_cmd()` = entrypoint ++ cmd, so either one alone makes init
the user's own program (`boxlite run --entrypoint /bin/send-payment alpine` has
no `cmd` at all).

A box without one boots the image's own default, and restarting that is not just
harmless but load-bearing — the SDK's create-then-exec model, and the cloud's
auto-stop, which revives an idle box on the next `/exec` and never calls start
(see Compatibility). Gating on status alone would have silently repealed it.

`can_exec()` already existed to express the status half and was dead code,
called only by its own unit test. It is now the gate's first check, with
`BoxImpl` owning the second — because only `BoxImpl` can see the config.

## Compatibility

- **SDK/daemon boxes (create-without-command, exec-many)**: unchanged — init =
  image default (e.g. boxlite-agent-base daemon), execs join it. This is the
  docker-consistent pod-ish pattern and keeps working.
- **Breaking (intentional, docker-consistent):** `run IMAGE quick-cmd` then
  `exec` later. Before: exec hit a zombie (procfs panic on bun-like images) or
  joined a still-alive image default (nginx-like). After: box is Stopped with
  the cmd's exit code; exec refuses cleanly and does not restart it — same as
  docker, which also treats `exec` on a non-running container as an error
  rather than an implicit `start`.
- Images whose default blocks (nginx, node) lose nothing; images whose default
  exits (oven/bun) go from silently-broken to working.
- **The `apps/` sweep (done, and it found one).** The cloud stops idle boxes on
  an `auto-stop-check` cron (`apps/api/src/box/managers/box.manager.ts`) and
  revives them on the *next SDK call*: the data-plane proxy
  (`boxlite-rest/boxlite-proxy.controller.ts`) forwards `/exec`, `/files` and
  `/metrics` to the runner and only bumps `lastActivityAt` — the string `start`
  appears nowhere in it. That auto-restart works solely because a Stopped box
  boots implicitly on `exec`.

  So the "don't re-run the main command" gate cannot key on status alone, or it
  silently repeals that contract. It keys on the *config*: only a box with an
  main command of its own — `cmd` or `--entrypoint`, since either lands in
  init's argv — refuses an implicit boot, because only that box's init is the
  user's own workload. A cloud box has neither (the façade mapper drops both, and
  the internal DTO has no such fields): its init is the agent-base daemon, and
  restarting that is the designed behaviour. Both sides are covered —
  `a_stopped_box_without_a_main_command_still_restarts_on_exec` and
  `test_init_semantics_cp_from_a_finished_job_does_not_rerun_it`, the latter using
  `--entrypoint` with no COMMAND precisely so a `cmd`-only rule would fail it.

## Verification (two-sided, per CLAUDE.md)

Integration tests mirroring the podman side-by-side (S1–S4), asserting on the
**fixed** semantics; each must fail on current main:
1. `run -d -p :80 oven/bun:1.2.1 bun -e 'Bun.serve(…)'` → curl 200 (fails
   today: 000).
2. Inside `run IMAGE sh -c 'tr "\0" " " </proc/1/cmdline'` → prints the user
   command (fails today: image default).
3. `run --rm IMAGE sh -c 'exit 42'` → host rc 42 **and** box Stopped/Exited
   (rc passes today; status fails).
4. `run -d oven/bun:1.2.1` (no cmd) → status Exited(0) within seconds; exec →
   clean "not running" error (fails today: Running + procfs panic).
5. nginx no-command parity: `run -d nginx:alpine` serves; exec works.

### Test suite

- `src/cli/tests/run_init_semantics.rs` — the CLI-level docker-parity contract:
  COMMAND-is-PID1, stop-on-exit + exit code, `128+n` on signal death,
  exec-after-exit refused-without-restart, cp-from-a-finished-job doesn't re-run
  it, `create IMAGE COMMAND` stores it, and `--user`/`-w` landing on *init* (they
  were exec-only before init became the command).
- `src/boxlite/tests/run_main_command.rs` — the library lifecycle: `run -t` PTY
  (with a pipes control), cloud auto-restart of a no-command box, spent-handle
  refusal on a dead VM, an adopted running box followed to its exit, the
  failed-attached-start poison guard, and self-stop restart refusal.
- `src/cli/tests/run_rest_e2e.rs` — the one true end-to-end for the REST data
  plane: spins up `boxlite serve`, and `run --url alpine sh -c 'echo …; exit 7'`
  must stream the output back and propagate the code — the path whose *breakage*
  (start-then-attach racing a fast command) was a release blocker, guarded before
  only at the unit level. Teardown drains the server's boxes first: box teardown
  over REST is async (exit → guest power-off → server watcher → `--rm` removal, a
  beat after the client returns), and `serve` runs its stop-everything path only
  on SIGINT, so killing it mid-window would leak a shim.
- Unit: `ExitRecord` wire format, serve reaper/main-session lookup, the `tty`
  create-wire mapping, `can_exec`.

### 7. create → attach → start, in that order

`run` attaches to the main command **before** it runs. The guest's
`Container.Init` creates the container and stops; the host attaches to init's
session; only then does it call `Container.Start`. That is docker's ordering, and
runc's create/start split, which the guest already had internally
(`create_container_with_stdio` and `start_container` were two calls fused inside
one RPC).

Start-then-attach is a race, and a quiet one. Init *is* the user's command now, so
`start()` runs it — and a command that finishes instantly (`run alpine echo hi`)
can be gone before the attach reaches the guest. The VM powers off, the box is
Stopped, and attaching is then *refused*, because restarting it would run the
command a second time (§6). `run` would print that refusal instead of `hi`, and
the output and exit code would be gone. The only thing holding that off was a
bounded flush window in the guest — a bet, not a guarantee, and the comment there
used to claim it wasn't load-bearing when it was.

Honest note on verification: the ordering fix is correct by construction, but I
could not *force* the old race to fire even with the flush window set to 0 — the
guest's exec drain delays power-off enough on its own. So this is a bet removed,
not a reproduced failure fixed. The window now genuinely only costs trailing
stdout: the client cannot be late, and the exit code comes from the exit file if
the Wait is cut.

`-d` still uses plain `start()`: nobody is reading, so there is nothing to be
early for.

### 8. Known deviation: `cp` to/from a box whose command is not running

`docker cp` works on a stopped container. Ours refuses, when the box has a main
command of its own and is not Running.

This is not an oversight, it is the honest end of a real constraint. Docker can
read a stopped container's files because its storage driver exposes the layer on
the *host*. A boxlite container's filesystem lives inside the VM's disk, so
reaching it means booting the VM — and booting runs init, which **is** the user's
command. The available options were therefore: refuse, or run someone's job as a
side effect of copying a file out of it. Refusing is the only defensible one.

Boxes without a main command are unaffected (they boot the image default, which
is what the cloud and the SDKs do), and volumes remain the way to get a job's
output onto the host — which is the usual pattern for jobs anyway.

**The follow-up that closes it** is a capability we do not have: mount the
container's filesystem without running it — runc's `create`-then-`start` split,
which we currently fuse into one `Container.Init`. The guest side is nearly free:
its file RPCs already resolve paths through
`layout.shared().container(id).rootfs_dir()` and never touch the container
registry, so a `Container.Init` that prepares the rootfs and stops short of
`Container::start` would serve them. The cost is all on the host: a VM booted for
file access is a lifecycle this codebase does not model — `live_state()` is a
`OnceCell`, so the first caller would fix the box's boot mode for the handle's
whole life, and a transient boot needs its own teardown or it leaks a VM. That is
a feature with a design, not a line in this change.

## Follow-ups

- **Init creation via the zygote** — `init-build-via-zygote.md` (designed):
  init's `build()` currently clone3s on the multi-threaded guest, the last
  site outside the zygote's fork-safety guarantee.
- **Exit code over REST** is surfaced on the box (`BoxResponse.exit_code`), but
  a REST client still cannot *wait* on the main command the way a local one
  can; `rt.run()`-style convenience is the SDK PR's problem.
- **Node/Python `BoxOptions` do not expose `cmd`/`tty`** — the SDK surface is
  `sdk-run-semantics-api.md`'s job. They compile at the defaults.
- **Reserved-id guard is deliberate**: init's session id = container id (the
  kata convention). Kata #11315 documents exec-id/container-id collision as a
  stream-leak vector; boxlite's exec handler already refuses duplicate
  execution_ids while the init session holds the id — do not "simplify" that
  check away.

## Open questions

1. Accept the intentional breaking change (exec-after-exit refused)? —
   recommended: yes, it is the docker contract.
2. Box teardown on init exit: stop only (keep VM bootable for `start` again,
   docker-like) — assumed; or full VM shutdown?
3. Anything in cloud/runner that depends on `run`'s implicit `sh` session? —
   **swept; nothing depends on the `sh` session**, but the cloud *does* depend
   on a stopped box restarting implicitly on `exec` (auto-stop → next SDK call).
   See Compatibility above; the gate keys on the box's *config* (`cmd` or
   `--entrypoint`), not on its status, because of it.
