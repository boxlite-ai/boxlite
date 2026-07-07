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
| `CodeBox` | Agent runs Python/shell code snippets |
| `SimpleBox` | Agent runs arbitrary commands |
| `JsBoxlite` + `BoxOptions` | Full control (resources, security, volumes) |

---

## CodeBox — for running code

```javascript
import { CodeBox } from '@boxlite-ai/boxlite';

const box = new CodeBox();
try {
  const result = await box.run("print('hello from sandbox')");
  console.log(result.stdout);
} finally {
  await box.stop();
}
```

TypeScript 5.2+ with async disposal:

```typescript
import { CodeBox } from '@boxlite-ai/boxlite';

await using box = new CodeBox();
const result = await box.run("print('hello')");
console.log(result.stdout);
// box.stop() called automatically
```

---

## SimpleBox — for shell commands

```javascript
import { SimpleBox } from '@boxlite-ai/boxlite';

const box = new SimpleBox({ image: 'python:slim' });
try {
  const result = await box.exec('python', '-c', "print('hello')");
  console.log(result.stdout);
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

---

## Full Control — JsBoxlite

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
  const execution = await box.exec('python', ['-c', "print('secure')"], { timeout: 30 });
  console.log(execution.stdout);
} finally {
  await box.stop();
  await runtime.remove(box.id);
}
```

---

## REST API (cloud / production)

```javascript
import { JsBoxlite } from '@boxlite-ai/boxlite';

const runtime = new JsBoxlite({
  url: process.env.BOXLITE_REST_URL ?? 'https://api.boxlite.ai/api',
  apiKey: process.env.BOXLITE_API_KEY,
});
```

---

## Timeout Handling

```javascript
async function execWithTimeout(box, cmd, args = [], timeoutMs = 30000) {
  const execution = await box.exec(cmd, args);
  const timer = setTimeout(() => execution.kill(), timeoutMs);
  try {
    return await execution.wait();
  } finally {
    clearTimeout(timer);
  }
}
```

---

## Error Handling

```javascript
import { ExecError, TimeoutError } from '@boxlite-ai/boxlite';

try {
  const result = await box.exec('python', ['-c', 'raise ValueError("bad")']);
} catch (err) {
  if (err instanceof ExecError) {
    console.error('Exit code:', err.exitCode);
    console.error('Stderr:', err.stderr);
  } else if (err instanceof TimeoutError) {
    console.error('Timed out');
  }
}
```
