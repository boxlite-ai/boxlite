# Naming Glossary

This glossary defines the naming boundary for BoxLite cloud and core runtime work.

| Term | Use It For | Do Not Use It For | Current Names To Replace |
| --- | --- | --- | --- |
| `Box` | User-facing execution instance. | Low-level OS sandboxing or historical DB names unless part of a planned migration. | `Sandbox` in UI/product text where safe. |
| `BoxTemplate` | A reusable template selected when creating a Box. Includes metadata, default resources, visibility, regions, entrypoint, and `artifactRef`. | Core runtime snapshots; registry blobs themselves. | `Snapshot` entity/service/controller where it means user-selectable template; `Environment` where it means system template. |
| `Template` | Short UI label for `BoxTemplate`. | Internal artifact or runner cache names. | `Environment`, `Base image` where the user is choosing a template rather than inspecting image internals. |
| `RuntimeArtifact` | Immutable runtime material that can be pulled by a runner. | Template metadata or Box state snapshots. | `snapshotRef` when it is an OCI/reference string; `SnapshotManager` if it manages artifact propagation. |
| `artifactRef` | String reference to a runtime artifact in the registry. | Template id/name; Box snapshot id/name. | `snapshotRef` in `BuildInfo`, runner jobs, cache rows, and start payload mapping. |
| `RunnerArtifactCache` | Per-runner cache state for a runtime artifact. | Template availability or Box lifecycle state. | `SnapshotRunner`. |
| `ArtifactRegistry` | S3-backed OCI registry service storing runtime artifacts. | Product templates or core snapshots. | `apps/snapshot-manager` service name. |
| `BoxSnapshot` | Future cloud/user concept for snapshotting a Box state. | Templates and artifact refs. | New future concept only. |
| `Snapshot` | Existing BoxLite core snapshot/restore feature. | Cloud templates, image refs, prewarm cache, registry service. | No replacement inside core snapshot code. |

## Naming Rules

1. If a user chooses it before creating a Box, call it `Template` in UI and `BoxTemplate` in code.
2. If a runner pulls it or a registry stores it, call it `RuntimeArtifact` or `artifactRef`.
3. If a row records that a runner has pulled or is pulling something, call it `RunnerArtifactCache`.
4. If it captures mutable Box state for restore/clone/export, call it `Snapshot`.
5. Avoid `Environment` for the template system. It implies runtime variables or deployed infrastructure, which is not the product concept.
6. Avoid `Image` as the primary user label in Create Box. The template may be backed by an image, but the user is choosing a prepared template with defaults and warmup behavior.

## Approved Short Labels

| Surface | Preferred Label |
| --- | --- |
| Dashboard navigation | Templates |
| Create Box selector | Template |
| Template defaults section | Default resources |
| Resource override section | Resources |
| Internal registry setting | Artifact registry |
| Runner cache status | Artifact cache |
| Future Box state capture | Snapshot |

## Transitional Compatibility

Compatibility aliases should not be introduced before launch. If a future staged rollout needs one, name it explicitly as a legacy alias at the boundary instead of letting `Snapshot` or `Environment` leak back into domain code.
