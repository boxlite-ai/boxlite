# Mounting volumes

Mount host directories into boxes for data input/output.

## Mount types

**virtiofs (Default):**
- High-performance file sharing
- Low overhead
- Real-time host-guest synchronization

**QCOW2 (container disk):**
- Block device
- Survives stop only when the box is kept (`auto_delete=0`)
- Copy-on-write

## Read-only vs read-write

**Read-Only Mount (Data Input):**

```python
volumes=[
    ("/host/config", "/etc/app/config", True),
    ("/host/datasets", "/mnt/data", True),
]
```

**Read-Write Mount (Data Output):**

```python
volumes=[
    ("/host/output", "/mnt/output", False),
    ("/host/logs", "/var/log/app", False),
]
```

## Common use cases

### 1. Configuration files

```python
import os
import boxlite

# Mount config directory
async with boxlite.SimpleBox(
    image="python:slim",
    volumes=[
        (os.path.expanduser("~/.config/myapp"), "/etc/myapp", True)
    ]
) as box:
    result = await box.exec("cat", "/etc/myapp/config.yaml")
    print(result.stdout)
```

### 2. Data processing

```python
# Input data (read-only), output results (read-write)
async with boxlite.SimpleBox(
    image="python:slim",
    volumes=[
        ("/data/input", "/mnt/input", True),
        ("/data/output", "/mnt/output", False),
    ]
) as box:
    await box.exec("python", "process.py", "--input", "/mnt/input", "--output", "/mnt/output")
```

### 3. Source code development

```python
# Mount source code for live development
async with boxlite.SimpleBox(
    image="python:slim",
    volumes=[
        (os.getcwd(), "/workspace", False)
    ],
    working_dir="/workspace"
) as box:
    # Run tests in isolated environment
    await box.exec("pytest", "tests/")
```

### 4. Persistent storage with QCOW2

```python
# Create a box that keeps its disk after stop
box = await runtime.create(boxlite.BoxOptions(
    image="postgres:latest",
    disk_size_gb=20,  # 20 GB disk
    env=[("POSTGRES_PASSWORD", "secret")],
    auto_delete=0,  # keep the box after stop
))

# Data survives stop/restart
await box.stop()
# ... later ...
box = await runtime.get(box.id)  # Disk still intact
```

## Performance considerations

**virtiofs Performance:**
- Fast for small files
- Slight overhead for large files
- Real-time synchronization

**QCOW2 Performance:**
- Block-level access (faster for large files)
- Copy-on-write overhead
- No real-time sync with host

**Best Practices:**
- Use read-only mounts when possible (lower overhead)
- Mount specific directories, not entire filesystem
- For large datasets, consider QCOW2 disk
