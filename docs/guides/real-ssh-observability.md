# Real SSH: observability wiring

Design (external source of truth, `boxlite_integration_test` repo, not checked
into this repository):
https://github.com/nieyy/boxlite_integration_test/blob/main/docs/designs/2026-07-23-boxlite-direct-tunnel-real-ssh-design-zh.md,
Phase 4 (`增加 listener readiness、auth result、sync lag、generation、resource
limit、identity mismatch dashboard/alert`).

**Status: NOT_IMPLEMENTED.** This document is a signal-mapping reference, not
a dashboard/alert implementation — no dashboard, alert rule, or panel exists
anywhere in this repository or any external system as a result of this work.
Confirmed by repo-wide search: no Grafana/Prometheus/Datadog/CloudWatch
config-as-code exists under this repository at any path (`apps/infra/`,
including `sst.config.ts`, defines no alarms; the only observability-adjacent
code is OTel trace instrumentation in `apps/api/src/main.ts` and
`apps/api/src/common/decorators/otel.decorator.ts`, which emits traces, not
dashboards or alerts). Production observability, if any, lives in an external
system this repo does not check in and that this environment has no access
to.

What follows instead documents the *actual signals this feature already
emits* — verified against the source, not invented — and a proposed alert
per signal, in a tool-agnostic form any target system could implement
against. That mapping is real and locally verified; the dashboards/alerts
built from it are not.

**Owner**: unassigned — no team/individual has been designated to own this
work; needs an explicit assignment before it can be scheduled.
**Target system**: undetermined — three candidates are named throughout this
doc (Grafana, Datadog, CloudWatch) as tool-agnostic illustrations, not a
decision; which one (if any) matches this repo's actual production
observability stack is unknown from within this repository and must be
confirmed with whoever owns that stack before implementation starts.

See the "Not locally verifiable" section at the end for exactly what is
blocked and its prerequisite.

## 1. Listener readiness

**Signal**: guest logs `ssh: listener ready` once, at `bound_addr` with the
host key `fingerprint`, when the russh listener successfully binds.
Source: `src/guest/src/service/ssh/mod.rs:139`.

Also queryable per-box, on demand, via the typed status call: `Ssh.Status()`
(guest RPC) → `SshHandle::status()` (`src/boxlite/src/litebox/ssh.rs`) →
`SshAccessSetStatus.listenerReady` (`apps/api/src/box/runner-adapter/ssh-access-set.adapter.ts`).
The same field is returned synchronously from every `reconcile()` call
(`apps/api/src/box/services/box-ssh-reconciliation.service.ts:86-93`, logged
at `LOG` level as `SSH access set reconciled for box <id>: ... listenerReady=<bool> ...`).

**Proposed alert**: `listenerReady=false` (or the guest log line absent) for
more than N minutes after a box reaches `STARTED` — the guest process is up
but its SSH listener failed to bind. Guest also logs
`SSH listener failed to start; guest SSH unavailable` (`src/guest/src/main.rs`)
on that specific failure path.

## 2. Auth result

**Signal**: every authentication attempt is logged, success and failure,
guest-side:
- `ssh: auth accepted` with the presented key's `fingerprint`
  (`src/guest/src/service/ssh/server.rs:122`).
- `ssh: auth rejected` with only the attempted `user` — never whether the
  fingerprint is registered, to avoid letting a log reader enumerate valid
  credentials (`src/guest/src/service/ssh/server.rs:127`).

**Proposed alert**: rejection-rate spike per box/fleet (e.g. >20
`auth rejected` events/minute from one source) — credential-stuffing or a
misconfigured client hammering a revoked key.

## 3. Sync lag (desired generation vs. applied)

**Signal**: `apps/api/src/box/services/box-ssh-reconciliation.service.ts`'s
`reconcile()` now logs on every successful apply (added as part of this
Phase 4 pass — previously only the failure path was logged):
`SSH access set reconciled for box <id>: generation=<n> listenerReady=<bool> accessCount=<n>`.
Failures log `SSH reconciliation failed for box <id> on start: <reason>`
(`box-ssh-reconciliation.service.ts:103`) or propagate as a typed
`ServiceUnavailableException` from `SshAccessSetAdapter`
(`apps/api/src/box/runner-adapter/ssh-access-set.adapter.ts:114-117`) on the
synchronous credential create/revoke paths.

**Known gap**: there is no persisted "last successfully applied generation"
column — `box_ssh_access_generation` only tracks the *next generation to
allocate*, not confirmation the guest applied it. Sync lag today is only
derivable by joining the reconcile-success log timestamps against
`box_ssh_access_generation.updatedAt` in a log/metrics pipeline, not via a
single SQL query. Persisting last-confirmed-generation is a reasonable
follow-up if this proves too coarse in practice; not done here to avoid
adding schema beyond what Phase 3 already shipped and verified.

**Proposed alert**: no successful reconcile log for a box within N minutes
of its `box_ssh_access_generation.updatedAt` advancing (i.e., the desired
state changed but the guest never confirmed catching up).

## 4. Generation

**Signal**: `box_ssh_access_generation.generation` (API desired,
monotonic per box) vs. the guest-confirmed `appliedGeneration` in every
reconcile-success log line (#3 above) and in the synchronous
`TemporarySshCredentialResponseDto`/`SshAccessSetResponse` returned from
create/revoke calls. Guest-side, every applied generation is logged at
`src/guest/src/service/ssh/rpc.rs:92` (`ssh: access set applied`).

**Proposed dashboard panel**: applied generation over time per box,
annotated with reconcile-triggering events (credential create/revoke, box
start).

## 5. Resource limits

**Signal**: guest logs every limit-triggered rejection, per connection and
per channel:
- `ssh: connection limit reached, dropping connection` at `peer_addr`
  (`src/guest/src/service/ssh/mod.rs:169`, bound: `MAX_CONNECTIONS = 128`,
  `src/guest/src/service/ssh/limits.rs:8`).
- `ssh: channel limit reached, rejecting channel open` with the current
  `open`/`limit` counts (`src/guest/src/service/ssh/server.rs:138-144`,
  added as part of this Phase 4 pass — the connection-limit case already
  logged, the channel-limit case previously rejected silently; bound:
  `MAX_CHANNELS_PER_CONNECTION = 16`, `limits.rs:11`).

API-side, `TemporarySshCredentialService.create` and `BoxAccessGrantService`
reject with `ConflictException`/`BadRequestError` on TTL, scope, and
duplicate-credential bounds (no dedicated log line today — these are
client-facing 4xx responses, not operational anomalies, so they weren't
added to the log-based signal set here).

**Proposed alert**: any `channel limit reached` or `connection limit
reached` event fleet-wide — these bounds exist specifically so that a
runaway or malicious client can't exhaust guest resources; a live hit means
either a real attack or a limit set too low for legitimate use, both
actionable.

## 6. Identity mismatch

**Signal**: `BoxSshIdentity.status` transitions to `DEGRADED` with a logged
cause, exactly once per unexplained mismatch:
`Unexplained SSH host identity change for box <id>: expected <fp>, observed
<fp>` (`apps/api/src/box/services/box-ssh-reconciliation.service.ts:154-156`,
`error` level). `TemporarySshCredentialService.create` additionally refuses
new credentials while a box is `DEGRADED`
(`apps/api/src/box/services/temporary-ssh-credential.service.ts:89-94`), so
a degraded box is also visible as a spike in that specific `ConflictException`.

**Proposed alert**: any `box_ssh_identity.status = DEGRADED` row, or the
`error`-level log line above — both should page, since design invariant #2
requires the parent grant *and* a matching active credential before SSH can
succeed at all, and a degraded identity silently blocks all new access
until an operator investigates.

## Not locally verifiable

**Status: NOT_IMPLEMENTED / BLOCKED_EXTERNAL.** No dashboard or alert exists
yet (NOT_IMPLEMENTED — nothing to implement it against was available, see
Owner/Target system above). Building one is additionally
BLOCKED_EXTERNAL: turning any of the six proposed alerts above into a *live*
dashboard/alert requires (a) a target system (Grafana/Datadog/CloudWatch —
none configured in this repo, and no decision recorded on which applies),
and (b) real traffic to observe non-synthetic values against. Neither is
available in this local environment, and neither can be resolved from within
this repository.

Prerequisite to unblock: an owner assigned, a target system confirmed with
whoever runs this org's production observability, and a staging deployment
with that backend wired to the existing structured-log pipeline (or a new
metrics emitter, if log-based alerting proves insufficient) — then
import/author the panels and alert rules described above against real
signal data.
