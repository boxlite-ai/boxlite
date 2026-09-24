//! Task: Container rootfs preparation.
//!
//! Pulls container image and prepares container rootfs:
//! - Disk-based: Creates ext4 disk image from merged layers (fast boot)
//! - Overlayfs: Extracts layers for guest-side overlayfs (flexible)
//!
//! For restart (reuse_rootfs=true), opens existing COW disk instead of creating new.

use super::{InitCtx, log_task_error, task_start};
use crate::disk::{BackingFormat, Disk, DiskFormat, Qcow2Helper};
use crate::images::{ContainerImageConfig, ImageDiskManager, ImageManager, ResolvedImage};
use crate::litebox::init::types::{ContainerRootfsPrepResult, USE_DISK_ROOTFS, USE_OVERLAYFS};
use crate::pipeline::PipelineTask;
use crate::runtime::layout::BoxFilesystemLayout;
use crate::runtime::options::RootfsSpec;
use crate::runtime::rt_impl::SharedRuntimeImpl;
use async_trait::async_trait;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

pub struct ContainerRootfsTask;

#[async_trait]
impl PipelineTask<InitCtx> for ContainerRootfsTask {
    async fn run(self: Box<Self>, ctx: InitCtx) -> BoxliteResult<()> {
        let task_name = self.name();
        let box_id = task_start(&ctx, task_name).await;

        let (
            rootfs_spec,
            env,
            runtime,
            layout,
            reuse_rootfs,
            disk_size_gb,
            entrypoint_override,
            cmd_override,
            user_override,
            working_dir_override,
            built_from,
        ) = {
            let ctx = ctx.lock().await;
            let layout = ctx
                .layout
                .clone()
                .ok_or_else(|| BoxliteError::Internal("filesystem task must run first".into()))?;
            let mut env = ctx.config.options.env.clone();
            // Inject secret placeholder env vars (e.g., BOXLITE_SECRET_OPENAI=<BOXLITE_SECRET:openai>).
            // The MITM proxy substitutes real values at the network boundary.
            env.extend(ctx.config.options.secrets.iter().map(|s| s.env_pair()));

            (
                ctx.config.options.rootfs.clone(),
                env,
                ctx.runtime.clone(),
                layout,
                ctx.reuse_rootfs,
                ctx.config.options.disk_size_gb,
                ctx.config.options.entrypoint.clone(),
                ctx.config.options.cmd.clone(),
                ctx.config.options.user.clone(),
                ctx.config.options.working_dir.clone(),
                ctx.built_from.clone(),
            )
        };

        let (container_image_config, disk, resolved_image) = run_container_rootfs(
            &rootfs_spec,
            &env,
            &runtime,
            &layout,
            reuse_rootfs,
            disk_size_gb,
            entrypoint_override.as_deref(),
            cmd_override.as_deref(),
            user_override.as_deref(),
            working_dir_override.as_deref(),
            built_from.as_ref(),
        )
        .await
        .inspect_err(|e| log_task_error(&box_id, task_name, e))?;

        let mut ctx = ctx.lock().await;
        ctx.container_image_config = Some(container_image_config);
        ctx.container_disk = Some(disk);
        ctx.resolved_image = resolved_image;

        Ok(())
    }

    fn name(&self) -> &str {
        "container_rootfs_prep"
    }
}

/// Pull image and prepare rootfs, then create or reuse COW disk.
#[allow(clippy::too_many_arguments)]
async fn run_container_rootfs(
    rootfs_spec: &RootfsSpec,
    env: &[(String, String)],
    runtime: &SharedRuntimeImpl,
    layout: &BoxFilesystemLayout,
    reuse_rootfs: bool,
    disk_size_gb: Option<u64>,
    entrypoint_override: Option<&[String]>,
    cmd_override: Option<&[String]>,
    user_override: Option<&str>,
    working_dir_override: Option<&str>,
    built_from: Option<&ResolvedImage>,
) -> BoxliteResult<(ContainerImageConfig, Disk, Option<ResolvedImage>)> {
    let disk_path = layout.disk_path();

    // For restart, reuse existing COW disk
    if reuse_rootfs {
        tracing::info!(
            disk_path = %disk_path.display(),
            "Restart mode: reusing existing container rootfs disk"
        );

        if !disk_path.exists() {
            return Err(BoxliteError::Storage(format!(
                "Cannot restart: container rootfs disk not found at {}",
                disk_path.display()
            )));
        }

        let disk = Disk::new(disk_path.clone(), DiskFormat::Qcow2, true);

        // Load container config
        let image = match rootfs_spec {
            RootfsSpec::Image(r) => {
                image_for_restart(&runtime.image_manager, r, built_from).await?
            }
            RootfsSpec::RootfsPath(path) => {
                let bundle_dir = std::path::Path::new(path);

                if !bundle_dir.exists() {
                    return Err(BoxliteError::Storage(format!(
                        "Rootfs path does not exist: {}",
                        path
                    )));
                }

                runtime
                    .image_manager
                    .load_from_local(bundle_dir.to_path_buf(), format!("local:{}", path))
                    .await?
            }
        };
        let image_config = image.load_config().await?;
        let mut container_image_config = ContainerImageConfig::from_oci_config(&image_config)?;
        if !env.is_empty() {
            container_image_config.merge_env(env.to_vec());
        }
        apply_user_overrides(
            &mut container_image_config,
            entrypoint_override,
            cmd_override,
            user_override,
            working_dir_override,
        );

        return Ok((
            container_image_config,
            disk,
            resolved_image_of(rootfs_spec, reuse_rootfs, &image),
        ));
    }

    // Fresh start: pull or load image
    let image = match rootfs_spec {
        RootfsSpec::Image(r) => image_for_new_disk(&runtime.image_manager, r).await?,
        RootfsSpec::RootfsPath(path) => {
            let bundle_dir = std::path::Path::new(path);

            if !bundle_dir.exists() {
                return Err(BoxliteError::Storage(format!(
                    "Rootfs path does not exist: {}",
                    path
                )));
            }

            runtime
                .image_manager
                .load_from_local(bundle_dir.to_path_buf(), format!("local:{}", path))
                .await?
        }
    };

    // Prepare rootfs from image
    let rootfs_result = if USE_DISK_ROOTFS {
        prepare_disk_rootfs(&runtime.image_disk_mgr, &image).await?
    } else if USE_OVERLAYFS {
        prepare_overlayfs_layers(&image).await?
    } else {
        return Err(BoxliteError::Storage(
            "Merged rootfs not supported. Use overlayfs or disk rootfs.".into(),
        ));
    };

    let image_config = image.load_config().await?;
    let mut container_image_config = ContainerImageConfig::from_oci_config(&image_config)?;

    if !env.is_empty() {
        container_image_config.merge_env(env.to_vec());
    }
    apply_user_overrides(
        &mut container_image_config,
        entrypoint_override,
        cmd_override,
        user_override,
        working_dir_override,
    );

    let disk = create_cow_disk(&rootfs_result, layout, disk_size_gb)?;

    Ok((
        container_image_config,
        disk,
        resolved_image_of(rootfs_spec, reuse_rootfs, &image),
    ))
}

/// Create COW disk from base rootfs.
///
/// # Arguments
/// * `rootfs_result` - Result of rootfs preparation (disk image or layers)
/// * `layout` - Box filesystem layout for disk paths
/// * `disk_size_gb` - Optional user-specified disk size in GB. If set, the COW disk
///   will have this virtual size (or the base disk size, whichever is larger).
fn create_cow_disk(
    rootfs_result: &ContainerRootfsPrepResult,
    layout: &crate::runtime::layout::BoxFilesystemLayout,
    disk_size_gb: Option<u64>,
) -> BoxliteResult<Disk> {
    match rootfs_result {
        ContainerRootfsPrepResult::DiskImage {
            base_disk_path,
            disk_size: base_disk_size,
        } => {
            // Calculate target disk size: use max of user-specified size and base disk size
            let target_disk_size = if let Some(size_gb) = disk_size_gb {
                let user_size_bytes = size_gb * 1024 * 1024 * 1024;
                std::cmp::max(user_size_bytes, *base_disk_size)
            } else {
                *base_disk_size
            };

            let cow_disk_path = layout.disk_path();
            let temp_disk = Qcow2Helper::create_cow_child_disk(
                base_disk_path,
                BackingFormat::Raw,
                &cow_disk_path,
                target_disk_size,
            )?;

            // Make disk persistent so it survives stop/restart
            // create_cow_child_disk returns non-persistent disk, but we want to preserve
            // COW disks across box restarts (only delete on remove)
            let disk_path = temp_disk.leak(); // Prevent cleanup
            let disk = Disk::new(disk_path, DiskFormat::Qcow2, true); // persistent=true

            tracing::info!(
                cow_disk = %cow_disk_path.display(),
                base_disk = %base_disk_path.display(),
                virtual_size_mb = target_disk_size / (1024 * 1024),
                "Created container rootfs COW overlay (persistent)"
            );

            Ok(disk)
        }
        ContainerRootfsPrepResult::Layers { .. } => Err(BoxliteError::Internal(
            "Layers mode requires overlayfs - disk creation not applicable".into(),
        )),
        ContainerRootfsPrepResult::Merged(_) => {
            Err(BoxliteError::Internal("Merged mode not supported".into()))
        }
    }
}

/// Apply user overrides to container image config (entrypoint, CMD, user,
/// and working dir) — the docker `run` override set, applied to the init
/// process configuration.
fn apply_user_overrides(
    config: &mut ContainerImageConfig,
    entrypoint_override: Option<&[String]>,
    cmd_override: Option<&[String]>,
    user_override: Option<&str>,
    working_dir_override: Option<&str>,
) {
    if let Some(ep) = entrypoint_override {
        config.entrypoint = ep.to_vec();
    }
    if let Some(cmd) = cmd_override {
        config.cmd = cmd.to_vec();
    }
    if let Some(user) = user_override {
        config.user = user.to_string();
    }
    if let Some(wd) = working_dir_override {
        config.working_dir = wd.to_string();
    }
}

/// The image a new disk is built from.
///
/// The one pull that decides what a box runs, so the one that asks the
/// registry: the cache is keyed by the ref string, and a tag cached here may
/// have moved since, or have been cached by someone else's box. A digest names
/// one build, so the cache is already the answer. `refresh` still starts from
/// the cache when the registry gives no answer, so an offline host behaves as
/// it did before.
///
/// A restart never comes here: it reads the build its disk was made from, see
/// [`image_for_restart`].
async fn image_for_new_disk(
    images: &ImageManager,
    image_ref: &str,
) -> BoxliteResult<crate::images::ImageObject> {
    if names_one_build(image_ref) {
        images.pull(image_ref).await
    } else {
        images.refresh(image_ref).await
    }
}

/// The image a restart reads its config from: the build its disk was made from.
///
/// A restart keeps its disk, so the entrypoint, env and user must come from
/// that same build. The ref alone does not say which one: a new box built from
/// a tag gets whatever the tag points to now, while the ref's cache entry keeps
/// the build this host first cached for it. The digest recorded when the disk
/// was built names the build, and the store indexes every pull under that
/// digest too, so this is still answered from the cache. A box with nothing
/// recorded — imported, or made by a release that recorded no build — reads by
/// ref, which for a box made here names the build this host first cached, the
/// one that release built its disk from. So does a box whose recorded build
/// cannot be read.
async fn image_for_restart(
    images: &ImageManager,
    image_ref: &str,
    built_from: Option<&ResolvedImage>,
) -> BoxliteResult<crate::images::ImageObject> {
    if let Some(pinned) = built_from.map(|build| pinned_ref(image_ref, &build.manifest_digest)) {
        match images.pull(&pinned).await {
            Ok(image) => return Ok(image),
            Err(e) => tracing::warn!(
                image_ref,
                pinned = %pinned,
                error = %e,
                "cannot read the build this box's disk was made from; reading the image by reference"
            ),
        }
    }
    images.pull(image_ref).await
}

/// `image_ref` pinned to `digest`: its registry and repository, any tag or
/// digest it carried replaced. Kept as written rather than normalised, so an
/// unqualified ref still resolves through the configured search registries.
fn pinned_ref(image_ref: &str, digest: &str) -> String {
    let name = image_ref
        .split_once('@')
        .map_or(image_ref, |(name, _)| name);
    // A colon after the last slash is a tag; one before it is a registry port.
    let name = match name.rsplit_once(':') {
        Some((repository, tag)) if !tag.contains('/') => repository,
        _ => name,
    };
    format!("{name}@{digest}")
}

/// Whether `image_ref` is pinned to a digest, and so names one build wherever
/// it is resolved. A ref that does not parse is left to the pull to reject.
fn names_one_build(image_ref: &str) -> bool {
    image_ref
        .parse::<oci_client::Reference>()
        .is_ok_and(|reference| reference.digest().is_some())
}

/// What to record about the image this start read, if anything.
fn resolved_image_of(
    rootfs_spec: &RootfsSpec,
    reuse_rootfs: bool,
    image: &crate::images::ImageObject,
) -> Option<ResolvedImage> {
    records_resolved_image(rootfs_spec, reuse_rootfs).then(|| ResolvedImage {
        manifest_digest: image.manifest_digest().to_string(),
        total_layer_size: image.total_layer_size(),
    })
}

/// Whether the image this start read is the one the box's disk was built from.
///
/// Only when this start built the disk. A restart keeps the disk an earlier
/// start made but reads the image again by reference, and a moving tag may by
/// then resolve to a different build — so what it read says nothing about what
/// the box runs, and recording it would overwrite the record that does.
///
/// And only for a registry pull. A local bundle's manifest digest is computed on
/// this host and names nothing a registry could resolve.
fn records_resolved_image(rootfs_spec: &RootfsSpec, reuse_rootfs: bool) -> bool {
    matches!(rootfs_spec, RootfsSpec::Image(_)) && !reuse_rootfs
}

async fn prepare_overlayfs_layers(
    image: &crate::images::ImageObject,
) -> BoxliteResult<ContainerRootfsPrepResult> {
    let layer_paths = image.layer_extracted().await?;

    if layer_paths.is_empty() {
        return Err(BoxliteError::Storage(
            "No layers found for overlayfs".into(),
        ));
    }

    let layers_dir = layer_paths[0]
        .parent()
        .ok_or_else(|| BoxliteError::Storage("Layer path has no parent directory".into()))?
        .to_path_buf();

    let layer_names: Vec<String> = layer_paths
        .iter()
        .map(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string()
        })
        .collect();

    tracing::info!(
        "Prepared {} layers for guest-side overlayfs",
        layer_names.len()
    );

    Ok(ContainerRootfsPrepResult::Layers {
        layers_dir,
        layer_names,
    })
}

/// Prepare disk-based rootfs from image via ImageDiskManager.
///
/// Delegates to ImageDiskManager which handles caching, layer merging,
/// and ext4 creation with staged atomic install.
async fn prepare_disk_rootfs(
    image_disk_mgr: &ImageDiskManager,
    image: &crate::images::ImageObject,
) -> BoxliteResult<ContainerRootfsPrepResult> {
    let disk = image_disk_mgr.get_or_create(image).await?;

    let disk_path = disk.path().to_path_buf();
    let disk_size = std::fs::metadata(&disk_path)
        .map(|m| m.len())
        .unwrap_or(64 * 1024 * 1024);

    // Ownership stays with cache — prevent drop cleanup
    let _ = disk.leak();

    Ok(ContainerRootfsPrepResult::DiskImage {
        base_disk_path: disk_path,
        disk_size,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        image_for_new_disk, image_for_restart, names_one_build, pinned_ref, records_resolved_image,
    };
    use crate::db::Database;
    use crate::images::test_support::{registry_answering, seed_cached_build};
    use crate::images::{ImageManager, ResolvedImage};
    use crate::runtime::options::{ImageRegistry, RootfsSpec};

    const DIGEST: &str = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const FIRST: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0";
    const NEWER: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee1";

    /// An image manager whose one registry answers 404 to everything, so any
    /// pull that asks it fails and only the cache can answer.
    async fn images_behind_a_404() -> (tempfile::TempDir, ImageManager, String) {
        let host = registry_answering(404).await;
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.db")).unwrap();
        let images = ImageManager::new(
            dir.path().join("images"),
            db,
            vec![ImageRegistry::http(&host)],
        )
        .unwrap();
        (dir, images, host)
    }

    fn recorded(digest: &str) -> ResolvedImage {
        ResolvedImage {
            manifest_digest: digest.to_string(),
            total_layer_size: 0,
        }
    }

    /// The cache may hold the tag, but a new disk still asks the registry.
    #[tokio::test]
    async fn a_new_disk_from_a_tag_asks_the_registry() {
        let (_dir, images, host) = images_behind_a_404().await;
        let tag = format!("{host}/acme/app:v1");
        seed_cached_build(&images, &tag, FIRST).await;

        let answer = image_for_new_disk(&images, &tag).await;

        assert!(answer.is_err(), "the registry's 404 must reach the caller");
    }

    #[tokio::test]
    async fn a_new_disk_from_a_digest_is_answered_from_the_cache() {
        let (_dir, images, host) = images_behind_a_404().await;
        let pinned = format!("{host}/acme/app@{FIRST}");
        seed_cached_build(&images, &pinned, FIRST).await;

        let image = image_for_new_disk(&images, &pinned).await.unwrap();

        assert_eq!(image.manifest_digest(), FIRST);
    }

    /// The tag's entry names another build; the restart reads its own.
    #[tokio::test]
    async fn a_restart_reads_the_build_its_disk_was_made_from() {
        let (_dir, images, host) = images_behind_a_404().await;
        let tag = format!("{host}/acme/app:v1");
        seed_cached_build(&images, &tag, FIRST).await;
        seed_cached_build(&images, &format!("{host}/acme/app@{NEWER}"), NEWER).await;

        let image = image_for_restart(&images, &tag, Some(&recorded(NEWER)))
            .await
            .unwrap();

        assert_eq!(image.manifest_digest(), NEWER);
    }

    /// A recorded build this host can no longer read — gone from the cache,
    /// and the registry will not give it back — leaves the ref to answer.
    #[tokio::test]
    async fn a_restart_whose_build_cannot_be_read_reads_by_ref() {
        let (_dir, images, host) = images_behind_a_404().await;
        let tag = format!("{host}/acme/app:v1");
        seed_cached_build(&images, &tag, FIRST).await;

        let image = image_for_restart(&images, &tag, Some(&recorded(NEWER)))
            .await
            .unwrap();

        assert_eq!(image.manifest_digest(), FIRST);
    }

    #[tokio::test]
    async fn a_restart_with_nothing_recorded_reads_by_ref() {
        let (_dir, images, host) = images_behind_a_404().await;
        let tag = format!("{host}/acme/app:v1");
        seed_cached_build(&images, &tag, FIRST).await;

        let image = image_for_restart(&images, &tag, None).await.unwrap();

        assert_eq!(image.manifest_digest(), FIRST);
    }

    /// A digest, with or without the tag it was read from, needs no registry.
    #[test]
    fn a_digest_names_one_build() {
        assert!(names_one_build(&format!("quay.io/acme/app@{DIGEST}")));
        assert!(names_one_build(&format!("quay.io/acme/app:v1@{DIGEST}")));
    }

    /// A tag, written or implied, may have moved since this host cached it.
    #[test]
    fn a_tag_does_not() {
        assert!(!names_one_build("quay.io/acme/app:v1"));
        assert!(!names_one_build("alpine"));
    }

    /// What a restart asks for: the same repository, at the recorded build.
    /// A registry port is not a tag, and an unqualified ref stays unqualified.
    #[test]
    fn a_restart_asks_for_the_recorded_build() {
        let already_pinned = format!("quay.io/acme/app:v1@sha256:{}", "f".repeat(64));
        for (image_ref, pinned) in [
            ("quay.io/acme/app:v1", format!("quay.io/acme/app@{DIGEST}")),
            ("quay.io/acme/app", format!("quay.io/acme/app@{DIGEST}")),
            (
                "127.0.0.1:25000/acme/app:v1",
                format!("127.0.0.1:25000/acme/app@{DIGEST}"),
            ),
            (
                "127.0.0.1:25000/acme/app",
                format!("127.0.0.1:25000/acme/app@{DIGEST}"),
            ),
            ("alpine:3.21", format!("alpine@{DIGEST}")),
            (
                already_pinned.as_str(),
                format!("quay.io/acme/app@{DIGEST}"),
            ),
        ] {
            assert_eq!(
                pinned_ref(image_ref, DIGEST),
                pinned,
                "image_ref={image_ref}"
            );
        }
    }

    #[test]
    fn the_start_that_builds_the_disk_records_what_it_pulled() {
        assert!(records_resolved_image(
            &RootfsSpec::Image("alpine:3.21".into()),
            false
        ));
    }

    /// A restart builds no disk, so what it reads says nothing about the build
    /// its disk was made from; that record stays the one the first start made.
    #[test]
    fn a_restart_records_nothing_because_it_built_nothing() {
        assert!(!records_resolved_image(
            &RootfsSpec::Image("alpine:3.21".into()),
            true
        ));
    }

    #[test]
    fn a_local_rootfs_names_nothing_a_registry_could_resolve() {
        assert!(!records_resolved_image(
            &RootfsSpec::RootfsPath("/tmp/bundle".into()),
            false
        ));
    }
}
