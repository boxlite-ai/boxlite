## TL;DR

Tag a stable version and publish its GitHub Release, which builds the application images into `dev`; then roll that tag out to `prod` with `mdeploy-all`.

# Release runbook

This is a short runbook for releasing a stable version to `prod`. The examples use `v0.10.3`;
replace it with the version you are releasing. The version must have the form `vX.Y.Z`;
pre-release suffixes are not supported.

## Before you start

- The release commit is merged into `main`, and the version numbers in the repository are already
  updated to this release.
- All required checks on `main` have passed.
- You can run GitHub Actions workflows and approve the `dev` and `prod` Environments.

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
images for this tag to `dev`.

Wait for the release workflows to finish, and check that the Release has at least these assets:

```text
boxlite-runner-vX.Y.Z-linux-amd64.tar.gz
boxlite-runner-vX.Y.Z-linux-amd64.tar.gz.sha256
```

`mdeploy-all` checks for both Runner files again before it deploys; the rollout cannot proceed
until they exist.

## 2. Wait for mbuild-release to publish the application images

Open **Actions → Publish Release Images** and confirm that it dispatched **mbuild-release**.
Approve the `dev` Environment for `mbuild-release`, then wait for the workflow to finish. It reads
the artifact declarations from the tagged commit, then builds the three current images in parallel
and publishes them to `dev`:

- `api`
- `proxy`
- `otel-collector` (the collector)

Published images are tagged `vX.Y.Z-<commit-sha>`. Deploy to production only after all three
matrix jobs have succeeded.

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
2. Calls `mbuild-release` to promote the images already published in `dev` to `prod`, without
   rebuilding them.
3. Verifies the images in `prod` and deploys the version to production.

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
- **Image already published or promoted**: do not move or reuse the release tag. Check the earlier
  workflow runs and the registry state before deciding whether to continue with `mdeploy-all`.

The full build, promotion and deployment mechanics are in
[Deploy through GitHub Actions](deployment.md#deploy-through-github-actions).
