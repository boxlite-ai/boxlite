# BoxLite Go SDK

Go SDK for BoxLite — an embeddable virtual machine runtime for secure, isolated code execution.

Access the [agent API](../../docs/reference/agents.md) through `Box.Agents()`
for session and turn methods, grouped options and error handling.

**Upgrade notice:** existing local boxes with secrets must be recreated with explicit
`headers`, including boxes managed by `boxlite serve`. See the
[required-headers migration notes](../../docs/reference/configuration.md#secrets).

## Install

```bash
go get github.com/boxlite-ai/boxlite/sdks/go
go run github.com/boxlite-ai/boxlite/sdks/go/cmd/setup
```

Requires Go 1.24+ with CGO enabled. The setup step downloads the prebuilt native library and header into the module directory in your Go module cache (one-time). Set `GITHUB_TOKEN` to avoid API rate limits.

## Usage

### Managed checkpoints

Only `WithName` may accompany `WithCheckpoint`, including when another option
has its default value: `WithDetach(false)` and `WithMemory(0)` reject before
creating native options. An explicitly empty checkpoint selector also rejects.

A checkpoint is a source for a new box, like an image: pass it to the ordinary
create call. The checkpoint handle only manages checkpoints. Archive import is a
separate operation for local `.boxlite` files and is unchanged. The CLI form is
`boxlite create --checkpoint ID [--name NAME]`.

`Create` captures a disk checkpoint from a stopped box. With
`CreateWithOptions(ctx, source, name, opts)`, set `opts.Kind` to a
`CheckpointKind`: leave it empty or use `CheckpointKindDisk` for disk capture.
Use `CheckpointKindFull` to capture disk, guest memory, and VM state from a
running box. Full capture checks `capabilities.memory_checkpoints_enabled`
through `GET /v1/config` before submitting the capture. If the server omits or
disables the capability, the call returns `ErrUnsupported`. Disk capture skips
the preflight.

On REST runtimes, `runtime.Checkpoints()` exposes `Create`, `CreateWithOptions`,
`List`, `Get`, and `Remove`, each taking a context. The handle follows its runtime's
lifetime and needs no separate close. Captured archives survive source deletion.

```go
checkpoint, err := runtime.Checkpoints().CreateWithOptions(ctx, "source", "dev-base",
    boxlite.CheckpointOptions{Kind: boxlite.CheckpointKindFull})
if err != nil { return err }
worker, err := runtime.Create(ctx, "", boxlite.WithCheckpoint(checkpoint.ID), boxlite.WithName("worker"))
if err != nil { return err }
defer worker.Close()
```

`CheckpointInfo.Kind` reports the archive kind, including `"unknown"` for an
unrecognized server kind. `CheckpointInfo.MemorySizeBytes` is a pointer to the
archived guest memory size and is `nil` when the server omits it. A reported
zero comes back as a pointer to zero.

Pass an empty image with `WithCheckpoint`; combining it with an image or
`WithRootfsPath` returns an error.

Cloud capture may report `creating`; query until `ready` before use. A box created
from a checkpoint inherits all saved execution settings; any other option is
refused with an invalid-argument error. `Remove(ctx, key, true)` ignores absence
only. Local runtime checkpoint operations return an unsupported-operation error.
Storage belongs to the server. Existing native archive
export/import and the runner's archive preparation helper remain available.

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
			Headers: map[string]string{"Authorization": "Bearer {value}"},
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

### Streaming file uploads

`CopyInStream` accepts a raw tar reader and defaults to replacing existing files.
Pass `WithCopyOverwrite(false)` to add only new entries:

```go
err := box.CopyInStream(ctx, "/app", tarReader,
    boxlite.WithCopyOverwrite(false))
```

Existing directories are reused. A conflicting file, symlink or incompatible
file/directory entry returns `ErrAlreadyExists` and retains existing contents.
Entries written before a conflict can remain; there is no archive rollback.
The existing call without an option retains `overwrite=true`.

Directory metadata is retained only for directories that existed before the
upload. A directory created by an earlier archive entry still receives its own
later header's permissions. Go `CopyOut` currently has no overwrite option and
cannot request protected downloads.

A local runtime treats the archive as trusted because local applications own
both the runtime and archive. A REST runtime uploads the file and relies on the
server's untrusted-upload policy.

Export and Import never delete the archive. The caller owns its retention and
must explicitly remove it when it is no longer needed.

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
- `WithSecret(boxlite.Secret{...})` injects a secret into outbound HTTPS requests to required `Hosts`; `Placeholder` defaults to `<BOXLITE_SECRET:{Name}>`. Set `Headers: map[string]string{"x-goog-api-key": "{value}"}` for a custom template. `Headers` is required; nil and empty maps are rejected.
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
  `Disable` never start the box. `Enable` requires saved configuration, works
  locally and over REST, and preserves healthy connections. `Enable` and `Disable`
  require a running box; a valid handle to a configured or stopped box returns
  `ErrInvalidState` (HTTP 409 over REST) without changing saved SSH intent. On such
  a local handle, `Status` reports disabled with generation zero. On a running box,
  `Disable` is safe to repeat and keeps the generation. Call `Disable` while
  running to persist the disabled switch.
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

## Threading

A `Box` is safe for concurrent use by multiple goroutines. Each native call
holds a shared lock on the box handle for the duration of its synchronous C
submission; `Close` takes the exclusive lock, waits for those submissions to
finish, then frees the handle exactly once. `Close` is idempotent. Methods
called after `Close` — or racing a finishing `Close` — return an
`ErrInvalidState` error ("box is closed"). Closing does not destroy the box;
the box keeps running in the runtime.

## Development

Agent record conversion uses the [shared JSON mapping](../../docs/reference/agents.md#go-json-mapping).
The fixture in `testdata/agents.json` comes from the Rust core's record functions;
the Rust test checks it for drift and the Go tests check conversion against it.
Agent calls, getters and subscriptions reach the C SDK and Rust core.
Open events before sending; `Events` returns only after connection. Streams allow
one `Next` reader and bound buffered JSON to 64 events/4 MiB; overflow preserves
the accepted prefix and ends with `ErrResourceExhausted`. Stream `Close` is
non-blocking and does not interrupt work. See [Go event streams](../../docs/reference/agents.md#go-event-streams).

`Box.Agents()` acquires its native namespace on first use. Agent and turn wrappers
must not be copied after first use; `Runtime.Close` releases all their native handles.
`Agent.Close` requests the core close operation, which may return `ErrUnsupported`;
it does not free the local handle. Canceling a context stops the wait without
canceling submitted work. Canceling an `AgentTurn.Wait` also releases its native
observer while other waits on the same turn continue. See [Go ownership and cancellation](../../docs/reference/agents.md#go-json-mapping).

The Go unit and coverage targets build the C SDK with its `test-support` feature and add
the `boxlite_agent_test` Go build tag. These tests cross the real C/core boundary
using a deterministic backend, without a VM. Normal `make dev:go` builds exclude
these test entry points; hosted tests do not verify OpenCode in a real VM.

```bash
make test:unit:go FILTER=Agent
make test:unit:rust FILTER=go_json_fixture_matches_core_records
# Race checks for agent calls, streams and ownership
make test:unit:go FILTER=Agent RACE=1
```

After an intentional core format change, regenerate the fixture with
`BOXLITE_UPDATE_AGENT_FIXTURES=1 make test:unit:rust FILTER=go_json_fixture_matches_core_records`,
then review the JSON diff and rerun both suites.

Build from source (requires Rust toolchain):

```bash
# From the project root
make dev:go

# Run hosted unit and REST tests
make test:unit:go

# Run native archive import/export tests on a VM-capable host
make test:integration:go
```

Native archive import/export tests use the production runtime constructor and
require a VM-capable host, even when the test does not start a VM.
The Linux native-binding coverage job runs the no-VM import/export cases through
`make coverage:go:checkpoint` and flushes the instrumented native counters before
Go exits. Full VM archive round-trips remain in the integration suite.

## License

Apache-2.0

### Nested virtualization at creation

Configure `AdvancedBoxOptions.SetNestedVirtualization(true)` and pass the handle
through `WithAdvancedOptions` to create a nested Box. The runtime must explicitly
authorize `nested-virtualization` using `WithExperimentalFeatures`. The existing
runtime create operation saves the option; `Box.Start(ctx)` keeps that saved value.

Runner reads its feature ENV at startup and chooses this creation option only for
eligible Cloud requests on supported hosts. This adds no start options or change
to default local creation. Changing organization policy affects future creates.

Local agent VM acceptance uses the same scripted model and OpenCode 2.2.2 binary
as the C/Rust tests, comparing normalized results, usage and first-event
identity relationships. It checks unsupported operations, getters and a running
turn completing after its local handle is released. It is outside hosted CI.

```bash
BOXLITE_TEST_OPENCODE_BINARY=/absolute/path/to/linux/opencode make test:integration:go:agents
```

The target builds C and Go callers, then runs the Rust comparison harness.
The OpenCode binary must match the VM architecture and use glibc Linux; the
Debian test image, VM support and complete runtime artifacts must be available.

### Agent VM parity with Rust

`make test:integration:go:agents` runs the three-language result comparison and
Go equivalents of all 15 cases in
[`agents_opencode.rs`](../../src/boxlite/tests/agents_opencode.rs).
`TestGoAgentVMParity` uses the Rust test names as Go subtest names, so a failed
scenario can be traced directly to its source contract.

| Rust VM scenario | Go assertions |
|---|---|
| Concurrent creates, send/events/wait | One registered service, configuration, matching turn event, lookup through another handle |
| Old turn beyond the first history page | Thirty turns outgrow the 50-message page; the first turn remains readable |
| Restart with running and queued turns | Reacquire the Box and agent; both original turns complete |
| Foreign server on the agent port | `ErrInvalidState` identifies the occupied port |
| Missing OpenCode binary | `ErrExecution` identifies the required version |
| User-owned ready or frozen service | Refuse takeover; preserve the service URL and PID |
| Stale service registration | Recover the service without signalling the unrelated PID |
| Environment reads and questions | `.env.example` is readable, `.env`/`.env.local` stay secret, denied questions do not block later work |
| Frozen BoxLite service | Report unresponsiveness; after thawing, reuse its PID |
| Remote service configuration | Refuse local startup and leave no local registration |
| Delivered binary outside the image PATH | Agent runs from a read-only mount without adding an image executable |
| Repeated installation | Reuse a single mount |
| Installation after a failed file lookup | The new executable becomes visible on the existing mount |
| Restart of a delivered agent | First Go lookup restores its recorded mount |
| Failed mount after restart | Surface the error, keep the VM running, and retry after removing the blocker |

The five installation scenarios use a `test-support` C fixture that calls the
existing Rust-only `install_from_host` setup method. It is excluded from
`boxlite.h` and normal builds; it adds no Go installation API. Subsequent agent
calls, visibility checks and restart recovery use the real Go SDK and VM.

The security cases observe the shared model's reply, which includes `SECRET`
only when a tool actually returned it. Service assertions inspect the guest's
registration and process state. These tests run outside hosted CI and require
the same complete runtime artifacts and OpenCode binary as the comparison.

For a scenario-only rerun, use `make test:integration:go:agents:parity` with the
same binary/runtime environment. `BOXLITE_GO_AGENT_VM_FILTER` optionally selects
a Go test/subtest pattern; omit it for the complete 15-scenario matrix.
