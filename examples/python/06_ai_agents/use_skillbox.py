#!/usr/bin/env python3
"""
SkillBox Example - Running Claude Code CLI with Skills

Demonstrates:
- Creating a SkillBox with skills pre-configured
- Lazy dependency installation on first call()
- Multi-turn conversations with Claude
- Manual skill installation
- Real-world use case: AI coding assistants with document skills

Prerequisites:
    1. boxlite Python SDK installed
    2. OAuth token set: export CLAUDE_CODE_OAUTH_TOKEN="your-token"

Usage:
    CLAUDE_CODE_OAUTH_TOKEN="your-token" python skillbox_example.py
"""

import asyncio
import logging
import os

import boxlite


async def example_basic():
    """Example 1: Basic SkillBox usage."""
    print("\n=== Example 1: Basic SkillBox Call ===")

    async with boxlite.SkillBox() as skill_box:
        print(f"Box ID: {skill_box.id}")
        print("Asking Claude a simple question...")

        # First call triggers lazy setup (installs Claude CLI, bash, git, python)
        result = await skill_box.call("What is 2 + 2? Just give the number.")
        print(f"Claude says: {result}")


async def example_with_skills():
    """Example 2: SkillBox with pre-configured skills."""
    print("\n\n=== Example 2: Pre-configured Skills ===")

    # Skills are installed on first call() along with Claude CLI
    async with boxlite.SkillBox(skills=["anthropics/skills"]) as skill_box:
        print("SkillBox with Anthropic skills ready")

        result = await skill_box.call("What skills do you have? List the top 5 briefly.")
        print(f"Claude says:\n{result[:500]}...")


async def example_multi_turn():
    """Example 3: Multi-turn conversation."""
    print("\n\n=== Example 3: Multi-turn Conversation ===")

    async with boxlite.SkillBox() as skill_box:
        # First message
        await skill_box.call("My name is Alice and I'm a software engineer.")

        # Second message - Claude should remember context
        await skill_box.call("I work mainly with Python and Rust.")

        # Third message - test that Claude remembers both previous messages
        result = await skill_box.call("What do you know about me? Be brief.")
        print(f"Claude remembers:\n{result}")


async def example_manual_skill_install():
    """Example 4: Manual skill installation."""
    print("\n\n=== Example 4: Manual Skill Installation ===")

    async with boxlite.SkillBox() as skill_box:
        print("Installing skill manually...")

        # install_skill returns bool indicating success
        success = await skill_box.install_skill("anthropics/skills")
        if success:
            print("Skill installed successfully!")
        else:
            print("Skill installation failed")
            return

        # Now use the skill
        result = await skill_box.call("List 3 document skills you now have.")
        print(f"Claude says:\n{result[:300]}...")


async def example_persistence():
    """Example 5: Box persistence for reuse."""
    print("\n\n=== Example 5: Box Persistence ===")

    # Set auto_remove=False to persist box between sessions
    # This means dependencies are only installed once

    print("First session - dependencies will be installed:")
    async with boxlite.SkillBox(name="my-persistent-skillbox", auto_remove=False) as skill_box:
        await skill_box.call("Hello! Remember this session.")
        print("First session complete")

    print("\nSecond session - reuses existing box with installed dependencies:")
    async with boxlite.SkillBox(name="my-persistent-skillbox", auto_remove=False) as skill_box:
        result = await skill_box.call("What did I say in the previous message?")
        print(f"Claude says: {result[:200]}...")
        print("(Note: Context is per-session, not persistent between sessions)")


async def example_custom_config():
    """Example 6: Custom configuration options."""
    print("\n\n=== Example 6: Custom Configuration ===")

    async with boxlite.SkillBox(
            name="custom-skill-box",
            memory_mib=4096,  # More memory for complex tasks
            disk_size_gb=10,  # Larger disk for more packages
            skills=["anthropics/skills"],
    ) as skill_box:
        info = skill_box.info()
        print(f"Box name: {info.name}")
        print(f"Memory: {info.memory_mib} MiB")
        print(f"Image: {info.image}")

        result = await skill_box.call("Confirm you're ready to help!")
        print(f"Claude says: {result[:100]}...")


async def main():
    """Run all examples."""
    print("=" * 60)
    print("SkillBox Examples - Claude Code CLI in BoxLite")
    print("=" * 60)

    # Check for token
    if not os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
        print("\nERROR: CLAUDE_CODE_OAUTH_TOKEN environment variable not set")
        print("\nTo run this example:")
        print("  1. Get your OAuth token from Claude Code CLI")
        print("  2. Run: CLAUDE_CODE_OAUTH_TOKEN='your-token' python skillbox_example.py")
        return

    # Run examples sequentially
    # Note: Some examples are commented out to speed up demo
    await example_basic()
    await example_with_skills()  # Uncomment to test skills
    await example_multi_turn()
    await example_manual_skill_install()  # Uncomment to test manual install
    await example_persistence()  # Uncomment to test persistence
    await example_custom_config()  # Uncomment for custom config

    print("\n" + "=" * 60)
    print("Examples completed!")
    print("\nKey Takeaways:")
    print("  - SkillBox runs Claude Code CLI in isolated VM")
    print("  - Lazy setup: deps installed on first call()")
    print("  - Multi-turn conversations supported")
    print("  - Skills can be pre-configured or installed manually")
    print("  - Box persists by default for dependency reuse")


if __name__ == "__main__":
    # Enable logging to see installation progress
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    asyncio.run(main())
