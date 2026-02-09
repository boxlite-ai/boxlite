#!/usr/bin/env python3
"""Run a custom FUSE filesystem inside a BoxLite VM."""

import asyncio
from pathlib import Path

import boxlite

HERE = Path(__file__).parent


async def main():
    async with boxlite.SimpleBox(image="python:slim") as box:
        await box.copy_in(str(HERE / "hellofs.py"), "/opt")
        await box.copy_in(str(HERE / "run_fuse_demo.sh"), "/opt")

        result = await box.exec("sh", "/opt/run_fuse_demo.sh")

        print(result.stdout)


if __name__ == "__main__":
    asyncio.run(main())
