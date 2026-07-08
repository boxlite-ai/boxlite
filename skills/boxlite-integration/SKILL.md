---
name: boxlite-integration
description: Integrate BoxLite sandboxed execution into an AI agent codebase. Use this skill whenever the user mentions BoxLite, wants to sandbox their agent's code execution, wants to run untrusted code safely, wants to add a secure code execution environment to their agent, or asks how to use BoxLite with their agent. Trigger on phrases like "integrate boxlite", "add boxlite to my agent", "sandbox my agent", "run code safely", "use boxlite for code execution", "wrap my tool calls in boxlite", or any mention of BoxLite SDK setup. Even if the user only vaguely says "make my agent's code execution safer" or "I want to sandbox the code my agent runs", invoke this skill.
---

# BoxLite Integration

This skill helps you integrate BoxLite into an existing AI agent — reading the agent's current code execution pattern and injecting the right BoxLite wrapping with minimal friction.

## Core Principles

1. **Read first**: Always read the user's existing agent code before writing anything. Understand *where* the agent currently runs code or shell commands — that's the integration point.
2. **Detect the SDK**: Check the project's language and existing dependencies to choose Python, Node.js, Go, or C SDK.
3. **Match the pattern**: Don't rewrite the agent. Wrap the existing execution pattern with BoxLite — preserve the agent's structure.
4. **Cover the gotchas**: Timeout/zombie prevention and box lifecycle management are the most common failure modes. Always apply them.

---

## Step 1: Understand the Agent

Before writing any code, do these in order:

1. **Find the execution point** — grep for patterns like `subprocess`, `exec(`, `os.system`, `child_process`, `eval(`, `execSync(`, shell tool calls. This is where BoxLite wraps in.
2. **Flag dangerous patterns explicitly** — if you see `eval(user_code)`, `subprocess.run(..., shell=True)`, or `execSync(\`python -c "${code}"\`)`, point it out before proceeding. These run untrusted code on the host and are security vulnerabilities. BoxLite fixes this by moving execution into an isolated VM.
3. **Validate inputs before sandbox handoff** — sandboxing isolates execution from the host, but it does not validate what gets executed. Before passing anything to `box.exec()`, check that the command name is in an allowlist and that arguments don't contain shell metacharacters or path traversal sequences. Never construct commands by concatenating untrusted strings.
3. **Identify the lifecycle** — is this a short-lived script, a long-running server, or a per-request handler? This determines whether to create one box (reuse across calls) or one box per invocation.
4. **Check environment** — does the project already have `BOXLITE_API_KEY` / `BOXLITE_REST_URL` set?

---

## Step 2: Determine Box Lifecycle

Infer from the code — only ask the user when it's genuinely ambiguous.

**Auto-detect signals:**

| Code pattern | Lifecycle decision |
|---|---|
| FastAPI / Flask / Express server | Long-running — create box at startup, reuse across requests |
| `if __name__ == "__main__"` single-run script | Short-lived — context manager per run |
| Per-request handler with no shared state | Per-request box |
| LangChain / LlamaIndex agent loop | Long-running — one box per agent session |

**When to ask the user (don't guess):**
> Multi-tenant deployments — if the same agent instance serves multiple users concurrently, per-request isolation is safer (shared box risks data leakage between users). Ask: *"Is this serving multiple users concurrently?"* only when the deployment model is not clear from the code.

**Choose the API accordingly:**

| Scenario | Recommended Pattern |
|----------|---------------------|
| Agent runs code snippets (Python) | `CodeBox` — simplest API, handles lifecycle automatically |
| Agent shells out to commands | `SimpleBox.exec()` with timeout wrapper |
| Long-running, many tool calls | Single box reused across calls |
| Multi-tenant / strict isolation | One box per request |
| REST API / cloud deployment | `Boxlite.rest()` with `ApiKeyCredential` |

For local development, use `Boxlite.default()`. For cloud/production, use `Boxlite.rest()` with env vars.

---

## Step 3: Apply the Integration

For SDK-specific code patterns, see:
- **[references/python.md](references/python.md)** — Python SDK patterns (SimpleBox, CodeBox, REST client, timeout handling)
- **[references/node.md](references/node.md)** — Node.js SDK patterns (SimpleBox, CodeBox, TypeScript async disposal)
- **[references/go.md](references/go.md)** — Go SDK patterns (NewRuntime, box lifecycle, timeout, LLM tool call struct)
- **[references/c.md](references/c.md)** — C SDK patterns (Simple API vs Native API, memory management, thread safety)
- **[references/patterns.md](references/patterns.md)** — Lifecycle, timeout/zombie prevention, concurrency, file transfer

Read only the reference file that matches the project's language.

### Timeout + Zombie Prevention (apply to every `exec()` call)

This is the most commonly missed step. When a timeout fires, cancelling the coroutine or promise does **not** kill the process running inside the VM — it keeps running and leaks resources. Always kill explicitly:

**Python — SimpleBox** (high-level, most common): pass `timeout` directly, SDK handles kill internally:
```python
result = await box.exec("python", "-c", code, timeout=30)
return result.stdout
```

**Python — lower-level Box** (from `Boxlite.default().create()`): exec returns a handle, kill explicitly:
```python
async def safe_exec(box, cmd, args=None, timeout=30):
    execution = await box.exec(cmd, args or [])
    try:
        result = await asyncio.wait_for(execution.wait(), timeout=timeout)
        return result
    except BaseException:
        await execution.kill()  # kill guest process on timeout, cancel, or any error
        raise
```

**Node.js:**
```javascript
async function safeExec(box, cmd, args = [], timeoutMs = 30_000) {
  const execution = await box.exec(cmd, args);
  const timer = setTimeout(() => execution.kill().catch(() => {}), timeoutMs);
  try {
    return await execution.wait();
  } finally {
    clearTimeout(timer);
  }
}
```

Use these wrappers instead of bare `execution.wait()` whenever the code being run is user-supplied or LLM-generated.

---

## Step 4: Environment Setup

Tell the user what to configure before running:

**Local (default runtime):**
```bash
# No env vars needed — BoxLite.default() uses local runtime
pip install boxlite                          # Python
npm install @boxlite-ai/boxlite              # Node.js
go get github.com/boxlite-ai/boxlite/sdks/go # Go (+ run setup step, see references/go.md)
cargo build --release -p boxlite-c           # C (build from source, see references/c.md)
```

**Cloud / REST API:**
```bash
export BOXLITE_API_KEY="your-api-key"       # From Console → API Keys
export BOXLITE_REST_URL="https://api.boxlite.ai/api"  # Or your self-hosted URL
```

---

## Step 5: Verify

After applying the integration, check:
- [ ] Box is always stopped/removed in a `finally` block or context manager — never leave boxes running on error paths
- [ ] `exec()` calls have timeout + `execution.kill()` on timeout (see patterns.md)
- [ ] The box lifecycle matches the agent's lifecycle (don't create a new box per `exec()` call if the agent is long-running)
- [ ] Secrets are read from env vars, not hardcoded

---

## Quick Reference: Minimal Working Example

**Python (simplest path):**
```python
import boxlite

async with boxlite.CodeBox() as box:
    stdout = await box.run("print('hello from sandbox')")  # returns str directly
    print(stdout)
```

**Node.js (simplest path):**
```javascript
import { CodeBox } from '@boxlite-ai/boxlite';

const box = new CodeBox();
try {
  const stdout = await box.run("print('hello')");
  console.log(stdout);
} finally {
  await box.stop();
}
```
