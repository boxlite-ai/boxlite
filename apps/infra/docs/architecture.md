# Infrastructure architecture

`sst.config.ts` is the provider/app entrypoint. It dynamically imports the `stack/deployStack()`
facade because SST initializes providers before it evaluates the resource graph.

The intended declaration order is stable:

1. foundation: VPC, database, Redis, storage, cluster, and shared IAM setup
2. observability: Jaeger and OpenTelemetry
3. API: the control-plane API and its artifact selection
4. edge: Proxy, admin tools, CDN, DNS, and routing
5. runners: protected EC2 Runner instances, registration, and in-place binary updates

Operational code is grouped separately:

- `deployment/`: guarded SST execution, scope, config, and post-deploy verification
- `artifacts/`: API and Runner artifact identity, publication, and preflight
- `runner/`: inventory, state baselines, registration, and rolling updates
- `bootstrap/`: AWS/GitHub/Auth0 provisioning
- `shared/`: dependency-free utilities shared across domains
- `policies/runner/`: mandatory Pulumi Runner safety policy

Factories use ordinary functions and pass typed resource interfaces between layers. They do not
introduce Pulumi `ComponentResource` parents, so existing parent hierarchies and URNs remain stable.
