# Agent bundle image

A reference [`Dockerfile`](./Dockerfile) that bundles ten terminal coding agents
into a single box image, layered on the curated `boxlite-agent-node` base.

## Why the Node base

The `boxlite-agent-node` base already ships **Node 22 + npm + python3/pip + git/
curl**, so both the npm-installed CLIs and the two curl-installed native agents
run without extra runtimes. The `base` and `python` curated images lack Node, so
the npm agents (the majority) cannot install on them.

## Agents included

| Agent | Install source |
| --- | --- |
| Claude Code | `npm i -g @anthropic-ai/claude-code` |
| Codex CLI | `npm i -g @openai/codex` |
| Gemini CLI | `npm i -g @google/gemini-cli` |
| Copilot CLI | `npm i -g @github/copilot` |
| OpenCode | `npm i -g opencode-ai` |
| raft | `npm i -g @botiverse/raft` |
| Kimi Code | `npm i -g @moonshot-ai/kimi-code` |
| Pi | `npm i -g @mariozechner/pi-coding-agent` |
| Cursor CLI (`cursor-agent`) | `curl https://cursor.com/install \| bash` (native) |
| Antigravity CLI (`agy`) | `curl https://antigravity.google/cli/install.sh \| bash` (native) |

## Build

```bash
docker build -t agent-bundle:latest examples/agent-bundle
```

## Size (linux/amd64)

| | Size |
| --- | --- |
| On disk (uncompressed) | ~3.25 GB |
| Compressed (registry / pull) | ~807 MB |

The base image contributes ~0.4 GB; the agents add the rest. The npm CLIs
dominate — OpenCode, Codex, Copilot, and Claude Code are ~250–360 MB each.

## Install each agent the way it will be run

Boxes run as the unprivileged `boxlite` user, so the install user is kept
consistent with the run user:

- **npm CLIs** install as `root` into the system prefix (`/usr/local`) — `npm i -g`
  needs root, but the result is world-readable and runs fine as any user (they
  only need a writable `$HOME` for their own config/cache).
- **Native CLIs** (Cursor, Antigravity) install **as `boxlite`**, so their
  `curl | bash` installers drop into that user's own `~/.local` — their normal
  per-user, non-root install path. Nothing lands root-only under `/root`, so no
  relocation or permission fix-ups are needed; `PATH` just includes
  `~/.local/bin`.

`node_modules` is slimmed of source maps, docs, tests/examples, and changelogs
(kept `*.d.ts` and package metadata). All ten CLIs are smoke-checked to resolve
on `PATH` at build time, and each returns `--version` when run as the box user.
