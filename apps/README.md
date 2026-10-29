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

- [`api/README.md`](./api/README.md) — the control-plane API: business events and the
  operation context that records who asked.
- [`runner/README.md`](./runner/README.md) — the runner daemon: box lifecycle, execution and
  attach, files, and metrics.
- [`proxy/README.md`](./proxy/README.md) — the preview proxy: preview hosts, authentication, and
  tunnels to guest ports.
- [`image-service/README.md`](./image-service/README.md) — the registry proxy: how a runner pulls
  an image whose registry credentials only the platform holds.

## Testing

Run `make test:apps` from the repository root with PostgreSQL and Redis available.
Use disposable services: integration tests create database objects and may clear
Redis data. Set `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE`,
`REDIS_HOST`, and `REDIS_PORT` to select those services.

The matrix builds the Go SDK dependency and runs infrastructure checks, then runs
API suites serially through `make test:apps:api`. These suites share PostgreSQL;
a concurrent index build can wait on another suite's transaction even when the
suites use different schemas. The remaining Nx projects run in parallel after
the API suites finish.

By default, an API failure still allows the remaining projects to run, and either
group's failure makes the matrix fail. Use `FAIL_FAST=true` to stop after an API
failure, or `FILTER=<pattern>` to select test names with each runner's existing
filter behavior.

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
