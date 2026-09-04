# Agent In Box Test Runbook

This runbook is written for Codex, Claude, or another code agent to read after
cloning the repository. It focuses on reproducing the PR 825 agent-in-box tests
against a cloud REST environment and reporting actionable results.

Do not use the local e2e stack for this runbook. Do not run
`scripts/test/e2e/bootstrap.sh` or `scripts/test/e2e/fixture_setup.py`.

## Test Goals

1. `research_agent.py` can be copied into a REST-backed box and executed there.
2. Real LLM calls use a BoxLite secret placeholder inside the box, while the
   plaintext API key stays on the host.
3. Agent work files written inside the box survive `stop` followed by `start`.

## Relevant Files

| File | Purpose |
|------|---------|
| `examples/python/06_ai_agents/research_agent.py` | Agent under test |
| `examples/python/06_ai_agents/research_agent_fixture.json` | Deterministic search fixture |
| `scripts/test/e2e/cases/test_research_agent_example.py` | REST box e2e tests |
| `examples/python/06_ai_agents/run_codex_in_box.py` | Manual Codex CLI in-box smoke test |

## Prerequisites

Run commands from the repository root:

```bash
cd boxlite
PYTHON="${PYTHON:-$(test -x .venv/bin/python && echo .venv/bin/python || echo python)}"
```

The REST e2e tests need a working cloud BoxLite API profile. By default they
read the `p1` profile from `~/.boxlite/credentials.toml`. To use a different
cloud profile:

```bash
export BOXLITE_E2E_PROFILE="p1"
```

The profile must point at the cloud API, not a local API. The file should have
this shape:

```toml
[profiles.p1]
url = "https://<cloud-api-host>/api"
api_key = "<cloud-api-key>"
auth_method = "api_key"
path_prefix = "<path-prefix-if-required>"
```

Always skip local runner journal path verification for this cloud-only flow:

```bash
export BOXLITE_E2E_SKIP_PATH_VERIFY=1
```

If cloud image discovery fails, or if the default image is unavailable, pin a
Python-capable image:

```bash
export BOXLITE_E2E_RESEARCH_IMAGE="ghcr.io/boxlite-ai/boxlite-agent-python:20260605-p0-r3"
```

The real LLM e2e test requires a host-side environment variable:

```bash
export BOXLITE_E2E_OPENAI_API_KEY="sk-..."
export BOXLITE_E2E_OPENAI_MODEL="${BOXLITE_E2E_OPENAI_MODEL:-gpt-4.1-mini}"
```

Do not write API keys into the repository, fixtures, or logs.

## Run Order

Run the smallest REST box e2e first. It creates a real cloud box, copies the
agent and fixture into it, and executes the echo provider inside the box:

```bash
"$PYTHON" -m pytest \
  scripts/test/e2e/cases/test_research_agent_example.py::test_research_agent_example_runs_inside_rest_box \
  -vv -s --tb=short
```

Next, verify that agent work files survive `stop` followed by `start`:

```bash
"$PYTHON" -m pytest \
  scripts/test/e2e/cases/test_research_agent_example.py::test_research_agent_worklog_persists_after_stop_and_rerun \
  -vv -s --tb=short
```

Finally, if `BOXLITE_E2E_OPENAI_API_KEY` is set, run the real LLM e2e. This test
does not skip; without a key, it is expected to fail:

```bash
"$PYTHON" -m pytest \
  scripts/test/e2e/cases/test_research_agent_example.py::test_research_agent_openai_provider_uses_boxlite_secret_in_rest_box \
  -vv -s --tb=short
```

To run the full focused e2e file:

```bash
"$PYTHON" -m pytest scripts/test/e2e/cases/test_research_agent_example.py -vv -s --tb=short
```

## Expected Signals

The REST echo e2e agent output should include:

```text
Echo provider summary for: What can this agent do?
BoxLite AI agent examples
Codex tool-use loop
```

The worklog persistence e2e should read both markers after the second start:

```text
run=first
run=second
```

The real LLM e2e first verifies that the box can only see the placeholder:

```text
<BOXLITE_SECRET:openai_api_key>
```

The final agent output must not contain `sk-` and must not contain
`<BOXLITE_SECRET:openai_api_key>`.

## Relationship To Secret Passthrough

The PR 825 tests create a box with a secret and expect the REST -> runner ->
box/gvproxy path to deliver the secret placeholder into the box. The tests only
validate agent-in-box behavior. If the target REST environment does not include
create secret passthrough support, the real LLM e2e can fail because the
placeholder is missing or the outbound request is unauthorized.

When validating PR 825 itself, run the echo e2e and worklog e2e first. When
validating the full real LLM agent-in-box path, also make sure the target
environment includes the secret passthrough fix.

## Common Failures

| Symptom | Action |
|---------|--------|
| `~/.boxlite/credentials.toml` is missing | Configure a cloud REST profile |
| The desired profile is not `p1` | Set `BOXLITE_E2E_PROFILE` |
| Local path verification fails | Set `BOXLITE_E2E_SKIP_PATH_VERIFY=1` |
| The box image has no Python | Set `BOXLITE_E2E_RESEARCH_IMAGE` to a Python image |
| The real LLM e2e reports a missing key | Set `BOXLITE_E2E_OPENAI_API_KEY` |
| The box does not contain `<BOXLITE_SECRET:openai_api_key>` | The current REST/runner path is not passing create secrets into the box |
| Agent output contains a plaintext key or placeholder | Treat this as a security failure and inspect secret substitution |

## Minimal Prompt For A Code Agent

Give this prompt to Codex or Claude:

```text
Read docs/guides/agent-in-box-test.md. From the repo root, run the deterministic
REST echo e2e and worklog persistence e2e against the configured cloud profile.
If BOXLITE_E2E_OPENAI_API_KEY is set, also run the real LLM e2e. Report exact
commands, pass/fail, and any box ids left behind.
```
