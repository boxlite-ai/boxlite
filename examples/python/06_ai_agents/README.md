# 06 AI Agents

Using BoxLite as a sandbox for AI agent workflows.

| File | Description |
|------|-------------|
| `drive_box_with_llm.py` | Let an LLM drive a SimpleBox via tool-use loop (OpenAI) |
| `drive_box_with_minimax.py` | Let MiniMax M2.7 drive a SimpleBox via tool-use loop |
| `use_skillbox.py` | Run Claude Code CLI with skills inside a box |
| `chat_with_claude.py` | Multi-turn Claude conversation via stdin JSON protocol |
| `order_starbucks.py` | End-to-end agent: order Starbucks via browser automation |
| `run_openclaw.py` | Run OpenClaw (ClawdBot) AI gateway in a container |

Most examples require `CLAUDE_CODE_OAUTH_TOKEN` to be set.

**Recommended first example:** `drive_box_with_llm.py`

## AI Agent Integration

BoxLite works with any LLM provider to create secure sandboxed environments for AI agents.
The examples in this directory include ready-to-run integrations for
OpenAI and [MiniMax](https://platform.minimax.io) (`MiniMax-M2.7`, `MiniMax-M2.7-highspeed`, `MiniMax-M2.5`, `MiniMax-M2.5-highspeed`).
