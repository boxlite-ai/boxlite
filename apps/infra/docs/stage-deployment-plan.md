# Deploy stage alongside dev

Stage runs dedicated application resources in the existing development GCP
project. It follows dev's existing capabilities; production version admission
and the existing dev-to-prod path remain unchanged.

## Deployment contract

| Concern | Stage behavior |
| --- | --- |
| Applications | BoxLite platform, Backoffice and Commerce |
| GCP placement | Development project, `us-east5`, separate stage resource names and state |
| Deployment entry | Each repository's existing `mdeploy-all` workflow |
| Candidate refs | Commits and PR merge candidates, with workflow code from `main` |
| Production promotion | Explicit `dev` or `stage` source; no required dev-to-stage hop |
| Customer identity | Dedicated stage Auth0 tenant and customer database |
| Employee identity | Dedicated stage employee Auth0 tenant |
| Payments | Dedicated Stripe sandbox, separate webhook destination and signing secret |
| Deployment evidence | Existing dev subsystem only; no new platform Pub/Sub publisher |

Example: deploy a candidate to stage, publish its released images there, then
select `source=stage` for a production release. Platform and Commerce retain
stable published-release admission; Backoffice retains its own tag/commit policy.
Promoting a source does not relax production approval or confirmation gates.

## 1. Prepare the project and declarations

1. Declare `stage` beside `dev` and `prod` in each application's local mstage
   configuration, using the development project and `us-east5`.
2. Use distinct stage registries, state, secret names, networks and databases;
   project IAM, enabled APIs, quotas and billing remain shared.
3. Run the existing bootstrap for each application and configure its GitHub
   `stage` Environment, federation settings and stage declaration.
4. Retain production Environment protection and the existing workflow branch
   restrictions; stage workflows run from `main`, even when deploying PR code.

Apply the compatible workflow/parser changes to `main` before publishing a
multi-source declaration to a live Environment. Platform and Backoffice accept
`promoteFrom: ["dev", "stage"]`. Commerce's currently vendored shared parser
accepts a single source string; do not write an array there or edit the vendored
digest to hide drift. Its workflow can select either source independently;
ensure production's publisher has read access to the selected source registry.
An upstream shared-tool update is required before Commerce can bootstrap both
sources from one array declaration.

## 2. Configure identity and external services

1. Configure the customer stage Auth0 tenant and application for the stage
   dashboard/API URLs, including callback, logout, origin and API audience.
2. Configure the independent employee stage tenant, Backoffice application,
   API permissions, roles and existing login Actions.
3. Configure the customer custom domain, DNS verification, email provider and
   existing login policy using the [identity guide](identity-and-mail.md).
4. Create stage Stripe sandbox credentials and its webhook configuration;
   configure application mail and GitHub App callbacks needed by stage.

Do not copy production credentials or customer data. Auth0 dashboard login does
not establish CLI authorization; use the intended tenant for each operation.
Keep secret values in the existing encrypted stage configuration, never in Git.

## 3. Configure application endpoints and secrets

Replace dev hostnames with their stage equivalents, including
`stage.boxlite.ai`, `api.stage.boxlite.ai` and `proxy.stage.boxlite.ai`.
Configure `PROXY_DOMAIN` with the proxy hostname and explicitly select HTTPS
where the public endpoint uses TLS; container-side TLS is a separate setting.

Use each application's existing environment schema for database, Redis,
ClickHouse, internal authentication, signing and encryption secrets. Generate
independent stage values where the setting identifies or protects stage data.
Set Backoffice's platform environment to `stage`, GCP location to `us-east5`,
runtime to `cloud-run`, and inventory labels to `{"stage":"stage"}`.
The service label scopes discovery; it does not restrict IAM.

Backoffice and Commerce need their stage platform and OAuth coordinates.
Validate the selected config revision through the normal preview path rather
than copying encrypted state between applications or environments.

## 4. Preview and deploy the main platform

1. Run `mdeploy-all` from `main` with `stage=stage`, the intended ref and
   `components=api+runner`; start with `apply=false`.
2. Inspect the plan for stage names, image selectors and project/region;
   shared dev/prod resource replacements are not an expected stage creation.
3. Run the same workflow with `apply=true` and any required confirmation.

The workflow prepares required images and Runner artifacts before applying the
stack. A preview can therefore prepare artifacts, but does not create the stage
runtime. A successful preview is not proof of service readiness.

Self-hosted ClickHouse uses the existing PSC publication:

```text
Main platform ClickHouse
  <- internal load balancer / PSC service attachment
  <- Backoffice private PSC endpoint
  <- HyperDX and authorized log queries
```

The producer attachment is `boxlite-app-stage-clickstack`; Backoffice discovers
it and the reader-secret references using the main platform's stage coordinates.
The optional `CLICKSTACK_CONSUMER_ACCOUNT` can remain absent during the initial
platform apply, before the Backoffice identity exists. If that optional grant is
needed, read the actual identity after Backoffice creates it, update the setting
and configuration digest, then use normal platform preview/apply to grant access.
Backoffice owns its existing HyperDX/API reader permissions.

## 5. Preview and deploy Commerce and Backoffice

1. Use each repository's `mdeploy-all` to prepare artifacts and preview stage;
   preserve its existing source verification and deployment gates.
2. Deploy Commerce with stage payment credentials and the existing platform
   integration; complete the normal schema/migration steps.
3. Deploy Backoffice after the private ClickHouse publication exists;
   preserve its schema-bootstrap job, projection worker, queue and DLQ resources.

Backoffice uses separate `bo-stage-schema-bootstrap` and
`bo-stage-projection-worker` names within the shared project. Its existing
producer and consumer configuration remains required; this stage work adds no
platform event publisher. An infrastructure apply alone does not prove an event
was produced or projected into the Backoffice database.

## 6. Verify runtime behavior

| Check | Required observation |
| --- | --- |
| Public endpoints | Stage DNS/TLS and application health succeed |
| Customer identity | Stage signup/login and corresponding database records agree |
| Employee identity | Backoffice login and role-based access work in the stage tenant |
| Box lifecycle | Stage API creates, accesses and deletes a box |
| Private ClickHouse | PSC reports `ACCEPTED`, then an authorized real query succeeds |
| Commerce | Sandbox payment/webhook reaches stage and updates the intended records |
| Inventory | Stage services appear under the configured location/label filter |
| Existing projection | When its existing producer emits an event, the worker updates the stage database |

The existing `e2e-cloud` workflow accepts stage with explicit
`BOXLITE_STAGE_API_URL` and independent `BOXLITE_STAGE_API_KEY`,
`BOXLITE_STAGE_P2_API_KEY`, and `BOXLITE_STAGE_P2_READONLY_API_KEY`.
The helper refuses missing stage coordinates, target overrides and known dev/prod
API origins before requests. Stage runs the main suite and identity lane;
automatic sweeping and the shared-subdomain fixture remain dev-only.
Production retains its single-profile smoke selection.

## 7. Exercise promotion and rollback

Publish a stable release to the chosen source and select that source explicitly
for production. Keep existing production admission, image verification,
approvals and protected-apply confirmation. If selected source artifacts are
missing, prepare them in that source rather than rebuilding in production.
The main platform retains its existing no-op path when destination artifacts
already exist; it does not revalidate their selected source on that path.

Rollback uses each application's existing workflow with previously retained
artifacts and the intended configuration revision. Database migrations and data
recovery follow the application's own rollback policy; selecting an older image
does not reverse data changes.
