//! Parsing for `--mount` specs.
//!
//! `--mount type=volume,source=run42,target=/workspace`
//!
//! Every field is a named `key=value`, so unlike `-v` nothing is inferred from a
//! field's position or from the first character of a path: `type` says what
//! `source` names. The keys are `type` (`volume` | `bind`), `source` and
//! `target`; `read_only` and `subpath` are not taken yet(TODO).
//!
//! The shape is Docker's `--mount` (`docker/cli/opts/mount.go:24-198`), with
//! two deliberate differences:
//!
//! - `type` is required. Docker defaults it to `volume` (`:73`), which is how a
//!   forgotten `type=bind` becomes a lookup for a volume named after a path.
//! - Keys are matched exactly. Docker lower-cases them (`:79`) and its own TODO
//!   there says it should not.
//!
//! Values are split on `,` without quoting, so no value can contain a comma.

use boxlite::runtime::options::{MountSpec, MountType};

/// Every key `--mount` accepts, in the order the help text lists them.
const KEYS: [&str; 3] = ["type", "source", "target"];

/// Parse one `--mount` value into a [`MountSpec`].
///
/// Nothing here touches the filesystem: a spec means the same thing on every
/// machine. A relative `bind` source is made absolute by the caller.
pub fn parse(spec: &str) -> anyhow::Result<MountSpec> {
    let fields = MountFields::split(spec)?;

    let mount_type = match fields.get("type") {
        Some(value) => value.parse::<MountType>()?,
        None => anyhow::bail!("mount spec {spec:?} needs type=volume or type=bind"),
    };

    let target = match fields.get("target") {
        Some(target) => absolute_target(target)?,
        None => anyhow::bail!("mount spec {spec:?} needs target=BOX_PATH"),
    };

    let source = match fields.get("source") {
        Some(source) => source.to_string(),
        None => match mount_type {
            MountType::Volume => {
                anyhow::bail!("volume mount spec {spec:?} needs source=VOLUME (an id or a name)")
            }
            MountType::Bind => anyhow::bail!("bind mount spec {spec:?} needs source=HOST_PATH"),
        },
    };

    Ok(MountSpec {
        mount_type,
        source: Some(source),
        target,
        read_only: false,
        sub_path: None,
    })
}

/// The `key=value` fields of one spec, each key at most once.
struct MountFields<'a> {
    fields: Vec<(&'a str, &'a str)>,
}

impl<'a> MountFields<'a> {
    /// Split a spec into fields, refusing anything that is not a known key with
    /// a value. An unknown key is an error rather than noise: a misspelt
    /// `read_only` would otherwise hand back a writable mount.
    fn split(spec: &'a str) -> anyhow::Result<Self> {
        let spec = spec.trim();
        if spec.is_empty() {
            anyhow::bail!("empty mount spec");
        }

        let mut fields: Vec<(&str, &str)> = Vec::new();
        for field in spec.split(',').map(str::trim) {
            if field.is_empty() {
                anyhow::bail!("empty field in mount spec {spec:?}");
            }
            let Some((key, value)) = field.split_once('=') else {
                anyhow::bail!("mount field {field:?} in {spec:?} must be a key=value pair");
            };
            let (key, value) = (key.trim(), value.trim());
            if !KEYS.contains(&key) {
                anyhow::bail!(
                    "unknown mount key {key:?} in {spec:?}; supported: {}",
                    KEYS.join(", ")
                );
            }
            if fields.iter().any(|(seen, _)| *seen == key) {
                anyhow::bail!("mount key {key:?} is set twice in {spec:?}");
            }
            if value.is_empty() {
                anyhow::bail!("mount key {key:?} has an empty value in {spec:?}");
            }
            fields.push((key, value));
        }

        Ok(Self { fields })
    }

    fn get(&self, key: &str) -> Option<&'a str> {
        self.fields
            .iter()
            .find(|(seen, _)| *seen == key)
            .map(|(_, value)| *value)
    }
}

/// The mount point inside the box. Always POSIX-absolute: guests are Linux.
fn absolute_target(target: &str) -> anyhow::Result<String> {
    if !target.starts_with('/') {
        anyhow::bail!("mount target must be absolute (e.g. /data), got {target:?}");
    }
    Ok(target.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn error(spec: &str) -> String {
        parse(spec)
            .expect_err("the spec should be refused")
            .to_string()
    }

    /// Each type with its source and target; a mount is writable and, for a
    /// volume, whole, since `read_only` and `subpath` are not taken yet(TODO).
    #[test]
    fn volume_and_bind_specs_set_their_fields() {
        assert_eq!(
            parse("type=volume,source=run42,target=/workspace").unwrap(),
            MountSpec::volume_mount("run42", "/workspace")
        );
        assert_eq!(
            parse("type=bind,source=/srv/data,target=/data").unwrap(),
            MountSpec::bind_mount("/srv/data", "/data")
        );
    }

    /// Fields are named, so their order carries nothing, and the space a
    /// caller leaves after a comma is not part of the value.
    #[test]
    fn field_order_and_spacing_do_not_matter() {
        assert_eq!(
            parse("target=/workspace, source=run42, type=volume").unwrap(),
            MountSpec::volume_mount("run42", "/workspace")
        );
    }

    /// A relative bind source is kept as written; resolving it against the
    /// working directory is the caller's job, as it is for `-v`.
    #[test]
    fn a_relative_bind_source_is_left_for_the_caller() {
        let mount = parse("type=bind,source=./data,target=/data").unwrap();
        assert_eq!(mount.source.as_deref(), Some("./data"));
    }

    #[test]
    fn type_target_and_source_are_required() {
        assert!(error("source=run42,target=/workspace").contains("needs type=volume or type=bind"));
        assert!(error("type=volume,source=run42").contains("needs target=BOX_PATH"));
        assert!(error("type=volume,target=/workspace").contains("needs source=VOLUME"));
        assert!(error("type=bind,target=/workspace").contains("needs source=HOST_PATH"));
    }

    #[test]
    fn only_volume_and_bind_are_types() {
        for mount_type in ["tmpfs", "Volume", "volumes"] {
            let message = error(&format!("type={mount_type},source=run42,target=/w"));
            assert!(message.contains("unknown mount type"), "{message}");
        }
    }

    /// An unknown key is refused rather than ignored: Docker's spellings in
    /// particular would otherwise be dropped and mount something writable or
    /// whole that the caller asked to restrict. So are `read_only` and
    /// `subpath`, until this parser takes them(TODO).
    #[test]
    fn unknown_and_docker_only_keys_are_refused() {
        for key in [
            "read_only",
            "subpath",
            "ro",
            "readonly",
            "volume-subpath",
            "src",
            "dst",
            "sub_path",
        ] {
            let message = error(&format!("type=volume,source=run42,target=/w,{key}=x"));
            assert!(message.contains("unknown mount key"), "{key}: {message}");
            assert!(
                message.contains("supported: type, source, target"),
                "{key}: {message}"
            );
        }
    }

    #[test]
    fn malformed_fields_are_refused() {
        assert!(error("").contains("empty mount spec"));
        assert!(error("type=volume,,target=/w").contains("empty field"));
        assert!(error("type=volume,source=run42,target=/w,read_only").contains("key=value"));
        assert!(error("type=volume,source=,target=/w").contains("empty value"));
        assert!(error("type=volume,type=bind,source=run42,target=/w").contains("set twice"));
    }

    #[test]
    fn target_must_be_absolute() {
        assert!(error("type=volume,source=run42,target=workspace").contains("must be absolute"));
    }
}
