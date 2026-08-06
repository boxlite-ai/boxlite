# Container Lifecycle Hook System — Alpha Test Plan

## Scope

Alpha = Phase 1 from the design doc: core infrastructure (host-exec, in-process
trait, CLI). GuestExec, snapshot hooks, restore hooks, and SDK surfaces are
out of scope.

| Area | In alpha | Deferred |
|------|----------|----------|
| `Hook` types + serde round-trip | Yes | — |
| `HookContext` JSON / env-var serialization | Yes | — |
| `$BOXLITE_*` variable substitution | Yes | — |
| `HookRunner::fire()` ordering, condition eval, error dispatch | Yes | — |
| `HostExec` strategy (spawn, stdin pipe, capture, timeout, kill) | Yes | — |
| `Hook` trait (in-process) | Yes | — |
| `fire_count` persistence | Yes | — |
| Tracing spans | Yes | — |
| CLI flags (`--hook`, `--hook-json`, `--hook-arg`, modifiers) | Yes | — |
| Wire `fire()` into `BoxImpl::{start, stop, exec}` | Yes | — |
| Wire `fire()` into `RuntimeImpl::create_box()` | Yes | — |
| `GuestExec` strategy | No | Phase 2 |
| Snapshot / restore hook points | No | Phase 3 |
| Python / Node / Go / C SDK | No | Phase 4 |
| REST API hook validation | No | Phase 4 |

## Test Environment

```
Rust:      cargo test / cargo nextest
OS:        Linux (KVM available for integration tests)
Features:  --features krun,gvproxy (integration); no special features (unit)
CLI:       built debug binary at target/debug/boxlite
```

## Module: Types & Serialization

File: `src/boxlite/src/hooks/mod.rs` (tests inline or in `tests/types.rs`)

### T-SERDE-01 — Hook round-trip JSON

```
Given:  a Hook with all fields set to non-default values
When:   serialized to JSON, then deserialized
Then:   the result equals the original
```

```json
{
  "name": "my-hook",
  "point": "post-exec",
  "action": {
    "type": "host-exec",
    "program": "/usr/bin/curl",
    "args": ["-X", "POST", "$BOXLITE_BOX_ID"],
    "env": [["DEBUG", "1"]]
  },
  "enabled": false,
  "priority": 5,
  "timeout_secs": 60,
  "condition": {
    "kind": "exec-result",
    "trigger": "on-failure"
  },
  "on_error": {
    "retry": {
      "max_retries": 3,
      "backoff_secs": 2,
      "on_exhausted": "continue"
    }
  }
}
```

### T-SERDE-02 — Hook with all defaults (minimal JSON)

```
Given:  {"name":"h","point":"post-create","action":{"type":"host-exec","program":"true","args":[]}}
When:   deserialized
Then:   enabled=true, priority=0, timeout_secs=30, condition=None, on_error=Continue
```

### T-SERDE-03 — HookAction tag discriminator

```
Given:  {"type":"host-exec","program":"ls","args":[]}
When:   deserialized as HookAction
Then:   matches HostExec { program: "ls", args: [], env: [] }

Given:  {"type":"guest-exec","command":"ls","args":[],"user":null,"working_dir":null}
When:   deserialized as HookAction
Then:   matches GuestExec { command: "ls", args: [], env: [], user: None, working_dir: None }

Given:  {"type":"guest-exec","command":"/bin/sh","args":["-c","init.sh"],"user":"agent","working_dir":"/opt/app"}
When:   deserialized as HookAction
Then:   matches GuestExec { command: "/bin/sh", args: ["-c","init.sh"], env: [], user: Some("agent"), working_dir: Some("/opt/app") }
```

### T-SERDE-04 — Unknown variant rejection

```
Given:  {"type":"invalid","program":"ls","args":[]}
When:   deserialized as HookAction
Then:   Err (serde error about unknown variant)
```

### T-SERDE-05 — HookErrorPolicy variants

```
Given:  "continue" / "fail" / {"retry":{"max_retries":2,"backoff_secs":1,"on_exhausted":"fail"}}
When:   each deserialized
Then:   Continue / Fail / Retry { max_retries: 2, backoff_secs: 1, on_exhausted: Fail }
```

### T-SERDE-05b — OnExhausted standalone deserialization

```
Given:  "continue" / "fail"
When:   each deserialized as OnExhausted
Then:   Continue / Fail
```

### T-SERDE-06 — ExecHookTrigger variants

```
Given:  "always" / "on-success" / "on-failure" / {"exit-code":42} / {"command-matches":"pip*"}
When:   each deserialized
Then:   Always / OnSuccess / OnFailure / ExitCode(42) / CommandMatches("pip*")
```

### T-SERDE-07 — HookCondition tagged enum

```
Given:  {"kind":"exec-result","trigger":"on-success"}
When:   deserialized
Then:   HookCondition::ExecResult { trigger: ExecHookTrigger::OnSuccess }
```

### T-SERDE-08 — HookPoint kebab-case serialization

```
Given:  HookPoint::PostCreate
When:   serialized to JSON string
Then:   "post-create"

Given:  HookPoint::PreStart
When:   serialized to JSON string
Then:   "pre-start"
```

(Verify all 11 variants round-trip through their kebab-case names.)

## Module: HookContext

File: `src/boxlite/src/hooks/context.rs` (tests inline)

### T-CTX-01 — JSON serialization for HostExec

```
Given:  HookContext for post-exec with exit_code=0, exec_command=["pip","install"]
When:   serialized to JSON
Then:   all fields present; box_id, container_id are strings;
        hook_point is "post-exec"; box_status is "running" (BoxStatus kebab-case);
        exit_code=0; exec_command=["pip","install"];
        exec_duration_ms is a u64; snapshot_name is null
```

### T-CTX-02 — Env-var serialization for GuestExec

```
Given:  HookContext with box_id="bx1", hook_point=PostStart, exit_code=None
When:   serialized to env-var map
Then:   BOXLITE_BOX_ID=bx1, BOXLITE_HOOK_POINT=post-start,
        BOXLITE_EXIT_CODE="" (empty string), BOXLITE_SNAPSHOT_NAME=""
```

### T-CTX-03 — Pre-exec context (exit_code is None)

```
Given:  HookContext::for_pre_exec(box_id, container_id, command, duration=None)
When:   serialized
Then:   exit_code is null/absent, exec_duration_ms is null/absent,
        exec_command == ["sh", "-c", "echo hi"]
```

### T-CTX-04 — Snapshot context (snapshot_name present)

```
Given:  HookContext for pre-snapshot with snapshot_name="my-snap"
When:   serialized
Then:   snapshot_name="my-snap"; exit_code and exec_command are null/empty
```

## Module: Variable Substitution

File: `src/boxlite/src/hooks/runner.rs` (tests in `tests/substitution.rs`)

### T-SUB-01 — Single variable substitution in args

```
Given:  args=["snapshot","$BOXLITE_BOX_ID","--name","latest"], ctx.box_id="bxp8k2m"
When:   substitute(ctx, args)
Then:   ["snapshot","bxp8k2m","--name","latest"]
```

### T-SUB-02 — Multiple variables in single arg

```
Given:  args=["--msg=$BOXLITE_BOX_ID:$BOXLITE_HOOK_POINT"], ctx.box_id="bx1", ctx.hook_point=PostStart
When:   substitute(ctx, args)
Then:   ["--msg=bx1:post-start"]
```

### T-SUB-03 — Variable substitution in env values

```
Given:  env=[("BOX","$BOXLITE_BOX_ID"),("POINT","$BOXLITE_HOOK_POINT")], ctx.box_id="bx1", ctx.hook_point=PostStart
When:   substitute in env values
Then:   [("BOX","bx1"),("POINT","post-start")]
```

### T-SUB-04 — Unrecognized variable left as-is

```
Given:  args=["$BOXLITE_UNKNOWN_VAR"], ctx with no such field
When:   substitute(ctx, args)
Then:   ["$BOXLITE_UNKNOWN_VAR"]
```

### T-SUB-05 — No $BOXLITE_ prefix left as-is

```
Given:  args=["$HOME","$PATH","literal"]
When:   substitute(ctx, args)
Then:   ["$HOME","$PATH","literal"]
```

### T-SUB-06 — Empty variables for non-applicable context

```
Given:  ctx for PostStart (exit_code=None, exec_command=None, snapshot_name=None)
When:   substitute "$BOXLITE_EXIT_CODE", "$BOXLITE_EXEC_COMMAND", "$BOXLITE_SNAPSHOT_NAME"
Then:   all replaced with "" (empty string)
```

### T-SUB-07 — Integer values stringified

```
Given:  ctx.fire_count=42, ctx.exit_code=Some(137), ctx.exec_duration_ms=Some(4200)
When:   substitute each
Then:   "42", "137", "4200"
```

### T-SUB-08 — All 11 variables present and substituted

```
Given:  a fully-populated HookContext
When:   substitute each of the 11 documented variables
Then:   each replaced with the correct string value; no variable left unsubstituted
        except for intentionally non-applicable ones (empty)
```

## Module: HookRunner::fire()

File: `src/boxlite/src/hooks/runner.rs` (tests in `tests/runner.rs`)

### T-RUN-01 — No hooks, no error

```
Given:  HookRunner with empty trait_hooks and declarative_hooks
When:   fire(HookPoint::PostStart, ctx, guest=None)
Then:   returns Ok(())
```

### T-RUN-02 — Single enabled hook fires

```
Given:  one HostExec hook: program="true", enabled=true
When:   fire()
Then:   hook executes; exit_status.success(); fire() returns Ok(())
```

### T-RUN-03 — Disabled hook skipped

```
Given:  one HostExec hook: program="false", enabled=false
When:   fire()
Then:   hook is NOT executed; fire() returns Ok(())
```

### T-RUN-04 — Priority ordering

```
Given:  three hooks with priorities 10, 0, 5 (all HostExec, program="true")
When:   fire()
Then:   execution order is priority 0, then 5, then 10
```

### T-RUN-05 — Equal priority: trait before declarative

```
Given:  one trait hook (priority 0), one declarative hook (priority 0)
When:   fire()
Then:   trait hook executes before declarative hook
```

### T-RUN-06 — Condition: OnSuccess skips on failure

```
Given:  HostExec hook with condition=ExecResult(OnSuccess)
When:   fire(PostExec, ctx with exit_code=Some(1))
Then:   hook is skipped; fire() returns Ok(())
```

### T-RUN-07 — Condition: OnSuccess fires on success

```
Given:  HostExec hook with condition=ExecResult(OnSuccess), program="true"
When:   fire(PostExec, ctx with exit_code=Some(0))
Then:   hook executes
```

### T-RUN-08 — Condition: OnFailure skips on success

```
Given:  HostExec hook with condition=ExecResult(OnFailure)
When:   fire(PostExec, ctx with exit_code=Some(0))
Then:   hook is skipped
```

### T-RUN-09 — Condition: ExitCode(n) exact match

```
Given:  hook with condition=ExecResult(ExitCode(42))
When:   fire(PostExec, ctx with exit_code=Some(42))
Then:   hook executes

When:   fire(PostExec, ctx with exit_code=Some(0))
Then:   hook skipped
```

### T-RUN-10 — Condition: CommandMatches glob

```
Given:  hook with condition=ExecResult(CommandMatches("pip*")), program="true"
When:   fire(PostExec, ctx with exec_command=["pip","install","-r","req.txt"])
Then:   hook executes

When:   fire(PostExec, ctx with exec_command=["python","agent.py"])
Then:   hook skipped
```

### T-RUN-11 — Condition: CommandMatches wildcard patterns

```
Given:  glob "pip*"
Then:   matches "pip", "pip3", "pip3.12"
Then:   does NOT match "python3 -m pip" (checks argv[0] only)

Given:  glob "pip"
Then:   matches "pip" (exact)
Then:   does NOT match "pip3"
```

### T-RUN-12 — Condition: None always fires

```
Given:  hook with condition=None, program="true"
When:   fire() regardless of ctx
Then:   hook always executes
```

### T-RUN-13 — OnError::Continue after non-zero exit

```
Given:  hook with on_error=Continue, program="false" (exits 1)
When:   fire()
Then:   fire() returns Ok(()); warning is logged
```

### T-RUN-14 — OnError::Fail after non-zero exit

```
Given:  hook with on_error=Fail, program="false" (exits 1)
When:   fire()
Then:   fire() returns Err(...); remaining hooks in chain NOT executed
```

### T-RUN-15 — OnError::Fail stops chain at first failure

```
Given:  hook-A (priority 0, on_error=Fail, program="false"),
        hook-B (priority 1, program="true")
When:   fire()
Then:   hook-A fails; hook-B never executes; fire() returns Err
```

### T-RUN-16 — OnError::Continue keeps chain going

```
Given:  hook-A (priority 0, on_error=Continue, program="false"),
        hook-B (priority 1, program="true")
When:   fire()
Then:   hook-A fails; hook-B still executes; fire() returns Ok(())
```

### T-RUN-17 — Retry: success on second attempt

```
Given:  hook with on_error=Retry { max_retries: 3, backoff_secs: 0, on_exhausted: Continue }
        program="./flaky.sh" (fails once, succeeds after)
When:   fire()
Then:   first attempt fails; retry succeeds; fire() returns Ok(()); total executions = 2
```

### T-RUN-18 — Retry: exhausts all retries, applies on_exhausted

```
Given:  hook with on_error=Retry { max_retries: 2, backoff_secs: 0, on_exhausted: Fail }
        program="false" (always fails)
When:   fire()
Then:   3 attempts (initial + 2 retries); on_exhausted=Fail applied; fire() returns Err
```

### T-RUN-19 — Retry: exhausts with Continue

```
Given:  on_error=Retry { max_retries: 1, backoff_secs: 0, on_exhausted: Continue }
        program="false"
When:   fire()
Then:   2 attempts; on_exhausted=Continue; next hook still runs; fire() returns Ok(())
```

### T-RUN-20 — Retry count is correct (fast, backoff_secs=0)

```
Given:  hook with on_error=Retry { max_retries: 2, backoff_secs: 0, on_exhausted: Fail }
        program="./counter.sh" (fails exactly 2 times, succeeds on 3rd)
When:   fire()
Then:   3 total executions (initial + 2 retries); fire() returns Ok(())
```

### T-RUN-20b — Retry backoff timing (simulated time)

```
Given:  hook with on_error=Retry { max_retries: 2, backoff_secs: 5, on_exhausted: Continue }
        program="false" (always fails)
When:   fire() with tokio::time::advance (or #[ignore] for real-time CI skip)
Then:   total elapsed >= 10 s (2 retries × 5 s backoff); plus execution time
```

### T-RUN-21 — Timeout kills HostExec

```
Given:  hook with timeout_secs=1, program="sleep 30"
When:   fire()
Then:   child receives SIGTERM ~1 s after start; after 5 s grace, SIGKILL;
        fire() returns timeout error; on_error policy applied
```

### T-RUN-22 — Timeout with on_error=Continue

```
Given:  hook with timeout_secs=1, on_error=Continue, program="sleep 30"
When:   fire()
Then:   timeout occurs; warning logged; fire() returns Ok(())
```

### T-RUN-23 — HostExec program not found

```
Given:  hook with program="/nonexistent/binary"
When:   fire()
Then:   spawn error; on_error policy applied
```

### T-RUN-24 — HostExec stdin pipe contains context JSON

```
Given:  hook with program="cat" (reads stdin to stdout)
When:   fire()
Then:   captured stdout matches the JSON-serialized HookContext
```

### T-RUN-25 — HostExec stdout captured at INFO

```
Given:  hook with program="echo hello"
When:   fire()
Then:   stdout captured; tracing::info! emitted with hook_output field containing "hello\n"
```

### T-RUN-26 — HostExec stderr captured on failure

```
Given:  hook with program="sh", args=["-c","echo err >&2; exit 1"]
When:   fire()
Then:   stderr captured; tracing::warn! emitted with hook_output containing "err\n"
```

### T-RUN-27 — GuestExec skipped when guest is None

```
Given:  GuestExec hook at PostExec (where guest=None)
When:   fire(PostExec, ctx, guest=None)
Then:   hook is skipped with a tracing::debug! message
```

### T-RUN-28 — Trait hook fires

```
Given:  a Hook impl that records invocations
When:   fire(point matching the impl's points())
Then:   on_<point> called exactly once with correct HookContext
```

### T-RUN-29 — Trait hook returning Err on pre- hook aborts

```
Given:  trait hook on PreStart returning Err(BoxliteError::...)
When:   fire(PreStart, ctx, guest=None)
Then:   fire() returns Err; this matches the "Yes" error-semantics for PreStart
```

### T-RUN-30 — Trait hook returning Err on post- hook is logged

```
Given:  trait hook on PostStart returning Err(...)
When:   fire(PostStart, ctx, guest=...)
Then:   error is logged; fire() returns Ok(()); next hook still runs
```

## Module: HostExec Strategy

File: `src/boxlite/src/hooks/host_exec.rs` (tests inline)

### T-HEXEC-01 — Basic spawn and wait

```
Given:  program="true", args=[]
When:   HostExec::run(hook, ctx)
Then:   returns Ok(ExitStatus::success())
```

### T-HEXEC-02 — Non-zero exit captured

```
Given:  program="false", args=[]
When:   HostExec::run(...)
Then:   returns Ok(ExitStatus with code=1); stdout/stderr captured
```

### T-HEXEC-03 — Stdin receives context JSON

```
Given:  program="cat", args=[] (reads stdin to stdout), ctx.box_id="test-box-123"
When:   HostExec::run(...)
Then:   captured stdout parses as valid JSON; .box_id field == "test-box-123"
```

### T-HEXEC-04 — Env vars merged

```
Given:  hook.env=[("MY_VAR","my_value")], current env has PATH
When:   child spawned
Then:   child's env contains MY_VAR=my_value AND PATH (inherited)
```

### T-HEXEC-05 — $BOXLITE_* substitution applied before spawn

```
Given:  hook.args=["--id","$BOXLITE_BOX_ID"], ctx.box_id="bx1"
When:   HostExec::run(...)
Then:   child receives argv=["--id","bx1"]
```

### T-HEXEC-06 — Timeout SIGTERM then SIGKILL

```
Given:  program="sleep", args=["60"], timeout_secs=1
When:   HostExec::run(...)
Then:   child killed (SIGTERM at ~1s, SIGKILL at ~6s);
        function returns Err(timeout)
```

### T-HEXEC-07 — Child process group killed

```
Given:  program="sh", args=["-c","sleep 60 & sleep 60 & wait"], timeout_secs=1
When:   HostExec::run(...)
Then:   all processes in group killed (no orphans)
```

### T-HEXEC-08 — Args with spaces passed correctly

```
Given:  args=["echo","hello world"]
When:   HostExec::run(...)
Then:   child sees ["echo","hello world"] as two args; stdout="hello world\n"
        (not ["echo","hello","world"] because args are NOT shell-split)
```

## Module: fire_count Persistence

File: `src/boxlite/src/hooks/fire_count.rs` (tests inline)

### T-FC-01 — First fire returns 1

```
Given:  declarative hook never fired before
When:   fire_count = increment_and_get(box_id, hook_name)
Then:   fire_count == 1
```

### T-FC-02 — Increment across fires

```
Given:  hook fired 3 times previously
When:   fire_count = increment_and_get(box_id, hook_name)
Then:   fire_count == 4
```

### T-FC-03 — Persisted in box state database

```
Given:  hook fired twice; box persisted to DB
When:   runtime restarts and loads box; read fire_count for same hook_name
Then:   fire_count == 2
```

### T-FC-04 — Per-hook isolation

```
Given:  hook-A fired 5 times, hook-B fired 3 times (same box)
When:   read both fire_counts
Then:   hook-A fire_count=5, hook-B fire_count=3
```

### T-FC-05 — Per-box isolation

```
Given:  hook "auto-snapshot" fired 3 times on box-1, 1 time on box-2
When:   read fire_counts
Then:   box-1 fire_count=3, box-2 fire_count=1
```

### T-FC-06 — Trait hooks reset on re-registration

```
Given:  trait hook registered, fires 2 times, runtime restarts, re-registered
When:   first fire after restart
Then:   fire_count == 1 (not 3)
```

## Module: Tracing

File: `src/boxlite/src/hooks/runner.rs` (verify via test subscriber)

### T-TRACE-01 — Span contains box.id and hook.name

```
Given:  hook with name="test-hook", ctx.box_id="bx-trace"
When:   fire()
Then:   tracing span emitted with fields: box.id="bx-trace", hook.name="test-hook",
        hook.point="post-start", hook.fire_count=N
```

### T-TRACE-02 — HostExec success logs at INFO

```
Given:  HostExec hook with program="true"
When:   fire()
Then:   log at INFO level contains hook_output field with captured stdout
```

### T-TRACE-03 — HostExec failure logs at WARN

```
Given:  HostExec hook with program="false"
When:   fire()
Then:   log at WARN level contains hook_output field with captured stderr
```

### T-TRACE-04 — Hook skip logged at DEBUG

```
Given:  disabled hook or condition-mismatched hook
When:   fire()
Then:   log at DEBUG level indicates hook was skipped with reason
```

## Integration: Wire Into Box Lifecycle

File: `src/boxlite/tests/` (integration tests, require `--features krun,gvproxy`)

### T-INT-01 — PostCreate fires on Runtime.create()

```
Given:  BoxOptions with a post-create HostExec hook: program="sh", args=["-c","touch /tmp/created-$BOXLITE_BOX_ID"]
When:   rt.create(opts).await
Then:   hook fires BEFORE create() returns; /tmp/created-<box_id> exists
```

### T-INT-02 — PostCreate does NOT fire on restart/reattach

```
Given:  box with post-create hook was created and persisted; runtime restarts
When:   rt.get(box_id).await  (load from DB, not create)
Then:   hook does NOT fire a second time
```

### T-INT-03 — PreStart fires before Container.Start

```
Given:  box with pre-start hook: program="sh", args=["-c","echo started > /tmp/pre-start-test"]
When:   bx.start().await
Then:   /tmp/pre-start-test contains "started"; hook fires BEFORE container init runs
        (verify by checking hook output timestamp vs container start timestamp in logs)
```

### T-INT-04 — PreStart with on_error=Fail aborts start

```
Given:  pre-start hook with on_error=Fail, program="false" (exits 1)
When:   bx.start().await
Then:   start() returns Err; box remains in Configured state; container init NOT run
```

### T-INT-05 — PreStart with on_error=Continue allows start

```
Given:  pre-start hook with on_error=Continue, program="false"
When:   bx.start().await
Then:   warning logged; start() succeeds; box reaches Running state
```

### T-INT-06 — PostStart fires after init is running

```
Given:  box with post-start hook: program="sh", args=["-c","echo $BOXLITE_BOX_STATUS > /tmp/post-start-status"]
When:   bx.start().await
Then:   /tmp/post-start-status contains "running" (container init is running at hook time)
```

### T-INT-07 — PreStop fires before guest shutdown

```
Given:  box running, pre-stop hook: program="sh",
        args=["-c","date +%s > /tmp/pre-stop-time"]
When:   bx.stop().await; then check /tmp/pre-stop-time and stop completion time
Then:   /tmp/pre-stop-time exists; the timestamp in the file is earlier than
        the time stop() returned (hook ran before Guest.Shutdown completed)
```

### T-INT-08 — PreStop with on_error=Continue does not block stop

```
Given:  pre-stop hook with on_error=Continue, program="false"
When:   bx.stop().await
Then:   warning logged; stop() succeeds; box reaches Stopped
```

### T-INT-09 — PostStop fires after shim exits

```
Given:  box running, post-stop hook: program="sh", args=["-c","! pgrep -a boxlite-shim"]
When:   bx.stop().await
Then:   hook fires after shim has exited; shim PID no longer in process table
```

### T-INT-10 — PreExec fires before Exec RPC

```
Given:  box running with pre-exec hook: program="sh", args=["-c","touch /tmp/pre-exec-$BOXLITE_BOX_ID"]
When:   bx.exec(BoxCommand::new("echo hello")).await
Then:   /tmp/pre-exec-<box_id> exists; exec RPC sent AFTER hook returns
```

### T-INT-11 — PreExec with on_error=Fail aborts exec

```
Given:  box running, pre-exec hook with on_error=Fail, program="false"
When:   bx.exec(BoxCommand::new("echo hello")).await
Then:   exec() returns Err; "echo hello" never executed in container
```

### T-INT-12 — PostExec fires after Wait returns

```
Given:  box running with post-exec hook: program="sh", args=["-c","[ $BOXLITE_EXIT_CODE = 42 ]"]
When:   bx.exec(BoxCommand::new("sh -c 'exit 42'")).await; wait for completion
Then:   hook fires with exit_code=42; hook exits 0
```

### T-INT-13 — PostExec condition OnSuccess fires only on success

```
Given:  post-exec hook with condition=ExecResult(OnSuccess), program="touch /tmp/success"
When:   bx.exec(BoxCommand::new("true")).await   # exits 0
Then:   /tmp/success exists

When:   bx.exec(BoxCommand::new("false")).await  # exits 1
Then:   hook skipped; /tmp/success still exists from first exec only
```

### T-INT-14 — PostExec condition CommandMatches filters by command

```
Given:  post-exec hook with condition=ExecResult(CommandMatches("pip*")), program="touch /tmp/pip-ran"
When:   bx.exec(BoxCommand::new("pip install requests")).await
Then:   /tmp/pip-ran exists

When:   bx.exec(BoxCommand::new("ls -la")).await
Then:   hook skipped; /tmp/pip-ran unchanged
```

### T-INT-15 — Multiple hooks fire in priority order

```
Given:  three post-exec hooks (priority 30, 10, 20) each appending their priority to /tmp/order
When:   bx.exec(BoxCommand::new("true")).await
Then:   /tmp/order contains "10\n20\n30\n"
```

### T-INT-16 — Disabled hook does not fire

```
Given:  post-exec hook with enabled=false, program="touch /tmp/should-not-exist"
When:   bx.exec(BoxCommand::new("true")).await
Then:   /tmp/should-not-exist does NOT exist
```

### T-INT-17 — Hook timeout does not hang box operation

```
Given:  pre-start hook with timeout_secs=2, program="sleep 300"
When:   bx.start().await
Then:   returns within ~7 s (2s timeout + 5s grace); hook killed; start aborted
```

### T-INT-18 — Empty hooks list is a no-op

```
Given:  BoxOptions with hooks=[] (default)
When:   create, start, exec, stop
Then:   all operations succeed with no hook-related latency
```

### T-INT-19 — Hook trait fires in integration

```
Given:  a Hook trait impl that records calls in a shared AtomicUsize
When:   registered via runtime option; box goes through create→start→exec→stop
Then:   trait's on_post_create, on_pre_start, on_post_start, on_pre_exec,
        on_post_exec, on_pre_stop, on_post_stop all called exactly once
```

### T-INT-20 — HookContext fields populated in real usage

```
Given:  post-start hook: program="sh", args=["-c","cat > /tmp/ctx.json"]
When:   start()
Then:   /tmp/ctx.json contains valid JSON with box_id matching the created box,
        container_id non-empty, hook_point="post-start", box_status="running",
        image matching the BoxOptions image
```

## CLI Tests

File: `src/cli/tests/` or shell-based integration in `tests/cli/`

**Mechanism**: Most CLI tests are **parser unit tests** — they call the CLI
argument parser directly and assert the resulting `BoxOptions.hooks` fields
(no subprocess, no KVM, fast). Error-path tests (T-CLI-13 through T-CLI-16)
additionally run the binary as a subprocess to verify the exit code and error
message.

### T-CLI-01 — --hook simple syntax

```
When:   boxlite run alpine:latest --hook my-hook:post-start:host:echo --hook-arg hello -- echo world
Then:   hook "my-hook" configured as HostExec at PostStart; program="echo", args=["hello"]
```

### T-CLI-02 — --hook-arg with $BOXLITE_* variables

```
When:   boxlite run alpine:latest \
          --hook snap:post-exec:host:boxlite \
          --hook-arg snapshot \
          --hook-arg '$BOXLITE_BOX_ID' \
          -- true
Then:   hook args=["snapshot","$BOXLITE_BOX_ID"] (variable preserved, resolved at fire time)
```

### T-CLI-03 — --hook-json full configuration

```
When:   boxlite run alpine:latest --hook-json '{"name":"h","point":"post-exec","action":{"type":"host-exec","program":"true","args":[]},"condition":{"kind":"exec-result","trigger":"on-success"}}' -- true
Then:   hook configured with condition=ExecResult(OnSuccess)
```

### T-CLI-04 — --hook-on-error modifier

```
When:   --hook h:post-start:host:true --hook-on-error h=fail
Then:   hook.on_error=Fail
```

### T-CLI-05 — --hook-timeout modifier

```
When:   --hook h:post-start:host:true --hook-timeout h=45
Then:   hook.timeout_secs=45
```

### T-CLI-06 — --hook-priority modifier

```
When:   --hook h:post-start:host:true --hook-priority h=100
Then:   hook.priority=100
```

### T-CLI-07 — --hook-enabled modifier

```
When:   --hook h:post-start:host:true --hook-enabled h=false
Then:   hook.enabled=false
```

### T-CLI-08 — --hook-condition-exec-result modifier

```
When:   --hook h:post-exec:host:true --hook-condition-exec-result h=always
Then:   hook.condition=ExecResult(Always)

When:   --hook-condition-exec-result h=success
Then:   hook.condition=ExecResult(OnSuccess)

When:   --hook-condition-exec-result h=failure
Then:   hook.condition=ExecResult(OnFailure)

When:   --hook-condition-exec-result h=exit:137
Then:   hook.condition=ExecResult(ExitCode(137))

When:   --hook-condition-exec-result h=cmd:pip*
Then:   hook.condition=ExecResult(CommandMatches("pip*"))
```

### T-CLI-09 — --hook-env modifier

```
When:   --hook h:post-start:host:true --hook-env h=DEBUG=1
Then:   hook.action.env contains ("DEBUG","1")
```

### T-CLI-10 — --hook-user and --hook-workdir (GuestExec)

```
When:   --hook h:post-start:guest:/bin/sh --hook-user h=agent --hook-workdir h=/opt/app
Then:   hook.action is GuestExec with user=Some("agent"), working_dir=Some("/opt/app")
```

### T-CLI-11 — Multiple --hook flags

```
When:   --hook a:post-start:host:true --hook b:post-exec:host:true
Then:   two hooks configured; both fire at their respective points
```

### T-CLI-12 — --hook-json and --hook can be mixed

```
When:   --hook simple:post-start:host:true --hook-json '{"name":"complex",...}'
Then:   both hooks registered
```

### T-CLI-13 — Invalid hook name in modifier is rejected

```
When:   --hook-on-error nonexistent=fail   (no hook named "nonexistent")
Then:   CLI exits non-zero; error message mentions "nonexistent"
```

### T-CLI-14 — Invalid --hook-json is rejected

```
When:   --hook-json '{invalid json'
Then:   CLI exits non-zero; error message mentions JSON parse error
```

### T-CLI-15 — Invalid hook point name is rejected

```
When:   --hook h:invalid-point:host:true
Then:   CLI exits non-zero; error message mentions "invalid-point"
```

### T-CLI-16 — Hook name uniqueness enforced

```
When:   --hook dup:post-start:host:true --hook dup:post-exec:host:true
Then:   CLI exits non-zero; error message mentions duplicate hook name "dup"
```

## Success Criteria

All unit tests (T-SERDE-*, T-CTX-*, T-SUB-*, T-RUN-*, T-HEXEC-*, T-FC-*, T-TRACE-*)
must pass in CI without KVM. Total: **70 unit tests**.

Integration tests (T-INT-*) require a Linux host with KVM. They must pass on a
boxlite dev machine before alpha sign-off. Total: **20 integration tests**.

CLI tests (T-CLI-*) run against the debug binary. They must pass in CI. Total:
**16 CLI tests**.

**Grand total: 106 test cases.**

## Test Execution

```bash
# Unit tests (fast, no KVM, runs in CI on every push)
make test:unit:rust FILTER=hooks

# Integration tests (needs KVM, runs on merge to main)
make test:integration:rust FILTER=hook

# CLI tests
cargo test -p boxlite-cli --test hook_cli

# All hook-related tests
cargo nextest run -E 'test(/_hook_/) + test(/_hooks?::/)'
```

## Out of Scope (Deferred to Later Phases)

| Area | Phase |
|------|-------|
| GuestExec hook tests | Phase 2 |
| Snapshot hook tests (pre/post-snapshot) | Phase 3 |
| Restore hook tests (pre/post-restore) | Phase 3 |
| Python SDK hook tests | Phase 4 |
| Node SDK hook tests | Phase 4 |
| Go SDK hook tests | Phase 4 |
| C SDK hook tests | Phase 4 |
| REST API hook validation tests | Phase 4 |
| Hook performance benchmarks | Post-alpha |
| Stress tests (100 hooks per box, 1000 execs) | Post-alpha |
