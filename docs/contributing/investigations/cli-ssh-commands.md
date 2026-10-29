# CLI guest SSH commands

Date: 2026-10-29. Design: [#2190](https://github.com/boxlite-ai/boxlite/issues/2190),
following the original [SSH CLI design](https://github.com/boxlite-ai/boxlite/issues/2122).

## TL;DR

`boxlite ssh configure|status|disable|forward` adapts `LiteBox::ssh()` and the
existing `network tunnel` forwarder. Configuration and forwarding are separate
operations, with no combined command or compatibility alias.

The scope is four CLI subcommands, zero new HTTP routes, and zero new SDK operations.
`boxlite serve` remains unchanged. Its lack of tunnel support is a backend
compatibility limit; adding that capability is outside this change.

```bash
boxlite ssh configure dev --ssh-config ssh.json
boxlite ssh forward dev
```

## Decisions

| Question | Decision | Evidence |
| --- | --- | --- |
| Command responsibilities | Configure explicitly, then forward; `network tunnel` stays the generic forwarder | `configure` replaces configuration and disconnects clients; `forward` reads status without changing generation |
| Start boxes? | Never from the CLI; `configure()` keeps the SDK's implicit-start rules | `src/boxlite/src/litebox/ssh.rs` (`SshHandle` docs) |
| Retry configure? | No: each accepted call restarts the listener and drops clients | [SSH guide](../../guides/ssh.md#http-control-with-boxlite-serve) |
| Guest port | Forward from returned status, so a `:0` listener works; reject non-wildcard, non-`GUEST_IP` listeners only when forwarding | REST tunnels accept only `GUEST_IP` targets; configuration keeps the SDK contract |
| Forwarder | `network::tunnel::forward_until_interrupted`, shared with `network tunnel` | One lifecycle: print and flush address, close and await on Ctrl-C |
| Connect hint | Keep `LOGIN` for the caller to replace | Status exposes host identity and listener, but no account list |
| Config errors | File path plus JSON category and position only | serde data errors quote string values |
| REST tunnel URL | Left open on exit; docs give `--revoke` | Revoking could cut off other clients |

Removing the combined operation deletes its argument type, dispatch, exclusive
listener preflight, login inference, and partial-success handling. Those checks do
not move into `configure`. Config-source tests belong to `configure`; listener
tests belong to `forward`. The top-level `boxlite run` remains unchanged.

## Validation contracts

- Parser, SSH help, and nested Bash/Zsh/Fish completions expose only the four commands.
- Recording REST tests cover configuration, request counts, returned ports, and forwarding refusals.
- Real SSH tests configure then forward, including guest port zero, authenticated login,
  generation preservation, Ctrl-C port release, and disable blocking logins.
- `boxlite serve` tests prove SSH controls work and a failed forward leaves configuration unchanged.

## Residual risks

- A box that stops itself between `status()` and the first local `tunnel()` can be
  rebooted by the SDK; closing that needs a non-starting SDK tunnel.
- A local CLI exit stops running non-detached boxes, ending their SSH.
- A REST tunnel makes the SSH port publicly reachable, and a connection wakes a stopped box.
- No in-repo server has both SSH control and tunnels, so real REST forwarding is
  unproven; `boxlite serve` checks controls and forwarding failure separately.
