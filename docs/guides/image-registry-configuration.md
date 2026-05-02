# Guide: Image Registry Configuration

This guide explains how to configure BoxLite to pull OCI container images from custom registries, such as a private enterprise registry, a third-party registry like `ghcr.io` or `quay.io`, or a local caching proxy.

## How it Works

When you ask BoxLite to create a box from an image (e.g., `image="alpine"`), it needs to resolve this "unqualified" reference into a full image reference (e.g., `docker.io/library/alpine:latest`).

By default, if no registries are configured, BoxLite uses `docker.io` (Docker Hub) as the implicit default.

You can provide a list of custom registries. BoxLite will try to pull the image from each registry in the provided order. The first successful pull wins. If all registries fail, the operation returns an error.

**Fully qualified image references (e.g., `quay.io/prometheus/prometheus:v2.40.1`) always bypass this search mechanism and are pulled directly.**

## CLI Configuration

The CLI layers configuration sources with the following priority (from lowest to highest):

1.  **Default**: `docker.io`
2.  **Configuration File (`--config`)**: Loads configuration from the specified path
3.  **CLI Flags (`--registry`)**: Prepended to registries from config file (highest priority)

### 1. Configuration File

Create a JSON configuration file with your registry preferences:

```json
{
  "image_registries": [
    {
      "host": "ghcr.io",
      "search": true
    },
    {
      "host": "quay.io",
      "search": true
    },
    {
      "host": "docker.io",
      "search": true
    },
    {
      "host": "registry.local:5000",
      "transport": "http",
      "search": true
    },
    {
      "host": "registry.example.com",
      "transport": "https",
      "skip_verify": true,
      "auth": {
        "type": "basic",
        "username": "user",
        "password": "password"
      }
    }
  ]
}
```

- `image_registries` (optional): Per-registry settings for fully qualified pulls and, when `search` is true, unqualified image fallback.
- `transport: "http"` enables a plain HTTP registry.
- `skip_verify: true` disables TLS certificate and hostname verification for HTTPS registries.
- `auth` can be `{ "type": "basic", "username": "...", "password": "..." }` or `{ "type": "bearer", "token": "..." }`.

### 2. Using the Configuration File

Use the `--config` flag to specify your configuration file:

```bash
# Use a project-specific configuration
boxlite --config ./project-config.json run alpine
```

**Important**: If you specify a config file with `--config` and the file does not exist or is invalid, the command will fail with an error.

### 3. Command Line Flags

You can use the global `--registry` flag with `boxlite run` or `boxlite create`. You can specify it multiple times.

These flags are **prepended** to your configured list. This allows you to force a specific registry to be checked first for a single command without editing your config file.

```bash
# Assume config.json contains image_registries entries for ghcr.io and docker.io

# This command will search:
# 1. my.private.registry.com (from flag)
# 2. ghcr.io (from config)
# 3. docker.io (from config)
boxlite --config ./config.json \
  run --registry my.private.registry.com \
  my-internal-app:latest
```

## SDK Configuration

The SDKs are "pure" by design. They **do not** automatically load any configuration file. This ensures that your code's behavior is deterministic and doesn't silently depend on the user's local environment.

1.  **Programmatic Options**: You explicitly pass the list of registries when initializing the runtime.
2.  **Default**: `docker.io` (if you pass an empty list or nothing).

### Python

Pass structured `image_registries` to `boxlite.Options`.

```python
import boxlite

# Configure a runtime to search ghcr.io first, then docker.io
options = boxlite.Options(
    image_registries=[
        boxlite.ImageRegistry(host="ghcr.io", search=True),
        boxlite.ImageRegistry(host="docker.io", search=True),
        boxlite.ImageRegistry(
            host="registry.example.com",
            username="user",
            password="password",
        ),
        boxlite.ImageRegistry(
            host="registry.local:5000",
            transport="http",
            search=True,
        ),
    ],
)
runtime = boxlite.Boxlite(options)

# When creating a box, 'alpine' will be tried as:
# 1. ghcr.io/library/alpine
# 2. docker.io/library/alpine
async with boxlite.SimpleBox(image="alpine", runtime=runtime) as box:
    await box.exec(["echo", "Hello!"])
```

### Node.js

Pass structured `imageRegistries` to the `JsBoxlite` constructor.

```javascript
import { JsBoxlite, SimpleBox } from '@boxlite-ai/boxlite';

// Configure a runtime to search ghcr.io first, then docker.io
const runtime = new JsBoxlite({
  imageRegistries: [
    { host: 'ghcr.io', search: true },
    { host: 'docker.io', search: true },
    {
      host: 'registry.example.com',
      auth: { username: 'user', password: 'password' }
    },
    {
      host: 'registry.local:5000',
      transport: 'http',
      search: true
    }
  ]
});

// Pass the custom runtime to the box constructor
const box = new SimpleBox({
  image: 'alpine',
  runtime: runtime
});

await box.exec('echo', 'Hello!');
```

### Advanced: Loading Config in SDKs

If you want your SDK application to respect a configuration file, you can manually load it. This puts the control in your hands.

```python
import boxlite
import json
from pathlib import Path

def load_boxlite_options(config_path: str):
    """Load BoxLite options from a configuration file."""
    with open(config_path) as f:
        config = json.load(f)

    return boxlite.Options(
        image_registries=[
            boxlite.ImageRegistry(
                host=entry["host"],
                transport=entry.get("transport", "https"),
                skip_verify=entry.get("skip_verify", False),
                search=entry.get("search", False),
                username=entry.get("auth", {}).get("username"),
                password=entry.get("auth", {}).get("password"),
                bearer_token=entry.get("auth", {}).get("token"),
            )
            for entry in config.get("image_registries", [])
        ],
    )

# Use it
runtime = boxlite.Boxlite(load_boxlite_options("./config.json"))
```
