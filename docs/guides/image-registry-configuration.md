# Guide: Image registry configuration

This guide explains how to configure BoxLite to pull OCI container images from custom registries, such as a private enterprise registry, a third-party registry like `ghcr.io` or `quay.io`, or a local caching proxy.

## How it works

When you ask BoxLite to create a box from an image (e.g., `image="alpine"`), it needs to resolve this "unqualified" reference into a full image reference (e.g., `docker.io/library/alpine:latest`).

By default, if no registries are configured, BoxLite uses `docker.io` (Docker Hub) as the implicit default.

You can provide a list of custom registries. BoxLite will try to pull the image from each registry in the provided order. The first successful pull wins. If all registries fail, the operation returns an error.

**Fully qualified image references (e.g., `quay.io/prometheus/prometheus:v2.40.1`) always bypass this search mechanism and are pulled directly.**

## TLS trust

HTTPS pulls trust the operating system's certificate store in addition to the Mozilla roots bundled with BoxLite, as Docker does. A registry or a TLS-intercepting proxy signed by a private CA works once that CA is installed in the system store:

- **Linux**: add the CA to the distribution's trust store (for example `/usr/local/share/ca-certificates/` and `update-ca-certificates` on Debian and Ubuntu).
- **macOS**: add it to the System keychain and mark it trusted.
- **Windows (WSL2)**: add it to the WSL distribution's trust store as on Linux; the Windows certificate store is not read.

The store is read on every pull, so a newly installed CA applies without restarting the application. When `SSL_CERT_FILE` or `SSL_CERT_DIR` is set, BoxLite reads only those locations in place of the system store; the bundled roots still apply. Certificates the store holds but rustls cannot parse are skipped. `skip_verify: true` disables verification for that registry, so no store is consulted.

## Pull proxy

By default, pulls use the application's `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, and `NO_PROXY` environment variables. To route pulls through a proxy without changing the whole process environment, set `image_registry_proxy` in the runtime options or the CLI `--config` file:

```json
{
  "image_registry_proxy": {
    "https_proxy": "http://user:password@proxy.corp.example:3128",
    "no_proxy": "registry.local,10.0.0.0/8"
  }
}
```

| Setting | Behavior |
| --- | --- |
| unset | the environment variables apply |
| `https_proxy` or `http_proxy` set | every proxy environment variable is ignored for pulls, `NO_PROXY` included |
| `https_proxy` only | `transport: "http"` registries connect directly |
| `no_proxy` without a proxy URL | rejected when the runtime is created |
| a scheme other than `http://` or `https://`, or an invalid URL | rejected when the runtime is created |

The proxy carries every pull request, including token exchanges and blob redirects to a CDN. `no_proxy` follows curl, not Docker: `*.corp.example` and `host:port` entries never match (write `.corp.example` or `corp.example` instead), and `localhost` is not bypassed unless listed. A TLS-intercepting proxy also needs its CA in the system store; see [TLS trust](#tls-trust).

The setting covers image pulls only; traffic from inside a box does not use it. A CLI profile that targets a remote server ignores `--config`, so the server's own settings apply there.

## CLI configuration

The CLI layers configuration sources with the following priority (from lowest to highest):

1.  **Default**: `docker.io`
2.  **Configuration File (`--config`)**: Loads configuration from the specified path
3.  **CLI Flags (`--registry`)**: Prepended to registries from config file (highest priority)

### 1. Configuration file

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

### 2. Using the configuration file

Use the `--config` flag to specify your configuration file:

```bash
# Use a project-specific configuration
boxlite --config ./project-config.json run alpine
```

**Important**: If you specify a config file with `--config` and the file does not exist or is invalid, the command will fail with an error.

### 3. Command line flags

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

## SDK configuration

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

### Advanced: Loading config in SDKs

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
