# BoxLite infrastructure

SST deploys the BoxLite control plane to AWS and configures its Cloudflare edge. The package is
organized by operational domain; each command enters one domain facade and `sst.config.ts` loads
the stack facade.

```text
npm command -> domain CLI -> deployment facade -> SST -> stack/deployStack()
            -> foundation -> observability -> API -> edge -> runners
```

## Start here

- [Architecture](docs/architecture.md) — resource graph and source layout
- [Deployment](docs/deployment.md) — prerequisites, bootstrap, preview, deploy, artifact modes, routine commands, and troubleshooting
- [Security](docs/security.md) — credentials, policy enforcement, and protected resources
- [Networking](docs/networking.md) — VPC layout and traffic flows

Use the repository make targets for validation:

```bash
make test:apps:infra
make test:apps:infra-config
```

Never apply a preview merely to validate configuration. All deploys require an explicit stage and
run through `deployment/sst.ts`, which loads provider credentials, enforces scope and Runner
policies, cleans Pulumi event logs, and performs post-deploy verification.
