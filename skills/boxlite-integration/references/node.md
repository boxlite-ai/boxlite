# BoxLite Node.js SDK — Integration Patterns

## Installation

```bash
npm install @boxlite-ai/boxlite
```

Requirements: Node.js 18+

---

## API Levels

| Class | Use When |
|-------|----------|
| `CodeBox` | Agent runs Python code snippets — returns stdout string directly |
| `SimpleBox` | Agent runs arbitrary commands — returns `{ exitCode, stdout, stderr }` |
| `JsBoxlite` + `BoxOptions` | Full control (resources, security, volumes, streaming) |

---

## CodeBox — for running Python code

`CodeBox.run()` returns a `Promise<string>` (stdout). It throws `ExecError` on non-zero exit.

```javascript
import { CodeBox } from '@boxlite-ai/boxlite';

const box = new CodeBox();
try {
  const stdout = await box.run("print('hello from sandbox')");
  console.log(stdout);
} finally {
  await box.stop();
}
```

TypeScript 5.2+ with async disposal:

```typescript
import { CodeBox } from '@boxlite-ai/boxlite';

await using box = new CodeBox();
const stdout = await box.run("print('hello')");
console.log(stdout);
// box.stop() called automatically
```

---

## SimpleBox — for shell commands

`SimpleBox.exec()` returns `Promise<ExecResult>` = `{ exitCode, stdout, stderr }`. It **never throws** on non-zero exit — check `exitCode` manually.

```javascript
import { SimpleBox } from '@boxlite-ai/boxlite';

const box = new SimpleBox({ image: 'python:slim' });
try {
  const result = await box.exec('python', '-c', "print('hello')");
  console.log(result.stdout);
  if (result.exitCode !== 0) console.error(result.stderr);
} finally {
  await box.stop();
}
```

Multiple `exec()` calls on the same box reuse the VM:

```javascript
const box = new SimpleBox({ image: 'python:slim' });
try {
  await box.exec('pip', 'install', 'numpy');
  const result = await box.exec('python', '-c', 'import numpy; print(numpy.__version__)');
  console.log(result.stdout);
} finally {
  await box.stop();
}
```

Timeout is passed as an options object in the last argument:

```javascript
const result = await box.exec('python', ['-c', code], undefined, { timeoutSecs: 30 });
```

---

## Full Control — JsBoxlite

`JsBoxlite` is the low-level runtime. `box.exec()` here returns a `JsExecution` handle with `.wait()`, `.kill()`, `.stdout()`, `.stderr()` — useful for streaming output.

```javascript
import { JsBoxlite } from '@boxlite-ai/boxlite';

const runtime = new JsBoxlite();
const box = await runtime.create({
  image: 'python:slim',
  cpus: 2,
  memoryMib: 1024,
  workingDir: '/workspace',
});

try {
  // args?, env?, tty?, user?, timeoutSecs?, workingDir?
  const execution = await box.exec('python', ['-c', "print('secure')"], null, null, null, 30);
  const execResult = await execution.wait(); // { exitCode, errorMessage }
  // collect stdout via stream
  const stdoutStream = await execution.stdout();
  let out = '';
  while (true) {
    const chunk = await stdoutStream.next();
    if (chunk === null) break;
    out += chunk;
  }
  console.log(out);
} finally {
  await box.stop();
  await runtime.remove(box.id);
}
```

---

## REST API (cloud / production)

Use `JsBoxlite.rest()` — the constructor does not accept `url`/`apiKey`.

```javascript
import { JsBoxlite, BoxliteRestOptions, ApiKeyCredential } from '@boxlite-ai/boxlite';

const runtime = JsBoxlite.rest(new BoxliteRestOptions({
  url: process.env.BOXLITE_REST_URL ?? 'https://api.boxlite.ai/api',
  credential: new ApiKeyCredential(process.env.BOXLITE_API_KEY),
}));

// Use runtime.create() / box.exec() as normal
```

---

## Timeout Handling

For `SimpleBox`, pass `timeoutSecs` in the options object. For `JsBoxlite`, pass as the 6th positional arg or use a low-level `JsExecution` handle:

```javascript
// SimpleBox — timeout via options
const result = await box.exec(cmd, [arg], undefined, { timeoutSecs: 30 });

// JsBoxlite low-level — explicit kill on timeout
async function safeExec(box, cmd, args = [], timeoutSecs = 30) {
  const execution = await box.exec(cmd, args, null, null, null, timeoutSecs);
  const timer = setTimeout(() => execution.kill().catch(() => {}), timeoutSecs * 1000);
  try {
    return await execution.wait();
  } finally {
    clearTimeout(timer);
  }
}
```

---

## Error Handling

`SimpleBox.exec()` never throws on non-zero exit — check `result.exitCode`. Only `CodeBox.run()` throws `ExecError` on failure:

```javascript
import { ExecError } from '@boxlite-ai/boxlite';

// CodeBox — throws on non-zero exit
try {
  const stdout = await box.run('raise ValueError("bad")');
} catch (err) {
  if (err instanceof ExecError) {
    console.error('Exit code:', err.exitCode);
    console.error('Stderr:', err.stderr);
  }
}

// SimpleBox — never throws, check exitCode
const result = await box.exec('python', ['-c', 'raise ValueError("bad")']);
if (result.exitCode !== 0) {
  console.error('Failed:', result.stderr);
}
```
