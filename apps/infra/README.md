# BoxLite infrastructure

BoxLite's hosted apps include the API/dashboard, proxy, VM runner fleet and collector.
Each cloud has its own architecture and operational procedures; the shared tools are mstage, mbuild and mdeploy.

## Choose a cloud

| Task | [AWS guide](docs/aws/README.md) | [GCP guide](docs/gcp/README.md) |
| --- | --- | --- |
| Understand the system | [Architecture](docs/aws/architecture.md) | [Architecture](docs/gcp/architecture.md) |
| Bootstrap and deploy | [Deployment](docs/aws/deployment.md) | [Deployment](docs/gcp/deployment.md) |
| Operate runners | [Runner operations](docs/aws/runners.md) | [Runner operations](docs/gcp/runners.md) |
| Trace connectivity | [Networking](docs/aws/networking.md) | [Networking](docs/gcp/networking.md) |
| Inspect access | [Security](docs/aws/security.md) | [Security](docs/gcp/security.md) |
| Operate telemetry | [ClickHouse](docs/aws/clickhouse.md) | [ClickHouse](docs/gcp/clickhouse.md) |
| Configure identity/mail | [Identity and mail](docs/aws/identity-and-mail.md) | [Identity and mail](docs/gcp/identity-and-mail.md) |
| Estimate costs | [Costs](docs/aws/costs.md) | [Costs](docs/gcp/costs.md) |

## Shared references

- [Configuration and secrets](docs/configuration.md), [deployment commands](docs/deployment.md) and [runner artifact commands](docs/runners.md).
- [mstage](mstage/README.md): identity, stage values, CI declarations and state recovery.
- [mbuild](mbuild/README.md): container publication, verification and promotion.
- [mdeploy](mdeploy/README.md): engine selection, inputs, intent and protection.
- [Release runbook](docs/release.md): tag a version, publish its application images and roll it out to prod.
- [Observability configuration](docs/clickhouse.md), [Auth0 login and branding](docs/identity-and-mail.md), and [status page](docs/status-page.md).
- [Stable launchers](scripts/README.md) and [Auth0 assets](auth0/branding/ASSETS.md).

## Deploy an existing stack

Follow the selected cloud's deployment guide before the [shared preview/apply workflow](docs/deployment.md#deploy-an-existing-stack).
A successful `npm run bootstrap` does not establish that every runtime prerequisite is present.

## Cloudflare API token

See [DNS credentials](docs/deployment.md#cloudflare-api-token) for token scope and the cloud guides for storage destinations.

## Validate changes

Run from the repository root:

```bash
make test:apps:infra
make test:apps:infra-config
```

The first target typechecks tooling and runs the infrastructure suites. The second installs SST's
platform and typechecks the full configuration. For documentation-only edits, check local links,
anchors, Mermaid rendering and existing documentation contracts; a cloud apply is not validation.
