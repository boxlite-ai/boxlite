use boxlite::runtime::options::MountSpec;

pub fn parse(spec: &str) -> anyhow::Result<MountSpec> {
    let mut mount_type = None;
    let mut source = None;
    let mut target = None;
    let mut sub_path = None;
    let mut read_only = false;

    for field in spec.split(',') {
        if field.is_empty() {
            anyhow::bail!("empty mount field in {spec:?}");
        }
        if field == "readonly" {
            if read_only {
                anyhow::bail!("duplicate readonly flag in {spec:?}");
            }
            read_only = true;
            continue;
        }
        let (key, value) = field
            .split_once('=')
            .ok_or_else(|| anyhow::anyhow!("invalid mount field {field:?}"))?;
        if value.is_empty() {
            anyhow::bail!("mount field {key:?} cannot be empty");
        }
        match key {
            "type" => {
                if mount_type.replace(value.to_owned()).is_some() {
                    anyhow::bail!("duplicate mount type in {spec:?}");
                }
            }
            "source" => {
                if source.replace(value.to_owned()).is_some() {
                    anyhow::bail!("duplicate mount source in {spec:?}");
                }
            }
            "target" => {
                if target.replace(value.to_owned()).is_some() {
                    anyhow::bail!("duplicate mount target in {spec:?}");
                }
            }
            "sub_path" => {
                if sub_path.replace(value.to_owned()).is_some() {
                    anyhow::bail!("duplicate mount sub_path in {spec:?}");
                }
            }
            _ => anyhow::bail!("unknown mount field {key:?}"),
        }
    }

    if mount_type.as_deref() != Some("volume") {
        anyhow::bail!("--mount currently requires type=volume");
    }
    let source = source.ok_or_else(|| anyhow::anyhow!("mount source is required"))?;
    let target = target.ok_or_else(|| anyhow::anyhow!("mount target is required"))?;
    let mut mount = MountSpec::volume_mount(source, target);
    mount.read_only = read_only;
    mount.sub_path = sub_path;
    mount.validate()?;
    Ok(mount)
}

#[cfg(test)]
mod tests {
    use super::*;
    use boxlite::runtime::options::MountType;

    #[test]
    fn parses_a_typed_volume_mount() {
        let mount =
            parse("type=volume,source=workspace,target=/workspace,readonly,sub_path=team/backend")
                .expect("parse a read-only volume subdirectory");
        assert_eq!(mount.mount_type, MountType::Volume);
        assert_eq!(mount.source.as_deref(), Some("workspace"));
        assert_eq!(mount.target, "/workspace");
        assert!(mount.read_only);
        assert_eq!(mount.sub_path.as_deref(), Some("team/backend"));
    }

    #[test]
    fn rejects_invalid_or_unsupported_mounts() {
        for invalid in [
            "type=bind,source=/tmp,target=/data",
            "type=volume,source=workspace",
            "source=workspace,target=/workspace",
            "type=volume,source=,target=/workspace",
            "type=volume,source=workspace,target=/workspace,readonly=true",
            "type=volume,source=workspace,target=/workspace,unknown=value",
            "type=volume,source=workspace,target=/workspace,readonly,readonly",
            "type=volume,source=workspace,target=/workspace,sub_path=a,b",
        ] {
            assert!(parse(invalid).is_err(), "{invalid} must be rejected");
        }
    }
}
