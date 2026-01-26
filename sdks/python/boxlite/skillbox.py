"""
SkillBox - Secure Claude Code CLI execution container.

Provides an isolated environment for running Claude Code CLI with skills.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import TYPE_CHECKING, Optional

from .simplebox import SimpleBox

if TYPE_CHECKING:
    from .boxlite import Boxlite, Execution

logger = logging.getLogger("boxlite.skillbox")

__all__ = ["SkillBox"]


class SkillBox(SimpleBox):
    """
    Secure container for running Claude Code CLI with skills.

    SkillBox provides an isolated environment for executing Claude Code CLI
    with user-specified skills installed. It supports multi-turn conversations
    and persists between sessions for dependency reuse.

    SkillBox defaults to `auto_remove=True` for automatic cleanup after use,
    and has a default name for easy identification.

    Usage:
        >>> async with SkillBox(skills=["anthropics/skills"]) as box:
        ...     result = await box.call("What skills do you have?")
        ...     print(result)

    Attributes:
        skills: List of skill IDs to install (e.g., ["anthropics/skills"])
        oauth_token: Claude OAuth token (from param or CLAUDE_CODE_OAUTH_TOKEN env)
    """

    def __init__(
        self,
        skills: list[str] | None = None,
        oauth_token: str | None = None,
        name: str = "skill-box",
        image: str = "node:20-alpine",
        memory_mib: int = 2048,
        disk_size_gb: int = 5,
        auto_remove: bool = True,
        runtime: Optional["Boxlite"] = None,
        **kwargs,
    ):
        """
        Create a SkillBox.

        Args:
            skills: Skills to install on first call (e.g., ["anthropics/skills"])
            oauth_token: Claude OAuth token. Uses CLAUDE_CODE_OAUTH_TOKEN env if not provided.
            name: Box name for persistence/reuse (default: "skill-box")
            image: Node.js container image (default: "node:20-alpine")
            memory_mib: Memory allocation in MiB (default: 2048)
            disk_size_gb: Disk size in GB (default: 5)
            auto_remove: Remove box when stopped (default: True for cleanup)
            runtime: Optional runtime instance (uses global default if None)
            **kwargs: Additional BoxOptions parameters
        """
        # Store skills and oauth before parent init
        self._skills = skills or []
        self._oauth_token = oauth_token or os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")

        # Initialize SimpleBox with persistent settings
        super().__init__(
            image=image,
            memory_mib=memory_mib,
            name=name,
            auto_remove=auto_remove,
            runtime=runtime,
            disk_size_gb=disk_size_gb,
            env=[
                ("CLAUDE_CODE_OAUTH_TOKEN", self._oauth_token),
                ("HOME", "/root"),
            ],
            **kwargs,
        )

        # Runtime state for Claude CLI process
        self._process: Optional["Execution"] = None
        self._stdin = None
        self._stdout = None
        self._session_id: str = "default"
        self._setup_complete: bool = False

    async def __aenter__(self) -> "SkillBox":
        """Enter context - creates/reuses box but defers setup to first call()."""
        if not self._oauth_token:
            raise ValueError(
                "OAuth token required. Set CLAUDE_CODE_OAUTH_TOKEN env var "
                "or pass oauth_token parameter."
            )
        await super().__aenter__()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Exit context - clean up Claude process and box (if auto_remove=True)."""
        await self._stop_claude()
        return await super().__aexit__(exc_type, exc_val, exc_tb)

    async def call(self, prompt: str) -> str:
        """
        Send a prompt to Claude and return the response.

        This method supports multi-turn conversations - Claude remembers
        previous messages within the same SkillBox session.

        Auto-setup: On first call, installs dependencies if not already installed.

        Args:
            prompt: The message to send to Claude

        Returns:
            Claude's response text

        Example:
            >>> async with SkillBox() as box:
            ...     result = await box.call("Hello, what can you do?")
            ...     # Multi-turn: Claude remembers context
            ...     result2 = await box.call("Tell me more about that")
        """
        if not self._started:
            raise RuntimeError(
                "SkillBox not started. Use 'async with SkillBox() as box:'"
            )

        # Lazy setup on first call
        if not self._setup_complete:
            await self._setup()
            self._setup_complete = True

        # Start Claude if not running (may have been setup by install_skill())
        if not self._stdin or not self._stdout:
            await self._start_claude()

        response_text, self._session_id = await self._send_message(prompt)
        return response_text

    async def install_skill(self, skill_id: str) -> bool:
        """
        Install a skill from skills.sh.

        Args:
            skill_id: Skill identifier (owner/repo format, e.g., "anthropics/skills")

        Returns:
            True if installation succeeded

        Example:
            >>> async with SkillBox() as box:
            ...     success = await box.install_skill("anthropics/skills")
            ...     if success:
            ...         result = await box.call("Use the pdf skill")
        """
        if not self._started:
            raise RuntimeError(
                "SkillBox not started. Use 'async with SkillBox() as box:'"
            )

        # Ensure dependencies are installed
        if not self._setup_complete:
            await self._setup()
            self._setup_complete = True

        return await self._install_skill_internal(skill_id)

    async def _setup(self) -> None:
        """Install dependencies if not already present."""
        # Check if Claude is already installed
        if await self._is_claude_installed():
            logger.info("Claude CLI already installed")
        else:
            await self._install_dependencies()

        # Install configured skills
        for skill_id in self._skills:
            await self._install_skill_internal(skill_id)

    async def _is_claude_installed(self) -> bool:
        """Check if Claude CLI is installed in the box."""
        try:
            result = await super().exec("claude", "--version")
            return result.exit_code == 0
        except RuntimeError:
            # Binary doesn't exist
            return False

    async def _install_dependencies(self) -> None:
        """Install Claude CLI and required dependencies."""
        # Install Claude CLI
        logger.info("Installing Claude CLI...")
        result = await super().exec("npm", "install", "-g", "@anthropic-ai/claude-code")
        if result.exit_code != 0:
            raise RuntimeError(f"Failed to install Claude CLI: {result.stderr}")

        # Install bash (Claude CLI requires bash/zsh, not ash)
        logger.info("Installing bash...")
        result = await super().exec("apk", "add", "--no-cache", "bash")
        if result.exit_code != 0:
            raise RuntimeError(f"Failed to install bash: {result.stderr}")

        # Install git (required by skills CLI to clone skill repos)
        logger.info("Installing git...")
        result = await super().exec("apk", "add", "--no-cache", "git")
        if result.exit_code != 0:
            raise RuntimeError(f"Failed to install git: {result.stderr}")

        # Install Python (required by document skills like pdf, docx, pptx)
        logger.info("Installing Python...")
        result = await super().exec("apk", "add", "--no-cache", "python3", "py3-pip")
        if result.exit_code != 0:
            raise RuntimeError(f"Failed to install Python: {result.stderr}")

        # Verify installation
        result = await super().exec("claude", "--version")
        logger.info("Installed: %s", result.stdout.strip())

    async def _install_skill_internal(self, skill_id: str) -> bool:
        """Install a skill from skills.sh (internal implementation)."""
        logger.info("Installing skill: %s", skill_id)
        result = await super().exec(
            "npx", "add-skill", skill_id, "-y", "--agent", "claude-code"
        )
        if result.exit_code != 0:
            logger.warning("Failed to install skill %s: %s", skill_id, result.stderr)
            return False
        return True

    async def _start_claude(self) -> None:
        """Start the Claude CLI process with stream-json format."""
        logger.info("Starting Claude CLI process...")

        # Use raw box method for process with stdin control
        self._process = await self._box.exec(
            "claude",
            [
                "--dangerously-skip-permissions",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
            ],
            [
                ("CLAUDE_CODE_OAUTH_TOKEN", self._oauth_token),
                ("IS_SANDBOX", "1"),
                ("SHELL", "/bin/bash"),
            ],
        )
        self._stdin = self._process.stdin()
        self._stdout = self._process.stdout()
        logger.info("Claude CLI ready")

    async def _stop_claude(self) -> None:
        """Stop the Claude CLI process."""
        if self._stdin:
            try:
                await self._stdin.close()
            except Exception as e:
                logger.debug("Error closing stdin: %s", e)
            self._stdin = None

        if self._process:
            try:
                await self._process.wait()
            except Exception as e:
                logger.debug("Error waiting for process: %s", e)
            self._process = None

        self._stdout = None

    async def _send_message(self, content: str) -> tuple[str, str]:
        """
        Send a message and wait for response.

        Args:
            content: Message content to send

        Returns:
            Tuple of (response_text, new_session_id)

        Note:
            BoxLite streams stdout in fixed-size chunks (not line-buffered),
            so we buffer data and parse complete JSON lines.
        """
        # Build message
        msg = {
            "type": "user",
            "message": {"role": "user", "content": content},
            "session_id": self._session_id,
            "parent_tool_use_id": None,
        }

        # Send via stdin
        payload = json.dumps(msg) + "\n"
        logger.debug("Sending message: %s...", content[:50])
        await self._stdin.send_input(payload.encode())

        # Read response with buffering for chunked data
        responses = []
        new_session_id = self._session_id
        buffer = ""

        try:
            while True:
                chunk = await asyncio.wait_for(self._stdout.__anext__(), timeout=120)

                if isinstance(chunk, bytes):
                    chunk_str = chunk.decode("utf-8", errors="replace")
                else:
                    chunk_str = chunk

                buffer += chunk_str

                # Process complete lines
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue

                    try:
                        parsed_msg = json.loads(line)
                        responses.append(parsed_msg)
                        msg_type = parsed_msg.get("type", "unknown")
                        logger.debug("Received message type: %s", msg_type)

                        # Capture session_id for multi-turn
                        if parsed_msg.get("session_id"):
                            new_session_id = parsed_msg.get("session_id")

                        # Stop on result message
                        if msg_type == "result":
                            raise StopIteration
                    except json.JSONDecodeError as e:
                        logger.debug("JSON parse error: %s", e)

        except asyncio.TimeoutError:
            logger.warning("Timeout waiting for response")
        except StopAsyncIteration:
            logger.debug("Stream ended")
        except StopIteration:
            logger.debug("Response complete")

        # Extract response text from result message
        result_msg = next((r for r in responses if r.get("type") == "result"), None)
        response_text = ""

        if result_msg:
            response_text = result_msg.get("result", "")
        else:
            # Fallback: extract from assistant messages
            for r in responses:
                if r.get("type") == "assistant":
                    content_list = r.get("message", {}).get("content", [])
                    for item in content_list:
                        if item.get("type") == "text" and item.get("text"):
                            response_text = item.get("text", "")
                            break
                    if response_text:
                        break

        return response_text, new_session_id
