# Hosted platform

The services under [`apps/`](../../../../apps/README.md) form BoxLite's hosted control plane and
runner data plane. This section documents what spans several of those services: how they fit
together, the interfaces between them, and the data they share. Each service's own internals stay
in its README under `apps/`.

## Architecture

The dashboard, API, proxy, collector, and runners are shared application components; how they map
onto a cloud depends on the stage's declared provider, and neither provider is preferred.

| Cloud | Guide                                                                        |
| ----- | ---------------------------------------------------------------------------- |
| AWS   | [Architecture and diagrams](../../../../apps/infra/docs/aws/architecture.md) |
| GCP   | [Architecture and diagrams](../../../../apps/infra/docs/gcp/architecture.md) |

Deployment, configuration, runner operations, networking, security, observability, and costs live
beside the infra code; start at the [infrastructure index](../../../../apps/infra/README.md).

## Pages

- [Service interfaces](api.md): the categorized inventory of every application interface, with its
  method, path, owning service, and purpose, plus outbound events, static asset trees, the local
  development stack, and APIs whose clients live here but whose routes are served elsewhere.
- [Data model](schema.md): the control-plane Postgres schema, with every table's columns, keys, and
  indexes, how the tables relate and which relationships the database enforces, and the satellite
  stores beside it.

A migration, entity, or route change updates `schema.md` or `api.md` in the same pull request.
