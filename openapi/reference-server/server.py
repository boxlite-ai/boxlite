#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "fastapi>=0.115",
#     "uvicorn>=0.34",
#     "sse-starlette>=2.0",
#     "PyJWT>=2.8",
#     "python-multipart>=0.0.9",
# ]
# ///
"""
BoxLite REST API Reference Server

Reference implementation of the BoxLite Cloud Sandbox REST API.
Implements the OpenAPI spec at ../rest-sandbox-open-api.yaml.

Purpose: showcase the API and validate client implementations.
NOT production-ready — no persistence, no real auth, single-tenant.

Usage:
    make dev:python  # build boxlite SDK
    uv run --active server.py --port 8080
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import logging
import os
import tarfile
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

import jwt
import uvicorn
from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Path,
    Query,
    Request,
    Response,
)
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse, ServerSentEvent

import boxlite

# ============================================================================
# Configuration
# ============================================================================

JWT_SECRET = "boxlite-reference-server-secret"  # NOT for production
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_SECONDS = 3600

# Hardcoded test credentials
TEST_CLIENT_ID = "test-client"
TEST_CLIENT_SECRET = "test-secret"

logger = logging.getLogger("boxlite-server")

# ============================================================================
# Pydantic Models
# ============================================================================


class ErrorModel(BaseModel):
    message: str
    type: str
    code: int
    stack: Optional[list[str]] = None


class ErrorResponse(BaseModel):
    error: ErrorModel


class CreateBoxRequest(BaseModel):
    name: Optional[str] = None
    image: Optional[str] = "alpine:latest"
    rootfs_path: Optional[str] = None
    cpus: Optional[int] = None
    memory_mib: Optional[int] = None
    disk_size_gb: Optional[int] = None
    working_dir: Optional[str] = None
    env: Optional[dict[str, str]] = None
    entrypoint: Optional[list[str]] = None
    cmd: Optional[list[str]] = None
    user: Optional[str] = None
    volumes: Optional[list[dict]] = None
    ports: Optional[list[dict]] = None
    network: Optional[str] = "isolated"
    auto_remove: Optional[bool] = True
    detach: Optional[bool] = False
    security: Optional[str] = None


class StopBoxRequest(BaseModel):
    timeout_seconds: Optional[float] = 30


class ExecCommandRequest(BaseModel):
    command: str
    args: Optional[list[str]] = None
    env: Optional[dict[str, str]] = None
    timeout_seconds: Optional[float] = None
    working_dir: Optional[str] = None
    tty: bool = False


class SignalRequest(BaseModel):
    signal: int


class ResizeRequest(BaseModel):
    cols: int
    rows: int


# ============================================================================
# State
# ============================================================================


@dataclass
class ActiveExecution:
    the_execution: Any
    box_id: str
    stdout: Any
    stderr: Any
    stdin: Any
    status: str = "running"
    exit_code: Optional[int] = None
    error_message: Optional[str] = None
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


class AppState:
    def __init__(self):
        self.runtime: Optional[boxlite.Boxlite] = None
        self.active_executions: dict[str, ActiveExecution] = {}


state = AppState()

# ============================================================================
# Error Mapping
# ============================================================================

# Maps BoxliteError message prefixes to (HTTP status, error type)
ERROR_MAP = [
    ("box not found:", 404, "NotFoundError"),
    ("already exists:", 409, "AlreadyExistsError"),
    ("invalid state:", 409, "InvalidStateError"),
    ("stopped:", 409, "StoppedError"),
    ("invalid argument:", 400, "InvalidArgumentError"),
    ("configuration error:", 400, "ConfigError"),
    ("unsupported:", 400, "UnsupportedError"),
    ("unsupported engine", 400, "UnsupportedError"),
    ("images error:", 422, "ImageError"),
    ("Execution error:", 422, "ExecutionError"),
    ("storage error:", 500, "StorageError"),
    ("internal error:", 500, "InternalError"),
    ("engine reported an error:", 500, "EngineError"),
    ("portal error:", 502, "PortalError"),
    ("network error:", 502, "NetworkError"),
    ("gRPC/tonic error:", 502, "RpcError"),
    ("gRPC transport error:", 502, "RpcTransportError"),
    ("database error:", 500, "DatabaseError"),
    ("metadata error:", 500, "MetadataError"),
]


def classify_error(message: str) -> tuple[int, str]:
    for prefix, status, error_type in ERROR_MAP:
        if message.startswith(prefix):
            return status, error_type
    return 500, "InternalError"


def error_response(status: int, message: str, error_type: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": {"message": message, "type": error_type, "code": status}},
    )


# ============================================================================
# Auth
# ============================================================================

bearer_scheme = HTTPBearer(auto_error=False)


def create_token(client_id: str, scopes: str = "") -> dict:
    now = time.time()
    payload = {
        "sub": client_id,
        "iat": now,
        "exp": now + JWT_EXPIRY_SECONDS,
        "scope": scopes
        or "boxes:read boxes:write boxes:exec images:read images:write runtime:admin",
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_in": JWT_EXPIRY_SECONDS,
        "scope": payload["scope"],
    }


async def require_auth(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
) -> dict:
    if credentials is None:
        raise HTTPException(
            status_code=401,
            detail={
                "error": {
                    "message": "missing authorization header",
                    "type": "UnauthorizedError",
                    "code": 401,
                }
            },
        )
    try:
        payload = jwt.decode(
            credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM]
        )
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=401,
            detail={
                "error": {
                    "message": "token expired",
                    "type": "UnauthorizedError",
                    "code": 401,
                }
            },
        )
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=401,
            detail={
                "error": {
                    "message": "invalid token",
                    "type": "UnauthorizedError",
                    "code": 401,
                }
            },
        )


# ============================================================================
# Helpers
# ============================================================================


def box_info_to_dict(info) -> dict:
    return {
        "box_id": info.id,
        "name": info.name,
        "status": info.state.status,
        "created_at": info.created_at,
        "updated_at": info.created_at,
        "pid": info.state.pid,
        "image": info.image,
        "cpus": info.cpus,
        "memory_mib": info.memory_mib,
        "labels": {},
    }


def build_box_options(req: CreateBoxRequest) -> boxlite.BoxOptions:
    kwargs = {}
    if req.image and not req.rootfs_path:
        kwargs["image"] = req.image
    if req.rootfs_path:
        kwargs["rootfs_path"] = req.rootfs_path
    if req.cpus is not None:
        kwargs["cpus"] = req.cpus
    if req.memory_mib is not None:
        kwargs["memory_mib"] = req.memory_mib
    if req.disk_size_gb is not None:
        kwargs["disk_size_gb"] = req.disk_size_gb
    if req.working_dir is not None:
        kwargs["working_dir"] = req.working_dir
    if req.env:
        kwargs["env"] = list(req.env.items())
    if req.entrypoint is not None:
        kwargs["entrypoint"] = req.entrypoint
    if req.cmd is not None:
        kwargs["cmd"] = req.cmd
    if req.user is not None:
        kwargs["user"] = req.user
    if req.auto_remove is not None:
        kwargs["auto_remove"] = req.auto_remove
    if req.detach is not None:
        kwargs["detach"] = req.detach
    if req.volumes:
        kwargs["volumes"] = [
            (v["host_path"], v["guest_path"], v.get("read_only", False))
            for v in req.volumes
        ]
    if req.ports:
        kwargs["ports"] = [
            (p.get("host_port", 0), p["guest_port"], p.get("protocol", "tcp"))
            for p in req.ports
        ]
    if req.security:
        presets = {
            "development": boxlite.SecurityOptions.development,
            "standard": boxlite.SecurityOptions.standard,
            "maximum": boxlite.SecurityOptions.maximum,
        }
        if req.security in presets:
            kwargs["security"] = presets[req.security]()

    return boxlite.BoxOptions(**kwargs)


async def get_box_or_404(box_id: str):
    box_handle = await state.runtime.get(box_id)
    if box_handle is None:
        raise HTTPException(
            status_code=404,
            detail={
                "error": {
                    "message": f"box not found: {box_id}",
                    "type": "NotFoundError",
                    "code": 404,
                }
            },
        )
    return box_handle


def get_active_execution_or_404(exec_id: str) -> ActiveExecution:
    active = state.active_executions.get(exec_id)
    if active is None:
        raise HTTPException(
            status_code=404,
            detail={
                "error": {
                    "message": f"execution not found: {exec_id}",
                    "type": "NotFoundError",
                    "code": 404,
                }
            },
        )
    return active


# ============================================================================
# App
# ============================================================================


@asynccontextmanager
async def lifespan(app: FastAPI):
    state.runtime = boxlite.Boxlite.default()
    logger.info("BoxLite runtime initialized")
    yield
    try:
        await state.runtime.shutdown(timeout=10)
    except Exception as e:
        logger.warning("Shutdown error: %s", e)


app = FastAPI(
    title="BoxLite Cloud Sandbox REST API",
    version="0.1.0",
    lifespan=lifespan,
)


@app.exception_handler(RuntimeError)
async def runtime_error_handler(request: Request, err: RuntimeError):
    message = str(err)
    status, error_type = classify_error(message)
    return error_response(status, message, error_type)


# ============================================================================
# Config & Auth
# ============================================================================


@app.get("/v1/config")
async def get_config():
    return {
        "defaults": {
            "cpus": 2,
            "memory_mib": 512,
            "disk_size_gb": 10,
            "security_preset": "standard",
            "auto_remove": True,
        },
        "overrides": {},
        "capabilities": {
            "max_cpus": 32,
            "max_memory_mib": 16384,
            "max_disk_size_gb": 100,
            "max_boxes_per_prefix": 50,
            "max_concurrent_executions": 10,
            "file_transfer_max_bytes": 1073741824,
            "exec_timeout_max_seconds": 3600,
            "tty_enabled": True,
            "streaming_enabled": True,
            "supported_security_presets": ["development", "standard", "maximum"],
            "idempotency_key_lifetime": "PT24H",
        },
    }


@app.post("/v1/oauth/tokens")
async def get_token(request: Request):
    body = await request.form()
    grant_type = body.get("grant_type")
    client_id = body.get("client_id")
    client_secret = body.get("client_secret")
    scope = body.get("scope", "")

    if grant_type != "client_credentials":
        return error_response(400, "unsupported grant_type", "InvalidArgumentError")

    if client_id != TEST_CLIENT_ID or client_secret != TEST_CLIENT_SECRET:
        return error_response(401, "invalid client credentials", "UnauthorizedError")

    return create_token(client_id, scope)


# ============================================================================
# Boxes
# ============================================================================


@app.post("/v1/{prefix}/boxes", status_code=201)
async def create_box(
    prefix: str,
    req: CreateBoxRequest,
    _auth: dict = Depends(require_auth),
):
    options = build_box_options(req)
    box_handle = await state.runtime.create(options, req.name)
    info = box_handle.info()
    data = box_info_to_dict(info)
    return JSONResponse(
        status_code=201,
        content=data,
        headers={"Location": f"/v1/{prefix}/boxes/{info.id}"},
    )


@app.get("/v1/{prefix}/boxes")
async def list_boxes(
    prefix: str,
    status: Optional[str] = Query(None),
    pageSize: int = Query(100, ge=1, le=1000),
    pageToken: Optional[str] = Query(None),
    _auth: dict = Depends(require_auth),
):
    infos = await state.runtime.list_info()
    if status:
        infos = [i for i in infos if i.state.status == status]
    boxes = [box_info_to_dict(i) for i in infos]
    return {"boxes": boxes, "next_page_token": None}


@app.get("/v1/{prefix}/boxes/{box_id}")
async def get_box(
    prefix: str,
    box_id: str,
    _auth: dict = Depends(require_auth),
):
    info = await state.runtime.get_info(box_id)
    if info is None:
        return error_response(404, f"box not found: {box_id}", "NotFoundError")
    return box_info_to_dict(info)


@app.head("/v1/{prefix}/boxes/{box_id}")
async def box_exists(
    prefix: str,
    box_id: str,
    _auth: dict = Depends(require_auth),
):
    info = await state.runtime.get_info(box_id)
    if info is None:
        return Response(status_code=404)
    return Response(status_code=204)


@app.delete("/v1/{prefix}/boxes/{box_id}", status_code=204)
async def remove_box(
    prefix: str,
    box_id: str,
    force: bool = Query(False),
    _auth: dict = Depends(require_auth),
):
    await state.runtime.remove(box_id, force=force)
    return Response(status_code=204)


@app.post("/v1/{prefix}/boxes/{box_id}/start")
async def start_box(
    prefix: str,
    box_id: str,
    _auth: dict = Depends(require_auth),
):
    box_handle = await get_box_or_404(box_id)
    await box_handle.start()
    info = box_handle.info()
    return box_info_to_dict(info)


@app.post("/v1/{prefix}/boxes/{box_id}/stop")
async def stop_box(
    prefix: str,
    box_id: str,
    req: Optional[StopBoxRequest] = None,
    _auth: dict = Depends(require_auth),
):
    box_handle = await get_box_or_404(box_id)
    await box_handle.stop()
    info = box_handle.info()
    return box_info_to_dict(info)


# ============================================================================
# Execution
# ============================================================================


@app.post("/v1/{prefix}/boxes/{box_id}/exec", status_code=201)
async def start_execution(
    prefix: str,
    box_id: str,
    req: ExecCommandRequest,
    _auth: dict = Depends(require_auth),
):
    box_handle = await get_box_or_404(box_id)

    kwargs = {}
    if req.args:
        kwargs["args"] = req.args
    if req.env:
        kwargs["env"] = list(req.env.items())
    if req.tty:
        kwargs["tty"] = True

    execution = await box_handle.exec(req.command, **kwargs)
    exec_id = execution.id()

    # Take streams immediately (can only be called once)
    active = ActiveExecution(
        the_execution=execution,
        box_id=box_id,
        stdout=execution.stdout(),
        stderr=execution.stderr(),
        stdin=execution.stdin(),
    )
    state.active_executions[exec_id] = active

    # Background task: wait for completion and update status
    async def wait_for_completion():
        try:
            result = await execution.wait()
            active.exit_code = result.exit_code
            active.error_message = result.error_message
            active.status = (
                "completed" if result.exit_code is not None else "killed"
            )
        except Exception as e:
            active.status = "killed"
            active.error_message = str(e)

    asyncio.create_task(wait_for_completion())

    return JSONResponse(
        status_code=201,
        content={"execution_id": exec_id},
        headers={
            "Location": f"/v1/{prefix}/boxes/{box_id}/executions/{exec_id}"
        },
    )


@app.get("/v1/{prefix}/boxes/{box_id}/executions/{exec_id}")
async def get_execution(
    prefix: str,
    box_id: str,
    exec_id: str,
    _auth: dict = Depends(require_auth),
):
    active = get_active_execution_or_404(exec_id)
    elapsed = (datetime.now(timezone.utc) - active.started_at).total_seconds()
    return {
        "execution_id": exec_id,
        "status": active.status,
        "exit_code": active.exit_code,
        "started_at": active.started_at.isoformat(),
        "duration_ms": int(elapsed * 1000) if active.status != "running" else None,
        "error_message": active.error_message,
    }


@app.get("/v1/{prefix}/boxes/{box_id}/executions/{exec_id}/output")
async def stream_execution_output(
    prefix: str,
    box_id: str,
    exec_id: str,
    _auth: dict = Depends(require_auth),
):
    active = get_active_execution_or_404(exec_id)

    async def event_generator():
        queue: asyncio.Queue = asyncio.Queue()

        async def produce(stream, event_type: str):
            if stream is None:
                return
            try:
                async for line in stream:
                    encoded = base64.b64encode(
                        line.encode("utf-8")
                    ).decode("ascii")
                    await queue.put(
                        ServerSentEvent(
                            event=event_type,
                            data=json.dumps({"data": encoded}),
                        )
                    )
            except Exception:
                pass
            finally:
                await queue.put(None)

        tasks = []
        stream_count = 0
        if active.stdout is not None:
            tasks.append(
                asyncio.create_task(produce(active.stdout, "stdout"))
            )
            stream_count += 1
        if active.stderr is not None:
            tasks.append(
                asyncio.create_task(produce(active.stderr, "stderr"))
            )
            stream_count += 1

        if stream_count == 0:
            while active.status == "running":
                await asyncio.sleep(0.1)
        else:
            done = 0
            while done < stream_count:
                item = await queue.get()
                if item is None:
                    done += 1
                else:
                    yield item

        # Wait for exit status
        while active.status == "running":
            await asyncio.sleep(0.1)

        elapsed = (
            datetime.now(timezone.utc) - active.started_at
        ).total_seconds()
        yield ServerSentEvent(
            event="exit",
            data=json.dumps(
                {
                    "exit_code": active.exit_code,
                    "duration_ms": int(elapsed * 1000),
                }
            ),
        )

    return EventSourceResponse(event_generator())


@app.post(
    "/v1/{prefix}/boxes/{box_id}/executions/{exec_id}/input",
    status_code=204,
)
async def send_execution_input(
    prefix: str,
    box_id: str,
    exec_id: str,
    request: Request,
    x_close_stdin: Optional[str] = Header(None, alias="X-Close-Stdin"),
    _auth: dict = Depends(require_auth),
):
    active = get_active_execution_or_404(exec_id)
    if active.stdin is None:
        return error_response(409, "stdin not available", "InvalidStateError")

    body = await request.body()
    if body:
        await active.stdin.send_input(body)

    if x_close_stdin and x_close_stdin.lower() == "true":
        await active.stdin.close()

    return Response(status_code=204)


@app.post(
    "/v1/{prefix}/boxes/{box_id}/executions/{exec_id}/signal",
    status_code=204,
)
async def signal_execution(
    prefix: str,
    box_id: str,
    exec_id: str,
    req: SignalRequest,
    _auth: dict = Depends(require_auth),
):
    active = get_active_execution_or_404(exec_id)
    if active.status != "running":
        return error_response(409, "execution is not running", "InvalidStateError")

    # SDK only supports kill (SIGKILL)
    await active.the_execution.kill()
    active.status = "killed"
    return Response(status_code=204)


@app.post(
    "/v1/{prefix}/boxes/{box_id}/executions/{exec_id}/resize",
    status_code=204,
)
async def resize_execution_tty(
    prefix: str,
    box_id: str,
    exec_id: str,
    req: ResizeRequest,
    _auth: dict = Depends(require_auth),
):
    active = get_active_execution_or_404(exec_id)
    if active.status != "running":
        return error_response(
            409, "execution is not running", "InvalidStateError"
        )

    await active.the_execution.resize_tty(req.rows, req.cols)
    return Response(status_code=204)


# ============================================================================
# Files
# ============================================================================


@app.put("/v1/{prefix}/boxes/{box_id}/files", status_code=204)
async def upload_files(
    prefix: str,
    box_id: str,
    path: str = Query(..., description="Destination path inside the container"),
    overwrite: bool = Query(True),
    request: Request = None,
    _auth: dict = Depends(require_auth),
):
    box_handle = await get_box_or_404(box_id)
    body = await request.body()

    with tempfile.TemporaryDirectory() as tmpdir:
        tar_path = os.path.join(tmpdir, "upload.tar")
        with open(tar_path, "wb") as f:
            f.write(body)

        extract_dir = os.path.join(tmpdir, "extracted")
        os.makedirs(extract_dir)
        with tarfile.open(tar_path, "r:*") as tar:
            tar.extractall(extract_dir)

        await box_handle.copy_in(
            extract_dir, path,
            boxlite.CopyOptions(overwrite=overwrite, include_parent=False),
        )

    return Response(status_code=204)


@app.get("/v1/{prefix}/boxes/{box_id}/files")
async def download_files(
    prefix: str,
    box_id: str,
    path: str = Query(
        ..., description="Source path inside the container"
    ),
    follow_symlinks: bool = Query(False),
    _auth: dict = Depends(require_auth),
):
    box_handle = await get_box_or_404(box_id)

    with tempfile.TemporaryDirectory() as tmpdir:
        dest = os.path.join(tmpdir, "out")
        os.makedirs(dest)
        await box_handle.copy_out(
            path,
            dest,
            boxlite.CopyOptions(follow_symlinks=follow_symlinks),
        )

        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tar:
            for entry in os.listdir(dest):
                tar.add(os.path.join(dest, entry), arcname=entry)
        tar_bytes = buf.getvalue()

    return Response(content=tar_bytes, media_type="application/x-tar")


# ============================================================================
# Metrics
# ============================================================================


@app.get("/v1/{prefix}/metrics")
async def get_runtime_metrics(
    prefix: str,
    _auth: dict = Depends(require_auth),
):
    m = await state.runtime.metrics()
    return {
        "boxes_created_total": m.boxes_created_total,
        "boxes_failed_total": m.boxes_failed_total,
        "boxes_stopped_total": 0,  # Python SDK doesn't expose this counter
        "num_running_boxes": m.num_running_boxes,
        "total_commands_executed": m.total_commands_executed,
        "total_exec_errors": m.total_exec_errors,
    }


@app.get("/v1/{prefix}/boxes/{box_id}/metrics")
async def get_box_metrics(
    prefix: str,
    box_id: str,
    _auth: dict = Depends(require_auth),
):
    box_handle = await get_box_or_404(box_id)
    m = await box_handle.metrics()
    return {
        "commands_executed_total": m.commands_executed_total,
        "exec_errors_total": m.exec_errors_total,
        "bytes_sent_total": m.bytes_sent_total,
        "bytes_received_total": m.bytes_received_total,
        "cpu_percent": m.cpu_percent,
        "memory_bytes": m.memory_bytes,
        "network_bytes_sent": m.network_bytes_sent,
        "network_bytes_received": m.network_bytes_received,
        "network_tcp_connections": m.network_tcp_connections,
        "network_tcp_errors": m.network_tcp_errors,
        "boot_timing": {
            "total_create_ms": m.total_create_duration_ms,
            "guest_boot_ms": m.guest_boot_duration_ms,
            "filesystem_setup_ms": m.stage_filesystem_setup_ms,
            "image_prepare_ms": m.stage_image_prepare_ms,
            "guest_rootfs_ms": m.stage_guest_rootfs_ms,
            "box_config_ms": m.stage_box_config_ms,
            "box_spawn_ms": m.stage_box_spawn_ms,
            "container_init_ms": m.stage_container_init_ms,
        },
    }


# ============================================================================
# Main
# ============================================================================


def main():
    parser = argparse.ArgumentParser(
        description="BoxLite REST API Reference Server"
    )
    parser.add_argument("--host", default="0.0.0.0", help="Bind address")
    parser.add_argument("--port", type=int, default=8080, help="Bind port")
    parser.add_argument("--log-level", default="info", help="Log level")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)


if __name__ == "__main__":
    main()
