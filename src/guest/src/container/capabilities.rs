//! Linux capabilities for container processes.
//!
//! Defines BoxLite's Docker-compatible baseline and custom capability policy.
//! Used by:
//! - OCI spec builder (process.capabilities)
//! - Tenant process spawning (exec capabilities)

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use oci_spec::runtime::{Capability, LinuxCapabilities, LinuxCapabilitiesBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

// Linux UAPI capability numbers, in order from 0 through CAP_LAST_CAP.
const CAPABILITIES_BY_NUMBER: [Capability; 41] = [
    Capability::Chown,
    Capability::DacOverride,
    Capability::DacReadSearch,
    Capability::Fowner,
    Capability::Fsetid,
    Capability::Kill,
    Capability::Setgid,
    Capability::Setuid,
    Capability::Setpcap,
    Capability::LinuxImmutable,
    Capability::NetBindService,
    Capability::NetBroadcast,
    Capability::NetAdmin,
    Capability::NetRaw,
    Capability::IpcLock,
    Capability::IpcOwner,
    Capability::SysModule,
    Capability::SysRawio,
    Capability::SysChroot,
    Capability::SysPtrace,
    Capability::SysPacct,
    Capability::SysAdmin,
    Capability::SysBoot,
    Capability::SysNice,
    Capability::SysResource,
    Capability::SysTime,
    Capability::SysTtyConfig,
    Capability::Mknod,
    Capability::Lease,
    Capability::AuditWrite,
    Capability::AuditControl,
    Capability::Setfcap,
    Capability::MacOverride,
    Capability::MacAdmin,
    Capability::Syslog,
    Capability::WakeAlarm,
    Capability::BlockSuspend,
    Capability::AuditRead,
    Capability::Perfmon,
    Capability::Bpf,
    Capability::CheckpointRestore,
];

/// The resolved Linux capability policy for every process in one container.
///
/// This is the guest's single semantic boundary: external APIs carry familiar
/// add/drop strings, then this type parses and resolves them once before the
/// OCI spec or any exec process is built.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct CapabilitySet(HashSet<Capability>);

impl Default for CapabilitySet {
    fn default() -> Self {
        Self(
            [
                Capability::Chown,
                Capability::DacOverride,
                Capability::Fowner,
                Capability::Fsetid,
                Capability::Kill,
                Capability::Setgid,
                Capability::Setuid,
                Capability::Setpcap,
                Capability::NetBindService,
                Capability::NetRaw,
                Capability::SysChroot,
                Capability::Mknod,
                Capability::AuditWrite,
                Capability::Setfcap,
            ]
            .into_iter()
            .collect(),
        )
    }
}

impl CapabilitySet {
    /// Resolve Docker-style capability additions and removals.
    ///
    /// Names are case-insensitive and may include the `CAP_` prefix. `ALL` in
    /// additions starts from every capability supported by this guest; `ALL`
    /// in removals starts from an empty set. Without `ALL`, removals are applied
    /// before additions, so an explicitly added capability wins a named
    /// conflict. With `add=ALL`, named drops win, matching Moby exactly.
    pub(crate) fn resolve(add: &[String], drop: &[String]) -> BoxliteResult<Self> {
        let additions = parse_capabilities(add)?;
        let removals = parse_capabilities(drop)?;

        let supported = if add.is_empty() && drop.is_empty() {
            None
        } else {
            Some(supported_capabilities()?)
        };
        if let Some(supported) = &supported {
            ensure_supported(&additions, supported)?;
            ensure_supported(&removals, supported)?;
        }

        if add.iter().any(|name| is_all(name)) {
            let mut resolved = supported.ok_or_else(|| {
                BoxliteError::Internal(
                    "capability support was not resolved for add=ALL".to_string(),
                )
            })?;
            for capability in removals {
                resolved.remove(&capability);
            }
            return Ok(Self(resolved));
        }

        if drop.iter().any(|name| is_all(name)) {
            return Ok(Self(additions));
        }

        let mut resolved = Self::default().0;
        for capability in removals {
            resolved.remove(&capability);
        }
        resolved.extend(additions);
        Ok(Self(resolved))
    }

    /// Build the exact OCI sets used by BoxLite's high-level add/drop policy.
    ///
    /// Docker/containerd apply ordinary container capabilities to bounding,
    /// effective, and permitted. Inheritable and ambient are deliberately
    /// absent: they require a separate security contract and implicitly
    /// populating them has caused runtime vulnerabilities during exec.
    pub(crate) fn to_oci(&self) -> BoxliteResult<LinuxCapabilities> {
        let mut capabilities = LinuxCapabilitiesBuilder::default()
            .bounding(self.0.clone())
            .effective(self.0.clone())
            .permitted(self.0.clone())
            .build()
            .map_err(|error| {
                BoxliteError::Internal(format!("failed to build Linux capabilities: {error}"))
            })?;

        // oci-spec 0.6's builder defaults these sets to three capabilities.
        capabilities.set_inheritable(None);
        capabilities.set_ambient(None);
        Ok(capabilities)
    }

    /// Canonical names accepted by libcontainer's tenant builder.
    pub(crate) fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .0
            .iter()
            .map(|capability| format!("CAP_{capability}"))
            .collect();
        names.sort_unstable();
        names
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.0.len()
    }

    #[cfg(test)]
    fn contains(&self, capability: &Capability) -> bool {
        self.0.contains(capability)
    }

    #[cfg(test)]
    fn iter(&self) -> impl Iterator<Item = &Capability> {
        self.0.iter()
    }
}

fn parse_capabilities(names: &[String]) -> BoxliteResult<HashSet<Capability>> {
    names
        .iter()
        .filter(|name| !is_all(name))
        .map(|name| parse_capability(name))
        .collect()
}

fn parse_capability(name: &str) -> BoxliteResult<Capability> {
    let normalized = name.to_ascii_uppercase();
    let unprefixed = normalized.strip_prefix("CAP_").unwrap_or(&normalized);
    unprefixed
        .parse::<Capability>()
        .map_err(|_| BoxliteError::InvalidArgument(format!("unknown Linux capability '{name}'")))
}

fn is_all(name: &str) -> bool {
    name.eq_ignore_ascii_case("ALL") || name.eq_ignore_ascii_case("CAP_ALL")
}

fn supported_capabilities() -> BoxliteResult<HashSet<Capability>> {
    let raw = std::fs::read_to_string("/proc/sys/kernel/cap_last_cap").map_err(|error| {
        BoxliteError::Internal(format!(
            "failed to read guest kernel capability ceiling: {error}"
        ))
    })?;
    let last_capability = raw.trim().parse::<usize>().map_err(|error| {
        BoxliteError::Internal(format!(
            "invalid guest kernel capability ceiling '{}': {error}",
            raw.trim()
        ))
    })?;

    Ok(CAPABILITIES_BY_NUMBER
        .iter()
        .take(last_capability.saturating_add(1))
        .copied()
        .collect())
}

fn ensure_supported(
    requested: &HashSet<Capability>,
    supported: &HashSet<Capability>,
) -> BoxliteResult<()> {
    if let Some(capability) = requested
        .iter()
        .find(|capability| !supported.contains(capability))
    {
        return Err(BoxliteError::InvalidArgument(format!(
            "Linux capability 'CAP_{capability}' is not supported by the guest kernel"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn default_capabilities_has_14_docker_defaults() {
        let caps = CapabilitySet::default();
        assert_eq!(caps.len(), 14);
    }

    #[test]
    fn default_capabilities_includes_required_caps() {
        let caps = CapabilitySet::default();
        let required = [
            Capability::Chown,
            Capability::DacOverride,
            Capability::Fowner,
            Capability::Fsetid,
            Capability::Kill,
            Capability::Setgid,
            Capability::Setuid,
            Capability::Setpcap,
            Capability::NetBindService,
            Capability::NetRaw,
            Capability::SysChroot,
            Capability::Mknod,
            Capability::AuditWrite,
            Capability::Setfcap,
        ];
        for cap in &required {
            assert!(caps.contains(cap), "missing required capability: {:?}", cap);
        }
    }

    #[test]
    fn default_capabilities_excludes_dangerous_caps() {
        let caps = CapabilitySet::default();
        let dangerous = [
            Capability::SysAdmin,
            Capability::NetAdmin,
            Capability::SysModule,
            Capability::SysRawio,
            Capability::MacOverride,
        ];
        for cap in &dangerous {
            assert!(
                !caps.contains(cap),
                "dangerous capability must be excluded: {:?}",
                cap
            );
        }
    }

    #[test]
    fn capability_names_match_default_capabilities() {
        let caps = CapabilitySet::default();
        let names = caps.names();
        assert_eq!(caps.len(), names.len());
        for name in &names {
            assert!(
                name.starts_with("CAP_"),
                "capability name should start with CAP_: {}",
                name
            );
        }
    }

    #[test]
    fn capability_names_are_all_uppercase() {
        for name in CapabilitySet::default().names() {
            assert_eq!(name, name.to_uppercase(), "should be uppercase: {}", name);
        }
    }

    #[test]
    fn kernel_capability_table_matches_linux_uapi_numbers() {
        assert_eq!(CAPABILITIES_BY_NUMBER[0], Capability::Chown);
        assert_eq!(CAPABILITIES_BY_NUMBER[31], Capability::Setfcap);
        assert_eq!(CAPABILITIES_BY_NUMBER[37], Capability::AuditRead);
        assert_eq!(CAPABILITIES_BY_NUMBER[40], Capability::CheckpointRestore);
    }

    #[test]
    fn resolve_capabilities_without_overrides_preserves_docker_defaults() {
        let resolved = CapabilitySet::resolve(&[], &[]).expect("resolve default capabilities");

        assert_eq!(resolved, CapabilitySet::default());
        assert_eq!(resolved.len(), 14);
    }

    #[test]
    fn resolve_capabilities_adds_docker_style_name() {
        let resolved =
            CapabilitySet::resolve(&names(&["SYS_ADMIN"]), &[]).expect("resolve added capability");

        assert_eq!(resolved.len(), 15);
        assert!(resolved.contains(&Capability::SysAdmin));
        assert!(resolved.contains(&Capability::NetRaw));
    }

    #[test]
    fn resolve_capabilities_drops_docker_style_name() {
        let resolved =
            CapabilitySet::resolve(&[], &names(&["NET_RAW"])).expect("resolve dropped capability");

        assert_eq!(resolved.len(), 13);
        assert!(!resolved.contains(&Capability::NetRaw));
        assert!(resolved.contains(&Capability::NetBindService));
    }

    #[test]
    fn drop_all_then_add_keeps_only_explicit_additions() {
        let resolved = CapabilitySet::resolve(&names(&["SYS_ADMIN"]), &names(&["ALL"]))
            .expect("resolve drop ALL with one addition");

        assert_eq!(
            resolved,
            CapabilitySet([Capability::SysAdmin].into_iter().collect())
        );
    }

    #[test]
    fn cap_prefixed_all_is_the_all_sentinel() {
        assert!(is_all("CAP_ALL"));
        assert!(is_all("cap_all"));
    }

    #[test]
    fn add_all_then_drop_removes_only_explicit_drops() {
        let all = CapabilitySet::resolve(&names(&["ALL"]), &[]).expect("resolve ALL capabilities");
        let resolved = CapabilitySet::resolve(&names(&["ALL"]), &names(&["NET_RAW"]))
            .expect("resolve ALL capabilities with one drop");

        assert!(all.contains(&Capability::SysAdmin));
        assert!(all.contains(&Capability::NetRaw));
        assert_eq!(resolved.len(), all.len() - 1);
        assert!(!resolved.contains(&Capability::NetRaw));
        assert!(all
            .iter()
            .filter(|capability| **capability != Capability::NetRaw)
            .all(|capability| resolved.contains(capability)));
    }

    #[test]
    fn resolve_capabilities_rejects_unknown_name() {
        let error = CapabilitySet::resolve(&names(&["CAP_NOT_REAL"]), &[])
            .expect_err("unknown capability must fail");

        assert!(
            error.to_string().contains("CAP_NOT_REAL"),
            "error should identify the invalid capability: {error}"
        );
    }

    #[test]
    fn explicit_add_wins_when_capability_is_also_dropped() {
        let resolved = CapabilitySet::resolve(&names(&["SYS_ADMIN"]), &names(&["CAP_SYS_ADMIN"]))
            .expect("resolve conflicting capability overrides");

        assert!(resolved.contains(&Capability::SysAdmin));
    }

    #[test]
    fn capability_names_are_case_insensitive_prefixed_and_deduplicated() {
        let resolved = CapabilitySet::resolve(
            &names(&["sys_admin", "CAP_SYS_ADMIN", "cap_net_admin"]),
            &[],
        )
        .expect("resolve normalized capability names");

        assert_eq!(resolved.len(), CapabilitySet::default().len() + 2);
        assert!(resolved.contains(&Capability::SysAdmin));
        assert!(resolved.contains(&Capability::NetAdmin));
    }

    #[test]
    fn add_all_ignores_explicit_additions_after_specific_drops() {
        let resolved = CapabilitySet::resolve(&names(&["ALL", "MKNOD"]), &names(&["MKNOD"]))
            .expect("resolve ALL with redundant explicit addition");

        assert!(!resolved.contains(&Capability::Mknod));
    }
}
