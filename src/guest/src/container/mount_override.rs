//! Guest-side version-compatibility guard on `advanced.mount`.
//!
//! `source`/`options` are host-resolved literal OCI values, carried by the
//! caller and applied verbatim — nothing here re-derives them (see
//! docs/architecture/privileged-mode-design.md, Trade-offs, option F).
//! `destination` names which of the guest's own standard mounts those values
//! are for; this guest only knows how to apply them to `/sys`. `readonly_paths`
//! rides along on the same guarantee this guard checks (see
//! [`validate_mount_override`]) but has no logic of its own here.
//! `capabilities` is a separate concern entirely, resolved against the
//! guest's own kernel by [`super::capabilities::CapabilitySet::resolve`].

use super::spec::MountOverride;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// Reject a `destination` this guest can't apply, or a `source`/`options`
/// that signals a host/guest version mismatch.
///
/// `destination` is data, not a hardcoded assumption, so a host newer than
/// this guest could legitimately name a mount this guest has no override
/// logic for yet; failing clearly here beats silently applying `source`/
/// `options` to the wrong mount or dropping them.
///
/// `source`/`options` have no legitimate empty value for `/sys`: every real
/// host resolves `source = "/sys"` and at least
/// `options = ["rbind", "nosuid", "noexec", "nodev"]`, privileged or not
/// (advanced_options::mount_options). Empty here can only mean the host
/// predates these fields entirely — a version too old to know it should send
/// anything — not a deliberate request. Rejecting it here also means
/// `readonly_paths` being empty is trustworthy as the real "privileged"
/// signal whenever this check passes: an old host that doesn't know about
/// `source`/`options` doesn't know about `readonly_paths` either, so the two
/// are never legitimately split.
///
/// A real boot test confirmed the alternative (silently proceeding) doesn't
/// even degrade gracefully: youki's mount code requires `bind`/`rbind` in
/// `options` to treat `/sys` as a bind mount at all, so an empty list makes
/// container creation fail with an unrelated "failed to prepare rootfs" error
/// — this rejection turns that into a diagnosable one.
pub(crate) fn validate_mount_override(
    destination: &str,
    mount_override: &MountOverride,
) -> BoxliteResult<()> {
    if destination != "/sys" {
        return Err(BoxliteError::Unsupported(format!(
            "advanced.mount.destination {destination:?} is not supported; this guest \
             only knows how to apply host-resolved options to /sys"
        )));
    }
    if mount_override.source.is_empty() {
        return Err(BoxliteError::Unsupported(
            "advanced.mount.source is empty; the host predates \
             resolved security fields (privileged-mode-design.md, option F) \
             — recreate this box with a matching boxlite version"
                .to_string(),
        ));
    }
    if mount_override.options.is_empty() {
        return Err(BoxliteError::Unsupported(
            "advanced.mount.options is empty; the host predates \
             resolved security fields (privileged-mode-design.md, option F) \
             — recreate this box with a matching boxlite version"
                .to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mount_override(source: &str, options: &[&str]) -> MountOverride {
        MountOverride {
            source: source.to_string(),
            options: options.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn empty_options_is_rejected_as_a_version_mismatch() {
        let error = validate_mount_override("/sys", &mount_override("/sys", &[]))
            .expect_err("empty options must not pass");

        assert!(matches!(error, BoxliteError::Unsupported(_)), "{error:?}");
        assert!(
            error.to_string().contains("options"),
            "error should name the field: {error}"
        );
    }

    #[test]
    fn empty_source_is_rejected_as_a_version_mismatch() {
        let error = validate_mount_override("/sys", &mount_override("", &["rbind"]))
            .expect_err("empty source must not pass");

        assert!(matches!(error, BoxliteError::Unsupported(_)), "{error:?}");
        assert!(
            error.to_string().contains("source"),
            "error should name the field: {error}"
        );
    }

    #[test]
    fn non_empty_source_and_options_for_sys_passes() {
        validate_mount_override("/sys", &mount_override("/sys", &["rbind"]))
            .expect("non-empty source and options for /sys should pass");
    }

    #[test]
    fn unsupported_destination_is_rejected() {
        let error = validate_mount_override("/proc", &mount_override("/sys", &["rbind"]))
            .expect_err("a destination other than /sys must not pass");

        assert!(matches!(error, BoxliteError::Unsupported(_)), "{error:?}");
        assert!(
            error.to_string().contains("/proc"),
            "error should name the unsupported destination: {error}"
        );
    }
}
