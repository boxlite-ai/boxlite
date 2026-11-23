//! Aggregate mounts own their bindings and roots until the whole batch succeeds.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use boxlite_shared::layout::GUEST_BASE;
use boxlite_shared::{volume, Volume};
use nix::mount::{mount, umount, MsFlags};

use super::virtiofs::VirtiofsMount;
use super::volume::{mount_volume, resolve_mount_point};

#[derive(Debug, PartialEq, Eq)]
enum Mount {
    Root {
        tag: String,
        target: PathBuf,
    },
    Bind {
        source: PathBuf,
        target: PathBuf,
        read_only: bool,
    },
    Legacy {
        index: usize,
        target: Option<PathBuf>,
    },
}

fn plan(volumes: &[Volume]) -> BoxliteResult<Vec<Mount>> {
    let base = Path::new(GUEST_BASE).join("virtiofs");
    let mut roots = HashMap::new();
    let mut targets = std::collections::HashSet::new();
    let mut mounts = Vec::new();
    for (index, vol) in volumes.iter().enumerate() {
        let Some(volume::Source::Virtiofs(fs)) = &vol.source else {
            mounts.push(Mount::Legacy {
                index,
                target: vol.source.as_ref().map(|_| PathBuf::from(&vol.mount_point)),
            });
            continue;
        };
        if fs.device_tag.is_empty() && fs.export_key.is_empty() {
            mounts.push(Mount::Legacy {
                index,
                target: Some(resolve_mount_point(
                    &fs.tag,
                    &vol.mount_point,
                    &vol.container_id,
                )),
            });
            continue;
        }
        if fs.device_tag.is_empty()
            || fs.device_tag.len() > 36
            || fs.device_tag.contains('\0')
            || fs.export_key.is_empty()
            || fs.export_key == "."
            || fs.export_key == ".."
            || fs.export_key.contains(['/', '\0'])
        {
            return Err(BoxliteError::Storage(
                "Invalid aggregate mount identity".into(),
            ));
        }
        let target = resolve_mount_point(&fs.tag, &vol.mount_point, &vol.container_id);
        if !target.is_absolute()
            || target
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
            || target.starts_with(&base)
            || base.starts_with(&target)
            || !targets.insert(target.clone())
        {
            return Err(BoxliteError::Storage(format!(
                "Invalid aggregate destination: {}",
                target.display()
            )));
        }
        let root = if let Some(root) = roots.get(&fs.device_tag) {
            PathBuf::clone(root)
        } else {
            // The directory name is allocated locally, never derived from a device tag.
            let root = base.join(roots.len().to_string());
            roots.insert(fs.device_tag.clone(), root.clone());
            mounts.push(Mount::Root {
                tag: fs.device_tag.clone(),
                target: root.clone(),
            });
            root
        };
        mounts.push(Mount::Bind {
            source: root.join(&fs.export_key),
            target,
            read_only: fs.read_only,
        });
    }
    // Roots first, then every destination parent-first, including legacy shares
    // and block devices nested beneath an aggregate binding.
    mounts.sort_by_key(|mount| match mount {
        Mount::Root { .. } => (0, 0),
        Mount::Bind { target, .. } => (1, target.components().count()),
        Mount::Legacy { target, .. } => (1, target.as_ref().map_or(0, |p| p.components().count())),
    });
    Ok(mounts)
}

/// Rolls aggregate mounts back if a later guest initialization step fails.
pub(crate) struct MountedVolumes(Vec<PathBuf>);

impl MountedVolumes {
    pub(crate) fn commit(mut self) {
        self.0.clear();
    }
}

impl Drop for MountedVolumes {
    fn drop(&mut self) {
        for path in self.0.iter().rev() {
            if let Err(error) = unmount(path) {
                tracing::error!(%error, "Aggregate mount rollback failed");
            }
        }
    }
}

fn execute(
    mounts: &[Mount],
    mut apply: impl FnMut(&Mount) -> BoxliteResult<()>,
    mut undo: impl FnMut(&Path) -> BoxliteResult<()>,
) -> BoxliteResult<Vec<PathBuf>> {
    let mut owned = Vec::new();
    for operation in mounts {
        if let Err(error) = apply(operation) {
            let mut failures = Vec::new();
            for path in owned.into_iter().rev() {
                if let Err(cleanup) = undo(path) {
                    failures.push(cleanup.to_string());
                }
            }
            return if failures.is_empty() {
                Err(error)
            } else {
                Err(BoxliteError::Storage(format!(
                    "{error}; aggregate mount cleanup failed: {}",
                    failures.join("; ")
                )))
            };
        }
        match operation {
            Mount::Root { target, .. } | Mount::Bind { target, .. } => owned.push(target.as_path()),
            Mount::Legacy {
                target: Some(target),
                ..
            } => owned.push(target.as_path()),
            Mount::Legacy { target: None, .. } => {}
        }
    }
    Ok(owned.into_iter().map(Path::to_path_buf).collect())
}

/// Only explicitly marked aggregate batches use planning and rollback.
/// Legacy batches retain their input order and original failure semantics.
pub(crate) fn mount_volumes(volumes: &[Volume]) -> BoxliteResult<MountedVolumes> {
    let aggregate = volumes.iter().any(|volume| {
        matches!(&volume.source, Some(volume::Source::Virtiofs(fs))
            if !fs.device_tag.is_empty() || !fs.export_key.is_empty())
    });
    if !aggregate {
        super::mount_volumes(volumes)?;
        return Ok(MountedVolumes(Vec::new()));
    }
    execute(
        &plan(volumes)?,
        |operation| match operation {
            Mount::Root { tag, target } => {
                prepare_destination(target)?;
                VirtiofsMount::mount(tag, target, false)
            }
            Mount::Bind {
                source,
                target,
                read_only,
            } => bind(source, target, *read_only),
            Mount::Legacy { index, .. } => mount_volume(&volumes[*index]),
        },
        unmount,
    )
    .map(MountedVolumes)
}

fn prepare_destination(target: &Path) -> BoxliteResult<()> {
    let mut current = PathBuf::new();
    for component in target.components() {
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(BoxliteError::Storage(format!(
                    "Mount destination contains symlink: {}",
                    current.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current).map_err(|e| {
                    BoxliteError::Storage(format!("Create {}: {e}", current.display()))
                })?;
            }
            Err(error) => {
                return Err(BoxliteError::Storage(format!(
                    "Inspect {}: {error}",
                    current.display()
                )))
            }
        }
    }
    Ok(())
}

fn bind(source: &Path, target: &Path, read_only: bool) -> BoxliteResult<()> {
    prepare_destination(target)?;
    mount(
        Some(source),
        target,
        None::<&str>,
        MsFlags::MS_BIND,
        None::<&str>,
    )
    .map_err(|e| {
        BoxliteError::Storage(format!(
            "Bind {} to {}: {e}",
            source.display(),
            target.display()
        ))
    })?;
    if read_only {
        if let Err(error) = mount(
            None::<&str>,
            target,
            None::<&str>,
            MsFlags::MS_BIND | MsFlags::MS_REMOUNT | MsFlags::MS_RDONLY,
            None::<&str>,
        ) {
            let cleanup = unmount(target);
            return Err(BoxliteError::Storage(format!(
                "Read-only remount {}: {error}; cleanup: {cleanup:?}",
                target.display()
            )));
        }
    }
    Ok(())
}

fn unmount(path: &Path) -> BoxliteResult<()> {
    umount(path).map_err(|e| BoxliteError::Storage(format!("Unmount {}: {e}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn share(tag: &str, key: &str, target: &str) -> Volume {
        Volume {
            mount_point: target.into(),
            container_id: String::new(),
            source: Some(volume::Source::Virtiofs(boxlite_shared::VirtiofsSource {
                tag: tag.into(),
                device_tag: "boxlite".into(),
                export_key: key.into(),
                read_only: false,
            })),
        }
    }

    #[test]
    fn one_root_routes_exports_and_preserves_logical_destinations() {
        let mounts = plan(&[
            share(boxlite_shared::constants::mount_tags::SHARED, "shared", ""),
            share("vol0", "vol0", "/data"),
        ])
        .unwrap();
        assert_eq!(mounts.len(), 3);
        assert_eq!(
            mounts[0],
            Mount::Root {
                tag: "boxlite".into(),
                target: "/run/boxlite/virtiofs/0".into()
            }
        );
        assert_eq!(
            mounts[2],
            Mount::Bind {
                source: "/run/boxlite/virtiofs/0/shared".into(),
                target: "/run/boxlite/shared".into(),
                read_only: false
            }
        );
        assert_eq!(
            mounts[1],
            Mount::Bind {
                source: "/run/boxlite/virtiofs/0/vol0".into(),
                target: "/data".into(),
                read_only: false
            }
        );
    }

    #[test]
    fn parents_are_bound_before_children_regardless_of_input_order() {
        let mounts = plan(&[
            share("child", "child", "/data/nested"),
            share("parent", "parent", "/data"),
        ])
        .unwrap();
        let targets: Vec<_> = mounts
            .iter()
            .filter_map(|m| match m {
                Mount::Bind { target, .. } => Some(target.as_path()),
                _ => None,
            })
            .collect();
        assert_eq!(targets, vec![Path::new("/data"), Path::new("/data/nested")]);
    }

    #[test]
    fn invalid_identity_and_destinations_fail_before_mounting() {
        for key in ["", "..", "a/b", "a\0b"] {
            assert!(plan(&[share("shared", key, "/data")]).is_err());
        }
        for target in [
            "relative",
            "/",
            "/run/boxlite",
            "/run/boxlite/virtiofs/0",
            "/data/../other",
        ] {
            assert!(plan(&[share("shared", "shared", target)]).is_err());
        }
        assert!(plan(&[share("a", "a", "/data"), share("b", "b", "/data")]).is_err());
    }

    #[test]
    fn failure_unwinds_bindings_before_root_and_reports_cleanup_errors() {
        let mounts = plan(&[
            share(boxlite_shared::constants::mount_tags::SHARED, "shared", ""),
            share("vol0", "vol0", "/data"),
        ])
        .unwrap();
        let mut calls = 0;
        let mut undone = Vec::new();
        let error = execute(
            &mounts,
            |_| {
                calls += 1;
                if calls == 3 {
                    Err(BoxliteError::Storage("injected mount failure".into()))
                } else {
                    Ok(())
                }
            },
            |path| {
                undone.push(path.to_path_buf());
                Err(BoxliteError::Storage("injected cleanup failure".into()))
            },
        )
        .unwrap_err();
        assert_eq!(
            undone,
            vec![
                PathBuf::from("/data"),
                PathBuf::from("/run/boxlite/virtiofs/0")
            ]
        );
        assert!(error.to_string().contains("injected mount failure"));
        assert!(error.to_string().contains("injected cleanup failure"));
    }

    #[test]
    fn bind_mounts_enforce_read_only_and_rollback() {
        const CHILD: &str = "BOXLITE_AGGREGATE_MOUNT_TEST_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let status = std::process::Command::new("unshare")
                .args(["--user", "--map-root-user", "--mount"])
                .arg(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "storage::aggregate::tests::bind_mounts_enforce_read_only_and_rollback",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .status()
                .expect("start isolated mount test");
            assert!(status.success(), "mount namespace test failed: {status}");
            return;
        }
        mount(
            None::<&str>,
            Path::new("/"),
            None::<&str>,
            MsFlags::MS_REC | MsFlags::MS_PRIVATE,
            None::<&str>,
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let target = dir.path().join("target");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("file"), b"host bytes").unwrap();
        let alias = dir.path().join("alias");
        std::os::unix::fs::symlink(&source, &alias).unwrap();
        assert!(
            bind(&source, &alias.join("nested"), false).is_err(),
            "destination symlink must be rejected before creating or mounting"
        );
        assert!(!source.join("nested").exists());
        let operations = vec![
            Mount::Bind {
                source: source.clone(),
                target: target.clone(),
                read_only: true,
            },
            Mount::Bind {
                source: dir.path().join("missing"),
                target: dir.path().join("fail"),
                read_only: false,
            },
        ];
        let error = execute(
            &operations,
            |operation| {
                let Mount::Bind {
                    source,
                    target,
                    read_only,
                } = operation
                else {
                    unreachable!()
                };
                bind(source, target, *read_only)?;
                assert_eq!(std::fs::read(target.join("file")).unwrap(), b"host bytes");
                assert_eq!(
                    std::fs::write(target.join("file"), b"changed")
                        .unwrap_err()
                        .raw_os_error(),
                    Some(nix::libc::EROFS)
                );
                Ok(())
            },
            unmount,
        )
        .unwrap_err();
        assert!(error.to_string().contains("missing"));
        assert!(
            !target.join("file").exists(),
            "failed batch must unmount earlier binding"
        );
        assert_eq!(std::fs::read(source.join("file")).unwrap(), b"host bytes");
        bind(&source, &target, false).unwrap();
        std::fs::write(target.join("file"), b"guest bytes").unwrap();
        assert_eq!(std::fs::read(source.join("file")).unwrap(), b"guest bytes");
        {
            let _initializing = MountedVolumes(vec![target.clone()]);
        }
        assert!(
            !target.join("file").exists(),
            "later init failure drops aggregate ownership"
        );
        bind(&source, &target, false).unwrap();
        MountedVolumes(vec![target.clone()]).commit();
        assert!(
            target.join("file").exists(),
            "successful init retains the mount"
        );
        unmount(&target).unwrap();

        let parent = dir.path().join("parent");
        let child = dir.path().join("child");
        std::fs::create_dir_all(parent.join("nested")).unwrap();
        std::fs::create_dir(&child).unwrap();
        std::fs::write(child.join("marker"), b"child export").unwrap();
        let nested = target.join("nested");
        let mut operations = plan(&[
            share("child", "child", nested.to_str().unwrap()),
            share("parent", "parent", target.to_str().unwrap()),
        ])
        .unwrap();
        operations.retain(|op| matches!(op, Mount::Bind { .. }));
        for op in &mut operations {
            if let Mount::Bind {
                source,
                target: destination,
                ..
            } = op
            {
                *source = if destination == &target {
                    parent.clone()
                } else {
                    child.clone()
                };
            }
        }
        let owned = execute(
            &operations,
            |op| {
                let Mount::Bind {
                    source,
                    target,
                    read_only,
                } = op
                else {
                    unreachable!()
                };
                bind(source, target, *read_only)
            },
            unmount,
        )
        .unwrap();
        assert_eq!(
            std::fs::read(nested.join("marker")).unwrap(),
            b"child export"
        );
        drop(MountedVolumes(owned));
        assert!(!nested.join("marker").exists());
    }

    #[test]
    fn aggregate_parent_precedes_nested_legacy_mount() {
        let legacy = Volume {
            mount_point: "/run/boxlite/shared/disk".into(),
            container_id: String::new(),
            source: Some(volume::Source::BlockDevice(Default::default())),
        };
        let mounts = plan(&[
            legacy,
            share(boxlite_shared::constants::mount_tags::SHARED, "shared", ""),
        ])
        .unwrap();
        assert!(matches!(mounts[0], Mount::Root { .. }));
        assert!(matches!(mounts[1], Mount::Bind { .. }));
        assert!(matches!(mounts[2], Mount::Legacy { .. }));
        let owned = execute(&mounts, |_| Ok(()), |_| Ok(())).unwrap();
        assert_eq!(owned.last().unwrap(), Path::new("/run/boxlite/shared/disk"));
        let mut failing = mounts;
        failing.push(Mount::Legacy {
            index: 9,
            target: None,
        });
        let mut undone = Vec::new();
        assert!(execute(
            &failing,
            |operation| {
                if matches!(operation, Mount::Legacy { index: 9, .. }) {
                    Err(BoxliteError::Storage("later mount failed".into()))
                } else {
                    Ok(())
                }
            },
            |path| {
                undone.push(path.to_path_buf());
                Ok(())
            },
        )
        .is_err());
        assert_eq!(undone, owned.into_iter().rev().collect::<Vec<_>>());
    }

    #[test]
    fn legacy_batch_preserves_input_order_before_mounting() {
        let volume = |device: &str, target: &str| Volume {
            mount_point: target.into(),
            container_id: String::new(),
            source: Some(volume::Source::BlockDevice(
                boxlite_shared::BlockDeviceSource {
                    device: device.into(),
                    ..Default::default()
                },
            )),
        };
        let error = match mount_volumes(&[
            volume("/nonexistent-boxlite-first-device", "/data/nested"),
            volume("/nonexistent-boxlite-second-device", "/data"),
        ]) {
            Ok(_) => panic!("missing block device mounted"),
            Err(error) => error,
        };
        assert!(
            error
                .to_string()
                .contains("/nonexistent-boxlite-first-device"),
            "{error}"
        );
    }

    #[test]
    fn legacy_mounts_keep_their_original_dispatch() {
        let mut vol = share(boxlite_shared::constants::mount_tags::SHARED, "shared", "");
        if let Some(volume::Source::Virtiofs(fs)) = &mut vol.source {
            fs.device_tag.clear();
            fs.export_key.clear();
        }
        assert_eq!(
            plan(&[vol]).unwrap(),
            vec![Mount::Legacy {
                index: 0,
                target: Some(PathBuf::from("/run/boxlite/shared")),
            }]
        );
    }
}
