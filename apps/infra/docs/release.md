## TL;DR

Tag a stable version, publish its release images to GHCR, then deploy that existing tag with `mdeploy-all`.

# Release runbook

This is a short runbook for releasing a stable version to `prod`. The examples use `v0.10.3`;
replace it with the version you are releasing. The version must have the form `vX.Y.Z`;
pre-release suffixes are not supported.

## Before you start

- The release commit is merged into `main`, and the version numbers in the repository are already
  updated to this release.
- All required checks on `main` have passed.
- You can run GitHub Actions workflows and approve the target stage's Environment;
  the release publisher needs package write permission without a cloud Environment.

## 1. Tag the version and publish the GitHub Release

Sync `main`, then create and push the tag on the commit being released:

```bash
git switch main
git pull --ff-only origin main

TAG=v0.10.3
git tag "$TAG"
git push origin "$TAG"
```

Then publish a GitHub Release with the same name:

```bash
gh release create "$TAG" \
  --repo boxlite-ai/boxlite \
  --verify-tag \
  --generate-notes
```

Pushing the tag alone starts no release build; publishing the Release does:

- Its `published` event starts `Build Runtime`, `Build C SDK`, `Build Node.js`, `Build Wheels` and
  `Publish Release Images`.
- A successful `Build C SDK` run for the Release then starts `Build Go SDK` and
  `Build Runner Binary`, which attaches the Runner files below.

`Publish Release Images` dispatches `mbuild-release` from `main`, which publishes the application
images for this tag to GHCR.

Wait for the release workflows to finish, and check that the Release has at least these assets:

```text
boxlite-runner-vX.Y.Z-linux-amd64.tar.gz
boxlite-runner-vX.Y.Z-linux-amd64.tar.gz.sha256
```

`mdeploy-all` checks for both Runner files again before it deploys; the rollout cannot proceed
until they exist.

## 2. Wait for mbuild-release to publish the application images

Open **Actions → Publish Release Images** and confirm that it dispatched **mbuild-release**.
Wait for `mbuild-release` to finish; publication needs package write permission and no cloud
Environment approval. It reads the tagged commit's declaration, then builds the four current images
in parallel and publishes them to GHCR:

- `api`
- `proxy`
- `otel-collector` (the collector)
- `registry-proxy`

Images use `ghcr.io/boxlite-ai/boxlite/<artifact>:vX.Y.Z-<full-commit-sha>`, preserving AR's artifact/tag layout.
Publication logs each manifest digest. Deploy only after every declared artifact has succeeded.
A partial publication can be retried: existing images are reused, missing images are built, and none are overwritten.
Dependency audit failures stop immediately; image scanning runs after import into the receiving cloud registry.

If the automatic dispatch failed and you need to recover by hand, open
**Actions → mbuild-release → Run workflow** and enter:

| Input | Value |
| --- | --- |
| Run workflow from | `main` |
| `command` | `publish` |
| `tag` | The release tag, such as `v0.10.3` |

Or dispatch the same recovery with the GitHub CLI:

```bash
TAG=v0.10.3

gh workflow run mbuild-release.yml \
  --repo boxlite-ai/boxlite \
  --ref main \
  -f command=publish \
  -f tag="$TAG"
```

## 3. Roll out to prod with mdeploy-all

Open **Actions → mdeploy-all → Run workflow** and enter:

| Input | Value |
| --- | --- |
| Run workflow from | `main` |
| `stage` | `prod` |
| `components` | `api+runner` |
| `ref` | The release tag, such as `v0.10.3` |
| `apply` | `true` |
| `confirm` | `true` |

Approve the `prod` Environment. `mdeploy-all` then:

1. Checks the tag, the GitHub Release and the Runner artifacts.
2. Requires the selected images in GHCR, then imports their immutable digests into prod's AR/ECR repository.
3. Verifies copied digests, enforces prod's image scan policy and deploys the version.

If GHCR lacks an image, deployment stops and asks you to run `mbuild-release` manually as in step 2.
It never triggers that build itself, including for historical releases or images already present in the cloud registry.
Authentication and network failures remain registry errors; resolve those before retrying.

Or start it with the GitHub CLI:

```bash
TAG=v0.10.3

gh workflow run mdeploy-all.yml \
  --repo boxlite-ai/boxlite \
  --ref main \
  -f stage=prod \
  -f components=api+runner \
  -f ref="$TAG" \
  -f apply=true \
  -f confirm=true
```

The release is live only once every `mdeploy-all` job has succeeded. Check that the version,
commit, image tags and deployment results in the workflow summary match this release.

## Common failures

- **No GitHub Release**: only the tag was pushed. Publish a Release with the same name, then retry.
- **No mbuild-release run appeared**: check `Publish Release Images` first. Fix that run and
  retry, or dispatch `mbuild-release` from `main` by hand as in step 2.
- **Missing Runner artifact**: `Build Runner Binary` attaches the tarball and its `.sha256`, but
  only after `Build C SDK` succeeds. Wait for or fix whichever of the two has not succeeded.
- **Invalid tag, or tag not on main**: use a stable `vX.Y.Z` tag whose commit is on `main`.
- **Missing GHCR image**: run `mbuild-release` manually; re-running publication fills missing images without rebuilding existing ones.
- **Destination digest differs from GHCR**: deployment refuses to overwrite that release identity; inspect both registries before retrying.

The full publication, import and deployment mechanics are in
[Deploy through GitHub Actions](deployment.md#deploy-through-github-actions).
