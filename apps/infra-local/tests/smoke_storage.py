"""Real isolated VM: storage bootstrap, warm reuse, recreation, and durability."""

import asyncio
import argparse
from dataclasses import replace
from pathlib import Path
import os
import socket
import sys
import tempfile
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from compose import orchestrator
from compose.config import InfraConfig, worktree_home
from compose.services import HealthCheck, SPEC_MINIO
from compose.storage import ensure_bucket, storage_client


def client_smoke() -> None:
    from botocore.exceptions import ClientError

    cfg = InfraConfig.load()
    key = f"infra-local-smoke/{uuid.uuid4()}"
    ensure_bucket(cfg)
    with storage_client(cfg) as client:
        try:
            client.put_object(Bucket="boxlite", Key=key, Body=b"isolated S3 client check")
            assert client.get_object(Bucket="boxlite", Key=key)["Body"].read() == b"isolated S3 client check"
        finally:
            client.delete_object(Bucket="boxlite", Key=key)
        try:
            client.head_object(Bucket="boxlite", Key=key)
        except ClientError as exc:
            assert exc.response["ResponseMetadata"]["HTTPStatusCode"] == 404
        else:
            raise AssertionError("temporary S3 object still exists after deletion")
    print("PASS: real signed bucket access and isolated object put/get/delete; no VM restart")


async def smoke(root: Path) -> None:
    # A short home avoids macOS Unix-socket limits; ports are independent of
    # any running infra-local checkout. The SDK runtime is used in one loop.
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    home = Path(os.environ.get("BOXLITE_STORAGE_SMOKE_HOME") or worktree_home(Path(__file__).resolve().parents[3], "s"))
    cfg = InfraConfig(data_dir=root / "data", boxlite_home=home, minio_host_port=port)
    spec = replace(SPEC_MINIO, ports=[(port, 9000)], healthcheck=HealthCheck(http_url=f"http://127.0.0.1:{port}/health", retries=60))
    orchestrator.ensure_home_env(cfg)
    runtime = orchestrator.get_runtime()
    try:
        assert await orchestrator.start_service(runtime, spec, cfg)
        await asyncio.to_thread(ensure_bucket, cfg)
        with storage_client(cfg) as client:
            client.put_object(Bucket="boxlite", Key="infra-smoke", Body=b"durable across recovery")
            assert client.get_object(Bucket="boxlite", Key="infra-smoke")["Body"].read() == b"durable across recovery"
        assert not await orchestrator.start_service(runtime, spec, cfg), "healthy box was recreated"
        if any(item.name == "boxlite-local-minio" for item in await runtime.list_info()):
            await runtime.remove("boxlite-local-minio", force=True)
        assert await orchestrator.start_service(runtime, spec, cfg)
        await asyncio.to_thread(ensure_bucket, cfg)
        with storage_client(cfg) as client:
            assert client.get_object(Bucket="boxlite", Key="infra-smoke")["Body"].read() == b"durable across recovery"
            client.delete_object(Bucket="boxlite", Key="infra-smoke")
            assert client.list_objects_v2(Bucket="boxlite").get("KeyCount") == 0
        print("PASS: isolated S3 bootstrap, CRUD, warm reuse and persistence after recreation")
    finally:
        if any(item.name == "boxlite-local-minio" for item in await runtime.list_info()):
            await runtime.remove("boxlite-local-minio", force=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--client-only", action="store_true")
    args = parser.parse_args()
    if args.client_only:
        client_smoke()
    else:
        with tempfile.TemporaryDirectory(prefix="bl-infra-", dir="/tmp") as directory:
            asyncio.run(smoke(Path(directory)))
