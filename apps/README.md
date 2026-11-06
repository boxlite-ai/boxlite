## TL;DR

The API, proxy, collector and VM runners form BoxLite's cloud platform on AWS or GCP.

# BoxLite cloud applications

The applications under this directory form BoxLite's hosted control plane and
runner data plane. How they fit together, the interfaces between them, and the
data model they share are documented in
[`docs/contributing/architecture/platform/`](../docs/contributing/architecture/platform/README.md).

## Service guides

- [`api/README.md`](./api/README.md) — the control-plane API: business events and the
  operation context that records who asked.
- [`runner/README.md`](./runner/README.md) — the runner daemon: box lifecycle, execution and
  attach, files, and metrics.
- [`proxy/README.md`](./proxy/README.md) — the preview proxy: preview hosts, authentication, and
  tunnels to guest ports.
- [`image-service/README.md`](./image-service/README.md) — the registry proxy: how a runner pulls
  an image whose registry credentials only the platform holds.
- [`infra/README.md`](./infra/README.md) — deployment, configuration, runner operations,
  networking, security, observability, and costs for each cloud.
