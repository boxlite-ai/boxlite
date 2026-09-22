# Collapse `start_attached` / `defer_container_start` into `attach` + `start`

**Date:** 2026-07-15
**Status:** Implemented
**Depends on:** run-command-semantics-fix.md (create/start split, exec-session model)

---

## Problem

The run-command work grew a boot/attach surface of five entry points plus a
threaded flag:

    start, start_attached, attach, attach_exec, exec        + defer_container_start

`start_attached` existed to guarantee docker's create → attach → start ordering:
a command that finishes instantly (`run alpine echo hi`) must have a client on
its stream *before* init runs, or its output and exit code die with the VM before
the attach lands. `defer_container_start` was the flag that made it possible —
booting a box and running its container's init were **one pipeline step**, so the
only way to insert an attach between them was to tell the boot to stop after
`Container.Init`.

The whole apparatus traces to that fusion: **boot ran the container.** Every
`start_attached`, every `defer_container_start`, exists to bolt an attach-point
into a boot that would otherwise start init on its own.

An output-buffer bus was considered (drain stdio from create so a late attach can
replay) and rejected: the bus lives in the guest and dies with the VM on
power-off, so it cannot serve an attach that arrives after the box stops — it
does not remove the ordering requirement, only widens the window.

## Fix: boot creates, `start` runs

Split the fused step. Booting now *only creates* the container (`Container.Init`);
running its init (`Container.Start`) is a separate, explicit step.

- **`ensure_booted`** — VM up, guest connected, container created. Idempotent
  (`OnceCell`), holds the spent-handle guard.
- **`ensure_container_started`** — runs init exactly once, `OnceCell`-single-
  flighted so the implicit-boot funnel and an explicit `start()` cannot double-run
  it; pre-set when reattaching to a box whose init is already running.
- **`live_state`** (the implicit-boot funnel: `exec`, `cp`, `metrics`) =
  `ensure_booted` + `ensure_container_started`. Unchanged behaviour — these still
  get a *running* container, as they did when boot ran it.
- **`start`** = `ensure_booted` + `ensure_container_started`; admits `Running` so
  a box brought up by a bare `attach()` still gets its init run; fires
  `on_box_started` only when this call actually ran it.
- **`attach`** = `ensure_booted` + subscribe. Boots without running init, so it
  can attach before `start()`. It never runs the user's command, so it drops the
  re-run guard the others keep; it does refuse a stopped box (nothing to follow).

`run` foreground is now `attach()` then `start()` — create → attach → start,
composed at the call site. `start_attached` and `defer_container_start` are gone.

## REST

The same split over the wire: `GET /attach` boots + subscribes (no run),
`POST /start` runs init. `run --url` calls `attach()` then `start()`, identical to
local. `start_box` was made to drop only a *spent* cached handle — a `Running`
one, just booted by `/attach` mid-run, is kept so `/start` runs its container
instead of dropping the live VM.

## Idempotency & the state machine

Boot sets status `Running` (VM up), so `start()` cannot key idempotency on the box
status — a box booted by `attach()` reports `Running` with its container not yet
started. `container_start: OnceCell<()>` tracks the container step instead: unset
after a fresh boot, pre-set on reattach, set once when init runs. A failed boot
leaves both the `live` cell and `container_start` empty, so the next `start()`
boots and runs normally (this replaces the flag-poisoning hazard the old parameter
guarded against).

## Verification

- Local docker-run semantics: `run_init_semantics` 8/8 (COMMAND=init, `--user`,
  `-w`, signals, exit codes, instant commands).
- `run_main_command`: PTY + pipes, exec-restart, self-stopped refusals, failed
  boot does not poison the next start, and `attach()` refuses a stopped box
  (new; two-sided verified against the gate).
- REST round-trip: `run_over_rest_streams_output_and_propagates_exit_code`.
- Regression: CLI `exec` 18/18, CLI `run` 53/53, working-dir / timeout / user.

## Non-goals

- No change to the create/start RPC split or the `execution_id == container_id`
  naming.
- `attach` + `attach_exec` are not merged here (a separate surface question).
