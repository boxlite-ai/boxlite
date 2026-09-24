# Running examples

BoxLite includes 9 comprehensive Python examples demonstrating all major use cases.

## Prerequisites

```bash
# Clone repository
git clone https://github.com/boxlite-ai/boxlite.git
cd boxlite

# Build Python SDK
make dev:python
```

## Example gallery

### 1. SimpleBox - foundation patterns

**File:** `examples/python/01_getting_started/run_simplebox.py`

Demonstrates core BoxLite features:
- Basic command execution
- Stdout/stderr separation
- Environment variables
- Working directory
- Error handling
- Multiple commands in same box

**Run:**
```bash
python examples/python/01_getting_started/run_simplebox.py
```

**Key Patterns:**
```python
async with boxlite.SimpleBox(image="python:alpine") as box:
    # Execute command
    result = await box.exec("ls", "-lh", "/")
    print(result.stdout)

    # With environment variables
    result = await box.exec(
        "python", "-c", "import os; print(os.getenv('MY_VAR'))",
        env=[("MY_VAR", "value")]
    )
```

### 2. CodeBox - AI code execution

**File:** `examples/python/01_getting_started/run_codebox.py`

Secure Python code execution for AI agents.

**Run:**
```bash
python examples/python/01_getting_started/run_codebox.py
```

**Key Patterns:**
```python
async with boxlite.CodeBox() as codebox:
    # Install packages automatically
    await codebox.install_package("requests")

    # Run untrusted code safely
    result = await codebox.run("""
import requests
response = requests.get('https://api.github.com/zen')
print(response.text)
""")
```

### 3. BrowserBox - browser automation

**File:** `examples/python/05_browser_desktop/automate_with_playwright.py`

**Run:**
```bash
python examples/python/05_browser_desktop/automate_with_playwright.py
```

**Use Cases:**
- Web scraping
- E2E testing
- Browser automation
- Screenshot generation

### 4. ComputerBox - desktop automation

**File:** `examples/python/05_browser_desktop/automate_desktop.py`

**Run:**
```bash
python examples/python/05_browser_desktop/automate_desktop.py
```

**Available Functions:**
- `screenshot()` - Capture screen
- `left_click()`, `right_click()`, `double_click()`
- `type_text(text)` - Type text
- `get_screen_size()` - Get dimensions
- `move_mouse(x, y)` - Move cursor
- And 9 more functions

### 5. Lifecycle management

**File:** `examples/python/03_lifecycle/manage_lifecycle.py`

Demonstrates box state management.

**Run:**
```bash
python examples/python/03_lifecycle/manage_lifecycle.py
```

### 6-9. Other examples

- `01_getting_started/list_boxes.py` - Runtime introspection
- `03_lifecycle/share_across_processes.py` - Multi-process operations
- `04_interactive/run_interactive_shell.py` - Interactive shells
- `07_advanced/use_native_api.py` - Low-level Rust API

## Customizing examples

All examples can be customized by editing the source files:

**Change Image:**
```python
async with boxlite.SimpleBox(image="ubuntu:22.04") as box:
    # ...
```

**Add Resources:**
```python
async with boxlite.SimpleBox(
    image="python:slim",
    cpus=2,
    memory_mib=2048
) as box:
    # ...
```

**Mount Volumes:**
```python
async with boxlite.SimpleBox(
    image="python:slim",
    volumes=[("/host/data", "/mnt/data", True)]
) as box:
    # ...
```
