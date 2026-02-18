# Node.js SDK API Reference

Complete API reference for the BoxLite Node.js/TypeScript SDK.

**Node.js:** 18+
**Platforms:** macOS (Apple Silicon), Linux (x86_64, ARM64)

## Table of Contents

- [Runtime Management](#runtime-management)
- [Box Handle](#box-handle)
- [Command Execution](#command-execution)
- [Box Types](#box-types)
- [Error Types](#error-types)
- [Metrics](#metrics)
- [Type Definitions](#type-definitions)
- [Constants](#constants)

---

## Runtime Management

### `JsBoxlite` / `Boxlite`

The main runtime for creating and managing boxes.

```typescript
import { JsBoxlite } from 'boxlite';
// or use the wrapper classes
import { SimpleBox } from 'boxlite';
```

#### Constructor

```typescript
new JsBoxlite(options: JsOptions)
```

#### Static Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `withDefaultConfig()` | `() => JsBoxlite` | Get runtime with default config (`~/.boxlite`) |
| `initDefault()` | `(options: JsOptions) => void` | Initialize default runtime with custom options |

#### Instance Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `create()` | `(options: JsBoxOptions, name?: string) => Promise<JsBox>` | Create a new box |
| `listInfo()` | `() => Promise<JsBoxInfo[]>` | List all boxes |
| `getInfo()` | `(idOrName: string) => Promise<JsBoxInfo \| null>` | Get box info |
| `get()` | `(idOrName: string) => Promise<JsBox \| null>` | Get box handle |
| `metrics()` | `() => Promise<JsRuntimeMetrics>` | Get runtime metrics |
| `remove()` | `(idOrName: string, force?: boolean) => Promise<void>` | Remove a box |
| `close()` | `() => void` | Close runtime (no-op) |

#### Example

```typescript
// Default runtime
const runtime = JsBoxlite.withDefaultConfig();

// Custom runtime
const runtime = new JsBoxlite({ homeDir: '/custom/path' });

// Create a box
const box = await runtime.create({
  image: 'alpine:latest',
  cpus: 2,
  memoryMib: 512
}, 'my-box');

// List all boxes
const boxes = await runtime.listInfo();
boxes.forEach(info => console.log(`${info.id}: ${info.status}`));
```

---

### `JsOptions`

Runtime configuration options.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `homeDir` | `string` | `~/.boxlite` | Base directory for runtime data |
| `imageRegistries` | `string[]` | `[]` | Custom image registries for unqualified references |

---

### `JsBoxOptions`

Configuration options for creating a box.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `image` | `string` | - | OCI image URI |
| `rootfsPath` | `string` | - | Pre-prepared rootfs directory (alternative to image) |
| `cpus` | `number` | `1` | Number of CPU cores |
| `memoryMib` | `number` | `512` | Memory limit in MiB |
| `diskSizeGb` | `number` | - | Persistent disk size in GB |
| `workingDir` | `string` | `"/root"` | Working directory inside container |
| `env` | `JsEnvVar[]` | `[]` | Environment variables |
| `volumes` | `JsVolumeSpec[]` | `[]` | Volume mounts |
| `network` | `string` | `"isolated"` | Network mode |
| `ports` | `JsPortSpec[]` | `[]` | Port mappings |
| `autoRemove` | `boolean` | `false` | Auto cleanup when stopped |
| `detach` | `boolean` | `false` | Survive parent process exit |

#### `JsEnvVar`

```typescript
interface JsEnvVar {
  key: string;
  value: string;
}
```

#### `JsVolumeSpec`

```typescript
interface JsVolumeSpec {
  hostPath: string;    // Path on host
  guestPath: string;   // Path in container
  readOnly?: boolean;  // Default: false
}
```

#### `JsPortSpec`

```typescript
interface JsPortSpec {
  hostPort?: number;   // None = auto-assign
  guestPort: number;   // Port inside container
  protocol?: string;   // "tcp" or "udp" (default: "tcp")
  hostIp?: string;     // Default: "0.0.0.0"
}
```

---

## Box Handle

### `JsBox`

Handle to a running or stopped box.

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Unique box identifier (ULID) |
| `name` | `string \| null` | User-defined name |

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `info()` | `() => JsBoxInfo` | Get box metadata (sync) |
| `exec()` | `(cmd, args?, env?, tty?) => Promise<JsExecution>` | Execute command |
| `stop()` | `() => Promise<void>` | Stop the box |
| `metrics()` | `() => Promise<JsBoxMetrics>` | Get resource metrics |

---

### `JsBoxInfo`

Metadata about a box.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique box identifier (ULID) |
| `name` | `string \| undefined` | User-defined name |
| `status` | `string` | Current status: `"Starting"`, `"Running"`, `"Stopped"`, etc. |
| `createdAt` | `string` | Creation timestamp (ISO 8601) |
| `lastUpdated` | `string` | Last state change (ISO 8601) |
| `pid` | `number \| undefined` | Process ID (if running) |

---

## Command Execution

### `JsExecution`

Handle for a running command.

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `id()` | `() => Promise<string>` | Get execution ID |
| `stdin()` | `() => Promise<JsExecStdin>` | Get stdin writer |
| `stdout()` | `() => Promise<JsExecStdout>` | Get stdout reader |
| `stderr()` | `() => Promise<JsExecStderr>` | Get stderr reader |
| `wait()` | `() => Promise<JsExecResult>` | Wait for completion |
| `kill()` | `() => Promise<void>` | Send SIGKILL |

#### Example

```typescript
const execution = await box.exec('ls', ['-la', '/']);

// Read stdout
const stdout = await execution.stdout();
while (true) {
  const line = await stdout.next();
  if (line === null) break;
  console.log(line);
}

// Wait for completion
const result = await execution.wait();
console.log(`Exit code: ${result.exitCode}`);
```

---

### `JsExecStdin`

Writer for sending input to a running process.

| Method | Signature | Description |
|--------|-----------|-------------|
| `write()` | `(data: Buffer) => Promise<void>` | Write bytes |
| `writeString()` | `(text: string) => Promise<void>` | Write UTF-8 string |

```typescript
const stdin = await execution.stdin();
await stdin.writeString('Hello, World!\n');
await stdin.write(Buffer.from([10])); // newline
```

---

### `JsExecStdout` / `JsExecStderr`

Readers for streaming output.

| Method | Signature | Description |
|--------|-----------|-------------|
| `next()` | `() => Promise<string \| null>` | Read next line (null = EOF) |

**Stream Consumption:** Each stream can only be consumed once. After iterating to EOF, subsequent calls return `null`.

```typescript
const stdout = await execution.stdout();
while (true) {
  const line = await stdout.next();
  if (line === null) break;
  console.log(line);
}
```

---

### `JsExecResult`

Result of a completed execution.

| Field | Type | Description |
|-------|------|-------------|
| `exitCode` | `number` | Process exit code (0 = success) |

---

## Box Types

### `SimpleBox`

Context manager for basic command execution with automatic cleanup.

```typescript
import { SimpleBox } from 'boxlite';
```

#### Constructor Options

```typescript
interface SimpleBoxOptions {
  image?: string;         // Default: "python:slim"
  memoryMib?: number;     // Memory in MiB
  cpus?: number;          // CPU cores
  runtime?: JsBoxlite;    // Runtime instance
  name?: string;          // Box name
  autoRemove?: boolean;   // Default: true
  detach?: boolean;       // Default: false
  workingDir?: string;    // Working directory
  env?: Record<string, string>;  // Environment variables
  volumes?: VolumeSpec[]; // Volume mounts
  ports?: PortSpec[];     // Port mappings
}
```

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Box ID (throws if not started) |
| `name` | `string \| undefined` | Box name |

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `getId()` | `() => Promise<string>` | Get box ID (async) |
| `getInfo()` | `() => Promise<JsBoxInfo>` | Get box info (async) |
| `exec()` | `(cmd, ...args) => Promise<ExecResult>` | Execute and wait |
| `stop()` | `() => Promise<void>` | Stop the box |
| `[Symbol.asyncDispose]()` | `() => Promise<void>` | Async disposal |

#### Example

```typescript
// With async disposal (TypeScript 5.2+)
await using box = new SimpleBox({ image: 'alpine:latest' });
const result = await box.exec('echo', 'Hello!');
console.log(result.stdout);

// Manual cleanup
const box = new SimpleBox({ image: 'alpine:latest' });
try {
  const result = await box.exec('ls', '-la');
  console.log(result.stdout);
} finally {
  await box.stop();
}
```

---

### `CodeBox`

Python code execution sandbox.

```typescript
import { CodeBox } from 'boxlite';
```

#### Constructor Options

```typescript
interface CodeBoxOptions extends SimpleBoxOptions {
  image?: string;  // Default: "python:slim"
}
```

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `run()` | `(code: string) => Promise<string>` | Execute Python code |
| `runScript()` | `(scriptPath: string) => Promise<string>` | Run script file |
| `installPackage()` | `(pkg: string) => Promise<string>` | pip install |
| `installPackages()` | `(...pkgs: string[]) => Promise<string>` | Install multiple |

#### Example

```typescript
const codebox = new CodeBox({ memoryMib: 1024 });
try {
  await codebox.installPackage('requests');
  const result = await codebox.run(`
import requests
print(requests.get('https://api.github.com/zen').text)
  `);
  console.log(result);
} finally {
  await codebox.stop();
}
```

---

### `BrowserBox`

Browser automation with Chrome DevTools Protocol.

```typescript
import { BrowserBox, BrowserType } from 'boxlite';
```

#### Constructor Options

```typescript
interface BrowserBoxOptions {
  browser?: BrowserType;  // "chromium" | "firefox" | "webkit"
  memoryMib?: number;     // Default: 2048
  cpus?: number;          // Default: 2
}
```

#### Browser CDP Ports

| Browser | Port | Image |
|---------|------|-------|
| `chromium` | 9222 | `mcr.microsoft.com/playwright:v1.47.2-jammy` |
| `firefox` | 9223 | `browserless/firefox:latest` |
| `webkit` | 9224 | `browserless/webkit:latest` |

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `start()` | `(timeout?: number) => Promise<void>` | Start browser |
| `endpoint()` | `() => string` | Get CDP endpoint URL |

#### Example

```typescript
import puppeteer from 'puppeteer-core';

const browser = new BrowserBox({ browser: 'chromium' });
try {
  await browser.start();
  const endpoint = browser.endpoint();  // "http://localhost:9222"

  const instance = await puppeteer.connect({ browserURL: endpoint });
  const page = await instance.newPage();
  await page.goto('https://example.com');
  console.log(await page.title());
} finally {
  await browser.stop();
}
```

---

### `ComputerBox`

Desktop automation with full GUI environment.

```typescript
import { ComputerBox } from 'boxlite';
```

#### Constructor Options

```typescript
interface ComputerBoxOptions {
  cpus?: number;          // Default: 2
  memoryMib?: number;     // Default: 2048
  guiHttpPort?: number;   // Default: 3000
  guiHttpsPort?: number;  // Default: 3001
}
```

#### Mouse Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `mouseMove()` | `(x: number, y: number) => Promise<void>` | Move cursor |
| `leftClick()` | `() => Promise<void>` | Left click |
| `rightClick()` | `() => Promise<void>` | Right click |
| `middleClick()` | `() => Promise<void>` | Middle click |
| `doubleClick()` | `() => Promise<void>` | Double click |
| `tripleClick()` | `() => Promise<void>` | Triple click |
| `leftClickDrag()` | `(startX, startY, endX, endY) => Promise<void>` | Drag |
| `cursorPosition()` | `() => Promise<[number, number]>` | Get cursor pos |

#### Keyboard Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `type()` | `(text: string) => Promise<void>` | Type text |
| `key()` | `(keySequence: string) => Promise<void>` | Press key(s) |

##### Key Syntax Reference (xdotool format)

| Key | Syntax |
|-----|--------|
| Enter | `Return` |
| Tab | `Tab` |
| Escape | `Escape` |
| Backspace | `BackSpace` |
| Delete | `Delete` |
| Space | `space` |
| Arrow keys | `Up`, `Down`, `Left`, `Right` |
| Function keys | `F1`, `F2`, ... `F12` |
| Page keys | `Page_Up`, `Page_Down`, `Home`, `End` |
| Modifiers | `ctrl`, `alt`, `shift`, `super` |
| Combinations | `ctrl+c`, `ctrl+shift+s`, `alt+Tab` |

**Examples:**
```typescript
await desktop.key('Return');        // Press Enter
await desktop.key('ctrl+c');        // Copy
await desktop.key('ctrl+shift+s');  // Save As
await desktop.key('alt+Tab');       // Switch window
await desktop.key('ctrl+a Delete'); // Select all and delete
```

#### Display Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `waitUntilReady()` | `(timeout?: number) => Promise<void>` | Wait for desktop |
| `screenshot()` | `() => Promise<Screenshot>` | Capture screen |
| `scroll()` | `(x, y, direction, amount?) => Promise<void>` | Scroll |
| `getScreenSize()` | `() => Promise<[number, number]>` | Get dimensions |

##### Screenshot Return Type

```typescript
interface Screenshot {
  data: string;    // Base64-encoded PNG
  width: number;   // 1024 (default)
  height: number;  // 768 (default)
  format: 'png';
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

```typescript
const desktop = new ComputerBox({ cpus: 4, memoryMib: 4096 });
try {
  await desktop.waitUntilReady(60);

  // Take screenshot
  const screenshot = await desktop.screenshot();
  console.log(`${screenshot.width}x${screenshot.height}`);

  // GUI interaction
  await desktop.mouseMove(100, 200);
  await desktop.leftClick();
  await desktop.type('Hello, World!');
  await desktop.key('Return');

  // Access via browser: http://localhost:3000
} finally {
  await desktop.stop();
}
```

---

### `InteractiveBox`

Interactive terminal sessions with PTY support.

```typescript
import { InteractiveBox } from 'boxlite';
```

#### Constructor Options

```typescript
interface InteractiveBoxOptions extends SimpleBoxOptions {
  shell?: string;        // Default: "/bin/sh"
  tty?: boolean;         // undefined = auto-detect
}
```

##### TTY Mode

| Value | Behavior |
|-------|----------|
| `undefined` | Auto-detect from stdin |
| `true` | Force TTY with I/O forwarding |
| `false` | No I/O forwarding |

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `start()` | `() => Promise<void>` | Start PTY session |
| `wait()` | `() => Promise<void>` | Wait for shell exit |

#### Example

```typescript
const box = new InteractiveBox({
  image: 'alpine:latest',
  shell: '/bin/sh',
  tty: true
});
try {
  await box.start();
  await box.wait();  // Blocks until shell exits
} finally {
  await box.stop();
}
```

---

## Error Types

```typescript
import { BoxliteError, ExecError, TimeoutError, ParseError } from 'boxlite';
```

### Exception Hierarchy

```
BoxliteError (base)
├── ExecError       # Command failed
├── TimeoutError    # Operation timeout
└── ParseError      # Output parsing failed
```

### `BoxliteError`

Base error class for all BoxLite errors.

```typescript
try {
  await box.exec('invalid-command');
} catch (err) {
  if (err instanceof BoxliteError) {
    console.error('BoxLite error:', err.message);
  }
}
```

### `ExecError`

Command execution failed (non-zero exit code).

| Property | Type | Description |
|----------|------|-------------|
| `command` | `string` | Failed command |
| `exitCode` | `number` | Non-zero exit code |
| `stderr` | `string` | Standard error output |

```typescript
try {
  await box.exec('false');
} catch (err) {
  if (err instanceof ExecError) {
    console.error(`Command: ${err.command}`);
    console.error(`Exit code: ${err.exitCode}`);
    console.error(`Stderr: ${err.stderr}`);
  }
}
```

### `TimeoutError`

Operation exceeded time limit.

```typescript
try {
  await desktop.waitUntilReady(5);
} catch (err) {
  if (err instanceof TimeoutError) {
    console.error('Desktop did not become ready');
  }
}
```

### `ParseError`

Failed to parse command output.

```typescript
try {
  const pos = await desktop.cursorPosition();
} catch (err) {
  if (err instanceof ParseError) {
    console.error('Failed to parse cursor position');
  }
}
```

---

## Metrics

### `JsRuntimeMetrics`

Runtime-wide metrics.

| Field | Type | Description |
|-------|------|-------------|
| `boxesCreatedTotal` | `number` | Total boxes created |
| `boxesFailedTotal` | `number` | Boxes that failed during creation |
| `numRunningBoxes` | `number` | Currently running boxes |
| `totalCommandsExecuted` | `number` | Total commands executed |
| `totalExecErrors` | `number` | Total execution errors |

```typescript
const metrics = await runtime.metrics();
console.log(`Boxes created: ${metrics.boxesCreatedTotal}`);
console.log(`Running: ${metrics.numRunningBoxes}`);
```

---

### `JsBoxMetrics`

Per-box resource metrics.

#### Counter Fields

| Field | Type | Description |
|-------|------|-------------|
| `commandsExecutedTotal` | `number` | Commands executed on this box |
| `execErrorsTotal` | `number` | Execution errors on this box |
| `bytesSentTotal` | `number` | Bytes sent via stdin |
| `bytesReceivedTotal` | `number` | Bytes received via stdout/stderr |

#### Resource Fields

| Field | Type | Description |
|-------|------|-------------|
| `cpuPercent` | `number \| undefined` | CPU usage (0.0-100.0) |
| `memoryBytes` | `number \| undefined` | Memory usage in bytes |
| `networkBytesSent` | `number \| undefined` | Network bytes sent |
| `networkBytesReceived` | `number \| undefined` | Network bytes received |
| `networkTcpConnections` | `number \| undefined` | Current TCP connections |
| `networkTcpErrors` | `number \| undefined` | Total TCP errors |

#### Timing Fields (milliseconds)

| Field | Type | Description |
|-------|------|-------------|
| `totalCreateDurationMs` | `number \| undefined` | Total create time |
| `guestBootDurationMs` | `number \| undefined` | Guest agent ready time |
| `stageFilesystemSetupMs` | `number \| undefined` | Directory setup time |
| `stageImagePrepareMs` | `number \| undefined` | Image pull/prepare time |
| `stageGuestRootfsMs` | `number \| undefined` | Rootfs bootstrap time |
| `stageBoxConfigMs` | `number \| undefined` | Configuration build time |
| `stageBoxSpawnMs` | `number \| undefined` | Subprocess spawn time |
| `stageContainerInitMs` | `number \| undefined` | Container init time |

```typescript
const metrics = await box.metrics();
console.log(`CPU: ${metrics.cpuPercent}%`);
console.log(`Memory: ${(metrics.memoryBytes || 0) / (1024 * 1024)} MB`);
console.log(`Boot time: ${metrics.guestBootDurationMs}ms`);
```

---

## Type Definitions

### `ExecResult` (wrapper)

Result from `SimpleBox.exec()`.

```typescript
interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
```

### `Screenshot`

Screenshot capture result.

```typescript
interface Screenshot {
  data: string;     // Base64-encoded PNG
  width: number;
  height: number;
  format: 'png';
}
```

### `BrowserType`

Supported browser types.

```typescript
type BrowserType = 'chromium' | 'firefox' | 'webkit';
```

---

## Constants

Default values used by BoxLite.

### Resource Defaults

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_CPUS` | `1` | Default CPU cores |
| `DEFAULT_MEMORY_MIB` | `512` | Default memory in MiB |

### ComputerBox Defaults

| Constant | Value | Description |
|----------|-------|-------------|
| `COMPUTERBOX_CPUS` | `2` | Default CPUs |
| `COMPUTERBOX_MEMORY_MIB` | `2048` | Default memory |
| `COMPUTERBOX_DISPLAY_WIDTH` | `1024` | Screen width |
| `COMPUTERBOX_DISPLAY_HEIGHT` | `768` | Screen height |
| `COMPUTERBOX_GUI_HTTP_PORT` | `3000` | HTTP GUI port |
| `COMPUTERBOX_GUI_HTTPS_PORT` | `3001` | HTTPS GUI port |
| `DESKTOP_READY_TIMEOUT` | `60` | Ready timeout (seconds) |

### BrowserBox Ports

| Constant | Value | Description |
|----------|-------|-------------|
| `BROWSERBOX_PORT_CHROMIUM` | `9222` | Chromium CDP port |
| `BROWSERBOX_PORT_FIREFOX` | `9223` | Firefox CDP port |
| `BROWSERBOX_PORT_WEBKIT` | `9224` | WebKit CDP port |

---

## See Also

- [Node.js SDK README](../../../sdks/node/README.md) - Quick start and examples
- [Getting Started Guide](../../getting-started/quickstart-nodejs.md) - Installation
- [Configuration Reference](../README.md#configuration-reference) - BoxOptions details
- [Error Codes](../README.md#error-codes--handling) - Error handling
