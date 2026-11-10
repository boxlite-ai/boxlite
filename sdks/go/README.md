# BoxLite Go SDK

Go SDK for BoxLite — an embeddable virtual machine runtime for secure, isolated code execution.

Access the [agent API](../../docs/reference/agents.md) through `Box.Agents()`
for session and turn methods, grouped options and error handling.

## Install

```bash
go get github.com/boxlite-ai/boxlite/sdks/go
go run github.com/boxlite-ai/boxlite/sdks/go/cmd/setup
```

Requires Go 1.24+ with CGO enabled. The setup step downloads the prebuilt native library and header into the module directory in your Go module cache (one-time). Set `GITHUB_TOKEN` to avoid API rate limits.

## Usage

### Managed checkpoints

The source must be stopped before `Create`; stop it and wait for `stopped` first.
Checkpoint creation rejects other states and never stops the source automatically.

`runtime.Checkpoints()` exposes `Create`, `List`, `Get`, `Remove`
and `ImportBox(ctx, key, name, boxID)`, each taking a context. The handle follows its runtime's
lifetime and needs no separate close. Captured archives survive source deletion.

```go
checkpoint, err := runtime.Checkpoints().Create(ctx, "source", "dev-base")
if err != nil { return err }
worker, err := runtime.Checkpoints().ImportBox(ctx, checkpoint.ID, "worker", "")
if err != nil { return err }
defer worker.Close()
```

Pass an empty `boxID` for a new Box; a nonempty `boxID` replaces that target.
Name and target are mutually exclusive.

Cloud capture may report `creating`; query until `ready` before use. New imports
and replacements inherit all saved execution settings without overrides. Local
replacement preserves the name and returns a new native ID; cloud replacement preserves
the public Box ID. `Remove(ctx, key, true)` ignores absence only. Cancellation
stops waiting; accepted native work continues under its ownership protection.
Create local replacement targets with `WithAutoDeleteInterval(0)` so stopping retains them.

Local storage defaults to `<BOXLITE_HOME>/checkpoints`. `WithCheckpointDir(path)`
overrides `BOXLITE_CHECKPOINTS_DIR` and the default. REST storage belongs to the
server. Existing archive export/import APIs retain their behavior.

### Create a box

```go
package main

import (
	"context"
	"fmt"
	"log"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

func main() {
	rt, err := boxlite.NewRuntime(
		boxlite.WithImageRegistry(boxlite.ImageRegistry{
			Host: "registry.example.com",
			Auth: boxlite.ImageRegistryAuth{
				Username: "user",
				Password: "password",
			},
		}),
	)
	if err != nil {
		log.Fatal(err)
	}
	defer rt.Close()

	ctx := context.Background()
	box, err := rt.Create(ctx, "alpine:latest",
		boxlite.WithName("my-box"),
		boxlite.WithCPUs(1),
		boxlite.WithMemory(512),
		boxlite.WithNetwork(boxlite.NetworkSpec{
			Outbound: boxlite.OutboundNetworkSpec{
				Mode:     boxlite.NetworkModeEnabled,
				AllowNet: []string{"api.openai.com"},
			},
		}),
		boxlite.WithSecret(boxlite.Secret{
			Name:  "openai",
			Value: "sk-...",
			Hosts: []string{"api.openai.com"},
		}),
	)
	if err != nil {
		log.Fatal(err)
	}

	if err := box.Start(ctx); err != nil {
		log.Fatal(err)
	}

	fmt.Println("Box started successfully!")
}
```

### Live Execution Discovery and Recovery

`box.Executions().List(ctx)` returns `[]ExecutionInfo` from the live guest,
including its main process (`IsMainSession`). Fields are `ExecutionID` (canonical guest
ID), `Argv`, `StartedAt` (Unix milliseconds), `TTY`, and `IsMainSession`.
Completed executions disappear. Listing never boots the box; a stopped or
not-yet-started box returns an empty slice, and a paused box returns an
invalid-state error.

`box.Executions().Get(ctx, id)` recovers a control-only `*Execution`: `ID()`,
`Wait`, `Kill`, `Signal`, and `ResizeTTY` work without claiming stdout/stderr.
It has no stdin or output sinks, and `Close` only releases the handle.

`box.Executions().Attach(ctx, id, opts)` opens live stdin/output streams with the
same `Stdout`, `Stderr`, `OnStdout`, and `OnStderr` sink options as
`StartExecution`. An existing reader causes a synchronous conflict rather than
stealing output. Launch options do not apply to attachment. After the original
reader disconnects, a fresh client can discover and attach by ID. Attachment
does not boot the box. It includes available buffered output, without guaranteeing
a complete historical log. Closing an attached handle releases its reader without
killing the guest process.

```go
executions, err := box.Executions().List(ctx)
if err != nil {
	log.Fatal(err)
}
for _, info := range executions {
	if info.IsMainSession {
		continue
	}
	control, err := box.Executions().Get(ctx, info.ExecutionID)
	if err != nil {
		log.Fatal(err)
	}
	err = control.Signal(ctx, 15)
	control.Close()
	if err != nil {
		log.Fatal(err)
	}
}
```

### Nested virtualization (experimental)

Set `BOXLITE_EXPERIMENTAL=nested-virtualization` before `NewRuntime`.
The runtime captures the environment once and enables nesting for every new box;
ordinary `Create` calls need no feature or advanced-options argument.
There is no public per-box setter. Keep the environment enabled when reopening
nested boxes; their saved configuration is immutable.

`NewRest` ignores local feature environment. The server selects its policy:
a local server uses its process environment; Cloud uses the organization's
Admin-controlled allowlist and the selected Runner's authorization.
An enabled policy that cannot be provided fails rather than creating an ordinary
box. Hardware is checked at VM startup; metadata creation does not establish L2.

Runner integration uses the private `boxlite_runner` build tag and saved decisions;
it does not apply local defaults to all tenants.

### Archive Export and Import

```go
archivePath, err := box.Export(ctx, "/var/lib/my-app/archives")
if err != nil {
	log.Fatal(err)
}

// An empty name uses the same unnamed-box behavior as Create without
// WithName. The imported box receives a new ID and starts stopped.
restored, err := rt.Import(ctx, archivePath, "")
if err != nil {
	log.Fatal(err)
}
defer restored.Close()
```

A local runtime treats the archive as trusted because local applications own
both the runtime and archive. A REST runtime uploads the file and relies on the
server's untrusted-upload policy.

Export and Import never delete the archive. The caller owns its retention and
must explicitly remove it when it is no longer needed.

`rt.PrepareCheckpointArchive` checks a downloaded checkpoint's recorded SHA-256,
native manifest and disk, then loads the pinned OCI startup configuration. It
returns a `PreparedCheckpointArchive` whose `Path()` can be passed to the same
`rt.Import`. It neither creates nor removes a box, so recovery callers can finish
preflight before removing their old target.

`SHA256()` and `SizeBytes()` describe the derived file, including its target
identity metadata; they do not replace the source checkpoint's immutable record.

Keep the prepared owner open until native import finishes; `Close()` removes
its private derived archive and leaves the source file intact. Optional platform
environment values may replace only the reserved BoxLite identity/telemetry
keys, require a target `BOXLITE_BOX_ID`, and preserve all other user variables
and execution settings. This utility requires a local runtime; a REST runtime
returns unsupported without transmitting local paths.

Canceling the preparation context stops the caller's wait. Accepted native work
retains its temporary archive until completion; an undelivered successful result
is freed by the callback. The caller must keep the source archive available until
that accepted work finishes.

### Runtime Image Management

`rt.Images()` holds the images a runtime can boot from: the local cache on a
runtime from `NewRuntime`, the server's catalog on one from `NewRest`. `List`,
`Get` and `Remove` run unchanged against either.

```go
ctx := context.Background()
images, err := rt.Images()
if err != nil {
	log.Fatal(err)
}
defer images.Close()

cached, err := images.List(ctx)
if err != nil {
	log.Fatal(err)
}
for _, image := range cached {
	fmt.Println(image.Repository, image.Tag, image.ID)
}

detail, err := images.Get(ctx, "docker.io/library/alpine")
if err != nil {
	log.Fatal(err)
}
for _, version := range detail.Versions {
	fmt.Println(detail.Name, version.Digest, version.RecordedAt)
}
if err := images.Remove(ctx, "docker.io/library/alpine"); err != nil {
	log.Fatal(err)
}
```

`Pull` fills a local cache ahead of time. A REST runtime refuses it with
`ErrUnsupported`, because creating a box there pulls the image:

```go
pull, err := images.Pull(ctx, "alpine:latest")
if err != nil {
	log.Fatal(err)
}
fmt.Println(pull.Reference, pull.ConfigDigest, pull.LayerCount)
```

| Method | Local runtime | REST runtime |
|--------|---------------|--------------|
| `Pull` | Pulls into the cache | `ErrUnsupported`: creating a box pulls |
| `List` | One row per cached reference | Catalog alias and digest references |
| `Get` | The cache entries under the name | The catalog entry with its versions |
| `Remove` | Forgets the name; layers stay | Removes the catalog entry; `ErrInvalidState` while a box can boot from it |
| `Usage` | `ErrUnsupported` | `ImageUsage{Count, Limit, KnownBytes}` |
| `CreateAlias` | `ErrUnsupported` | Creates a new alias; existing names conflict |
| `DeleteAlias` | `ErrUnsupported` | Removes only the named alias |

`Get` and `Remove` take an image name such as `"docker.io/library/alpine"`. A
reference with a tag or digest fails with `ErrInvalidArgument`, since a remove
takes every tag of the name; a name the runtime does not hold fails with
`ErrNotFound`. `ImageDetail.Versions` is newest first, and
`ImageVersion.SizeBytes` is nil when the size is unknown. Locally, a box built
from a removed image reads the image's configuration from the registry when it
next starts.

`CreateAlias(ctx, name, alias, digest)` creates a new catalog binding to an
existing ready digest. An existing name returns `ErrAlreadyExists`, including
an identical binding. `DeleteAlias(ctx, name, alias)` removes only the binding;
an absent alias returns `ErrNotFound`. Neither operation changes registry tags,
versions or existing boxes. Local runtimes return `ErrUnsupported`.

`ImageDetail.Aliases` and `ImageVersion.Aliases` hold catalog aliases. History
entries are `ImageAliasEvent` values with `Alias` and `RecordedAt`. Registry
tags remain in image references and `ImageInfo.Tag`.

### Private Registry Logins

On a runtime from `NewRest`, `images.Registries()` after `rt.Images()` manages the logins the server
pulls private images with. A runtime from `NewRuntime` returns
`ErrUnsupported`: pass `WithImageRegistries` instead.

```go
images, err := rt.Images()
if err != nil {
	log.Fatal(err)
}
defer images.Close()
registries, err := images.Registries()
if err != nil {
	log.Fatal(err)
}
defer registries.Close()

login, err := registries.Create(ctx, boxlite.NewRegistryCredential{
	RegistryHost:     "ghcr.io",
	RepositoryPrefix: "acme/", // "" for the whole registry
	Username:         "acme-bot",
	Password:         os.Getenv("GHCR_TOKEN"),
})
if err != nil {
	log.Fatal(err)
}
// ... boxes created from ghcr.io/acme/... now pull with this login ...
if err := registries.Remove(ctx, login.ID); err != nil {
	log.Fatal(err) // ErrInvalidState while a box still pulls through it
}
```

| Method | Returns or fails with |
|--------|-----------------------|
| `List` | Every login, oldest first |
| `Create` | The login; `ErrAlreadyExists` while one is held for the same registry and prefix |
| `Remove` | `ErrInvalidState` naming the boxes while one pulls through it; `ErrNotFound` for an unknown id; `ErrInvalidArgument` for an id that is not a UUID |

The password is sent once and never returned: `RegistryCredential` has no
password field, and `NewRegistryCredential` prints `Password:[redacted]` with
`%v`, `%+v` and `%#v`.

## Box Options

- `WithNetwork(boxlite.NetworkSpec{Outbound: boxlite.OutboundNetworkSpec{Mode: boxlite.NetworkModeEnabled, AllowNet: []string{"api.openai.com"}}})` restricts outbound traffic while keeping networking enabled.
- `WithNetwork(boxlite.NetworkSpec{Outbound: boxlite.OutboundNetworkSpec{Mode: boxlite.NetworkModeDisabled}})` disables the guest network interface entirely.
- `WithNetwork(boxlite.NetworkSpec{Inbound: boxlite.InboundNetworkSpec{Mode: boxlite.NetworkModeEnabled}})` permits proxy access subject to each tunnel's policy. Inbound access is disabled by default, including when `Inbound.Mode` is unset. The two directions are independent.
- The deprecated flat fields `NetworkSpec{Mode, AllowNet}` still configure the outbound direction. Setting them together with `Outbound` is rejected when the options are built. `NetworkInfo.Mode` and `NetworkInfo.AllowNet` likewise remain readable as views onto `NetworkInfo.Outbound`.
- `WithPort(boxlite.PortSpec{Guest: 3000})` publishes TCP locally on an OS-selected host port; after checking `BoxInfo.Network != nil`, read the concrete binding from `Network.PublishedPorts`.
- A nil `PublishedPorts` slice means the current handle does not know the bindings; a non-nil empty slice means there are no active publications. `Box.Info`, `Runtime.GetInfo`, and `Runtime.ListInfo` use callback-backed runtime operations and honor context cancellation.
- `WithSecret(boxlite.Secret{...})` injects a secret into the `Authorization` header of outbound HTTPS requests to `Hosts`, which is required; `Placeholder` is a dummy guest value that defaults to `<BOXLITE_SECRET:{Name}>`.
- Container capabilities live under advanced options:

  ```go
  advanced, err := boxlite.NewAdvancedBoxOptions()
  if err != nil { log.Fatal(err) }
  defer advanced.Close()
  if err := advanced.SetCapabilities(boxlite.ContainerCapabilities{
      Add: []string{"NET_ADMIN"},
      Drop: []string{"NET_RAW"},
  }); err != nil { log.Fatal(err) }
  box, err := runtime.Create(ctx, "alpine:latest", boxlite.WithAdvancedOptions(advanced))
  ```

Port publication is local-only. Remote runtimes reject it with guidance to use
the existing network tunnel API. Each tunnel handle is one-shot.
OCI `EXPOSE` metadata does not publish ports.

### Fractional CPUs

Use `WithCPUs(0.5)` for half a CPU of aggregate time on a Linux execution host, or `WithCPUs(1.5)` for two guest vCPUs sharing 1.5 CPUs.
`BoxInfo.CPUs` is a `float64`, reported through the initial native callback without extra information requests.
Integer inputs retain existing behavior; fractional values are immutable and local macOS execution rejects them.
A macOS REST client can request fractional CPUs from a supporting Linux server.
Rebuild against the matching C header/library because CPU fields and parameters now use `double`.
See [fractional CPUs](../../docs/guides/resource-limits.md#fractional-cpus-linux) for validation, cgroup delegation, and REST support.

## Service Tunnels

The same route workflow works with local and remote runtimes:

- `box.Network() (*Network, error)` returns box-scoped network operations.
- `network.Tunnel(ctx, target, opts) (*BoxTunnel, error)` prepares a tunnel. `target` has the concrete standard-library type `*net.TCPAddr` whose IP is localhost or the guest IP for now; an empty IP means localhost. `boxlite.DefaultTunnelOptions()` is public, and `boxlite.TunnelOptions{IsPublic: false}` (also the zero value) requests private cloud access. `tunnel.URI()` and `tunnel.Descriptor()` stay readable after `Connect` or `Forward`.
- `tunnel.Descriptor()` returns `URI`, `IsPublic`, and `Token` (full once, masked on later preparations).
- `network.RevokeTunnel(ctx, port) error` withdraws the port's tunnel. It
  is safe to repeat and leaves open connections running.
- `TCPListenAddress(host, port)` and `UnixListenAddress(path)` return validated
  standard `net.Addr` values for `tunnel.Forward(ctx, addr)`. The returned
  `TunnelForwarder` has `Addr() net.Addr`, `Wait(ctx) error`, and repeatable
  `Close() error`; canceling a wait context does not close the listener.
- `tunnel.URI() (string, error)` returns the public URL of a remotely served tunnel, or an empty string for a local one.
- `tunnel.Connect(ctx) (net.Conn, error)` consumes the prepared tunnel and opens its connection.

Choose `Connect` or `Forward`; a forwarder reuses the prepared declaration and
opens a fresh authenticated connection per client. It cannot undo revocation.
See [private tunnel usage](../../docs/concepts/networking.md#private-cloud-tunnels).
This differs from `WithPort`, which creates a persistent,
local-only host listener that accepts repeated connections.

## Domains

On a hosted runtime the organization can route a name of its own
(`demo.apps.example`) to a box port; see
[Domains](../../docs/concepts/networking.md#domains).

- `rt.Domains() (*Domains, error)` returns the handle; a local runtime returns
  an `ErrUnsupported` error. Release it with `Close()`.
- `domains.Bind(ctx, "demo.apps.example", boxlite.DomainTarget{Type: boxlite.DomainTargetBox, Box: "web-a", Port: 3000}) (*Domain, error)`
  requires an owned full hostname; request new names in Dashboard > Domains first. `Box` takes an
  id or name.
- `domains.List(ctx) (*DomainList, error)` returns every held full `Hostname`
  (`Target` nil while unbound) and the allowance.
- `domains.Unbind(ctx, "demo.apps.example") error` requires the full hostname and stops routing it; the organization
  keeps the name.

`Domain` has `Hostname`, `URL` and `Target`; there is no short `Name`.
`DomainTargetApp` with `App` reserves an App reference; servers currently reject
App binding with `app_target_not_supported`.

Each call is one blocking request, like `Network.Tunnel`: `ctx` is checked
before and after waiting for another call on the same handle. Cancellation
observed after that wait prevents the request; it does not interrupt a request
already in flight.

## Guest SSH

`box.SSH()` configures, observes, and disables the box's guest SSH listener.
SSH defaults to disabled when no state is saved; the SDK is not an SSH client.

```go
hostKey, err := os.ReadFile("host_ed25519") // unencrypted OpenSSH private key
if err != nil { log.Fatal(err) }
status, err := box.SSH().Configure(ctx, boxlite.SSHConfig{
	ListenAddress:  "0.0.0.0:2222",
	HostPrivateKey: string(hostKey),
	Accounts: []boxlite.SSHAccount{{
		Login:          "alice",
		AuthorizedKeys: []string{"ssh-ed25519 AAAA... alice@laptop"},
		// CA: &boxlite.SSHCAConfig{PublicKey: "ssh-ed25519 AAAA...", Principal: "alice"},
	}},
})
if err != nil { log.Fatal(err) }
fmt.Println(status.Generation, status.HostKeyFingerprint)

current, err := box.SSH().Status(ctx)
if err != nil { log.Fatal(err) }
fmt.Println(current.Enabled)

disabled, err := box.SSH().Disable(ctx)
if err != nil { log.Fatal(err) }
fmt.Println(disabled.Enabled, disabled.Generation) // false, generation kept

enabled, err := box.SSH().Enable(ctx) // reuse saved configuration
if err != nil { log.Fatal(err) }
fmt.Println(enabled.Enabled) // true
```

`SSH` has no `Close`: it refers to its `Box` and shares the box's and
runtime's lifetime.

- **Lifecycle:** `Configure` replaces the whole configuration, restarts the
  listener, and may start the box. With `WithCmd` or `WithEntrypoint`, call
  `box.Start` first or `Configure` returns `ErrInvalidState`. `Status`, `Enable` and
  `Disable` never start the box. `Enable` requires a running box and saved
  configuration, works locally and over REST, and preserves healthy connections. On an idle local box, `Status` reports disabled
  with generation zero, and `Disable` returns `ErrInvalidState`. On a running
  box, `Disable` is safe to repeat and keeps the generation.
- **Keys:** the guest validates keys and stores them on the container disk. A
  rejected configuration returns `ErrInvalidArgument` without echoing key
  material. `%v`, `%+v`, `%s`, and `%#v` redact keys and CA values; JSON
  encoding of these types does not.
- **Errors:** a closed `Box` returns `ErrInvalidState`; a closed runtime
  returns `ErrRuntimeClosed`. Canceling the context returns promptly but does
  not undo a configuration the guest already applied, so do not retry
  `Configure` automatically.
- **Connecting:** SSH publishes no host port. Reach `ListenAddress`'s port
  with `WithPort(boxlite.PortSpec{Guest: 2222})` on a local runtime, or a
  [service tunnel](#service-tunnels) such as `network.Tunnel(ctx, &net.TCPAddr{Port: 2222}, boxlite.DefaultTunnelOptions())`.
- **Native library:** SSH needs a `boxlite.h` and native library that export
  `boxlite_box_ssh_configure`, `_enable`, `_status`, and `_disable`. `cmd/setup` fetches
  the pair matching your module version; an older library fails to link.

See the [SSH guide](../../docs/guides/ssh.md) for listener behavior,
authentication rules, and the HTTP contract.

## Development

Build from source (requires Rust toolchain):

```bash
# From the project root
make dev:go

# Run hosted unit and REST tests
make test:unit:go

# Run native archive preparation and round-trip tests on a VM-capable host
make test:integration:go
```

Nested-virtualization argument tests always check malformed tokens before native
host validation. Local-runtime tests normally skip `ErrUnsupported` when the host
cannot use KVM or Hypervisor.framework. Set
`BOXLITE_REQUIRE_NESTED_RUNTIME_TESTS=1` to make those constructor checks mandatory;
the Linux x86_64 CI metadata pass uses this setting after granting KVM access.
Host-independent SDK tests capture ordinary REST requests with empty, enabled
and invalid local feature ENV; all use server policy without adding a nesting field.
The Runner-only bridge is separately exercised through Go/C and the native
managed runtime, preserving authorization and each saved decision without booting a VM.

Native checkpoint archive tests use the production runtime constructor, which
validates KVM or Hypervisor.framework even when preparation does not start a VM.
They run in the `boxlite_integration` archive suite through the shared SDK
integration target and the VM-capable E2E workflow. Their ownership,
cancellation, late-completion cleanup and native import assertions stay enabled.
Hosted unit coverage continues to run checkpoint REST and argument tests.
The Linux native-binding coverage job also enables KVM and runs the existing
archive preparation ownership/cancellation cases through
`make coverage:go:checkpoint`. It uploads the Go profile with the native binding
reports; the full archive round-trip remains in the VM integration suite.
The collector links Rust's instrumented library and matching LLVM profile
runtime. A coverage-only integration test entry point flushes native counters
before Go exits, so the report includes the C ABI archive preparation path.
LLVM collection builds the C library in the collector's Cargo target directory
before compiling the tagged Go tests.

## License

Apache-2.0
