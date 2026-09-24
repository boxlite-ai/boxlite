## TL;DR

Choose a cloud architecture guide; each keeps its diagrams and resource relationships together.

# Infrastructure architecture

[Infrastructure index](../README.md)

| Cloud | Guide |
| --- | --- |
| AWS | [Architecture and diagrams](aws/architecture.md) |
| GCP | [Architecture and diagrams](gcp/architecture.md) |

The dashboard, API, proxy, collector and BoxLite runner/runtime are shared application components.
Their cloud hosting, network paths and billing resources belong to the selected guide.

## Source ownership

| Responsibility | Source |
| --- | --- |
| Stage configuration, identity, encrypted environment and state access | [`mstage/`](../mstage/README.md) |
| Container build, verification and promotion | [`mbuild/`](../mbuild/) |
| Deploy intent and cloud engine selection | [`mdeploy/src/run.ts`](../mdeploy/src/run.ts), [`deploy.ts`](../mdeploy/src/deploy.ts) |
| Resource composition and provider interfaces | [`mdeploy/stack/`](../mdeploy/stack/) |
| Runner build, promotion and in-place updates | [`mdeploy/src/`](../mdeploy/src/) |
| Account/project bootstrap and federated CI identity | [`bootstrap/`](../bootstrap/) |
