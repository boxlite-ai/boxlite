# Python SDK API Reference

Complete API reference for the BoxLite Python SDK.

**Python:** 3.10+
**Platforms:** macOS (Apple Silicon), Linux (x86_64, ARM64)

## Table of Contents

- [Runtime Management](#runtime-management)
- [Box Handle](#box-handle)
- [Command Execution](#command-execution)
- [Box Types](#box-types)
- [Sync API](#sync-api)
- [Error Types](#error-types)
- [Metrics](#metrics)
- [Constants](#constants)

---

## Runtime Management

### `boxlite.Boxlite`

The main runtime for creating and managing boxes.

```python
from boxlite import Boxlite, Options, BoxOptions
```

#### Class Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `default()` | `() -> Boxlite` | Create runtime with default settings (`~/.boxlite`) |
| `__init__()` | `(options: Options) -> Boxlite` | Create runtime with custom options |

#### Instance Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `create()` | `(options: BoxOptions, name: str = None) -> Box` | Create a new box (async) |
| `get()` | `(box_id: str) -> Box` | Reattach to an existing box by ID (async) |
| `list()` | `() -> List[BoxInfo]` | List all boxes (async) |
| `metrics()` | `() -> RuntimeMetrics` | Get runtime-wide metrics (async) |

#### Example

```python
# Default runtime
runtime = Boxlite.default()

# Custom runtime
runtime = Boxlite(Options(home_dir="/custom/path"))

# Create a box
box = await runtime.create(BoxOptions(image="alpine:latest"))

# List all boxes
for info in await runtime.list():
    print(f"{info.id}: {info.status}")
```

---

### `boxlite.Options`

Runtime configuration options.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `home_dir` | `str` | `~/.boxlite` | Base directory for runtime data |
| `image_registries` | `List[str]` | `[]` | Custom image registries for unqualified references |

---

### `boxlite.BoxOptions`

Configuration options for creating a box.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `image` | `str` | Required | OCI image URI (e.g., `"python:slim"`, `"alpine:latest"`) |
| `cpus` | `int` | `1` | Number of CPU cores (1 to host CPU count) |
| `memory_mib` | `int` | `512` | Memory limit in MiB (128-65536) |
| `disk_size_gb` | `int \| None` | `None` | Persistent disk size in GB (None = ephemeral) |
| `working_dir` | `str` | `"/root"` | Working directory inside container |
| `env` | `List[Tuple[str, str]]` | `[]` | Environment variables as (key, value) pairs |
| `volumes` | `List[Tuple[str, str, str]]` | `[]` | Volume mounts as (host_path, guest_path, mode) |
| `ports` | `List[Tuple[int, int, str]]` | `[]` | Port forwarding as (host_port, guest_port, protocol) |
| `auto_remove` | `bool` | `True` | Auto cleanup when stopped |
| `detach` | `bool` | `False` | Survive parent process exit |

#### Volume Mount Format

```python
volumes=[
    ("/host/config", "/etc/app/config", "ro"),  # Read-only
    ("/host/data", "/mnt/data", "rw"),          # Read-write
]
```

#### Port Forwarding Format

```python
ports=[
    (8080, 80, "tcp"),    # HTTP
    (5432, 5432, "tcp"),  # PostgreSQL
    (53, 53, "udp"),      # DNS
]
```

---

## Box Handle

### `boxlite.Box`

Handle to a running or stopped box.

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | `str` | Unique box identifier (ULID format) |

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `exec()` | `(cmd, args, env, tty) -> Execution` | Execute command (async) |
| `stop()` | `() -> None` | Stop the box gracefully (async) |
| `remove()` | `() -> None` | Delete box and its data (async) |
| `info()` | `() -> BoxInfo` | Get box metadata (async) |
| `metrics()` | `() -> BoxMetrics` | Get resource usage metrics (async) |

---

### `boxlite.BoxInfo`

Metadata about a box.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `str` | Unique box identifier (ULID) |
| `name` | `str \| None` | Optional user-assigned name |
| `status` | `str` | Current status: `"running"`, `"stopped"`, `"created"` |
| `created_at` | `datetime` | Creation timestamp |
| `pid` | `int \| None` | Process ID (if running) |
| `image` | `str` | OCI image used |
| `cpus` | `int` | Allocated CPU cores |
| `memory_mib` | `int` | Allocated memory in MiB |

---

### `boxlite.BoxStateInfo`

Detailed state information for a box.

| Value | Description |
|-------|-------------|
| `Created` | Box created but not yet started |
| `Starting` | Box is initializing |
| `Running` | Box is running and ready |
| `Stopping` | Box is shutting down |
| `Stopped` | Box is stopped |
| `Failed` | Box encountered an error |

---

## Command Execution

### `boxlite.Execution`

Represents a running command execution.

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `stdout()` | `() -> ExecStdout` | Get stdout stream (async iterator) |
| `stderr()` | `() -> ExecStderr` | Get stderr stream (async iterator) |
| `stdin()` | `() -> ExecStdin` | Get stdin writer |
| `wait()` | `() -> ExecResult` | Wait for completion (async) |
| `kill()` | `(signal: int = 9) -> None` | Send signal to process (async) |
| `resize_tty()` | `(rows: int, cols: int) -> None` | Resize PTY terminal for executions started with `tty=True` (async) |

#### Example

```python
# Execute with streaming output
execution = await box.exec("python", ["-c", "for i in range(5): print(i)"])

# Stream stdout
async for line in execution.stdout():
    print(f"Output: {line}")

# Wait for completion
result = await execution.wait()
print(f"Exit code: {result.exit_code}")
```

---

### `boxlite.ExecStdout` / `boxlite.ExecStderr`

Async iterators for streaming output.

```python
# Stream stdout line by line
stdout = execution.stdout()
async for line in stdout:
    print(line)

# Stream stderr
stderr = execution.stderr()
async for line in stderr:
    print(f"Error: {line}", file=sys.stderr)
```

**Note:** Each stream can only be iterated once. After iteration, the stream is consumed.

---

### `boxlite.ExecStdin`

Writer for sending input to a running process.

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `send_input()` | `(data: bytes) -> None` | Write bytes to stdin (async) |

#### Example

```python
# Interactive input
execution = await box.exec("cat")
stdin = execution.stdin()

# Send data
await stdin.send_input(b"Hello\n")
await stdin.send_input(b"World\n")

# Wait for completion
result = await execution.wait()
```

---

### `boxlite.ExecResult`

Result of a completed execution.

| Field | Type | Description |
|-------|------|-------------|
| `exit_code` | `int` | Process exit code (0 = success) |

**Note:** For higher-level APIs (`SimpleBox.exec()`), the result also includes `stdout` and `stderr` strings.

---

## Box Types

### `boxlite.SimpleBox`

Context manager for basic command execution with automatic cleanup.

```python
from boxlite import SimpleBox
```

#### Constructor

```python
SimpleBox(
    image: str,
    memory_mib: int = None,
    cpus: int = None,
    runtime: Boxlite = None,
    name: str = None,
    auto_remove: bool = True,
    **kwargs
)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image` | `str` | Required | Container image to use |
| `memory_mib` | `int` | System default | Memory limit in MiB |
| `cpus` | `int` | System default | Number of CPU cores |
| `runtime` | `Boxlite` | Global default | Runtime instance |
| `name` | `str` | None | Optional unique name |
| `auto_remove` | `bool` | `True` | Remove box when stopped |
| `**kwargs` | | | Additional options: `env`, `volumes`, `ports`, `working_dir` |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | `str` | Box ID (raises if not started) |

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `start()` | `() -> Self` | Explicitly start the box (async) |
| `exec()` | `(cmd, *args, env=None) -> ExecResult` | Execute command and wait (async) |
| `info()` | `() -> BoxInfo` | Get box metadata |
| `shutdown()` | `() -> None` | Shutdown and release resources |

#### Example

```python
async with SimpleBox(image="python:slim") as box:
    result = await box.exec("python", "-c", "print('Hello!')")
    print(result.stdout)   # "Hello!\n"
    print(result.exit_code)  # 0
```

---

### `boxlite.CodeBox`

Specialized box for Python code execution with package management.

```python
from boxlite import CodeBox
```

#### Constructor

```python
CodeBox(
    image: str = "python:slim",
    memory_mib: int = None,
    cpus: int = None,
    runtime: Boxlite = None,
    **kwargs
)
```

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `run()` | `(code: str, timeout: int = None) -> str` | Execute Python code (async) |
| `run_script()` | `(script_path: str) -> str` | Execute Python script file (async) |
| `install_package()` | `(package: str) -> str` | Install package with pip (async) |
| `install_packages()` | `(*packages: str) -> str` | Install multiple packages (async) |

#### Example

```python
async with CodeBox() as cb:
    # Install packages
    await cb.install_package("requests")

    # Run code
    result = await cb.run("""
import requests
print(requests.get('https://api.github.com/zen').text)
""")
    print(result)
```

---

### `boxlite.BrowserBox`

Box configured for browser automation with Chrome DevTools Protocol.

```python
from boxlite import BrowserBox, BrowserBoxOptions
```

#### `BrowserBoxOptions`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `browser` | `str` | `"chromium"` | Browser type: `"chromium"`, `"firefox"`, `"webkit"` |
| `memory` | `int` | `2048` | Memory in MiB |
| `cpu` | `int` | `2` | Number of CPU cores |

#### Browser CDP Ports

| Browser | Port |
|---------|------|
| chromium | 9222 |
| firefox | 9223 |
| webkit | 9224 |

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `endpoint()` | `() -> str` | Get CDP endpoint URL |

#### Example

```python
from boxlite import BrowserBox, BrowserBoxOptions

opts = BrowserBoxOptions(browser="chromium", memory=4096)
async with BrowserBox(opts) as browser:
    endpoint = browser.endpoint()  # "http://localhost:9222"

    # Connect with Puppeteer or Playwright
    # puppeteer.connect({ browserURL: endpoint })
```

---

### `boxlite.ComputerBox`

Box with full desktop environment and GUI automation capabilities.

```python
from boxlite import ComputerBox
```

#### Constructor

```python
ComputerBox(
    cpu: int = 2,
    memory: int = 2048,
    gui_http_port: int = 3000,
    gui_https_port: int = 3001,
    runtime: Boxlite = None,
    **kwargs
)
```

#### Mouse Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `mouse_move()` | `(x: int, y: int) -> None` | Move cursor to coordinates (async) |
| `left_click()` | `() -> None` | Left click at current position (async) |
| `right_click()` | `() -> None` | Right click at current position (async) |
| `middle_click()` | `() -> None` | Middle click at current position (async) |
| `double_click()` | `() -> None` | Double left click (async) |
| `triple_click()` | `() -> None` | Triple left click (async) |
| `left_click_drag()` | `(start_x, start_y, end_x, end_y) -> None` | Drag from start to end (async) |
| `cursor_position()` | `() -> Tuple[int, int]` | Get current cursor (x, y) (async) |

#### Keyboard Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `type()` | `(text: str) -> None` | Type text characters (async) |
| `key()` | `(text: str) -> None` | Press key or key combination (async) |

##### Key Syntax Reference

The `key()` method uses **xdotool key syntax**:

| Key | Syntax |
|-----|--------|
| Enter | `Return` |
| Tab | `Tab` |
| Escape | `Escape` |
| Backspace | `BackSpace` |
| Delete | `Delete` |
| Arrow keys | `Up`, `Down`, `Left`, `Right` |
| Function keys | `F1`, `F2`, ... `F12` |
| Modifiers | `ctrl`, `alt`, `shift`, `super` |
| Combinations | `ctrl+c`, `ctrl+shift+s`, `alt+Tab` |

**Examples:**
```python
await computer.key("Return")        # Press Enter
await computer.key("ctrl+c")        # Copy
await computer.key("ctrl+shift+s")  # Save As
await computer.key("alt+Tab")       # Switch window
await computer.key("ctrl+a Delete") # Select all and delete
```

#### Display Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `wait_until_ready()` | `(timeout: int = 60) -> None` | Wait for desktop ready (async) |
| `screenshot()` | `() -> dict` | Capture screen (async) |
| `scroll()` | `(x, y, direction, amount=3) -> None` | Scroll at position (async) |
| `get_screen_size()` | `() -> Tuple[int, int]` | Get screen dimensions (async) |

##### Screenshot Return Format

```python
{
    "data": str,    # Base64-encoded PNG
    "width": int,   # 1024 (default)
    "height": int,  # 768 (default)
    "format": str   # "png"
}
```

##### Scroll Directions

| Direction | Description |
|-----------|-------------|
| `"up"` | Scroll up |
| `"down"` | Scroll down |
| `"left"` | Scroll left |
| `"right"` | Scroll right |

#### Example

```python
async with ComputerBox() as desktop:
    await desktop.wait_until_ready()

    # Take screenshot
    screenshot = await desktop.screenshot()

    # Mouse interaction
    await desktop.mouse_move(100, 200)
    await desktop.left_click()

    # Type text
    await desktop.type("Hello, World!")
    await desktop.key("Return")

    # Get screen size
    width, height = await desktop.get_screen_size()
```

---

### `boxlite.InteractiveBox`

Box for interactive terminal sessions with PTY support.

```python
from boxlite import InteractiveBox
```

#### Constructor

```python
InteractiveBox(
    image: str,
    shell: str = "/bin/sh",
    tty: bool = None,
    memory_mib: int = None,
    cpus: int = None,
    runtime: Boxlite = None,
    name: str = None,
    auto_remove: bool = True,
    **kwargs
)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image` | `str` | Required | Container image |
| `shell` | `str` | `"/bin/sh"` | Shell to run |
| `tty` | `bool \| None` | `None` | TTY mode (see below) |

##### TTY Mode

| Value | Behavior |
|-------|----------|
| `None` | Auto-detect from `sys.stdin.isatty()` |
| `True` | Force TTY mode with I/O forwarding |
| `False` | No I/O forwarding (programmatic control) |

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `wait()` | `() -> None` | Wait for shell to exit (async) |

#### Example

```python
# Interactive shell session
async with InteractiveBox(image="alpine:latest") as box:
    # You're now in an interactive shell
    # Type commands, see output in real-time
    # Type "exit" to close
    await box.wait()
```

---

## Sync API

Synchronous wrappers using greenlet fiber switching. Requires `pip install boxlite[sync]`.

```python
from boxlite import SyncBoxlite, SyncBox, SyncSimpleBox, SyncCodeBox
```

### When to Use

| Use Case | API |
|----------|-----|
| New async applications | Async API (default) |
| Existing sync codebase | Sync API |
| Jupyter notebooks | Sync API |
| REPL/interactive use | Sync API |
| Inside async functions | Async API only |

### Comparison Table

| Async API | Sync API | Notes |
|-----------|----------|-------|
| `Boxlite` | `SyncBoxlite` | |
| `Box` | `SyncBox` | |
| `Execution` | `SyncExecution` | |
| `ExecStdout` | `SyncExecStdout` | Regular iterator |
| `ExecStderr` | `SyncExecStderr` | Regular iterator |
| `SimpleBox` | `SyncSimpleBox` | |
| `CodeBox` | `SyncCodeBox` | |

### Classes

#### `SyncBoxlite`

```python
from boxlite import SyncBoxlite, BoxOptions

with SyncBoxlite.default() as runtime:
    box = runtime.create(BoxOptions(image="alpine:latest"))
    execution = box.exec("echo", ["Hello"])
    for line in execution.stdout():
        print(line)
    box.stop()
```

#### `SyncSimpleBox`

```python
from boxlite import SyncSimpleBox

with SyncSimpleBox(image="python:slim") as box:
    result = box.exec("python", "-c", "print('Hello!')")
    print(result.stdout)
```

#### `SyncCodeBox`

```python
from boxlite import SyncCodeBox

with SyncCodeBox() as cb:
    result = cb.run("print('Hello, World!')")
    print(result)
```

### Architecture

The sync API uses greenlet fiber switching:
1. A dispatcher fiber runs the asyncio event loop
2. User code runs in the main fiber
3. Sync methods switch to dispatcher, await async operations, then switch back

**Limitation:** Cannot be used inside an async context (when an event loop is already running).

---

## Error Types

```python
from boxlite import BoxliteError, ExecError, TimeoutError, ParseError
```

### Exception Hierarchy

```
BoxliteError (base)
├── ExecError       # Command execution failed
├── TimeoutError    # Operation timed out
└── ParseError      # Output parsing failed
```

### `BoxliteError`

Base exception for all BoxLite errors.

```python
try:
    async with SimpleBox(image="invalid:image") as box:
        pass
except BoxliteError as e:
    print(f"BoxLite error: {e}")
```

### `ExecError`

Raised when a command execution fails (non-zero exit code).

| Attribute | Type | Description |
|-----------|------|-------------|
| `command` | `str` | The command that failed |
| `exit_code` | `int` | Non-zero exit code |
| `stderr` | `str` | Standard error output |

```python
try:
    result = await box.exec("false")  # Exit code 1
except ExecError as e:
    print(f"Command: {e.command}")
    print(f"Exit code: {e.exit_code}")
    print(f"Stderr: {e.stderr}")
```

### `TimeoutError`

Raised when an operation times out.

```python
try:
    await computer.wait_until_ready(timeout=5)
except TimeoutError:
    print("Desktop did not become ready in time")
```

### `ParseError`

Raised when output parsing fails.

```python
try:
    x, y = await computer.cursor_position()
except ParseError:
    print("Failed to parse cursor position")
```

---

## Metrics

### `boxlite.RuntimeMetrics`

Aggregate metrics across all boxes.

| Field | Type | Description |
|-------|------|-------------|
| `boxes_created` | `int` | Total boxes created |
| `boxes_destroyed` | `int` | Total boxes destroyed |
| `total_exec_calls` | `int` | Total command executions |
| `active_boxes` | `int` | Currently running boxes |

```python
runtime = Boxlite.default()
metrics = await runtime.metrics()

print(f"Boxes created: {metrics.boxes_created}")
print(f"Active boxes: {metrics.active_boxes}")
```

---

### `boxlite.BoxMetrics`

Per-box resource usage metrics.

| Field | Type | Description |
|-------|------|-------------|
| `cpu_time_ms` | `int` | Total CPU time in milliseconds |
| `memory_usage_bytes` | `int` | Current memory usage in bytes |
| `network_bytes_sent` | `int` | Total bytes sent |
| `network_bytes_received` | `int` | Total bytes received |

```python
metrics = await box.metrics()

print(f"CPU time: {metrics.cpu_time_ms}ms")
print(f"Memory: {metrics.memory_usage_bytes / (1024**2):.2f} MB")
```

---

## Constants

Default values used by BoxLite.

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_CPUS` | `1` | Default CPU cores |
| `DEFAULT_MEMORY_MIB` | `2048` | Default memory in MiB |
| `COMPUTERBOX_CPUS` | `2` | ComputerBox default CPUs |
| `COMPUTERBOX_MEMORY_MIB` | `2048` | ComputerBox default memory |
| `COMPUTERBOX_DISPLAY_WIDTH` | `1024` | Screen width in pixels |
| `COMPUTERBOX_DISPLAY_HEIGHT` | `768` | Screen height in pixels |
| `COMPUTERBOX_GUI_HTTP_PORT` | `3000` | HTTP GUI port |
| `COMPUTERBOX_GUI_HTTPS_PORT` | `3001` | HTTPS GUI port |
| `DESKTOP_READY_TIMEOUT` | `60` | Desktop ready timeout (seconds) |

---

## See Also

- [Python SDK README](../../../sdks/python/README.md) - Quick start and examples
- [Getting Started Guide](../../getting-started/quickstart-python.md) - Installation
- [Configuration Reference](../README.md#configuration-reference) - BoxOptions details
- [Error Codes](../README.md#error-codes--handling) - Error handling
