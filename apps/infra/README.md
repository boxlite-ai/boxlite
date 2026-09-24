## TL;DR

Start with the architecture graphs, then use the deployment guide and focused runbooks for your stage's cloud and deployment path.

# BoxLite infrastructure

BoxLite's cloud apps include the API/dashboard, proxy, VM runner fleet, collector, and supporting
state/storage services. The current tools are mstage, mbuild and mdeploy; a legacy AWS SST path
remains available. The guides describe source configuration and call out migration boundaries.

## Start here

| Task | Guide |
| --- | --- |
| Understand the system | [Architecture: overview, runtime, supporting services, AWS](docs/architecture.md) |
| Bootstrap, preview, apply and verify | [Deployment](docs/deployment.md) |
| Change stage settings or secrets | [Configuration](docs/configuration.md) |
| Build, update, verify or scale runners | [Runner operations](docs/runners.md) |
| Trace a request or connectivity failure | [Networking](docs/networking.md) |
| Inspect access and resource protection | [Security](docs/security.md) |
| Operate telemetry and ClickHouse | [Observability](docs/clickhouse.md) |
| Configure OIDC, Auth0, SMTP or branding | [Identity and mail](docs/identity-and-mail.md) |
| Operate the public status integration | [Status page](docs/status-page.md) |
| Estimate the complete GCP billing surface | [Cost catalog](docs/costs.md) |

## Tool references

- [mstage](mstage/README.md): identity, stage values, CI declarations and state recovery.
- [mbuild](mbuild/README.md): container publication, verification and promotion.
- [mdeploy](docs/mdeploy.md): cloud engines, inputs, intent and protection.
- [AWS bootstrap](bootstrap/aws/README.md): policy ownership and legacy naming boundaries.
- [Stable launchers](scripts/README.md): commands persisted in deployment state.
- [Auth0 assets](auth0/branding/ASSETS.md): hashes, licenses and publication contract.

## Deploy an existing stack

Follow [the deployment runbook](docs/deployment.md), including its AWS compatibility check.
A successful `npm run bootstrap` does not establish that every runtime prerequisite is present.

## Cloudflare API token

See [DNS credentials](docs/deployment.md#cloudflare-api-token) for scope and storage locations.

## Validate changes

Run from the repository root:

```bash
make test:apps:infra
make test:apps:infra-config
```

The first target typechecks tooling and runs the infrastructure suites. The second installs SST's
platform and typechecks the full configuration. For documentation-only edits, check local links,
anchors, Mermaid rendering and any existing documentation contracts; a cloud apply is not validation.
