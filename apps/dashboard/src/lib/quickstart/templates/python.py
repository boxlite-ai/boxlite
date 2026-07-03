import asyncio
import os
import time

from boxlite import (
    ApiKeyCredential,
    Boxlite,
    BoxliteRestOptions,
    BoxOptions,
)

async def main():
    rt = Boxlite.rest(BoxliteRestOptions(
        url=os.environ.get("BOXLITE_REST_URL", "{{REST_API_URL}}"),
        credential=ApiKeyCredential({{API_KEY_PY}}),
    ))

    box_name = f"sdk-quickstart-python-{int(time.time())}"
    box = await rt.create(
        BoxOptions(
            image="ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3",
        ),
        name=box_name,
    )
    await box.start()

    execution = await box.exec("echo", args=["Hello from BoxLite SDK"])
    output = ""
    async for line in execution.stdout():
        output += line
    result = await execution.wait()
    print(f"Exit code: {result.exit_code}")
    print(output)

    await rt.remove(box.id, force=True)

asyncio.run(main())
