# Agent Runtime Images Design

## Goal

Publish the three BoxLite agent runtime images from source-controlled Dockerfiles through GitHub Actions, using the existing GHCR package names with version tags starting at `v0.1.0`.

These images are pure OCI images. They provide the filesystem and default tools that a Box can pull and run; they do not embed `boxlite-daemon`, `start-agent-runtime.sh`, or any BoxLite process supervisor.

## Context

The image source now lives in this repository so the GHCR packages can be rebuilt from reviewed code instead of unpublished local Dockerfiles:

- `images/agent-runtime/base.Dockerfile`
- `images/agent-runtime/python.Dockerfile`
- `images/agent-runtime/node.Dockerfile`

The BoxLite runtime already pulls and loads image refs. The image should therefore stay limited to OS/runtime contents and a default keep-alive command. BoxLite control-plane or runner behavior belongs outside the image.

## Naming And Versioning

Use the existing package names:

- `ghcr.io/boxlite-ai/boxlite-agent-base`
- `ghcr.io/boxlite-ai/boxlite-agent-python`
- `ghcr.io/boxlite-ai/boxlite-agent-node`

Use version tags derived from `images/agent-runtime/VERSION`. The initial version is `0.1.0`, published as `v0.1.0`. Each future agent-runtime image release increments that file and publishes the matching `vX.Y.Z` tag.

Do not delete or retag older package versions.

## Architecture

Add Dockerfiles in `images/agent-runtime/` so local development and CI share one source of truth. Add a publish workflow that builds and pushes the three images as multi-architecture GHCR images for `linux/amd64` and `linux/arm64`.

The workflow reads the version from `images/agent-runtime/VERSION` by default and supports a manual override through `workflow_dispatch`. A shell build script remains available for local dry runs and for CI reuse where useful.

Multi-architecture support is handled by Docker Buildx. The Dockerfiles contain only packages and shell setup, so no architecture-specific BoxLite binary is copied into the image.

## Data Flow

1. Developer updates an agent runtime Dockerfile or bumps `images/agent-runtime/VERSION`.
2. GitHub Actions validates the version and logs in to GHCR.
3. Buildx builds each pure runtime image for `linux/amd64` and `linux/arm64`.
4. GHCR receives the three existing package names with the same version tag.
5. API allowlist, infra fallback env, and dashboard image picker point at the new refs.
6. Dashboard creates boxes using the new refs, and API rejects refs outside the curated set.

## Files To Change

- Add `images/agent-runtime/base.Dockerfile`
- Add `images/agent-runtime/python.Dockerfile`
- Add `images/agent-runtime/node.Dockerfile`
- Add `images/agent-runtime/VERSION`
- Add `scripts/images/build-agent-runtime.sh`
- Add `.github/workflows/publish-agent-runtime-images.yml`
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
