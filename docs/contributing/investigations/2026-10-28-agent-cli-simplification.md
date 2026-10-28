## TL;DR

Use nine flat agent commands with a positional Box and named inner targets; combine reads while keeping mutations explicit.

## Details

This study explains the agent CLI design in
[#2140](https://github.com/boxlite-ai/boxlite/issues/2140). The
[CLI reference](../../reference/cli/README.md#boxlite-agent) owns the command and
option definitions.

### Research

Sources checked on 2026-10-28:

| Source | Observation | BoxLite decision |
|---|---|---|
| [Kubernetes exec](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_exec/) | Selects a Pod positionally and a container with `-c`. | Keep BOX positional, consistent with `boxlite exec`; name agent and turn selectors. |
| [AWS ECS exec](https://docs.aws.amazon.com/cli/latest/reference/ecs/execute-command.html) | Selects a task and container through separate flags. | Multiple runtime targets do not require more command levels. |
| [exe.dev API](https://exe.dev/docs/api) and [Shelley API](https://github.com/boldsoftware/shelley/blob/main/API.md#single-conversation) | Infrastructure uses SSH commands; Shelley separately exposes chat, streams, cancellation and settings. | Preserve distinct agent effects; VM CLI simplicity does not determine an agent command hierarchy. |
| [Rivet CLI](https://github.com/rivet-dev/agents/blob/main/sandbox-agent/docs/content/docs/cli.mdx#api) | Its scripting API uses nested resources such as `api agents list`. | Nesting helps protocol discovery. Nine BoxLite task verbs need less navigation. |
| [OpenHands CLI](https://docs.openhands.dev/openhands/usage/cli/command-reference#global-options) | Task, resume and headless flags serve conversation workflows. | Adapt the workflow focus, while retaining separately addressed agents and turns. |
| [OpenComputer developer resources](https://opencomputer.dev/developers/) | Its quickstart emphasizes initialization/deployment; the Management API separately exposes sessions, turns and events. | Keep deployment outside the agent instance API. This does not establish parity with its complete CLI. |

The OpenComputer comparison is limited to its developer portal; its agent API
reference could not be retrieved reliably during this study.

### Alternatives and boundaries

| Choice | Assessment |
|---|---|
| Sixteen nested leaves | Makes SDK ownership explicit, but exposes handle lookup as a shell task and repeats agent/turn navigation. |
| Flatten all sixteen | Shortens spelling while retaining duplicate reads. |
| Nine flat verbs with named targets | Combines read selection and event scope; keeps different mutations visible. Chosen. |
| One action command with mode flags | Moves the same operations into flags and obscures whether a call submits, steers or interrupts. |

This is an interface judgment, not a measured usability result. Removing
capabilities or hiding mutations would not be justified by command count alone.

`inspect` selects state or agent config/capabilities/requests. Agent-only
views conflict with `--turn`. SDKs expose `get`/`get_turn` methods; CLI targeting
subsumes them. Explicit agent/turn/request IDs prevent commands from guessing
which conversation or turn to affect.

Creation uses `create BOX --agent IMPLEMENTATION`; other commands use `--agent ID`
to target an instance. The subcommand determines whether the value selects an
implementation or an existing agent. SDK create calls take the implementation
identifier positionally, and get calls take the instance ID.

```bash
boxlite agent create dev --agent coder
boxlite agent send dev --agent agent-id "Review this code"
boxlite agent inspect dev --agent agent-id --view requests
boxlite agent steer dev --agent agent-id --turn turn-id "Focus on tests"
```

Option groups cover JSON input, queue/reject mode, retry keys, cursors
and wait timeouts. The
[failure contract](../../reference/agents.md#failure-contract) describes operation
availability.

### Validation

The process test exercises each verb and read selector against the real binary,
including missing runtime files and an invalid server URL. Invalid target/view
combinations, missing agent selection and unknown subcommands must produce usage
errors. Help and completion checks cover the resulting command tree.

Real Fish cases use command names inside IDs, messages and option values,
including option values before the verb is selected.
`clap_complete` 4.6.3 matches token presence at two levels. Agent completion
conditions use exact command-path checks while preserving generated option
values and quoting.

CLI tests, Rust lint and formatting validate parsing and error behavior. They do not
establish backend execution or replace the full VM matrix.
