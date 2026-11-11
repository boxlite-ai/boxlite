"""Upload overwrite protection through real REST and MCP entry points."""
from __future__ import annotations

import base64
import io
import json
import tarfile
import urllib.error
import urllib.parse
import urllib.request

import pytest

from e2e_auth import auth_context


def archive(files):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as tar:
        for name, data in files.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            tar.addfile(entry, io.BytesIO(data))
    return output.getvalue()


def request(method, url, data, headers):
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


@pytest.mark.asyncio
@pytest.mark.parametrize("transport,hinted", [("rest", False), ("rest", True), ("mcp", False)])
async def test_upload_overwrite_preserves_bytes(box, transport, hinted):
    ctx = auth_context()
    guest_path = "/workspace/upload-policy"
    headers = ctx.auth_headers()

    def mcp(method, params):
        status, raw = request("POST", urllib.parse.urljoin(ctx.url, "/mcp"), json.dumps({
            "jsonrpc": "2.0", "id": 1, "method": method, "params": params,
        }).encode(), {**headers, "MCP-Protocol-Version": "2025-03-26", "Content-Type": "application/json",
                     "Accept": "application/json, text/event-stream"})
        assert status == 200, (status, raw)
        value = json.loads(raw)
        assert "error" not in value, value
        return value["result"]

    if transport == "mcp":
        mcp("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                           "clientInfo": {"name": "upload-regression", "version": "1"}})

    def upload(files, overwrite=None):
        args = {"box_id": box.id, "path": guest_path}
        if hinted:
            args["source_is_dir"] = "true"
        if overwrite is not None:
            args["overwrite"] = overwrite
        payload = archive(files)
        if transport == "mcp":
            result = mcp("tools/call", {"name": "uploadFiles", "arguments": {
                **args, "body_base64": base64.b64encode(payload).decode(),
            }})
            if result.get("isError"):
                assert "already_exists" in json.dumps(result), result
                return 409
            assert result["content"][0]["text"] == "HTTP 204", result
            return 204
        args.pop("box_id")
        query = urllib.parse.urlencode(args)
        status, _ = request("PUT", ctx.url_for(ctx.v1(f"boxes/{box.id}/files")) + "?" + query,
                            payload, {**headers, "Content-Type": "application/x-tar"})
        return status

    def download():
        query = urllib.parse.urlencode({"path": guest_path})
        status, data = request("GET", ctx.url_for(ctx.v1(f"boxes/{box.id}/files")) + "?" + query,
                               None, headers)
        assert status == 200, (status, data)
        with tarfile.open(fileobj=io.BytesIO(data)) as tar:
            return {member.name.rsplit("/", 1)[-1]: tar.extractfile(member).read()
                    for member in tar.getmembers() if member.isfile()}

    assert upload({"keep.txt": b"original", "unrelated.txt": b"untouched"}) == 204
    assert upload({"new.txt": b"new"}, False) == 204
    assert upload({"keep.txt": b"replacement"}, False) == 409
    assert download() == {"keep.txt": b"original", "unrelated.txt": b"untouched", "new.txt": b"new"}
    assert upload({"keep.txt": b"replacement"}, True) == 204
    assert download()["keep.txt"] == b"replacement"
    assert upload({"keep.txt": b"default"}) == 204
    assert download()["keep.txt"] == b"default"
