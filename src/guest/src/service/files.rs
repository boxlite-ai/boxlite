#![cfg(target_os = "linux")]
//! Files service implementation.
//!
//! Provides tar-based upload/download between host and the single container
//! running inside the guest.

use crate::service::server::GuestServer;
use crate::storage::attach::Attacher;
use boxlite_shared::errors::BoxliteError;
use boxlite_shared::{
    files_server::Files, BoxByteStream, DownloadChunk, DownloadRequest, UploadChunk, UploadResponse,
};
use futures::StreamExt;
use std::path::{Path, PathBuf};
use tokio::sync::{mpsc, OwnedRwLockReadGuard};
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status, Streaming};
use tracing::info;

// ── Refusal wording ───────────────────────────────────────────────
//
// A copy meets a mount in three places — the path the request names, a path an
// archive entry would land on, and a mount sitting inside a directory being read
// out — and each says so differently. The phrasing is a shipped contract, not
// decoration: `examples/python/02_features/copy_files.py` and
// `examples/node/cp_tmpfs_workaround.js` both *fail closed* on the
// `'<mount>' mount` fragment — matching a bare `/tmp` would also match the
// runtime's own staging tar path — so a rewording that drops it turns both demos
// into hard errors with nothing else going red. The three live together so a
// rewording of one is read next to the others, and
// [`tests::every_mount_refusal_names_the_mount_the_way_the_examples_match`] pins
// the fragment in each.

/// Why the path the request names cannot be transferred, and what to do instead.
fn unreachable_mount_message(in_container: &Path, mount: &Path) -> String {
    format!(
        "{} is under the container's '{}' mount, which file transfer cannot reach; \
         copy to a path outside '{}' (for example /workspace), or pipe a tar through \
         exec: exec([\"tar\", \"xf\", \"-\", \"-C\", \"{}\"])",
        in_container.display(),
        mount.display(),
        mount.display(),
        mount.display(),
    )
}

/// Why an archive entry cannot be written, when the destination root itself was
/// reachable but the payload would land under a mount.
fn unreachable_payload_message(landed: &Path, mount: &Path) -> String {
    format!(
        "this copy would write {} under the container's '{}' mount, which file \
         transfer cannot reach; copy to a path outside '{}', or pipe a tar through \
         exec: exec([\"tar\", \"xf\", \"-\", \"-C\", \"{}\"])",
        landed.display(),
        mount.display(),
        mount.display(),
        mount.display(),
    )
}

/// Why a directory cannot be read out, when a mount sits somewhere inside it.
fn unreadable_subtree_message(src_in_container: &Path, mount: &Path) -> String {
    format!(
        "{} contains the container's '{}' mount, which file transfer cannot read; \
         copying it would return the image's file rather than the one the box sees. \
         Copy a path that excludes '{}', or pipe a tar through exec: \
         exec([\"tar\", \"cf\", \"-\", \"-C\", \"{}\", \".\"])",
        src_in_container.display(),
        mount.display(),
        mount.display(),
        src_in_container.display(),
    )
}

/// The status an upload's extraction error goes back as: a mount refusal from
/// [`CopyTarget::payload_refusal`] as `failed_precondition`, like the other
/// mount refusals, and anything else as the landing classifies it.
fn payload_refusal_status(error: BoxliteError) -> Status {
    match error {
        BoxliteError::AlreadyExists(message) => Status::already_exists(message),
        BoxliteError::Unsupported(message) => Status::failed_precondition(message),
        error => error.into_validation_status(),
    }
}

/// Normalize a request path to how the container sees it: absolute, no `..`.
///
/// Mount destinations in the OCI spec are absolute, so comparisons only line up
/// once the request is expressed the same way.
#[allow(clippy::result_large_err)]
fn to_container_path(path: &str) -> Result<PathBuf, Status> {
    let path_obj = Path::new(path);
    if path_obj
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(Status::invalid_argument("path must not contain .."));
    }
    Ok(Path::new("/").join(path_obj.strip_prefix("/").unwrap_or(path_obj)))
}

/// The deepest mount destination that covers `path` (at or below it), if any.
///
/// Deepest so a message names `/dev/shm` rather than `/dev`.
fn deepest_covering(path: &Path, mounts: &[PathBuf]) -> Option<PathBuf> {
    mounts
        .iter()
        .filter(|mount| path.starts_with(mount))
        .max_by_key(|mount| mount.components().count())
        .cloned()
}

/// One request path resolved against one container.
///
/// Copying is only ever safe where the rootfs layer and the container's own
/// mount namespace agree, so every question a transfer asks — may I write
/// here, may I read this subtree, will this payload land somewhere the box
/// cannot see — is a question about the same pair: the path, and the mounts
/// that might hide it. Holding both together is what lets this answer them.
///
/// Resolved once per request. Previously each check re-derived the container
/// path and re-fetched the mount list behind two locks, and every call site
/// had to destructure a different tuple and pick the matching message; a
/// refusal now returns ready to `?`.
struct CopyTarget {
    /// The path as the container sees it: absolute, no `..`.
    in_container: PathBuf,
    /// Where that path lands on the guest-side rootfs directory.
    on_rootfs: PathBuf,
    /// Destinations of every mount in the container, including those added
    /// after creation by `Container.Mount`.
    mounts: Vec<PathBuf>,
    /// Keeps `Container.Mount` out until the copy ends, so `mounts` stays
    /// true for the whole transfer.
    _mount_gate: OwnedRwLockReadGuard<Attacher>,
}

impl CopyTarget {
    /// Resolve `path` for `container_id`, refusing it outright when a mount
    /// hides the path itself.
    ///
    /// File transfer works on the rootfs layer from outside the container's
    /// mount namespace. The container mounts a tmpfs over `/tmp` (and binds
    /// volumes elsewhere) *inside* that namespace, so a path at or below one of
    /// those destinations resolves to a different inode than the one any
    /// process in the box sees: writes land under the mount and are invisible
    /// forever, reads come back stale or missing. Refusing is the only honest
    /// answer available from out here — silently transferring the shadow is
    /// what made this a bug rather than a limitation.
    ///
    /// Refusing during construction rather than at each caller is deliberate:
    /// the rootfs path this hands back is only meaningful because it has
    /// already been proven reachable, so there is no way to hold one without
    /// the other.
    #[allow(clippy::result_large_err)]
    async fn resolve(server: &GuestServer, container_id: &str, path: &str) -> Result<Self, Status> {
        let in_container = to_container_path(path)?;
        let (mounts, mount_gate) = server.container_mounts(container_id).await?;

        if let Some(mount) = deepest_covering(&in_container, &mounts) {
            return Err(Status::failed_precondition(unreachable_mount_message(
                &in_container,
                &mount,
            )));
        }

        let rel = in_container.strip_prefix("/").unwrap_or(&in_container);
        let on_rootfs = server
            .layout
            .shared()
            .container(container_id)
            .rootfs_dir()
            .join(rel);

        Ok(Self {
            in_container,
            on_rootfs,
            mounts,
            _mount_gate: mount_gate,
        })
    }

    /// Where to read or write on the guest-side rootfs.
    fn on_rootfs(&self) -> &Path {
        &self.on_rootfs
    }

    /// A veto for landing paths relative to the destination, refusing entries
    /// hidden by a container mount.
    ///
    /// The root can be perfectly reachable while the payload is not:
    /// `copy_in(dir, "/etc")` where `dir` contains `hosts` would write the
    /// image's `/etc/hosts` beneath the bind, invisible to the box. Asked per
    /// entry so a single file to `/etc` — which lands at `/etc/motd.txt`,
    /// under no mount — still works. A refused entry is never written;
    /// entries before it stay. The refusal travels as `Unsupported`, which
    /// [`payload_refusal_status`] turns back into `failed_precondition`.
    fn payload_refusal(&self) -> impl Fn(&Path) -> Result<(), BoxliteError> + Send + Sync {
        let in_container = self.in_container.clone();
        let mounts = self.mounts.clone();
        move |relative: &Path| {
            let landed = in_container.join(relative);
            match deepest_covering(&landed, &mounts) {
                Some(mount) => Err(BoxliteError::Unsupported(unreachable_payload_message(
                    &landed, &mount,
                ))),
                None => Ok(()),
            }
        }
    }

    /// Refuse a read-out whose subtree contains a mount.
    ///
    /// Packing walks the rootfs layer, so a mount anywhere inside the source
    /// tree would be read through rather than seen — the archive would carry
    /// the image's file where the workload has the mount's. Same bug as the
    /// write direction, one level down, so it is refused the same way.
    #[allow(clippy::result_large_err)]
    fn refuse_shadowed_subtree(&self) -> Result<(), Status> {
        let deepest_below = self
            .mounts
            .iter()
            .filter(|mount| {
                mount.as_path() != self.in_container && mount.starts_with(&self.in_container)
            })
            .max_by_key(|mount| mount.components().count());

        match deepest_below {
            Some(mount) => Err(Status::failed_precondition(unreadable_subtree_message(
                &self.in_container,
                mount,
            ))),
            None => Ok(()),
        }
    }
}

#[tonic::async_trait]
impl Files for GuestServer {
    async fn upload(
        &self,
        request: Request<Streaming<UploadChunk>>,
    ) -> Result<Response<UploadResponse>, Status> {
        let mut stream = request.into_inner();

        // First chunk must carry dest_path (and optional container_id)
        let first = stream
            .message()
            .await?
            .ok_or_else(|| Status::invalid_argument("empty upload stream"))?;

        let dest_path = first.dest_path.clone();
        if dest_path.is_empty() {
            return Err(Status::invalid_argument(
                "dest_path is required in first chunk",
            ));
        }
        let container_id = self
            .resolve_container_id(first.container_id.as_str())
            .await
            .map_err(Status::failed_precondition)?;

        // Resolves the destination and refuses it if a mount hides it.
        let dest = CopyTarget::resolve(self, &container_id, &dest_path).await?;
        let dest_root = dest.on_rootfs().to_path_buf();

        // Overwrite / mkdir flags
        let mkdir_parents = first.mkdir_parents;
        let overwrite = first.overwrite;
        let container = self
            .containers
            .lock()
            .await
            .get(&container_id)
            .cloned()
            .ok_or_else(|| {
                Status::failed_precondition(format!("container not found: {container_id}"))
            })?;
        let owner = container.lock().await.user();
        let first_data = first.data;
        // The archive's first entry decides how it lands; only a trailing
        // '/' the resolved path dropped has to be passed along.
        let force_directory = dest_path.ends_with('/');
        let tar_stream: BoxByteStream = Box::pin(async_stream::stream! {
            if !first_data.is_empty() {
                yield Ok(first_data);
            }
            loop {
                match stream.message().await {
                    Ok(Some(chunk)) => {
                        if !chunk.data.is_empty() {
                            yield Ok(chunk.data);
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        yield Err(std::io::Error::other(e));
                        break;
                    }
                }
            }
        });

        boxlite_shared::tar::unpack_stream_owned(
            tar_stream,
            dest_root.clone(),
            boxlite_shared::tar::UnpackContext {
                overwrite,
                mkdir_parents,
                force_directory,
            },
            // Parent resolution must stay inside the container rootfs.
            self.layout
                .shared()
                .container(&container_id)
                .rootfs_dir()
                .to_path_buf(),
            owner,
            dest.payload_refusal(),
        )
        .await
        .map_err(payload_refusal_status)?;

        info!(dest = %dest_root.display(), container_id = %container_id, "upload completed");
        Ok(Response::new(UploadResponse {
            success: true,
            error: None,
        }))
    }

    type DownloadStream = ReceiverStream<Result<DownloadChunk, Status>>;

    async fn download(
        &self,
        request: Request<DownloadRequest>,
    ) -> Result<Response<Self::DownloadStream>, Status> {
        let req = request.into_inner();
        if req.src_path.is_empty() {
            return Err(Status::invalid_argument("src_path is required"));
        }
        let container_id = self
            .resolve_container_id(req.container_id.as_str())
            .await
            .map_err(Status::failed_precondition)?;

        let src = CopyTarget::resolve(self, &container_id, &req.src_path).await?;
        let src_path = src.on_rootfs().to_path_buf();
        if !src_path.exists() {
            return Err(Status::not_found("source path does not exist"));
        }

        if src_path.is_dir() {
            src.refuse_shadowed_subtree()?;
        }

        let include_parent = req.include_parent;
        let follow_symlinks = req.follow_symlinks;

        // Stream the tar directly from disk (no temp file). Its first entry
        // tells the receiver how it lands.
        let tar_stream = boxlite_shared::tar::pack_stream(
            src_path,
            boxlite_shared::tar::PackContext {
                follow_symlinks,
                include_parent,
            },
        )
        .await
        .map_err(|e| Status::internal(e.to_string()))?;

        let (tx, rx) = mpsc::channel::<Result<DownloadChunk, Status>>(4);
        tokio::spawn(async move {
            let mut stream = tar_stream;
            while let Some(item) = stream.next().await {
                match item {
                    Ok(data) => {
                        let chunk = DownloadChunk { data };
                        if tx.send(Ok(chunk)).await.is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(Status::internal(e.to_string()))).await;
                        break;
                    }
                }
            }
        });

        info!(
            src = %req.src_path,
            container_id = %container_id,
            "download started"
        );

        Ok(Response::new(ReceiverStream::new(rx)))
    }
}

impl GuestServer {
    async fn resolve_container_id(&self, requested: &str) -> Result<String, String> {
        if !requested.is_empty() {
            return Ok(requested.to_string());
        }

        let containers = self.containers.lock().await;
        if containers.len() == 1 {
            if let Some((id, _)) = containers.iter().next() {
                return Ok(id.clone());
            }
        }
        Err("container_id required when multiple containers present".into())
    }

    /// Hold the mount gate while sampling the destinations visible to a copy.
    ///
    /// Also returns the read side of the container's mount lock, taken before
    /// the list is read and without holding the container's own lock, the same
    /// order `Container.Mount` takes them. While a copy holds it, no mount can
    /// land under a path the list said was reachable.
    #[allow(clippy::result_large_err)]
    async fn container_mounts(
        &self,
        container_id: &str,
    ) -> Result<(Vec<PathBuf>, OwnedRwLockReadGuard<Attacher>), Status> {
        let container_arc = {
            let containers = self.containers.lock().await;
            containers.get(container_id).cloned().ok_or_else(|| {
                Status::failed_precondition(format!("container not found: {container_id}"))
            })?
        };
        let attacher = container_arc.lock().await.attacher();
        let mount_gate = attacher.read_owned().await;
        let mounts = container_arc.lock().await.mount_destinations().to_vec();
        Ok((mounts, mount_gate))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use boxlite_shared::tar;
    use std::sync::Arc;

    /// `/etc` holds the `/etc/hosts` bind but is not itself a mount, so naming
    /// it is fine — only paths at or below a mount are unreachable.
    #[test]
    fn only_paths_at_or_below_a_mount_are_covered() {
        let mounts = [PathBuf::from("/tmp"), PathBuf::from("/etc/hosts")];

        assert_eq!(
            deepest_covering(Path::new("/tmp/x"), &mounts),
            Some(PathBuf::from("/tmp"))
        );
        assert_eq!(deepest_covering(Path::new("/etc"), &mounts), None);
        assert_eq!(deepest_covering(Path::new("/tmpfoo"), &mounts), None);
    }

    /// Deepest wins so the message names the mount that actually blocks.
    #[test]
    fn the_deepest_covering_mount_is_reported() {
        let mounts = [PathBuf::from("/dev"), PathBuf::from("/dev/shm")];

        assert_eq!(
            deepest_covering(Path::new("/dev/shm/x"), &mounts),
            Some(PathBuf::from("/dev/shm"))
        );
    }

    /// A `CopyTarget` for `in_container`, with no rootfs behind it — enough to
    /// exercise the reachability checks, which read only the path and the mounts.
    fn target(in_container: &str, mounts: &[&str]) -> CopyTarget {
        CopyTarget {
            in_container: PathBuf::from(in_container),
            on_rootfs: PathBuf::from("/unused"),
            mounts: mounts.iter().map(PathBuf::from).collect(),
            _mount_gate: Arc::new(tokio::sync::RwLock::new(Attacher::default()))
                .try_read_owned()
                .unwrap(),
        }
    }

    /// A copy holds the mount lock from reading the mount list until it ends,
    /// so a `Container.Mount` cannot land under the copy meanwhile.
    #[tokio::test]
    async fn a_mount_waits_for_a_copy_in_progress() {
        let dir = tempfile::tempdir().unwrap();
        let server = GuestServer::new(crate::layout::GuestLayout::with_base(dir.path()));
        let container = crate::container::Container::for_unit_test(
            "c1",
            dir.path().join("state"),
            dir.path().join("bundle"),
        );
        let mount_lock = container.attacher();
        server.containers.lock().await.insert(
            "c1".to_string(),
            Arc::new(tokio::sync::Mutex::new(container)),
        );

        let copy = CopyTarget::resolve(&server, "c1", "/srv/data")
            .await
            .unwrap();
        assert!(
            Arc::clone(&mount_lock).try_write_owned().is_err(),
            "a mount waits while the copy runs"
        );

        drop(copy);
        assert!(
            mount_lock.try_write_owned().is_ok(),
            "and goes ahead once the copy ends"
        );
    }

    /// A reachable destination does not make its payload reachable:
    /// `copy_in(dir, "/etc")` carrying `hosts` lands on the image's shadowed
    /// `/etc/hosts`, not the bind the workload reads.
    #[test]
    fn an_entry_landing_under_a_mount_is_refused_though_the_root_was_fine() {
        let etc = target("/etc", &["/etc/hosts", "/tmp"]);

        // The root itself is clear — `/etc` merely contains a mount.
        assert!(deepest_covering(Path::new("/etc"), &etc.mounts).is_none());

        let refuse = etc.payload_refusal();
        let err = payload_refusal_status(
            refuse(Path::new("hosts")).expect_err("an entry landing on the bind must be refused"),
        );
        assert_eq!(err.code(), tonic::Code::FailedPrecondition, "{err:?}");
        assert!(err.message().contains("'/etc/hosts' mount"), "{err:?}");

        refuse(Path::new("motd.txt")).expect("an entry under no mount still copies");
    }

    /// Reading out a directory that *contains* a mount would tar the shadowed
    /// image file. A path that IS a mount is the other check's job, so it must
    /// not also trip this one — otherwise the two would report the same refusal
    /// twice with different wording.
    #[test]
    fn a_directory_holding_a_mount_cannot_be_read_out() {
        let err = target("/etc", &["/etc/hosts"])
            .refuse_shadowed_subtree()
            .expect_err("a mount inside the source tree must be refused");
        assert!(err.message().contains("'/etc/hosts' mount"), "{err:?}");

        target("/tmp", &["/tmp"])
            .refuse_shadowed_subtree()
            .expect("a path that is itself a mount is not a mount *below* it");

        target("/workspace", &["/tmp"])
            .refuse_shadowed_subtree()
            .expect("an unrelated mount does not block the read");
    }

    /// The refusal wording is a shipped contract, not prose. Both copy examples
    /// fail closed on the `'<mount>' mount` fragment (a bare `/tmp` would also
    /// match the runtime's own staging tar path), so a rewording that drops it
    /// breaks them with nothing else going red.
    ///
    /// All three refusals, not just the one the examples happen to trigger: a
    /// caller taught to match that fragment meets whichever of the three its
    /// copy runs into, and the payload and subtree wordings are the ones no
    /// test had ever read.
    #[test]
    fn every_mount_refusal_names_the_mount_the_way_the_examples_match() {
        let refusals = [
            (
                "request path",
                unreachable_mount_message(Path::new("/tmp/ghost.txt"), Path::new("/tmp")),
            ),
            (
                "archive entry",
                unreachable_payload_message(Path::new("/tmp/ghost.txt"), Path::new("/tmp")),
            ),
            (
                "subtree read out",
                unreadable_subtree_message(Path::new("/"), Path::new("/tmp")),
            ),
        ];

        for (site, message) in refusals {
            assert!(
                message.contains("'/tmp' mount"),
                "the {site} refusal drops the fragment \
                 examples/python/02_features/copy_files.py and \
                 examples/node/cp_tmpfs_workaround.js match exactly: {message}"
            );
        }
    }

    async fn extract(dest: &Path, bytes: Vec<u8>, overwrite: bool) -> Result<(), BoxliteError> {
        tar::unpack_stream_owned(
            Box::pin(tokio_stream::iter([Ok(bytes)])),
            dest.to_path_buf(),
            tar::UnpackContext {
                overwrite,
                mkdir_parents: true,
                force_directory: false,
            },
            PathBuf::from("/"),
            (
                nix::unistd::Uid::current().as_raw(),
                nix::unistd::Gid::current().as_raw(),
            ),
            |_| Ok(()),
        )
        .await
    }

    async fn packed(source: &Path, include_parent: bool) -> Vec<u8> {
        let archive = tempfile::NamedTempFile::new().unwrap();
        tar::pack(
            source.to_path_buf(),
            archive.path().to_path_buf(),
            tar::PackContext {
                follow_symlinks: false,
                include_parent,
            },
        )
        .await
        .unwrap();
        std::fs::read(archive.path()).unwrap()
    }

    #[tokio::test]
    async fn extraction_preserves_image_directories_and_file_permissions() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let tmp = tempfile::tempdir().unwrap();
        let rootfs = tmp.path().join("rootfs");
        let dest = rootfs.join("local");
        std::fs::create_dir_all(dest.join("bin")).unwrap();
        std::fs::set_permissions(dest.join("bin"), std::fs::Permissions::from_mode(0o751)).unwrap();
        let before = std::fs::metadata(dest.join("bin")).unwrap();
        let source = tmp.path().join("source");
        std::fs::create_dir_all(source.join("bin")).unwrap();
        std::fs::write(source.join("bin/tool"), b"payload").unwrap();
        std::fs::set_permissions(
            source.join("bin/tool"),
            std::fs::Permissions::from_mode(0o640),
        )
        .unwrap();
        extract(&dest, packed(&source, false).await, false)
            .await
            .unwrap();
        let after = std::fs::metadata(dest.join("bin")).unwrap();
        assert_eq!(
            (after.uid(), after.gid(), after.mode()),
            (before.uid(), before.gid(), before.mode())
        );
        assert_eq!(std::fs::read(dest.join("bin/tool")).unwrap(), b"payload");
        assert_eq!(
            std::fs::metadata(dest.join("bin/tool")).unwrap().mode() & 0o777,
            0o640
        );
    }

    #[tokio::test]
    async fn extraction_follows_image_directory_symlinks_in_request_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let rootfs = tmp.path().join("rootfs");
        std::fs::create_dir_all(rootfs.join("usr/lib")).unwrap();
        std::os::unix::fs::symlink("usr/lib", rootfs.join("lib")).unwrap();
        let source = tmp.path().join("tool");
        std::fs::write(&source, b"payload").unwrap();
        extract(&rootfs.join("lib"), packed(&source, true).await, true)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(rootfs.join("usr/lib/tool")).unwrap(),
            b"payload"
        );
    }

    #[tokio::test]
    async fn extraction_copies_a_symlink_without_modifying_its_target() {
        let tmp = tempfile::tempdir().unwrap();
        let rootfs = tmp.path().join("rootfs");
        std::fs::create_dir(&rootfs).unwrap();
        std::fs::write(rootfs.join("target"), b"image payload").unwrap();
        let source = tmp.path().join("source");
        std::os::unix::fs::symlink("target", &source).unwrap();
        extract(&rootfs.join("link"), packed(&source, true).await, true)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_link(rootfs.join("link")).unwrap(),
            Path::new("target")
        );
        assert_eq!(
            std::fs::read(rootfs.join("target")).unwrap(),
            b"image payload"
        );
    }

    #[tokio::test]
    async fn empty_upload_preserves_files_and_creates_no_parents() {
        let tmp = tempfile::tempdir().unwrap();
        let rootfs = tmp.path();
        let dest = rootfs.join("payload");
        std::fs::write(&dest, b"existing").unwrap();
        for overwrite in [false, true] {
            extract(&dest, vec![0; 1024], overwrite).await.unwrap();
            extract(
                &rootfs.join("missing/parent/file"),
                vec![0; 1024],
                overwrite,
            )
            .await
            .unwrap();
            assert_eq!(std::fs::read(&dest).unwrap(), b"existing");
            assert!(!rootfs.join("missing").exists());
        }
    }

    #[tokio::test]
    async fn partial_conflict_preserves_completed_payload_and_permissions() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let tmp = tempfile::tempdir().unwrap();
        let rootfs = tmp.path().join("rootfs");
        std::fs::create_dir(&rootfs).unwrap();
        let first = tmp.path().join("first");
        let conflict = tmp.path().join("conflict");
        std::fs::write(&first, b"completed").unwrap();
        std::fs::set_permissions(&first, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::write(&conflict, b"replacement").unwrap();
        std::fs::write(rootfs.join("conflict"), b"existing").unwrap();
        // Each packed file has one 512-byte header and one padded data block.
        let mut bytes = packed(&first, true).await;
        bytes.truncate(1024);
        bytes.extend(packed(&conflict, true).await);
        let error = extract(&rootfs, bytes, false).await.unwrap_err();
        assert_eq!(
            payload_refusal_status(error).code(),
            tonic::Code::AlreadyExists
        );
        assert_eq!(std::fs::read(rootfs.join("first")).unwrap(), b"completed");
        let completed = std::fs::metadata(rootfs.join("first")).unwrap();
        assert_eq!(completed.mode() & 0o777, 0o600);
        assert_eq!(
            (completed.uid(), completed.gid()),
            (
                nix::unistd::Uid::current().as_raw(),
                nix::unistd::Gid::current().as_raw()
            )
        );
        assert_eq!(std::fs::read(rootfs.join("conflict")).unwrap(), b"existing");
    }

    #[tokio::test]
    async fn extraction_creates_parents_and_replaces_existing_file_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let rootfs = tmp.path().join("rootfs");
        std::fs::create_dir(&rootfs).unwrap();
        let source = tmp.path().join("source");
        std::fs::write(&source, b"new payload").unwrap();
        let dest = rootfs.join("srv/probe/payload");
        let bytes = packed(&source, true).await;
        extract(&dest, bytes.clone(), true).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"new payload");
        std::fs::write(&dest, b"old payload").unwrap();
        extract(&dest, bytes, true).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"new payload");

        let empty = tmp.path().join("empty");
        std::fs::create_dir(&empty).unwrap();
        for include_parent in [false, true] {
            let dest = rootfs.join(format!("empty-{include_parent}/dest"));
            extract(&dest, packed(&empty, include_parent).await, true)
                .await
                .unwrap();
            assert!(dest.is_dir());
        }
    }

    #[test]
    fn container_paths_are_absolute_and_reject_parent_dirs() {
        assert_eq!(
            to_container_path("/tmp/x").unwrap(),
            PathBuf::from("/tmp/x")
        );
        assert_eq!(to_container_path("tmp/x").unwrap(), PathBuf::from("/tmp/x"));
        assert!(to_container_path("/a/../b").is_err());
    }
}
