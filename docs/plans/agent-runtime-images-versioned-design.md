# Agent Runtime Images Design

## Goal

Publish the three BoxLite agent runtime images from source-controlled Dockerfiles through GitHub Actions, using the existing GHCR package names with version tags starting at `v0.1.0`.

## Context

The historical Dockerfiles were introduced in commit `fc88aa0b` and also appear in `bdab4823`:

- `images/agent-runtime/base.Dockerfile`
- `images/agent-runtime/python.Dockerfile`
- `images/agent-runtime/node.Dockerfile`
- `images/agent-runtime/start-agent-runtime.sh`

The historical build script was `scripts/images/build-agent-runtime.sh`. It built a Linux daemon binary into `apps/dist/apps/daemon-runtime/boxlite-daemon`, then used the repository root as the Docker build context.

Current `origin/main` still has references to those paths in `apps/scripts/local-dex-env.mjs`, but the Dockerfiles and build script are absent. Current `.dockerignore` excludes `apps/dist`, which would break Dockerfile copies from `apps/dist/apps/daemon-runtime/` unless fixed.

## Naming And Versioning

Use the existing package names:

- `ghcr.io/boxlite-ai/boxlite-agent-base`
- `ghcr.io/boxlite-ai/boxlite-agent-python`
- `ghcr.io/boxlite-ai/boxlite-agent-node`

Use version tags derived from `images/agent-runtime/VERSION`. The initial version is `0.1.0`, published as `v0.1.0`. Each future agent-runtime image release increments that file and publishes the matching `vX.Y.Z` tag.

Do not delete or retag older package versions.

## Architecture

Restore the historical Dockerfiles in `images/agent-runtime/` so local development and CI share one source of truth. Add a publish workflow that builds and pushes the three images as multi-architecture GHCR images for `linux/amd64` and `linux/arm64`.

The workflow reads the version from `images/agent-runtime/VERSION` by default and supports a manual override through `workflow_dispatch`. A shell build script remains available for local dry runs and for CI reuse where useful.

Because these images embed `boxlite-daemon`, multi-architecture publishing must not copy one shared daemon binary into both platforms. The script builds `apps/dist/apps/daemon-runtime/boxlite-daemon-amd64` and `apps/dist/apps/daemon-runtime/boxlite-daemon-arm64`. The Dockerfiles use BuildKit's `TARGETARCH` argument to copy `boxlite-daemon-${TARGETARCH}` into `/boxlite/bin/boxlite-daemon`.

## Data Flow

1. Developer updates an agent runtime Dockerfile or daemon code.
2. GitHub Actions builds `boxlite-daemon-amd64` and `boxlite-daemon-arm64` for Linux.
3. Buildx builds each runtime image for `linux/amd64` and `linux/arm64`.
4. GHCR receives the three existing package names with the same version tag.
5. API allowlist, infra fallback env, and dashboard image picker point at the new refs.
6. Dashboard creates boxes using the new refs, and API rejects refs outside the curated set.

## Files To Change

- Restore `images/agent-runtime/base.Dockerfile`
- Restore `images/agent-runtime/python.Dockerfile`
- Restore `images/agent-runtime/node.Dockerfile`
- Restore `images/agent-runtime/start-agent-runtime.sh`
- Restore and upgrade `scripts/images/build-agent-runtime.sh`
- Add `.github/workflows/publish-agent-runtime-images.yml`
- Modify `.dockerignore`
- Modify `apps/api/src/box/constants/curated-images.constant.ts`
- Modify `apps/api/src/box/constants/curated-images.constant.spec.ts`
- Modify `apps/infra/sst.config.ts`
- Modify `apps/dashboard/src/components/Box/CreateBoxSheet.tsx`
- Add or update dashboard tests for the supported image refs.

## Error Handling

The build script should fail fast when:

- `TAG` is empty or malformed.
- `PLATFORMS` contains anything outside `linux/amd64` and `linux/arm64`.
- A required Dockerfile is missing.
- A required architecture-specific daemon binary cannot be built.

The workflow should not delete or retag existing image versions. It should push the requested version tag to the existing packages.

## Testing

Use test-first changes for user-visible behavior:

- API allowlist test should expect the three `*:v0.1.0` refs and fail before implementation.
- Dashboard image picker test should expect the three `*:v0.1.0` refs and fail before implementation.

Then verify:

- `make test:apps` for API/dashboard unit coverage.
- A local dry-run build for one platform where Docker is available.
- The workflow YAML is syntactically valid by inspection and uses `packages: write`.

## Out Of Scope

- Deleting old GHCR packages.
- Migrating existing boxes that already reference old images.
- Redesigning the image picker to fetch dynamic image refs from the API.
- Changing runner image pull authentication.
