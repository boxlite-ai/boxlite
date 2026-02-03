#!/usr/bin/env python3
"""
SkillBox Example - Using Claude Code CLI with skills in BoxLite.

This example demonstrates using the SkillBox SDK class to run Claude Code CLI
inside an isolated BoxLite VM with user-specified skills installed.

Example:
    async with SkillBox(skills=["anthropics/skills"]) as skill_box:
        result = await skill_box.call("create a pdf of my resume")
        print(result)

Prerequisites:
    1. boxlite Python SDK installed
    2. OAuth token set: export CLAUDE_CODE_OAUTH_TOKEN="your-token"
"""
from __future__ import annotations

import asyncio
import logging

from boxlite import SkillBox


async def main():
    """Example usage of SkillBox."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    print("=== SkillBox Example ===\n")

    async with SkillBox(skills=["anthropics/skills"]) as skill_box:
        # First call - Claude CLI and dependencies installed lazily on first call
        print("Asking about installed skills...")
        result = await skill_box.call("What skills do you have installed? List them briefly.")
        print(f"\nResponse:\n{result}\n")

        # Second call - demonstrates multi-turn (Claude remembers context)
        print("Follow-up question...")
        result2 = await skill_box.call("Which of those skills would be best for creating documents?")
        print(f"\nResponse:\n{result2}\n")

        # Third call - use a skill
        print("Follow-up question... creating PDF")
        result3 = await skill_box.call("use pdf skill to create a pdf with all the conversation history")
        print(f"\nResponse:\n{result3}\n")

    print("Done!")


if __name__ == "__main__":
    asyncio.run(main())
