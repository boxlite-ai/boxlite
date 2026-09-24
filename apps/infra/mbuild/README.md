## TL;DR

mbuild publishes, verifies, and promotes the container artifacts declared by mstage.

# mbuild reference

[Infrastructure index](../README.md) · [Deployment](../docs/deployment.md) · [Configuration](../docs/configuration.md)

Run from `apps/infra`. Bootstrap the registry and sign in before commands that contact it.
The three declared artifacts are `api` (including dashboard), `proxy`, and `otel-collector`.
Runner binaries use the separate [runner commands](../docs/mdeploy.md).

## Commands

```bash
npm run mbuild inspect -- --stage dev
npm run mbuild publish -- --tag <full-commit-sha> --stage dev
npm run mbuild verify -- --tag <full-commit-sha> --stage dev
npm run mbuild promote -- --tag <full-commit-sha> --from dev --to prod
```

| Option | Effect |
| --- | --- |
| `--artifact api` | Select one declared artifact; omission selects all |
| `--version vX.Y.Z` | Address the release build `vX.Y.Z-<sha>` instead of the commit build `<sha>` |
| `--stage` | Select publication/verification destination |
| `--from`, `--to` | Select promotion source and destination |

`inspect` prints registry kind, region, repository and artifact names without resolving cloud identity.
`publish` builds from the current checkout; the tag is an identity, not a checkout command.
Use the deployment workflow to resolve a ref and prepare the matching source tree.
`verify` prints `artifact=address` results and does not build missing images.

## Registry and promotion boundaries

| Stage home | Registry | Coordinates |
| --- | --- | --- |
| GCP | Artifact Registry | Declared project, region and repository |
| AWS | ECR | Account from credentials, declared region and repository |

Promotion copies existing image bytes within one registry kind. Cross-cloud promotion is refused.
The caller needs source read and destination write access; `promoteFrom` lets bootstrap prepare
those permissions. On AWS, the current CLI uses one resolved account for both registry addresses.

Image publication and the stage's scan policy are separate checks. Already-published artifacts
are verified instead of blindly overwritten. Release images carry a version-qualified address,
so a commit build is not interchangeable with the release build from the same SHA.

## Exit codes

| Code | Meaning | Response |
| --- | --- | --- |
| `0` | Requested operation succeeded | Continue to the next deployment check |
| `66` | Required artifact is absent | Publish or promote the intended artifact |
| `78` | Scan policy refused the artifact | Resolve the finding or review the policy |
| Other nonzero | Command, authentication, network or input failure | Read the error; do not treat it as absence |

## Implementation and verification

The CLI is [`bin/mbuild.ts`](bin/mbuild.ts). Addressing lives in [`src/address.ts`](src/address.ts),
configuration in [`src/config.ts`](src/config.ts), and publication in [`src/publish.ts`](src/publish.ts).
The reusable [mbuild workflow](../../../.github/workflows/mbuild.yml) is called by
[mdeploy-all](../../../.github/workflows/mdeploy-all.yml); release publication uses
[mbuild-release](../../../.github/workflows/mbuild-release.yml).

Run `make test:apps:infra` from the repository root for tooling typechecks and tests.
