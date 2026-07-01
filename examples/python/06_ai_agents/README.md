# 06 AI Agents

Using BoxLite as a sandbox for AI agent workflows.

| File | Description |
|------|-------------|
| `drive_box_with_llm.py` | Let an LLM drive a SimpleBox via tool-use loop (OpenAI) |
| `drive_box_with_minimax.py` | Let MiniMax M3 drive a SimpleBox via tool-use loop |
| `research_agent.py` | Search the web, ask an LLM through host-side secret substitution, and answer a question |
| `run_codex_in_box.py` | Install and run OpenAI Codex CLI inside a BoxLite box |
| `use_skillbox.py` | Run Claude Code CLI with skills inside a box |
| `chat_with_claude.py` | Multi-turn Claude conversation via stdin JSON protocol |
| `order_starbucks.py` | End-to-end agent: order Starbucks via browser automation |
| `run_openclaw.py` | Run OpenClaw (ClawdBot) AI gateway in a container |

Most examples require `CLAUDE_CODE_OAUTH_TOKEN` to be set.

**Recommended first example:** `drive_box_with_llm.py`

## AI Agent Integration

BoxLite works with any LLM provider to create secure sandboxed environments for AI agents.
The examples in this directory include ready-to-run integrations for
OpenAI and [MiniMax](https://platform.minimax.io) (`MiniMax-M3`, `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`).

## Research Agent

`research_agent.py` is a minimal research loop that can use BoxLite secret
substitution for LLM credentials:

1. Accept a user question.
2. Search the web with DuckDuckGo HTML search, or read fixture results for smoke tests.
3. Send the search context to an OpenAI-compatible chat completion endpoint.
4. Print the final answer.

The default `echo` provider is deterministic and needs no credentials:

```bash
python examples/python/06_ai_agents/research_agent.py \
  --search-provider fixture \
  --search-fixture examples/python/06_ai_agents/research_agent_fixture.json \
  "What can this agent do?"
```

Inside a BoxLite box, pass the real API key as a host-side secret and let the
agent use only the placeholder env var:

```python
box = runtime.create(
    boxlite.BoxOptions(
        image="python:3.12-slim",
        network=boxlite.NetworkSpec(
            mode="enabled",
            allow_net=["api.openai.com"],
        ),
        secrets=[
            boxlite.Secret(
                name="openai_api_key",
                value=os.environ["OPENAI_API_KEY"],
                hosts=["api.openai.com"],
            ),
        ],
    )
)
```

The container sees `BOXLITE_SECRET_OPENAI_API_KEY=<BOXLITE_SECRET:openai_api_key>`.
When the agent calls `https://api.openai.com/v1/chat/completions`, gvproxy
replaces that placeholder with the real key at the network boundary:

```bash
python /root/research_agent.py \
  --answer-provider openai \
  "What is BoxLite?"
```

## Codex CLI In A Box

`run_codex_in_box.py` installs the real `@openai/codex` CLI in a Node.js box,
logs in with a BoxLite secret-backed API key, and runs `codex exec`:

```bash
python examples/python/06_ai_agents/run_codex_in_box.py \
  --profile p1 \
  "Reply exactly: codex inside box works"
```

The script reads `OPENAI_API_KEY` from the current environment first, then
falls back to `~/.config/boxlite/e2e-openai.env` (`OPENAI_API_KEY` or
`BOXLITE_E2E_OPENAI_API_KEY`). Use `--env-file` to point at another file. The
box is created through the cloud REST profile from `~/.boxlite/credentials.toml`;
use `--profile`, `BOXLITE_E2E_PROFILE`, or `BOXLITE_PROFILE` to select it.

The box receives `BOXLITE_SECRET_OPENAI_API_KEY=<BOXLITE_SECRET:openai_api_key>`;
`codex login --with-api-key` stores that placeholder in the box, and gvproxy
substitutes the real key only on outbound requests to `api.openai.com`.

## Testing

These agent examples currently have two small test paths. For the full
agent-in-box verification flow, see
[`docs/guides/agent-in-box-test.md`](../../../docs/guides/agent-in-box-test.md).

### Research Agent

The unit test is deterministic and runs entirely on the host:

```bash
python -m unittest examples/python/06_ai_agents/test_research_agent.py
```

It checks DuckDuckGo HTML parsing, fixture-based prompt construction, and that
OpenAI requests use the BoxLite secret placeholder instead of a plaintext API
key.

The REST e2e copies `research_agent.py` into a real REST-backed box and executes
it there:

```bash
python -m pytest \
  scripts/test/e2e/cases/test_research_agent_example.py::test_research_agent_example_runs_inside_rest_box \
  -vv -s
```

The worklog persistence e2e verifies that files written by the agent inside the
box survive `stop` followed by `start`:

```bash
python -m pytest \
  scripts/test/e2e/cases/test_research_agent_example.py::test_research_agent_worklog_persists_after_stop_and_rerun \
  -vv -s
```

The real LLM version does not skip. Provide the key on the host before running
the OpenAI-backed case:

```bash
export BOXLITE_E2E_OPENAI_API_KEY="sk-..."
python -m pytest \
  scripts/test/e2e/cases/test_research_agent_example.py::test_research_agent_openai_provider_uses_boxlite_secret_in_rest_box \
  -vv -s
```

This case first asserts that the box can only see
`<BOXLITE_SECRET:openai_api_key>`, then asks the model through
`api.openai.com`, and finally confirms the agent output contains neither the
plaintext key nor the placeholder.

### Codex In Box

`run_codex_in_box.py` is a manual smoke test for verifying that a real
LLM-backed agent can run inside a box:

```bash
export OPENAI_API_KEY="sk-..."
python examples/python/06_ai_agents/run_codex_in_box.py \
  "Reply exactly: codex inside box works"
```

If you do not want to export the key every time, put `OPENAI_API_KEY` or
`BOXLITE_E2E_OPENAI_API_KEY` in `~/.config/boxlite/e2e-openai.env`, or pass a
different file with `--env-file`.

This path creates a Node.js box, installs `@openai/codex`, logs in with
`BOXLITE_SECRET_OPENAI_API_KEY`, and runs `codex exec`. The API key stays on the
host. The box stores and sends only the placeholder, and gvproxy substitutes the
real key only for requests to `api.openai.com`.

To verify Codex CLI itself when secret passthrough is unavailable, pass the key
directly into the box:

```bash
python examples/python/06_ai_agents/run_codex_in_box.py \
  --code-smoke
```

This direct-key mode is the default for manual smoke testing because current
cloud secret passthrough does not yet cover Codex's Responses API path. The
plaintext API key is visible inside the box. Pass `--secret-passthrough` to test
BoxLite secret substitution instead. The `--code-smoke` path asks Codex to create
`/workspace/fib.js`, run it, and then verifies the file by running
`node /workspace/fib.js 10` inside the same box.
