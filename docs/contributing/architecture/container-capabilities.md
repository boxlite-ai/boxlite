# Linux capability API design

Status: accepted

## Decision

BoxLite exposes a high-level delta policy rather than the OCI runtime's five
exact capability sets. The policy is grouped with the other expert-only
container settings instead of widening the top-level box API:

| Surface | Add | Drop |
| --- | --- | --- |
| Rust, Python, REST | `advanced.capabilities.add` | `advanced.capabilities.drop` |
| Node.js / TypeScript | `advanced.capabilities.add` | `advanced.capabilities.drop` |
| Go | `AdvancedBoxOptions.SetCapabilities({Add: ...})` | `AdvancedBoxOptions.SetCapabilities({Drop: ...})` |
| C | `boxlite_advanced_options_set_capabilities_add` | `boxlite_advanced_options_set_capabilities_drop` |
| CLI | repeatable `--cap-add` | repeatable `--cap-drop` |

Create inputs use that nested path. The CLI flags remain familiar Docker-style
shorthands and populate the nested object.

The values remain strings rather than a public enum. Linux can add
capabilities independently of an SDK release, and the API host may run a
different kernel and OCI library from the BoxLite guest. Boundaries validate
the string shape; the guest that owns the OCI runtime validates support.

Names are case-insensitive, may omit `CAP_`, and are deduplicated as sets.
Empty lists preserve BoxLite's 14-capability baseline. Resolution follows
Moby and Apple container:

1. With `add=["ALL"]`, start from every capability supported by the guest
   and remove explicitly named drops. Named drops win in this branch.
2. Otherwise, with `drop=["ALL"]`, keep only explicitly named additions.
3. Otherwise, start from the baseline, apply drops, then apply additions.
   A named addition therefore wins a named conflict.

Adding capabilities weakens the container boundary; `SYS_ADMIN` and `ALL` are
especially broad. Prefer `drop=["ALL"]` plus only the minimum additions a
workload needs. BoxLite's VM boundary remains separate, but it is not a reason
to grant unnecessary privilege inside the guest.

The resolved set populates OCI bounding, effective, and permitted sets for
init and every later exec. Inheritable and ambient remain absent. They have
different privilege propagation semantics and require a separate, explicit
security design if BoxLite ever exposes them.

Internally, the guest resolves the two input lists once into a `CapabilitySet`.
That facade owns parsing, default policy, `ALL` precedence, canonical names for
libcontainer, and OCI set construction. Downstream init/exec code carries only
the resolved type and cannot reinterpret the policy.

## Compatibility and rollout

Every versioned boundary negotiates capability support before a policy can be
silently dropped:

- A remote SDK re-reads `linux_capabilities_enabled` from `GET /v1/config`
  (uncached) immediately before creating a box with a custom policy, so a
  server rollback cannot be masked by a stale discovery cache.
- A BoxLite host requires the guest to report version 0.9.8 or newer from
  Ping before sending the nested policy. Guest rootfs images are cached per
  version and reused, so an older guest can outlive its release; it would
  decode the new field as unknown proto and drop it.

A stale server or too-old guest therefore fails closed. Boundaries that do
not carry a custom policy are unaffected: ordinary create, get, and list keep
working against any server version. Inspection does not report the policy —
it is create-time configuration, not box state.

The cloud control plane does not carry the policy yet. `boxlite serve` and the
reference server are the server side of the contract above. The hosted API
does not advertise `linux_capabilities_enabled`, so a BoxLite client refuses
to send a policy to it — the gate is on the client, not the server. A client
that skips that negotiation and posts `advanced` anyway has the field
dropped, because the hosted API does not reject unknown properties.

Named `get_or_create` on the local runtime refuses to adopt an existing box
whose capability policy differs from the requested one, so reuse cannot
silently widen or narrow privileges.

An export carrying a capability policy is stamped archive v4; ordinary
exports stay v3. A pre-capability importer accepts only up to v3, so it
refuses the archive instead of dropping the policy and starting the box with
wider privileges than the archive asked for.

Once a custom-policy box exists, do not roll a server back to a build that
predates these fields: such a build cannot preserve them while recreating the
box. Roll forward instead.

## Project research

The projects below were reviewed at their current primary-source interfaces.
Defaults differ by product, but direct container APIs consistently favor an
add/drop delta over exposing all five OCI sets.

| Project | Interface and relevant behavior |
| --- | --- |
| Docker CLI | Repeatable string-list flags, forwarded without client-side semantic validation ([opts.go:150-156](https://github.com/docker/cli/blob/5b21d378b0db9eda911a169fd72cacb9f00da685/cli/command/container/opts.go#L150-L156), [opts.go:669-695](https://github.com/docker/cli/blob/5b21d378b0db9eda911a169fd72cacb9f00da685/cli/command/container/opts.go#L669-L695)). |
| Moby Engine | Flat `CapAdd` / `CapDrop` string arrays ([hostconfig.go:418-435](https://github.com/moby/moby/blob/2196ab2eec2aebaf92201056ea52475880397169/api/types/container/hostconfig.go#L418-L435)); 14-capability default and the precedence adopted above ([defaults.go:3-20](https://github.com/moby/moby/blob/2196ab2eec2aebaf92201056ea52475880397169/daemon/pkg/oci/caps/defaults.go#L3-L20), [utils.go:72-117](https://github.com/moby/moby/blob/2196ab2eec2aebaf92201056ea52475880397169/daemon/pkg/oci/caps/utils.go#L72-L117)). |
| Docker Compose | Flat `cap_add` / `cap_drop` sequences delegated to the engine ([Compose service specification](https://docs.docker.com/reference/compose-file/services/#cap_add)). |
| docker-py | Optional `cap_add` / `cap_drop` lists, not a closed capability enum ([containers.py:264-269](https://github.com/docker/docker-py/blob/main/docker/types/containers.py#L264-L269)). |
| Docker.DotNet | `IList<string>` fields mirror Moby ([HostConfig.Generated.cs:80-87](https://github.com/dotnet/Docker.DotNet/blob/master/src/Docker.DotNet/Models/HostConfig.Generated.cs#L80-L87)). |
| Bollard | Rust `Option<Vec<String>>` fields mirror Moby ([HostConfig.cap_add](https://docs.rs/bollard/latest/bollard/service/struct.HostConfig.html#structfield.cap_add)). |
| Podman/libpod | Flat string arrays ([specgen.go:394-401](https://github.com/containers/podman/blob/e36e1a41c69ea9f6096ed628a71920f315f34514/pkg/specgen/specgen.go#L394-L401)); its native endpoint rejects overlap, while its Docker-compatible endpoint accepts Moby's shape ([capabilities.go:125-196](https://github.com/containers/podman/blob/e36e1a41c69ea9f6096ed628a71920f315f34514/vendor/go.podman.io/common/pkg/capabilities/capabilities.go#L125-L196)). |
| podman-py | `list[str]` under the same keyword names ([containers_create.py:615-620](https://github.com/containers/podman-py/blob/main/podman/domain/containers_create.py#L615-L620)). |
| nerdctl | String slices and repeatable/comma-compatible flags; warns rather than freezing unknown names in the client ([container_run.go:218-222](https://github.com/containerd/nerdctl/blob/d79ad647152503c2740c90c1329cf985421e37b0/cmd/nerdctl/container/container_run.go#L218-L222), [run_security_linux.go:176-235](https://github.com/containerd/nerdctl/blob/d79ad647152503c2740c90c1329cf985421e37b0/pkg/cmd/container/run_security_linux.go#L176-L235)). |
| containerd | Lower-level ordered `SpecOpts`; add/drop mutate bounding, effective, and permitted, with inheritable/ambient handled separately ([spec_opts.go:1066-1143](https://github.com/containerd/containerd/blob/aad11006b869517fcd3009450b6f82da282e1a9b/pkg/oci/spec_opts.go#L1066-L1143)). |
| Kubernetes API | Nested `Capabilities { Add, Drop }`, but `Capability` is an open string newtype rather than an enum ([types.go:3040-3052](https://github.com/kubernetes/api/blob/master/core/v1/types.go#L3040-L3052)). |
| Kubernetes CRI | Repeated add/drop strings plus a separate ambient-add field; ordinary add and ambient add are intentionally distinct ([api.proto:1026-1041](https://github.com/kubernetes/cri-api/blob/791729b255f0c2d0019d3862ba6ef000c4a30c4d/pkg/apis/runtime/v1/api.proto#L1026-L1041)). |
| CRI-O | Guest/runtime-side validation, product-specific default, add/drop resolution, and deliberate clearing of ambient/inheritable sets ([capabilities_linux.go:11-42](https://github.com/cri-o/cri-o/blob/65f79695590b9f53e5f69b34382146cdac8ab5c0/internal/config/capabilities/capabilities_linux.go#L11-L42), [container.go:640-785](https://github.com/cri-o/cri-o/blob/65f79695590b9f53e5f69b34382146cdac8ab5c0/internal/factory/container/container.go#L640-L785)). |
| Nomad Docker driver | Flat task fields plus an operator allowlist; its default intentionally differs from Docker by dropping `NET_RAW` ([config.go:377-392](https://github.com/hashicorp/nomad/blob/37c73b2918bd5798e285623d436644f3e5d2cb1b/drivers/docker/config.go#L377-L392), [defaults.go:14-31](https://github.com/hashicorp/nomad/blob/37c73b2918bd5798e285623d436644f3e5d2cb1b/drivers/shared/capabilities/defaults.go#L14-L31)). |
| Buildah | Add/drop string arrays with documented drop-wins conflicts ([run.go:155-160](https://github.com/containers/buildah/blob/18bf8e35f1a08b95a9847e383d340bd9e96f5097/run.go#L155-L160), [buildah-run.1.md:26-48](https://github.com/containers/buildah/blob/18bf8e35f1a08b95a9847e383d340bd9e96f5097/docs/buildah-run.1.md#L26-L48)). |
| Apple container | Persisted `capAdd` / `capDrop` arrays default to empty for backward compatibility and document the same Moby precedence BoxLite adopts ([ContainerConfiguration.swift:20-60](https://github.com/apple/container/blob/d1d763530df3c6a326dbae7f0c0a59a335808045/Sources/ContainerResource/Container/ContainerConfiguration.swift#L20-L60), [how-to.md:470-510](https://github.com/apple/container/blob/d1d763530df3c6a326dbae7f0c0a59a335808045/docs/how-to.md#L470-L510)). |
| LXC | `lxc.cap.drop` and mutually exclusive `lxc.cap.keep` provide subtractive and replacement policies ([lxc.container.conf:1811-1850](https://github.com/lxc/lxc/blob/dc15af12c6a12d2946a5178001b3c377e2a9c694/doc/lxc.container.conf.sgml.in#L1811-L1850)). |
| Incus | Exposes LXC capability controls through restricted `raw.lxc`; privileged containers receive product-specific drops ([config_options.txt:2372-2378](https://github.com/lxc/incus/blob/29b2ba74073c5cd033865f7154e2c77ba5744824/doc/config_options.txt#L2372-L2378), [driver_lxc.go:787-798](https://github.com/lxc/incus/blob/29b2ba74073c5cd033865f7154e2c77ba5744824/internal/server/instance/drivers/driver_lxc.go#L787-L798)). |
| systemd-nspawn | Separate add, drop, and ambient settings; ambient is explicitly not implied by ordinary additions ([systemd.nspawn.xml:190-240](https://github.com/systemd/systemd/blob/ba3b1eff0ba51d400475f4596677b2d429cb1a47/man/systemd.nspawn.xml#L190-L240)). |
| OCI Runtime Spec | Exact `bounding`, `effective`, `inheritable`, `permitted`, and `ambient` arrays, with no delta/default policy ([config.md:286-299](https://github.com/opencontainers/runtime-spec/blob/6999a89a76a0329f440d5740497bedb9dd431297/config.md#L286-L299)). |
| runc | Applies the five exact OCI sets and resets ambient state explicitly ([capabilities.go:47-149](https://github.com/opencontainers/runc/blob/8d2f7df5cdcbd8d26b15457a9201f1c0ad426459/libcontainer/capabilities/capabilities.go#L47-L149)). Its inheritable-capability exec advisory is why BoxLite does not infer inheritable/ambient from `cap_add` ([GHSA-f3fp-gc8g-vw66](https://github.com/opencontainers/runc/security/advisories/GHSA-f3fp-gc8g-vw66)). |
| AWS ECS | Nested `KernelCapabilities` with add/drop arrays and Docker-derived semantics ([KernelCapabilities API](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_KernelCapabilities.html)). |
| Azure Container Instances | Nested fluent `add` / `drop` string lists ([SecurityContextCapabilitiesDefinition](https://learn.microsoft.com/en-us/java/api/com.azure.resourcemanager.containerinstance.models.securitycontextcapabilitiesdefinition)). |
| Terraform Docker provider | Declarative nested block, but still only add/drop lists ([resource_docker_container.go:262-290](https://github.com/kreuzwerker/terraform-provider-docker/blob/master/internal/provider/resource_docker_container.go#L262-L290)). |

Kata Containers and gVisor were also checked. Both consume OCI/containerd or
Docker/Kubernetes contracts rather than defining a competing high-level
capability API, which supports keeping BoxLite's public delta policy separate
from its OCI realization.

## Alternatives rejected

- **Public closed enum:** safer autocomplete today, but prevents a newer guest
  from accepting a newer kernel capability until every SDK is released again.
- **Public five-set OCI object:** precise but too low-level for the common
  container use case and easy to misuse. Ambient and inheritable deserve
  separate review.
- **Flat top-level add/drop fields:** common in Docker-compatible engine APIs,
  but BoxLite's top-level options also cover application lifecycle and resource
  settings. Grouping the expert-only privilege policy under `advanced` keeps
  creation extensible and matches Kubernetes, ECS, ACI, and Terraform's
  structured security models.
- **Host semantic validation:** the host and guest may carry different OCI
  libraries or kernels. Freezing the supported list in Rust, TypeScript, and
  every SDK creates version skew; only lexical validation belongs upstream.
