## TL;DR

This local copy of gvisor-tap-vsock v0.8.7 repairs TCP relay half-close handling without modifying the Go module cache.

## Provenance and maintenance

Copied from [containers/gvisor-tap-vsock v0.8.7](https://github.com/containers/gvisor-tap-vsock/tree/v0.8.7):
the complete `pkg/` tree, `go.mod`, `go.sum`, and `LICENSE`. Command binaries,
VM fixtures and other upstream files are omitted because the bridge imports
only packages. Retain upstream copyright and license notices.

The intentional changes are:

- `pkg/tcpproxy/tcpproxy.go`: transfer through BoxLite's stdlib-only
  `tcprelay`, forward `Conn.CloseWrite`, and retain a legacy transfer option.
- `pkg/services/forwarder/ports.go`: explicitly retain upstream behavior for
  SSH tunnels and named pipes. SSH channel closure does not guarantee that
  blocked I/O terminates, so these adapters cannot use the relay's close-and-join
  contract. Their preexisting cleanup limitations are outside this TCP fix.
- `go.mod`: add the local shared relay module.

The bridge's `go.mod` replaces the upstream module with this directory, so
direct Go tests and native builds use identical sources. Cargo watches this
directory and the shared relay for rebuilds. This is a local module replacement,
not Go's generated vendor tree; do not run `go mod vendor` here.

For an upgrade, compare these three files against the new pinned upstream,
retain only necessary changes, and run `make test:unit:gvproxy` from the
repository root. Regressions cover unrestricted egress, IP/CIDR egress,
inspected hostname passthrough, TCP mappings and UNIX-to-TCP mappings.
