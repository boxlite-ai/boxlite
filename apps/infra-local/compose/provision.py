"""Keep the accepted Box when a cold image outlives the API's startup wait."""

import asyncio
import re


async def create_ready(runtime, options, name, timeout=180):
    """Create once under a unique name; recover only an explicit startup timeout."""
    async with asyncio.timeout(timeout):
        try:
            return await runtime.create(options, name=name)
        except RuntimeError as error:
            match = re.fullmatch(
                r"(?:internal error: )?server timed out: Timed out waiting for box "
                r"([A-Za-z0-9_-]+) to reach started",
                str(error),
            )
            if match is None:
                raise
            expected_id = match.group(1)

        print(
            f"RECOVER CREATE name={name} box={expected_id} deadline={timeout}s",
            flush=True,
        )
        previous = None
        while True:
            box = await runtime.get(name)
            status = "not-yet-visible"
            if box is not None:
                if box.id != expected_id:
                    raise RuntimeError(
                        f"Expected accepted Box {expected_id}; name {name} resolved to {box.id}"
                    )
                status = (await box.info()).state.status
                if status == "running":
                    print(
                        f"RECOVERED CREATE name={name} box={box.id} running", flush=True
                    )
                    return box
                if status in {"failed", "stopped", "stopping", "paused"}:
                    raise RuntimeError(
                        f"Accepted Box {box.id} entered {status}; retained"
                    )
            if status != previous:
                print(
                    f"WAIT CREATE name={name} box={expected_id} state={status}",
                    flush=True,
                )
                previous = status
            await asyncio.sleep(0.5)
