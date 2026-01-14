# Node.js Quick Start

Get up and running with BoxLite Node.js SDK in 5 minutes.

## Installation

```bash
npm install @boxlite-ai/boxlite
```

**Requirements:**
- Node.js 18 or later
- Platform with hardware virtualization (see [Prerequisites](./README.md#prerequisites))

**Verify Installation:**
```javascript
import { SimpleBox } from '@boxlite-ai/boxlite';
console.log('BoxLite loaded successfully');
```

## Basic Execution

Create a file `hello.js`:

```javascript
import { SimpleBox } from '@boxlite-ai/boxlite';

async function main() {
  const box = new SimpleBox({ image: 'python:slim' });
  try {
    const result = await box.exec('python', '-c', "print('Hello from BoxLite!')");
    console.log(result.stdout);
  } finally {
    await box.stop();
  }
}

main();
```

Run it:
```bash
node hello.js
```

**What's happening:**
1. BoxLite pulls the `python:slim` OCI image (first run only)
2. Creates a lightweight VM with the image
3. Executes the Python command inside the VM
4. Streams output back to your application
5. Cleans up when `stop()` is called

## TypeScript 5.2+ (Async Disposal)

```typescript
import { SimpleBox } from '@boxlite-ai/boxlite';

async function main() {
  await using box = new SimpleBox({ image: 'alpine:latest' });
  const result = await box.exec('echo', 'Hello!');
  console.log(result.stdout);
  // Box automatically stopped when leaving scope
}

main();
```

## Running Examples

BoxLite includes 5 Node.js examples:

```bash
# Clone the repository
git clone https://github.com/boxlite-labs/boxlite.git
cd boxlite/sdks/node

# Build the SDK
npm install && npm run build
npm link

# Run examples
cd ../../examples/node
npm link @boxlite-ai/boxlite

node simplebox.js
node codebox.js
node browserbox.js
node computerbox.js
node interactivebox.js
```

**Examples overview:**

1. **simplebox.js** - Basic command execution
2. **codebox.js** - Python code execution sandbox
3. **browserbox.js** - Browser automation with CDP
4. **computerbox.js** - Desktop automation (mouse, keyboard, screenshots)
5. **interactivebox.js** - Interactive terminal sessions

## Next Steps

- **[Node.js SDK README](../../sdks/node/README.md)** - Complete API reference
  - Core API (SimpleBox, CodeBox, BrowserBox, ComputerBox, InteractiveBox)
  - TypeScript support and type definitions
  - Async disposal patterns (TypeScript 5.2+)
  - Error handling (ExecError, TimeoutError)
