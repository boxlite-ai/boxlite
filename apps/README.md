## TL;DR

The API, proxy, collector and VM runners form BoxLite's cloud platform on AWS or GCP.

# BoxLite cloud applications

The applications under this directory form BoxLite's hosted control plane and
runner data plane. This view shows how public traffic reaches private services,
how the control plane schedules boxes, and where state and telemetry flow.

## Architecture

Choose the architecture for the stage's declared cloud; neither provider is preferred.

| Cloud | Guide |
| --- | --- |
| AWS | [Architecture and diagrams](infra/docs/aws/architecture.md) |
| GCP | [Architecture and diagrams](infra/docs/gcp/architecture.md) |

The [infrastructure index](infra/README.md) links deployment, configuration, runner operations,
networking, security, observability and costs. Follow the [deployment runbook](infra/docs/deployment.md)
for the intended cloud and deployment path.

## Service guides

- [`runner/README.md`](./runner/README.md) — the runner daemon: box lifecycle, execution and
  attach, files, and metrics.
- [`proxy/README.md`](./proxy/README.md) — the preview proxy: preview hosts, authentication, and
  tunnels to guest ports.

## API catalog

See [`API.md`](./API.md) for the categorized inventory of every application
interface, including its method, path, owning service, and purpose. Alongside
the registered routes it covers outbound events, static asset trees, the local
development stack, and the APIs whose clients live here but whose routes are
served elsewhere.

## Data model

See [`SCHEMA.md`](./SCHEMA.md) for the control-plane Postgres schema: every
table with its columns, keys, and indexes, how the tables relate and which of
those relationships the database enforces, and the satellite stores that sit
beside it.
