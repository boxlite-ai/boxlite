"""Exercise E2E callers through real bindings and a loopback REST boundary."""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import shutil
import subprocess
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock

import boxlite
import pytest

import test_cli_comprehensive as cli_cases
import test_lifecycle_comprehensive as lifecycle_cases
import test_volumes as volume_cases


@pytest.fixture(autouse=True)
def verify_runner_saw_all_boxes():
    # These checks use a loopback API, so there is no stage or runner journal.
    yield


@pytest.fixture
def loopback_api():
    requests = []
    volume = {
        "id": "volume-contract", "name": "loopback-volume",
        "created_at": "2026-01-01T00:00:00Z",
    }

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def respond(self, status, body):
            data = b"" if status == 204 else json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(("POST", self.path, body))
            self.respond(400, {"message": "create refused by test endpoint"})

        def do_DELETE(self):
            requests.append(("DELETE", self.path, None))
            self.respond(204, None)

        def do_GET(self):
            requests.append(("GET", self.path, None))
            if self.path == "/v1/volumes":
                self.respond(200, {"volumes": [volume]})
            elif self.path == f"/v1/volumes/{volume['id']}":
                self.respond(200, volume)
            else:
                self.respond(404, {"message": "not found"})

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}", requests, volume
        finally:
            server.shutdown()
            worker.join(timeout=5)
            assert not worker.is_alive()


@pytest.fixture
def offline_cli(loopback_api, tmp_path, monkeypatch):
    cli = os.environ.get("BOXLITE_E2E_CLI") or shutil.which("boxlite")
    if not cli or not Path(cli).is_file():
        pytest.skip("build the CLI to check its E2E callers")
    url, _, _ = loopback_api
    (tmp_path / "credentials.toml").write_text(
        f'[profiles.offline]\nurl = "{url}"\napi_key = "loopback-key"\n'
    )
    monkeypatch.setenv("BOXLITE_HOME", str(tmp_path))
    monkeypatch.delenv("BOXLITE_REST_URL", raising=False)
    monkeypatch.delenv("BOXLITE_REST_PATH_PREFIX", raising=False)
    monkeypatch.setattr(cli_cases, "CLI_PROFILE", "offline")
    return cli


def test_cli_fixture_sends_command_and_cleans_up_failed_create(offline_cli, loopback_api):
    _, requests, _ = loopback_api
    # The endpoint refuses creation after recording the real CLI's request.
    fixture = cli_cases.detached_box.__wrapped__(offline_cli)
    with pytest.raises((AssertionError, subprocess.CalledProcessError)):
        next(fixture)
    body = next(body for method, _, body in requests if method == "POST")
    assert body["cmd"] == ["sleep", "600"]
    assert body["name"].startswith("e2e-")
    assert body["auto_stop"] == 300 and body["auto_delete"] == 0
    assert any(method == "DELETE" and body["name"] in path for method, path, _ in requests)


def test_named_cli_failure_is_reported_instead_of_skipped(offline_cli):
    try:
        with pytest.raises(AssertionError, match="create refused by test endpoint"):
            cli_cases.test_cli_run_with_name(offline_cli)
    except pytest.skip.Exception as exc:
        pytest.fail(f"CLI failure was hidden as a skip: {exc}")


@pytest.mark.asyncio
async def test_volume_case_reaches_list_and_get_through_native_sdk(loopback_api):
    url, requests, volume = loopback_api
    rt = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(
        url=url, credential=boxlite.ApiKeyCredential("loopback-key"),
    ))
    await volume_cases.test_volume_is_listed_and_fetchable_through_the_sdk(rt, volume)
    assert [(method, path) for method, path, _ in requests] == [
        ("GET", "/v1/volumes"), ("GET", f"/v1/volumes/{volume['id']}"),
    ]


@pytest.mark.asyncio
async def test_stopped_exec_case_does_not_swallow_its_own_assertion(monkeypatch):
    # Inject the product regression this negative E2E case must reject.
    execution = SimpleNamespace(wait=AsyncMock(return_value=SimpleNamespace(exit_code=0)))
    box = SimpleNamespace(id="abcdefghijkl", stop=AsyncMock(), exec=AsyncMock(return_value=execution))
    rt = SimpleNamespace(
        create=AsyncMock(return_value=box), remove=AsyncMock(),
        get_info=AsyncMock(return_value=SimpleNamespace(state=SimpleNamespace(status="stopped"))),
    )
    monkeypatch.setattr(lifecycle_cases, "drain", AsyncMock(return_value=("should-fail", "")))
    with pytest.raises(AssertionError, match="exec on stopped box succeeded silently"):
        await lifecycle_cases.test_exec_on_stopped_box_fails(rt, "image")
