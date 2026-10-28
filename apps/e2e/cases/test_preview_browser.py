"""POL-1221: HTTPS session cookies, assets, fetch and WebSocket in Chromium."""
import asyncio
import json
import os
from pathlib import Path
import shutil

import pytest

from network_fixtures import prepare, ready, service_box
from preview import require


async def test_preview_browser_token_session(rt, image):
    if os.environ.get("BOXLITE_E2E_BROWSER") != "1":
        pytest.skip("not exercised: set BOXLITE_E2E_BROWSER=1 with Chromium and an HTTPS preview endpoint")
    require(bool(shutil.which("node")), "browser lane requires Node")
    driver = Path(__file__).parents[1] / "sdks/node/preview-browser.mjs"
    async with service_box(rt, image) as (box, marker):
        tunnel = await prepare(box, public=False)
        require(tunnel.uri().startswith("https://"), "browser lane requires HTTPS; HTTP cannot verify Secure cookies")
        await ready(tunnel.uri(), marker, {"X-BoxLite-Access-Token": tunnel.token()})
        process = await asyncio.create_subprocess_exec("node", str(driver), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            payload = json.dumps({"uri": tunnel.uri(), "token": tunnel.token(), "marker": marker.decode()}).encode()
            stdout, stderr = await asyncio.wait_for(process.communicate(payload), 90)
            # Playwright errors can include navigation URLs. Redact before reporting.
            detail = stderr.decode().replace(tunnel.token(), "[redacted]")
            require(process.returncode == 0, "browser preview failed: " + detail)
            assert b"PREVIEW_BROWSER=ok" in stdout
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
