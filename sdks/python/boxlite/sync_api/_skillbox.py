"""
SyncSkillBox - Synchronous wrapper for SkillBox.

Provides a synchronous API for Claude Code CLI execution using greenlet fiber switching.
API mirrors async SkillBox exactly.
"""

import json
import logging
import os
from typing import TYPE_CHECKING, Optional

from ._simplebox import SyncSimpleBox

if TYPE_CHECKING:
    from ._boxlite import SyncBoxlite

__all__ = ["SyncSkillBox"]

logger = logging.getLogger("boxlite.sync_skillbox")


class SyncSkillBox(SyncSimpleBox):
    """
    Synchronous wrapper for SkillBox.

    Provides synchronous methods for executing Claude Code CLI with skills.
    Built on top of SyncSimpleBox with Claude-specific convenience methods.
    API mirrors async SkillBox exactly.

    SyncSkillBox defaults to `auto_remove=True` for automatic cleanup after use,
    and has a default name for easy identification.

    Usage (standalone - recommended):
        with SyncSkillBox(skills=["anthropics/skills"]) as box:
            result = box.call("What skills do you have?")
            print(result)

    Usage (with explicit runtime):
        with SyncBoxlite.default() as runtime:
            with SyncSkillBox(skills=["anthropics/skills"], runtime=runtime) as box:
                result = box.call("Hello!")
                print(result)
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
        runtime: Optional["SyncBoxlite"] = None,
        **kwargs,
    ):
        """
        Create a SyncSkillBox.

        Args:
            skills: Skills to install on first call (e.g., ["anthropics/skills"])
            oauth_token: Claude OAuth token. Uses CLAUDE_CODE_OAUTH_TOKEN env if not provided.
            name: Box name for persistence/reuse (default: "skill-box")
            image: Node.js container image (default: "node:20-alpine")
            memory_mib: Memory allocation in MiB (default: 2048)
            disk_size_gb: Disk size in GB (default: 5)
            auto_remove: Remove box when stopped (default: True for cleanup)
            runtime: Optional SyncBoxlite runtime. If None, creates default runtime.
            **kwargs: Additional BoxOptions parameters
        """
        self._skills = skills or []
        self._oauth_token = oauth_token or os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")

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
        self._process = None
        self._stdin = None
        self._stdout = None
        self._session_id: str = "default"
        self._setup_complete: bool = False

    def __enter__(self) -> "SyncSkillBox":
        """Enter context - validates token and creates/reuses box."""
        if not self._oauth_token:
            raise ValueError(
                "OAuth token required. Set CLAUDE_CODE_OAUTH_TOKEN env var "
                "or pass oauth_token parameter."
            )
        return super().__enter__()

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        """Exit context - clean up Claude process and box (if auto_remove=True)."""
        self._stop_claude()
        return super().__exit__(exc_type, exc_val, exc_tb)

    def call(self, prompt: str) -> str:
        """
        Send a prompt to Claude and return the response.

        This method supports multi-turn conversations - Claude remembers
        previous messages within the same SyncSkillBox session.

        Auto-setup: On first call, installs dependencies if not already installed.

        Args:
            prompt: The message to send to Claude

        Returns:
            Claude's response text

        Example:
            with SyncSkillBox() as box:
                result = box.call("Hello, what can you do?")
                # Multi-turn: Claude remembers context
                result2 = box.call("Tell me more about that")
        """
        # Lazy setup on first call
        if not self._setup_complete:
            self._setup()
            self._setup_complete = True

        # Start Claude if not running (may have been setup by install_skill())
        if not self._stdin or not self._stdout:
            self._start_claude()

        response_text, self._session_id = self._send_message(prompt)
        return response_text

    def install_skill(self, skill_id: str) -> bool:
        """
        Install a skill from skills.sh.

        Args:
            skill_id: Skill identifier (owner/repo format, e.g., "anthropics/skills")

        Returns:
            True if installation succeeded

        Example:
            with SyncSkillBox() as box:
                success = box.install_skill("anthropics/skills")
                if success:
                    result = box.call("Use the pdf skill")
        """
        # Ensure dependencies are installed
        if not self._setup_complete:
            self._setup()
            self._setup_complete = True

        return self._install_skill_internal(skill_id)

    def _setup(self) -> None:
        """Install dependencies if not already present."""
        # Check if Claude is already installed
        if self._is_claude_installed():
            logger.info("Claude CLI already installed")
        else:
            self._install_dependencies()

        # Install configured skills
        for skill_id in self._skills:
            self._install_skill_internal(skill_id)

    def _is_claude_installed(self) -> bool:
        """Check if Claude CLI is installed in the box."""
        try:
            result = self._run_cmd("claude", "--version")
            return result.exit_code == 0
        except RuntimeError:
            # Binary doesn't exist
            return False

    def _install_dependencies(self) -> None:
        """Install Claude CLI and required dependencies."""
        # Install Claude CLI
        logger.info("Installing Claude CLI...")
        result = self._run_cmd("npm", "install", "-g", "@anthropic-ai/claude-code")
        if result.exit_code != 0:
            raise RuntimeError(f"Failed to install Claude CLI: {result.stderr}")

        # Install bash (Claude CLI requires bash/zsh, not ash)
        logger.info("Installing bash...")
        result = self._run_cmd("apk", "add", "--no-cache", "bash")
        if result.exit_code != 0:
            raise RuntimeError(f"Failed to install bash: {result.stderr}")

        # Install git (required by skills CLI to clone skill repos)
        logger.info("Installing git...")
        result = self._run_cmd("apk", "add", "--no-cache", "git")
        if result.exit_code != 0:
            raise RuntimeError(f"Failed to install git: {result.stderr}")

        # Install Python (required by document skills like pdf, docx, pptx)
        logger.info("Installing Python...")
        result = self._run_cmd("apk", "add", "--no-cache", "python3", "py3-pip")
        if result.exit_code != 0:
            raise RuntimeError(f"Failed to install Python: {result.stderr}")

        # Verify installation
        result = self._run_cmd("claude", "--version")
        logger.info("Installed: %s", result.stdout.strip())

    def _install_skill_internal(self, skill_id: str) -> bool:
        """Install a skill from skills.sh (internal implementation)."""
        logger.info("Installing skill: %s", skill_id)
        result = self._run_cmd(
            "npx", "add-skill", skill_id, "-y", "--agent", "claude-code"
        )
        if result.exit_code != 0:
            logger.warning("Failed to install skill %s: %s", skill_id, result.stderr)
            return False
        return True

    def _run_cmd(self, cmd: str, *args: str):
        """Internal helper to run a command using parent's exec method."""
        return SyncSimpleBox.exec(self, cmd, *args)

    def _start_claude(self) -> None:
        """Start the Claude CLI process with stream-json format."""
        logger.info("Starting Claude CLI process...")

        # Use raw box method for process with stdin control
        self._process = self._box.exec(
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

    def _stop_claude(self) -> None:
        """Stop the Claude CLI process."""
        if self._stdin:
            try:
                self._stdin.close()
            except Exception as e:
                logger.debug("Error closing stdin: %s", e)
            self._stdin = None

        if self._process:
            try:
                self._process.wait()
            except Exception as e:
                logger.debug("Error waiting for process: %s", e)
            self._process = None

        self._stdout = None

    def _send_message(self, content: str) -> tuple[str, str]:
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
        import time

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
        self._stdin.send_input(payload.encode())

        # Read response with buffering for chunked data
        responses = []
        new_session_id = self._session_id
        buffer = ""
        timeout = 120
        start_time = time.time()

        try:
            for chunk in self._stdout:
                if time.time() - start_time > timeout:
                    logger.warning("Timeout waiting for response")
                    break

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
