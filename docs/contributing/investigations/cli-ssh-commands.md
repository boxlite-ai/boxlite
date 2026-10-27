# CLI guest SSH commands

Date: 2026-10-27. Design: [#2122](https://github.com/boxlite-ai/boxlite/issues/2122).

## TL;DR

`boxlite ssh configure|status|disable|configure-and-forward|forward` adapts
`LiteBox::ssh()` and the existing `network tunnel` forwarder. It adds no SDK, server, or
key-management code.

The scope is five CLI subcommands, zero new HTTP routes, and zero new SDK operations.
`boxlite serve` remains unchanged. Its lack of tunnel support is a backend
compatibility limit; adding that capability is outside this change.

## Decisions

| Question | Decision | Evidence |
| --- | --- | --- |
| Command names | `configure-and-forward` and `forward` name each effect; `network tunnel` stays the generic forwarder | Only `configure-and-forward` replaces the configuration and disconnects clients |
| Start boxes? | Never from the CLI; `configure()` keeps the SDK's implicit-start rules | `src/boxlite/src/litebox/ssh.rs` (`SshHandle` docs) |
| Retry configure? | No: each accepted call restarts the listener and drops clients | [SSH guide](../../guides/ssh.md#http-control-with-boxlite-serve) |
| Guest port | From returned status, so a `:0` listener works; reject non-wildcard, non-`GUEST_IP` listeners | REST tunnels accept only `GUEST_IP` targets |
| Forwarder | `network::tunnel::forward_until_interrupted`, shared with `network tunnel` | One lifecycle: print and flush address, close and await on Ctrl-C |
| Config errors | File path plus JSON category and position only | serde data errors quote string values |
| REST tunnel URL | Left open on exit; docs give `--revoke` | Revoking could cut off other clients |

## Residual risks

- A box that stops itself between `status()` and the first local `tunnel()` can be
  rebooted by the SDK; closing that needs a non-starting SDK tunnel.
- A local CLI exit stops running non-detached boxes, ending their SSH.
- A REST tunnel makes the SSH port publicly reachable, and a connection wakes a stopped box.
- No in-repo server has both SSH control and tunnels, so real REST forwarding is
  unproven; `boxlite serve` checks the controls and the partial-success path.

## Verification

macOS arm64 host, real VMs.

| Check | Result |
| --- | --- |
| `make test:unit:cli` | 315 passed: subcommand names, clap relations, key files, multi-account/CA JSON, redaction, REST request counts, actual port, disabled/unreachable/port-0 refusal, partial success |
| `make test:integration:cli FILTER=ssh` | 30 passed, including local login through `forward` twice and `configure-and-forward` with guest `:0`, Ctrl-C exit 0 with port released, disable blocking login, and `boxlite serve` controls plus partial `configure-and-forward` |
| `make test:integration:cli FILTER=command_help` / `FILTER=completion` | 1 / 14 passed |
| `make fmt:check:rust`, `make lint:rust` | Exit 0 |
