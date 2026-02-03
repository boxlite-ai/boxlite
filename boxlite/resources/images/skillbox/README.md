# SkillBox Image

All-in-one AI CLI container with desktop GUI (noVNC) for visual monitoring.

## Features

- **Desktop GUI**: Ubuntu XFCE desktop accessible via noVNC (HTTP/HTTPS)
- **Multiple AI CLIs**: Claude Code, Codex, Gemini CLI, OpenCode
- **Document Skills**: Pre-installed anthropics/skills for PDF, DOCX, PPTX, XLSX handling

## Included CLIs

| CLI | Provider | Description |
|-----|----------|-------------|
| `claude` | Anthropic | Claude Code CLI for AI-assisted development |
| `codex` | OpenAI | OpenAI Codex CLI for code generation |
| `gemini` | Google | Gemini CLI for AI assistance |
| `opencode` | OpenCode | Go-based AI coding assistant |

## Building

```bash
# From repository root
make skillbox-image

# Or directly
docker build -t boxlite-skillbox:latest images/skillbox/
```

## Usage with SkillBox

```python
import asyncio
from boxlite import SkillBox

async def main():
    async with SkillBox() as box:
        # noVNC GUI available at:
        # - HTTP:  http://localhost:3000
        # - HTTPS: https://localhost:3001
        print("Watch Claude work at https://localhost:3001")

        result = await box.call("Create a simple Python script")
        print(result)

asyncio.run(main())
```

## Manual Docker Usage

```bash
# Run standalone with noVNC
docker run -d \
    -p 3000:3000 \
    -p 3001:3001 \
    -e CLAUDE_CODE_OAUTH_TOKEN="your-token" \
    boxlite-skillbox:latest

# Access via browser: https://localhost:3001
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Required for Claude Code authentication |
| `OPENAI_API_KEY` | Required for Codex CLI |
| `GOOGLE_API_KEY` | Required for Gemini CLI |

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 3000 | HTTP | noVNC web interface |
| 3001 | HTTPS | noVNC web interface (self-signed cert) |

## Verifying CLIs

After starting the container, verify all CLIs are available:

```bash
claude --version
codex --version
gemini --version
opencode --version
```

## Base Image

Built on [linuxserver/webtop:ubuntu-xfce](https://github.com/linuxserver/docker-webtop), which provides:
- Ubuntu 22.04 LTS
- XFCE desktop environment
- noVNC for browser-based access
- TigerVNC server
