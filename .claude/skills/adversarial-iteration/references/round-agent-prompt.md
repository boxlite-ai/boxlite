# Round Agent Prompt Template

Construct the agent prompt by filling in the bracketed sections below.
Spawn as a general-purpose agent with `mode: "auto"`.

---

You are running round [N] of an adversarial iteration loop on a codebase.

## Prior round summaries

[Paste accumulated round summaries here, one block per prior round.
If this is round 1, write: "This is the first review round."]

## Files changed so far

[List file paths from all prior rounds. Example:
- src/cli/src/commands/serve/handlers/executions.rs
- apps/runner/pkg/boxlite/exec_manager.go]

You MUST re-read every file in this list from disk before reviewing.
Do NOT rely on any cached content — you have a fresh context.

## Your task

1. **Re-read** all files listed above using the Read tool.

2. **Review**: The orchestrator (parent) has already obtained adversarial
   review findings and pasted them in the section below titled
   "Codex findings for this round." Do NOT attempt to spawn
   `codex:codex-rescue` or any nested Agent — the Agent tool is not
   available inside subagents in this harness, and the codex companion
   runs as a background bash task whose Monitor events fire on the
   parent, not back into you. (Trying it anyway burns a 15-min turn
   waiting for an event that will never reach you.)

   If the "Codex findings" section is empty or absent, treat that as
   zero findings and skip to step 3.

3. **If zero findings**: Return this exact summary and stop:
   ```
   ### Round [N] complete
   - Findings: none
   - Status: ZERO_FINDINGS
   ```

4. **If findings exist**, follow the full protocol:

   a. **REFLECT** on each finding:
      - What did I do wrong? (one sentence)
      - Why did I miss it? (name the unverified assumption)
      - Which CLAUDE.md rule was violated?
      - What cheap check catches it?
      - Across all findings: what is the unifying shape?

   b. **Cheap checks** (all four, before writing fix code):
      - Timeline draw (concurrent state)
      - Upstream contract read (grep producer, 5 lines)
      - Full lifecycle trace (init through teardown)
      - Variant enumeration (list each type's contract)

   c. **Reproducer test**: Write BEFORE the fix. Verify it FAILS.

   d. **Plan**: Reference REFLECT shape, reproducer, cheap check,
      chosen primitive, adjacent contracts.

   e. **Fix**: Implement the smallest change that satisfies the constraint.

   f. **Verify**: Reproducer flips red to green. Adjacent tests pass.

   g. **Audit**: `grep -rn 'round\|HACK\|FIXME\|debugging\|TEMP'`
      on changed files. Remove any round-N narrative.

   h. **Return** structured summary:
      ```
      ### Round [N] complete
      - Findings: [list]
      - Root-cause shape: [from REFLECT]
      - Fixes: [what changed and why]
      - Files changed: [paths]
      - Tests: pass/fail
      - Remaining risk: [if any]
      ```

## Rules

- Do NOT commit. All changes stay as working-tree edits.
- Do NOT ask the user questions. Pick "Recommended" and continue.
- Do NOT skip REFLECT. It is the difference between fixing symptoms
  and fixing the design.
- Re-read every file in the "files changed" list from disk before reviewing.
- Keep the returned summary under 10 lines. It must be signal, not transcript.
