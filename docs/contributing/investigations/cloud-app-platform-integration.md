# Cloud Apps in the platform control plane

Cloud Apps use the existing cloud API, organization identity, PostgreSQL, resource services, and deployment pipeline. The first deployment targets the dev stage and provisions new Apps.

## Scope and contracts

- Add Apps after Boxes in the existing dashboard navigation; use its OIDC session and selected organization.
- Keep the CLI manifest, deployment workflow, Supervisor protocol, application authentication, and Neon project/branch capabilities.
- Store control-plane records in platform PostgreSQL and source objects in configured object storage. App databases remain on the official Neon API.
- Scope every App to a platform organization. Organization API keys authorize Apps through their existing resource permissions; resource creation still applies platform admission and organization state.
- Deploy through mstage, mbuild, and mdeploy. A platform worker owns deployment, schedule, and cleanup execution.

## Implementation

`CloudAppModule` owns the public Nest controllers and injects persistence, platform resources, credentials, and configuration into the App engine. Existing TypeScript route handlers may remain internal to the engine while the Nest boundary supplies platform authentication and organization scope. They do not start a second control-plane server or establish a second platform identity.

The management namespace is `/api/v1/:organizationId/apps`. Console projections use explicit view routes in that namespace; CLI deployment routes retain their manifest and error contracts. Internal Supervisor callbacks are separately authenticated with environment-scoped credentials. HTTP and WebSocket entry points apply equivalent scope checks.

### Organization API keys

Apps use the existing organization API keys without adding columns or indexes to `api_key`.
Creating an App returns its configuration and an initialization prompt without issuing a credential.
Key creation, revocation and expiry remain in the platform API Keys workflow; deleting an App does
not revoke organization keys. The App-specific key endpoints and controls are removed.

When `POST /api/api-keys` omits `permissions`, it requests all supported organization resource
permissions. Existing delegation and member-role checks still apply: a restricted caller must
request a permitted subset. Explicit permission arrays, including an empty array, retain their
meaning, and existing keys are not widened. The dashboard continues to select the permissions its
current user can delegate. The added Apps permission enum values remain available for explicit grants.

The CLI stores credentials by organization API URL. Login verifies the organization independently
of an App; project operations select an App explicitly or through the project link. A credential can
operate on multiple Apps in its organization. Management and application ingress reject credentials
from another organization, and application forwarding removes recognized platform credentials.
Agent prompts contain the organization API URL, CLI package URL and App name; users supply their
organization key through the existing login workflow.

Validation covers unchanged API-key table columns, permission defaults and explicit restrictions,
same-organization multi-App access, cross-organization rejection, credential-free App creation and
deletion, and CLI login and deployment with an explicitly selected App.

PostgreSQL repositories replace synchronous SQLite access. Platform migrations create App tables and their organization associations. Deployment allocation and idempotency are transactional. Workers poll PostgreSQL and hold renewable Redis leases while publishing each environment. Worker ownership expires or is released on shutdown, and starting an API instance never fails another instance's deployment.

Neon project creation locks the owning App row and rechecks the project reference, so environments first provisioned by different workers share one project. Project references commit before branch provisioning. Supervisor callbacks, deployment events and screenshots are persisted in PostgreSQL; workers and API replicas can read each other's results. Runtime replacement deletes the old Box, and final App purge removes the source namespace before deleting its database records.

An environment has a stable hostname bound through the platform Domain model. The proxy resolves an App target and forwards HTTP and WebSocket traffic to the API's AppGateway. The gateway retains App access, OAuth/session and identity behavior and forwards to a private Box tunnel. Proxy service credentials and application Authorization remain separate. Tunnel credentials and Supervisor secrets remain server-side.

Neon keys, organization and region, platform/app OAuth, SMTP, signing/session secrets, runtime images and artifact URLs come from typed configuration. Dynamically created App credentials are persisted using platform encryption and injected into the relevant runtime. Frontend configuration contains only public values.

## Reuse and trade-offs

The baseline is main `4ad1423bd1511f15a4d22f44fd3cd95a60706fe1`; the feature source is `bd04f20b65412a0fc3faad041edb8b52898461d0`.

Existing `BoxService`, `VolumeService`, organization guards, encryption service, Redis leases and job claiming patterns provide the platform integration points. App Box creation preserves the commerce admission limit used by `BoxliteBoxController`. Domain bindings resolve App environment targets through the shared proxy.

The first ingress includes an API forwarding hop to preserve the existing TypeScript authentication behavior. App builds continue inside their environment Box. Independent build pools, multi-replica application serving, cross-Box release rollback and detailed Neon billing are subsequent capabilities.

The existing platform uses TypeORM 0.3.31, PostgreSQL and ioredis. PostgreSQL's [row locking](https://www.postgresql.org/docs/18/sql-select.html#SQL-FOR-UPDATE-SHARE) supports transactional queue claiming. [Neon's official project API](https://neon.com/docs/reference/api/projects/create-project) retains the current provider contract. [Cloud Run CPU allocation](https://docs.cloud.google.com/run/docs/configuring/billing-settings) requires an explicit hosting decision for background work; request handling alone does not provide a persistent worker.

## Validation and rollout

1. Repository tests verify organization isolation, organization credential permissions, atomic deployment allocation, callbacks and worker recovery against actual production services/repositories.
2. PostgreSQL integration tests use an isolated schema in the provided test database; resource/provider tests keep network effects explicit.
3. Dashboard checks cover navigation, selected-organization requests and late responses after organization switching.
4. API and proxy checks cover App domain routing, access decisions, application Authorization preservation and WebSocket upgrades.
5. Production builds include the shared engine, CLI and Supervisor artifacts. Stage configuration checks verify required secrets and object permissions without printing secret values.
6. Dev smoke creates an App, deploys a database-backed example, opens it, deploys an update, restarts the control plane, and removes its resources. Existing Box operations remain available.

An existing-data import is separate from feature integration. Migration and deployment failures retain their actual status; successful local builds do not establish a successful cloud deployment.
