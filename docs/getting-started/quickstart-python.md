# Python Quick Start

Get up and running with BoxLite Python SDK in 5 minutes.

## Installation

```bash
pip install boxlite
```

**Requirements:**
- Python 3.10 or later
- pip 20.0+

**Verify Installation:**
```python
python3 -c "import boxlite; print(boxlite.__version__)"
# Output: 0.4.4
```

## Basic Execution

Create a file `hello.py`:

```python
import asyncio
import boxlite


async def main():
    # Create a box and run a command
    async with boxlite.SimpleBox(image="python:slim") as box:
        result = await box.exec("python", "-c", "print('Hello from BoxLite!')")
        print(result.stdout)
        # Output: Hello from BoxLite!


if __name__ == "__main__":
    asyncio.run(main())
```

Run it:
```bash
python hello.py
```

**What's happening:**
1. BoxLite pulls the `python:slim` OCI image (first run only)
2. Creates a lightweight VM with the image
3. Executes the Python command inside the VM
4. Streams output back to your application
5. Automatically cleans up when the context exits

## Code Execution (AI Agents)

Create a file `codebox.py`:

```python
import asyncio
import boxlite


async def main():
    # Execute untrusted code safely
    code = """
import requests
response = requests.get('https://api.github.com/zen')
print(response.text)
"""

    async with boxlite.CodeBox() as codebox:
        result = await codebox.run(code)
        print(result)


if __name__ == "__main__":
    asyncio.run(main())
```

Run it:
```bash
python codebox.py
```

**What's happening:**
1. CodeBox automatically installs required packages (requests)
2. Executes the code in complete isolation
3. Returns the output
4. Your host system remains completely safe

## Running Examples

BoxLite includes 9 comprehensive Python examples:

```bash
# Clone the repository
git clone https://github.com/boxlite-labs/boxlite.git
cd boxlite

# Build Python SDK
make dev:python

# Run examples
python examples/python/simplebox_example.py
python examples/python/codebox_example.py
python examples/python/browserbox_example.py
python examples/python/computerbox_example.py
python examples/python/lifecycle_example.py
python examples/python/list_boxes_example.py
python examples/python/cross_process_example.py
python examples/python/interactivebox_example.py
python examples/python/native_example.py
```

**Examples overview:**

1. **simplebox_example.py** - Foundation patterns
2. **codebox_example.py** - AI code execution
3. **browserbox_example.py** - Browser automation
4. **computerbox_example.py** - Desktop automation
5. **lifecycle_example.py** - Box lifecycle management
6. **list_boxes_example.py** - Runtime introspection
7. **cross_process_example.py** - Multi-process operations
8. **interactivebox_example.py** - Interactive shells
9. **native_example.py** - Low-level Rust API

## Next Steps

- **[Python SDK README](../../sdks/python/README.md)** - Complete API reference
  - Core API (Boxlite, BoxOptions, Box, Execution)
  - Higher-level APIs (SimpleBox, CodeBox, BrowserBox, ComputerBox)
  - API Patterns (async/await, context managers, streaming I/O)
  - Configuration Reference (resources, volumes, ports)
