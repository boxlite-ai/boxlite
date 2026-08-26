#![cfg(target_os = "linux")]
//! Files service implementation.
//!
//! Provides tar-based upload/download between host and the single container
//! running inside the guest.

use crate::service::server::GuestServer;
use boxlite_shared::{
    files_server::Files, DownloadChunk, DownloadRequest, UploadChunk, UploadResponse,
};
use std::path::{Path, PathBuf};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status, Streaming};
use tracing::info;

const CHUNK_SIZE: usize = 1 << 20; // 1 MiB
const MAX_UPLOAD_BYTES: u64 = 512 * 1024 * 1024; // 512 MiB safety cap

/// Ancestors of `path`, outermost first, that do not exist yet.
///
/// Sampled before extraction so the directories `mkdir_parents` conjures can be
/// told apart from ones the image already shipped.
fn missing_ancestors(path: &Path) -> Vec<PathBuf> {
    let mut missing: Vec<PathBuf> = path
        .ancestors()
        .skip(1)
        .take_while(|ancestor| !ancestor.exists())
        .map(Path::to_path_buf)
        .collect();
    missing.reverse();
    missing
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

/// Paths the archive carries, relative to the extraction root.
///
/// The tar comes from the caller, so its entry names are untrusted: an entry
/// may be absolute (`/etc/shadow`) or climb out (`../../x`). Extraction already
/// refuses both — tar-rs strips a leading `/` and drops `..` entries — so this
/// applies the same rule, or a later `dest.join(rel)` would escape the
/// destination entirely (`Path::join` discards the base when handed an absolute
/// path) and hand a root-privileged chown a file nothing here wrote.
///
/// Header-only pass — no payload is read. Returns empty on a malformed archive
/// rather than failing: extraction has already succeeded by the time this runs,
/// and the worst case is that ownership is left alone.
fn archive_entry_paths(tar_path: &Path) -> Vec<PathBuf> {
    let Ok(file) = std::fs::File::open(tar_path) else {
        return Vec::new();
    };
    let mut archive = tar::Archive::new(file);
    let Ok(entries) = archive.entries() else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.path().ok().map(|p| p.into_owned()))
        .filter_map(|path| sanitize_entry_path(&path))
        .collect()
}

/// An archive entry name reduced to what extraction would actually create.
///
/// Mirrors tar-rs's own rule (`entry.rs`: `RootDir => continue`,
/// `ParentDir => return Ok(false)`): drop the leading `/`, refuse anything
/// containing `..`. `None` means extraction skipped it, so nothing downstream
/// should touch it either.
fn sanitize_entry_path(path: &Path) -> Option<PathBuf> {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            // Leading `/` and `.` are dropped by extraction, not rejected.
            Component::RootDir | Component::CurDir => continue,
            Component::ParentDir | Component::Prefix(_) => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
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

        // Build absolute dest root under container rootfs
        let in_container = to_container_path(&dest_path)?;
        let dest_root = self.container_rootfs(&container_id, &dest_path).await?;

        // Overwrite / mkdir flags
        let mkdir_parents = first.mkdir_parents;
        let overwrite = first.overwrite;

        // Temp file to hold tar stream
        let temp_path =
            std::env::temp_dir().join(format!("boxlite-upload-{}.tar", uuid::Uuid::new_v4()));
        let mut file = File::create(&temp_path)
            .await
            .map_err(|e| Status::internal(format!("failed to create temp file: {}", e)))?;

        // write first data chunk if present
        let mut total: u64 = 0;
        if !first.data.is_empty() {
            total += first.data.len() as u64;
            if total > MAX_UPLOAD_BYTES {
                return Err(Status::resource_exhausted("upload too large"));
            }
            file.write_all(&first.data)
                .await
                .map_err(|e| Status::internal(format!("failed to write temp file: {}", e)))?;
        }

        // stream remaining chunks
        while let Some(chunk) = stream.message().await? {
            let len = chunk.data.len() as u64;
            total += len;
            if total > MAX_UPLOAD_BYTES {
                return Err(Status::resource_exhausted("upload too large"));
            }
            file.write_all(&chunk.data)
                .await
                .map_err(|e| Status::internal(format!("failed to write temp file: {}", e)))?;
        }

        file.flush()
            .await
            .map_err(|e| Status::internal(format!("failed to flush temp file: {}", e)))?;

        // The root cleared the mount check, but individual entries may still
        // land under one. Refuse before touching the rootfs — a partially
        // applied copy is worse than a refused one.
        if let Some((landed, mount)) = self
            .shadowed_payload(&container_id, &in_container, &temp_path)
            .await?
        {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(Status::failed_precondition(format!(
                "this copy would write {} under the container's '{}' mount, which file \
                 transfer cannot reach; copy to a path outside '{}', or pipe a tar through \
                 exec: exec([\"tar\", \"xf\", \"-\", \"-C\", \"{}\"])",
                landed.display(),
                mount.display(),
                mount.display(),
                mount.display(),
            )));
        }

        // What does not exist yet — unpack is about to create it, and it needs
        // the same owner as the payload. Must be sampled *before* extraction,
        // since afterwards there is no way to tell what we made from what the
        // image already shipped.
        let created_dirs = missing_ancestors(&dest_root);
        let dest_root_existed = dest_root.exists();

        // Extract tar using shared logic
        // The original dest_path may have trailing '/' indicating directory mode,
        // but the resolved rootfs path won't. Use force_directory in that case.
        let force_directory = dest_path.ends_with('/');
        boxlite_shared::tar::unpack(
            temp_path.clone(),
            dest_root.clone(),
            boxlite_shared::tar::UnpackContext {
                overwrite,
                mkdir_parents,
                force_directory,
            },
        )
        .await
        .map_err(|e| Status::internal(e.to_string()))?;

        // Hand the payload to the user the box actually runs as. tar preserves
        // neither owner (it extracts as this process, root) nor any notion of
        // who will read the file, so without this every copy_in lands
        // root-owned and a non-root workload cannot open it.
        self.chown_to_container_user(
            &container_id,
            &dest_root,
            &temp_path,
            &created_dirs,
            dest_root_existed,
        )
        .await;

        let _ = tokio::fs::remove_file(&temp_path).await;

        info!(
            dest = %dest_root.display(),
            bytes = total,
            container_id = %container_id,
            "upload completed"
        );

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

        let src_path = self.container_rootfs(&container_id, &req.src_path).await?;
        if !src_path.exists() {
            return Err(Status::not_found("source path does not exist"));
        }

        // Packing walks the rootfs layer, so a mount anywhere inside the source
        // tree would be read through rather than seen — the archive would carry
        // the image's file where the workload has the mount's.
        let src_in_container = to_container_path(&req.src_path)?;
        if src_path.is_dir() {
            if let Some(mount) = self
                .shadowed_subtree(&container_id, &src_in_container)
                .await?
            {
                return Err(Status::failed_precondition(format!(
                    "{} contains the container's '{}' mount, which file transfer cannot read; \
                     copying it would return the image's file rather than the one the box sees. \
                     Copy a path that excludes '{}', or pipe a tar through exec: \
                     exec([\"tar\", \"cf\", \"-\", \"-C\", \"{}\", \".\"])",
                    src_in_container.display(),
                    mount.display(),
                    mount.display(),
                    src_in_container.display(),
                )));
            }
        }

        // Build tar into temp file
        let temp_path =
            std::env::temp_dir().join(format!("boxlite-download-{}.tar", uuid::Uuid::new_v4()));

        let include_parent = req.include_parent;
        let follow_symlinks = req.follow_symlinks;

        boxlite_shared::tar::pack(
            src_path,
            temp_path.clone(),
            boxlite_shared::tar::PackContext {
                follow_symlinks,
                include_parent,
            },
        )
        .await
        .map_err(|e| Status::internal(e.to_string()))?;

        // Stream file contents
        let (tx, rx) = mpsc::channel::<Result<DownloadChunk, Status>>(4);
        tokio::spawn(async move {
            let mut file = match File::open(&temp_path).await {
                Ok(f) => f,
                Err(e) => {
                    let _ = tx
                        .send(Err(Status::internal(format!(
                            "open temp tar failed: {}",
                            e
                        ))))
                        .await;
                    return;
                }
            };
            let mut buf = vec![0u8; CHUNK_SIZE];
            loop {
                match file.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx
                            .send(Ok(DownloadChunk {
                                data: buf[..n].to_vec(),
                            }))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = tx
                            .send(Err(Status::internal(format!(
                                "read temp tar failed: {}",
                                e
                            ))))
                            .await;
                        break;
                    }
                }
            }
            let _ = tokio::fs::remove_file(&temp_path).await;
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

    /// Resolve a container path against the rootfs directory, refusing any path
    /// a mount would hide.
    ///
    /// File transfer works on the rootfs layer from outside the container's
    /// mount namespace. The container mounts a tmpfs over `/tmp` (and binds
    /// volumes elsewhere) *inside* that namespace, so a path at or below one of
    /// those destinations resolves to a different inode than the one any
    /// process in the box sees: writes land under the mount and are invisible
    /// forever, reads come back stale or missing. Refusing is the only honest
    /// answer available from out here — silently transferring the shadow is
    /// what made this a bug rather than a limitation.
    async fn container_rootfs(&self, container_id: &str, path: &str) -> Result<PathBuf, Status> {
        let in_container = to_container_path(path)?;
        let rel = in_container.strip_prefix("/").unwrap_or(&in_container);
        if let Some(mount) = self.shadowing_mount(container_id, &in_container).await? {
            return Err(Status::failed_precondition(format!(
                "{} is under the container's '{}' mount, which file transfer cannot reach; \
                 copy to a path outside '{}' (for example /workspace), or pipe a tar through \
                 exec: exec([\"tar\", \"xf\", \"-\", \"-C\", \"{}\"])",
                in_container.display(),
                mount.display(),
                mount.display(),
                mount.display(),
            )));
        }

        let guest_layout = self.layout.shared().container(container_id);
        Ok(guest_layout.rootfs_dir().join(rel))
    }

    /// Give everything this upload created to the container's own user.
    ///
    /// Scope is exactly what we wrote: every entry the archive carried, the
    /// parent directories extraction had to create, and the destination itself
    /// only when we made it. A destination directory that the image already
    /// shipped is left alone — `copy_in("./x", "/usr/local/bin/")` must not
    /// hand `/usr/local/bin` to the box user. A destination *file* is always
    /// ours, existing or not, because extraction just overwrote it.
    ///
    /// Best-effort throughout: the bytes are already on disk by the time this
    /// runs, so a failure here must not be reported as the copy failing.
    async fn chown_to_container_user(
        &self,
        container_id: &str,
        dest_root: &Path,
        tar_path: &Path,
        created_dirs: &[PathBuf],
        dest_root_existed: bool,
    ) {
        let container_arc = {
            let containers = self.containers.lock().await;
            containers.get(container_id).cloned()
        };
        let Some(container_arc) = container_arc else {
            tracing::warn!(
                container_id = %container_id,
                "container vanished before copied files could be given to its user"
            );
            return;
        };
        let (uid, gid) = {
            let container = container_arc.lock().await;
            container.user()
        };
        if (uid, gid) == (0, 0) {
            return;
        }

        let mut targets: Vec<PathBuf> = created_dirs.to_vec();
        let dest_is_dir = dest_root.is_dir();
        if !dest_is_dir || !dest_root_existed {
            targets.push(dest_root.to_path_buf());
        }
        targets.extend(archive_entry_paths(tar_path).into_iter().map(|rel| {
            if dest_is_dir {
                dest_root.join(rel)
            } else {
                dest_root.to_path_buf()
            }
        }));

        // Second line of defence behind sanitize_entry_path: nothing outside the
        // destination gets chowned, whatever the archive claimed its names were.
        targets.retain(|target| target.starts_with(dest_root) || created_dirs.contains(target));

        let (mut changed, mut failed) = (0usize, 0usize);
        for target in &targets {
            match nix::unistd::fchownat(
                None,
                target.as_path(),
                Some(nix::unistd::Uid::from_raw(uid)),
                Some(nix::unistd::Gid::from_raw(gid)),
                nix::fcntl::AtFlags::AT_SYMLINK_NOFOLLOW,
            ) {
                Ok(()) => changed += 1,
                Err(_) => failed += 1,
            }
        }
        if failed > 0 {
            tracing::warn!(
                container_id = %container_id,
                uid, gid, changed, failed,
                "some copied paths could not be given to the container user"
            );
        }
    }

    /// The mount, if any, that hides `in_container` itself.
    ///
    /// Only paths *at or below* a mount. A path that merely contains one
    /// (`/etc`, which holds the `/etc/hosts` bind) resolves to the right inode
    /// and is fine to name — what crosses it is checked separately, per
    /// direction, by [`Self::shadowed_payload`] and [`Self::shadowed_subtree`].
    async fn shadowing_mount(
        &self,
        container_id: &str,
        in_container: &Path,
    ) -> Result<Option<PathBuf>, Status> {
        let mounts = self.container_mounts(container_id).await?;
        Ok(deepest_covering(in_container, &mounts))
    }

    /// The mount, if any, that an *uploaded entry* would land under.
    ///
    /// The copy root can be perfectly reachable while the payload is not:
    /// `copy_in(dir, "/etc")` where `dir` contains `hosts` would write the
    /// image's `/etc/hosts` beneath the bind, invisible to the box. Checked
    /// against the archive's own entries so a single file to `/etc` — which
    /// lands at `/etc/motd.txt`, under no mount — still works.
    async fn shadowed_payload(
        &self,
        container_id: &str,
        dest_in_container: &Path,
        tar_path: &Path,
    ) -> Result<Option<(PathBuf, PathBuf)>, Status> {
        let mounts = self.container_mounts(container_id).await?;
        Ok(archive_entry_paths(tar_path).into_iter().find_map(|rel| {
            let landed = dest_in_container.join(&rel);
            deepest_covering(&landed, &mounts).map(|mount| (landed, mount))
        }))
    }

    /// The mount, if any, lying *strictly below* a path being read out.
    ///
    /// Packing `/etc` walks the rootfs layer, so it would tar the image's
    /// shadowed `/etc/hosts` rather than the bind the workload sees — handing
    /// back content no process in the box ever had. Same bug as POL-305, one
    /// level down, so it is refused the same way.
    async fn shadowed_subtree(
        &self,
        container_id: &str,
        src_in_container: &Path,
    ) -> Result<Option<PathBuf>, Status> {
        let mounts = self.container_mounts(container_id).await?;
        Ok(mounts
            .into_iter()
            .filter(|mount| mount != src_in_container && mount.starts_with(src_in_container))
            .max_by_key(|mount| mount.components().count()))
    }

    /// Mount destinations of the container, read from its applied OCI spec.
    async fn container_mounts(&self, container_id: &str) -> Result<Vec<PathBuf>, Status> {
        let container_arc = {
            let containers = self.containers.lock().await;
            containers.get(container_id).cloned().ok_or_else(|| {
                Status::failed_precondition(format!("container not found: {container_id}"))
            })?
        };
        let container = container_arc.lock().await;
        container
            .mount_destinations()
            .map_err(|e| Status::internal(format!("failed to read container mounts: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tar is caller-supplied. An entry that is absolute or climbs out is
    /// skipped by extraction, so it must be skipped here too — otherwise
    /// `dest.join(entry)` escapes and a root chown lands on a file this copy
    /// never created.
    #[test]
    fn entry_paths_that_escape_the_destination_are_dropped() {
        assert_eq!(sanitize_entry_path(Path::new("../../etc/shadow")), None);
        assert_eq!(sanitize_entry_path(Path::new("a/../../b")), None);
        assert_eq!(sanitize_entry_path(Path::new("..")), None);
    }

    /// An absolute entry keeps its tail, matching extraction stripping the
    /// leading `/` rather than refusing the entry outright.
    #[test]
    fn absolute_entry_paths_are_made_relative() {
        assert_eq!(
            sanitize_entry_path(Path::new("/etc/shadow")),
            Some(PathBuf::from("etc/shadow"))
        );
    }

    #[test]
    fn ordinary_entry_paths_survive() {
        assert_eq!(
            sanitize_entry_path(Path::new("./dir/file.txt")),
            Some(PathBuf::from("dir/file.txt"))
        );
        assert_eq!(sanitize_entry_path(Path::new(".")), None);
    }

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
