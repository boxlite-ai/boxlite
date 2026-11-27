import asyncio
import os
import time

from boxlite import (
    ApiKeyCredential, Boxlite, BoxliteRestOptions, BoxOptions,
    NetworkSpec, InboundNetworkSpec,
)

async def main():
    rt = Boxlite.rest(BoxliteRestOptions(
    url=os.environ.get("BOXLITE_REST_URL", "{{REST_API_URL}}"),
    credential=ApiKeyCredential({{API_KEY_PY}}),
    ))
    box = await rt.create(BoxOptions(
    image="ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0",
    network=NetworkSpec(inbound=InboundNetworkSpec(mode="enabled")),
    ), name=f"sdk-quickstart-python-{time.time_ns()}")
    print(f"Created Box: {box.id}", flush=True)
    await box.start()
{{STEP_EXECUTION}}
    execution = await box.exec({{COMMAND_LITERAL}}, args=[{{ARGUMENT_LITERALS}}])
    output = "".join([line async for line in execution.stdout()])
    result = await execution.wait()
    print(output, end="")
    if result.exit_code != 0:
        raise RuntimeError(f"Command exited with {result.exit_code}")
{{STEP_PREVIEW}}
    server_code = {{SERVER_PY}}
    # Start the server without waiting for it to exit.
    server = await box.exec("python3", args=["-u", "-c", server_code])
    preview = await box.network.tunnel(("127.0.0.1", 3000))
    url = preview.uri()
    if not url:
        raise RuntimeError("Cloud did not return a preview URL")
    print(f"Preview URL: {url}", flush=True)

asyncio.run(main())
