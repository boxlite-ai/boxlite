"""
BoxRuntime - Multi-box orchestration with Ray-style decorator API.
"""

import asyncio
import base64
import json
import sys
from typing import Any, Callable, Optional

import cloudpickle

from ..simplebox import SimpleBox

__all__ = ["BoxRuntime", "ManagedBox"]


class ManagedBox:
    """Box with messaging runtime and decorator-based handler registration."""

    def __init__(self, runtime: "BoxRuntime", name: str, **kwargs):
        self._runtime = runtime
        self._name = name
        self._kwargs = kwargs
        self._box: Optional[SimpleBox] = None
        self._execution = None
        self._stdin = None
        self._stdout = None
        self._pump_task: Optional[asyncio.Task] = None
        self._pending: dict[str, asyncio.Future] = {}
        self._task_func: Optional[Callable] = None
        self._message_handlers: list[Callable] = []
        self._event_handlers: dict[str, list[Callable]] = {}

    @property
    def name(self) -> str:
        return self._name

    async def start(self) -> "ManagedBox":
        if self._box:
            return self
        self._box = SimpleBox(
            image=self._runtime._image,
            name=f"managed-{self._name}",
            **self._kwargs,
        )
        await self._box.start()
        await self._inject_sdk()
        return self

    async def _inject_sdk(self) -> None:
        from importlib.resources import files, as_file

        result = await self._box.exec("pip", "install", "-q", "cloudpickle")
        if result.exit_code != 0:
            raise RuntimeError(f"Failed to install cloudpickle: {result.stderr}")
        site_packages = (
            f"/usr/local/lib/python{self._runtime._python_version}/site-packages"
        )
        sdk_file = files("boxlite.orchestration.guest").joinpath("boxlite_runtime.py")
        with as_file(sdk_file) as path:
            await self._box.copy_in(str(path), site_packages, include_parent=False)

    def task(self, func: Callable) -> Callable:
        """Register one-shot task to run before event loop."""
        self._task_func = func
        return func

    def on_message(self, handler: Callable) -> Callable:
        """Register message handler (closures supported via cloudpickle)."""
        self._message_handlers.append(handler)
        return handler

    def on_event(self, event: str) -> Callable:
        """Register event handler for specific event type."""

        def decorator(handler: Callable) -> Callable:
            self._event_handlers.setdefault(event, []).append(handler)
            return handler

        return decorator

    async def run(self, env: Optional[dict[str, str]] = None) -> None:
        """Run with registered task and/or handlers."""
        if (
            not self._task_func
            and not self._message_handlers
            and not self._event_handlers
        ):
            raise RuntimeError("No task or handlers registered")
        if not self._box:
            raise RuntimeError("Box not started")
        if self._execution:
            raise RuntimeError("Already running")

        code = self._generate_code()
        script_env = {"BOXLITE_BOX_NAME": self._name}
        if env:
            script_env.update(env)

        self._execution = await self._box._box.exec(
            "python3", ["-c", code], list(script_env.items())
        )
        self._stdin = self._execution.stdin()
        self._stdout = self._execution.stdout()
        self._pump_task = asyncio.create_task(self._message_pump())

    def _generate_code(self) -> str:
        data = {
            "task": self._task_func,
            "message_handlers": self._message_handlers,
            "event_handlers": self._event_handlers,
        }
        payload = base64.b64encode(cloudpickle.dumps(data)).decode()
        return f'''
import cloudpickle, base64
from boxlite_runtime import on_message, on_event, run_forever
_d = cloudpickle.loads(base64.b64decode("{payload}"))
for _h in _d["message_handlers"]: on_message(_h)
for _e, _hs in _d["event_handlers"].items():
    for _h in _hs: on_event(_e)(_h)
if _d["task"]: _d["task"]()
if _d["message_handlers"] or _d["event_handlers"]: run_forever()
'''

    async def _message_pump(self) -> None:
        try:
            async for line in self._stdout:
                if isinstance(line, bytes):
                    line = line.decode("utf-8", errors="replace")
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue

                msg_type = msg.get("type")
                if msg_type == "send":
                    await self._handle_send(msg)
                elif msg_type == "publish":
                    await self._handle_publish(msg)
                elif msg_type == "response":
                    self._handle_response(msg)
        except asyncio.CancelledError:
            pass

    async def _handle_send(self, msg: dict) -> None:
        request_id, target, data = (
            msg.get("request_id"),
            msg.get("target"),
            msg.get("data"),
        )
        try:
            target_box = self._runtime._boxes.get(target)
            if not target_box:
                raise ValueError(f"Box '{target}' not found")
            if target_box.name == self._name:
                raise ValueError("Cannot send to self")
            result = await target_box._deliver_message(self._name, data)
            response = {"request_id": request_id, "result": result}
        except Exception as e:
            response = {"request_id": request_id, "error": str(e)}
        await self._send(response)

    async def _handle_publish(self, msg: dict) -> None:
        event, data = msg.get("event"), msg.get("data")
        for name, box in self._runtime._boxes.items():
            if name != self._name and box._execution:
                try:
                    await box._send({"type": "event", "event": event, "data": data})
                except Exception:
                    pass

    def _handle_response(self, msg: dict) -> None:
        request_id = msg.get("request_id")
        future = self._pending.pop(request_id, None)
        if future and not future.done():
            if "error" in msg:
                future.set_exception(RuntimeError(msg["error"]))
            else:
                future.set_result(msg.get("result"))

    async def _send(self, msg: dict) -> None:
        if self._stdin:
            await self._stdin.send_input((json.dumps(msg) + "\n").encode())

    async def _deliver_message(self, sender: str, data: Any) -> Any:
        import uuid

        if not self._execution:
            raise RuntimeError(f"Box {self._name} not running")
        request_id = str(uuid.uuid4())
        future = asyncio.get_event_loop().create_future()
        self._pending[request_id] = future
        await self._send(
            {
                "type": "message",
                "sender": sender,
                "data": data,
                "request_id": request_id,
            }
        )
        try:
            return await asyncio.wait_for(future, timeout=30.0)
        except asyncio.TimeoutError:
            self._pending.pop(request_id, None)
            raise RuntimeError(f"Timeout waiting for {self._name}")

    async def wait(self) -> int:
        if not self._execution:
            return 0
        try:
            result = await self._execution.wait()
            return result.exit_code
        finally:
            if self._pump_task:
                self._pump_task.cancel()
                try:
                    await self._pump_task
                except asyncio.CancelledError:
                    pass

    async def stop(self) -> None:
        if self._execution:
            try:
                await self._send({"type": "shutdown"})
            except Exception:
                pass
            if self._pump_task:
                self._pump_task.cancel()
            try:
                await self._execution.kill()
            except Exception:
                pass
        self._execution = None
        if self._box:
            await self._box._box.stop()
        self._box = None


class BoxRuntime:
    """Multi-box orchestration runtime with auto Python version detection."""

    def __init__(self):
        self._boxes: dict[str, ManagedBox] = {}
        self._python_version = f"{sys.version_info.major}.{sys.version_info.minor}"
        self._image = f"python:{self._python_version}-slim"

    async def __aenter__(self) -> "BoxRuntime":
        return self

    async def __aexit__(self, *_):
        await self.shutdown()

    async def create_box(
        self, name: str, *, auto_start: bool = True, **kwargs
    ) -> ManagedBox:
        if name in self._boxes:
            raise ValueError(f"Box '{name}' exists")
        box = ManagedBox(self, name, **kwargs)
        if auto_start:
            await box.start()
        self._boxes[name] = box
        return box

    def list_boxes(self) -> list[str]:
        """Get list of all box names."""
        return list(self._boxes.keys())

    async def wait_all(self, timeout: float = None) -> list[int]:
        if not self._boxes:
            return []
        tasks = [box.wait() for box in self._boxes.values()]
        if timeout:
            results = await asyncio.wait_for(
                asyncio.gather(*tasks, return_exceptions=True), timeout
            )
        else:
            results = await asyncio.gather(*tasks, return_exceptions=True)
        return [-1 if isinstance(r, Exception) else r for r in results]

    async def stop_all(self) -> None:
        await asyncio.gather(
            *[box.stop() for box in self._boxes.values()], return_exceptions=True
        )

    async def shutdown(self) -> None:
        await self.stop_all()
        self._boxes.clear()
