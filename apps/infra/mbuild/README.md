## TL;DR

mbuild publishes, verifies, and promotes the container artifacts declared by mstage.

# mbuild reference

[Infrastructure index](../README.md) · [Deployment](../docs/deployment.md) · [Configuration](../docs/configuration.md)

Run from `apps/infra`. Bootstrap the registry and sign in before commands that contact it.
The four declared artifacts are `api` (including dashboard), `proxy`, `otel-collector`, and `registry-proxy`.
Runner binaries use the separate [runner commands](../docs/runners.md).

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

### Release images in GHCR

The GHCR release commands publish images independently of dev/prod cloud credentials:

```bash
npm run mbuild publish -- --tag <full-commit-sha> --version vX.Y.Z --ghcr boxlite-ai/boxlite
npm run mbuild verify -- --tag <full-commit-sha> --version vX.Y.Z --ghcr boxlite-ai/boxlite
npm run mbuild import-release -- --tag <full-commit-sha> --version vX.Y.Z --ghcr boxlite-ai/boxlite --stage prod
```

The address is `ghcr.io/<owner>/<repository>/<artifact>:vX.Y.Z-<full-sha>`.
Artifact names and tags match Artifact Registry's layout; GHCR has no stage suffix.
Set `GHCR_USERNAME` and `GHCR_TOKEN`, or use `GITHUB_ACTOR` and `GH_TOKEN` in Actions.
Publishing needs package write access; verification/import needs package read access.
`publish` and `verify` with `--ghcr` read the artifact declaration without a cloud stage file.
For publication, use `MSTAGE_ENV_CONFIG` to select the release source's declaration and build context.
`import-release` imports and verifies the artifacts required by its current declaration;
an older release lacking a required artifact fails this import.

Publication audits dependencies and reuses existing images without overwriting them.
Retry a partial publication to build only missing artifacts; success requires every selected image to exist.
Import checks all source manifests before destination writes, pulls immutable source digests,
refuses conflicting destination images, and verifies the copied manifest digest.
Only single-platform OCI and Docker schema 2 manifests are supported; indexes are refused.
GHCR publication pushes `linux/amd64` explicitly and requires Docker API 1.46 or later.
GHCR image scanning runs after import, using the receiving stage's existing scan policy.
Confirmed missing manifests exit `66`; authentication, transport and other registry errors fail separately.

Stage-to-stage promotion copies existing image bytes within one cloud registry kind. Cross-cloud promotion is refused.
The caller needs source read and destination write access; `promoteFrom` lets bootstrap prepare
those permissions. On AWS, the current CLI uses one resolved account for both registry addresses.

Image publication and the stage's scan policy are separate checks. Already-published artifacts
are verified instead of blindly overwritten. Release images carry a version-qualified address,
so a commit build is not interchangeable with the release build from the same SHA.

## Exit codes

| Code | Meaning | Response |
| --- | --- | --- |
| `0` | Requested operation succeeded | Continue to the next deployment check |
| `65` | Dependency audit failed or could not complete | Resolve the reported cause before rerunning |
| `66` | Required artifact is absent | Publish or promote the intended artifact |
| `78` | Scan policy refused the artifact | Resolve the finding or review the policy |
| Other nonzero | Command, authentication, network or input failure | Read the error; do not treat it as absence |

### Dependency audit failures

`publish` audits production dependencies before the first image build. Both publication
workflows stop immediately on exit `65`, including audit service or registry errors;
the audit's stdout and stderr remain in the failure message. Image scan refusals (`78`)
also stop immediately, while other publication failures retain their retry policy.
An already-published artifact needs no build or audit.

For this repository, reproduce the gate from `apps/` with:

```bash
corepack yarn npm audit --severity high --environment production
```

Upgrade affected dependencies and commit both `package.json` and `yarn.lock` before
rerunning publication. If the audit could not reach its registry, resolve connectivity
and rerun deliberately; the workflow will not retry the failed audit automatically.

The API, proxy, collector and registry-proxy publications share this `apps/` audit;
a vulnerable workspace dependency can block all four before any image is built.
The workspace requires `ws ^8.21.3` and uses a Yarn resolution to upgrade copies
pinned by transitive dependencies, including Engine.IO and module federation.
This covers [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p),
which affects `ws >=8.0.0 <8.21.0`. Remove the resolution only when the direct and
transitive requirements all select patched versions; check `corepack yarn why ws`
and regenerate the lockfile before rerunning the audit.

## Implementation and verification

The CLI is [`bin/mbuild.ts`](bin/mbuild.ts). Addressing lives in [`src/address.ts`](src/address.ts),
configuration in [`src/config.ts`](src/config.ts), and publication in [`src/publish.ts`](src/publish.ts).
The reusable [mbuild workflow](../../../.github/workflows/mbuild.yml) is called by
[mdeploy-all](../../../.github/workflows/mdeploy-all.yml); release publication uses
[mbuild-release](../../../.github/workflows/mbuild-release.yml).

Run `make test:apps:mbuild` for image tooling typechecks and tests, or `make test:apps:infra`
for the complete infrastructure suite, from the repository root.
