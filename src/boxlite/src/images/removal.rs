//! Targeted cache reclamation. The caller owns exclusive cache access through
//! this entire blocking operation, including dependency checks and cleanup.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use boxlite_shared::{BoxliteError, BoxliteResult};
use oci_client::Reference;

use super::{ImageDiskManager, id::resolve_id, storage::ImageStorage};
use crate::db::ImageIndexStore;
use crate::litebox::config::BoxConfig;
use crate::runtime::{ImageRemovalResult, options::RootfsSpec, types::BoxState};

pub(super) struct RemovalCache {
    index: ImageIndexStore,
    storage: Arc<ImageStorage>,
}

impl RemovalCache {
    pub(super) fn new(index: ImageIndexStore, storage: Arc<ImageStorage>) -> Self {
        Self { index, storage }
    }

    pub(super) fn remove(
        &self,
        id: &str,
        boxes: &[(BoxConfig, BoxState)],
    ) -> BoxliteResult<ImageRemovalResult> {
        let entries = self.index.list_all()?;
        let image_id = resolve_id(id, &entries)?;
        let mut parsed = Vec::with_capacity(entries.len());
        for (reference, image) in &entries {
            for digest in std::iter::once(&image.manifest_digest)
                .chain(std::iter::once(&image.config_digest))
                .chain(&image.layers)
            {
                checked_digest(digest)?;
            }
            parsed.push(parse_reference(reference)?);
        }
        let target: Vec<_> = entries
            .iter()
            .enumerate()
            .filter(|(_, (_, image))| image.manifest_digest == image_id)
            .collect();
        let tags: Vec<_> = target
            .iter()
            .filter(|(position, _)| parsed[*position].tag().is_some())
            .map(|(_, (reference, _))| reference.clone())
            .collect();
        if !tags.is_empty() {
            return Err(BoxliteError::ImageHasTags(format!(
                "{image_id}: {}",
                tags.join(", ")
            )));
        }
        let target_references: Vec<_> = target
            .iter()
            .map(|(position, _)| &parsed[*position])
            .collect();
        let mut blockers = Vec::new();
        let mut unknown_contents = false;
        for (config, state) in boxes {
            if let Some(resolved) = &state.resolved_image {
                checked_digest(&resolved.manifest_digest)?;
                if resolved.manifest_digest == image_id {
                    blockers.push(config.id.to_string());
                }
                unknown_contents |= !entries
                    .iter()
                    .any(|(_, image)| image.manifest_digest == resolved.manifest_digest);
            } else if let RootfsSpec::Image(reference) = &config.options.rootfs {
                let box_ref = parse_reference(reference)?;
                let matches_repo =
                    |candidate: &Reference| same_repository(reference, &box_ref, candidate);
                let dependent = match box_ref.digest() {
                    Some(digest) => {
                        digest == image_id
                            || target_references.iter().any(|candidate| {
                                matches_repo(candidate) && candidate.digest() == Some(digest)
                            })
                    }
                    None => target_references
                        .iter()
                        .any(|candidate| matches_repo(candidate)),
                };
                if dependent {
                    blockers.push(config.id.to_string());
                }
                unknown_contents |= !parsed.iter().any(|candidate| {
                    matches_repo(candidate)
                        && candidate.tag() == box_ref.tag()
                        && candidate.digest() == box_ref.digest()
                });
            }
        }
        if !blockers.is_empty() {
            blockers.sort();
            return Err(BoxliteError::ImageUsedByBoxes(format!(
                "{image_id}: {}",
                blockers.join(", ")
            )));
        }
        let image = &target[0].1.1;
        if target.iter().any(|(_, (_, other))| {
            other.layers != image.layers || other.config_digest != image.config_digest
        }) {
            return Err(BoxliteError::MetadataError(format!(
                "inconsistent cache records for {image_id}"
            )));
        }
        let retained: Vec<_> = entries
            .iter()
            .filter(|(_, cached)| cached.manifest_digest != image_id)
            .map(|(_, cached)| cached)
            .collect();
        let mut paths = BTreeSet::from([self.storage.manifest_path(&image_id)]);
        if !unknown_contents {
            if !retained
                .iter()
                .any(|other| other.config_digest == image.config_digest)
            {
                paths.insert(self.storage.config_path(&image.config_digest));
            }
            for layer in &image.layers {
                if !retained.iter().any(|other| other.layers.contains(layer)) {
                    paths.insert(self.storage.layer_tarball_path(layer));
                    paths.insert(self.storage.layer_extracted_path(layer));
                }
            }
        }
        // Backing chains can outlive their image-index records. Without a
        // complete ownership record, keeping a disk is safer than guessing.
        if boxes.is_empty() && !retained.iter().any(|other| other.layers == image.layers) {
            paths.extend(ImageDiskManager::cache_paths(
                &self.storage.disk_images_dir(),
                &image.layers,
            )?);
        }
        let reclaimed_bytes = remove_paths(self.storage.root(), paths)?;
        let mut removed_references: Vec<_> = target
            .into_iter()
            .map(|(_, (reference, _))| reference.clone())
            .collect();
        removed_references.sort();
        self.index.remove_all(&removed_references)?;
        Ok(ImageRemovalResult {
            image_id,
            removed_references,
            reclaimed_bytes,
        })
    }
}

fn checked_digest(digest: &str) -> BoxliteResult<()> {
    if digest.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    }) {
        return Ok(());
    }
    Err(BoxliteError::MetadataError(format!(
        "invalid cache digest {digest:?}; refusing image removal"
    )))
}

fn parse_reference(reference: &str) -> BoxliteResult<Reference> {
    reference.parse().map_err(|error| {
        BoxliteError::MetadataError(format!(
            "cannot establish image dependencies for {reference:?}: {error}"
        ))
    })
}

fn same_repository(original: &str, reference: &Reference, candidate: &Reference) -> bool {
    if super::is_fully_qualified(original) {
        reference.registry() == candidate.registry()
            && reference.repository() == candidate.repository()
    } else {
        reference.repository().trim_start_matches("library/")
            == candidate.repository().trim_start_matches("library/")
    }
}

fn io_error(path: &Path, error: std::io::Error) -> BoxliteError {
    BoxliteError::Storage(format!(
        "remove image cache {}: {error}; retry removal or pull the image again",
        path.display()
    ))
}

/// Stage entire cache objects before unlinking, so an interrupted directory
/// cleanup cannot leave a half-removed extracted layer at its reusable name.
fn remove_paths(root: &Path, paths: BTreeSet<PathBuf>) -> BoxliteResult<u64> {
    let canonical_root = root.canonicalize().map_err(|error| io_error(root, error))?;
    let mut existing = Vec::new();
    // (device, inode) → (allocated bytes, link count, selected names, directory).
    let mut inodes: HashMap<(u64, u64), (u64, u64, u64, bool)> = HashMap::new();
    for path in paths {
        match fs::symlink_metadata(&path) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(io_error(&path, error)),
        }
        let parent = path.parent().unwrap();
        if !parent
            .canonicalize()
            .map_err(|error| io_error(parent, error))?
            .starts_with(&canonical_root)
        {
            return Err(BoxliteError::Storage(format!(
                "cache path {} escapes the image store",
                path.display()
            )));
        }
        for entry in walkdir::WalkDir::new(&path)
            .follow_links(false)
            .follow_root_links(false)
        {
            let entry = entry.map_err(|error| {
                BoxliteError::Storage(format!("inspect image cache {}: {error}", path.display()))
            })?;
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|error| io_error(entry.path(), error))?;
            let inode = inodes.entry((metadata.dev(), metadata.ino())).or_insert((
                metadata.blocks() * 512,
                metadata.nlink(),
                0,
                metadata.is_dir(),
            ));
            inode.2 += 1;
            // Layers may intentionally contain 0555 directories. Only eligible,
            // unshared directories are made traversable, never symlink targets.
            if metadata.is_dir() && metadata.mode() & 0o700 != 0o700 {
                fs::set_permissions(
                    entry.path(),
                    fs::Permissions::from_mode(metadata.mode() | 0o700),
                )
                .map_err(|error| io_error(entry.path(), error))?;
            }
        }
        existing.push(path);
    }
    if existing.is_empty() {
        return Ok(0);
    }
    let staging = tempfile::Builder::new()
        .prefix(".removing-")
        .tempdir_in(root)
        .map_err(|error| io_error(root, error))?;
    let mut staged: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (position, path) in existing.into_iter().enumerate() {
        let destination = staging.path().join(position.to_string());
        if let Err(error) = fs::rename(&path, &destination) {
            for (original, temporary) in staged.iter().rev() {
                if let Err(restore) = fs::rename(temporary, original) {
                    let kept = staging.keep();
                    return Err(BoxliteError::Storage(format!(
                        "restore image cache {}: {restore}; remaining data is in {}",
                        original.display(),
                        kept.display()
                    )));
                }
            }
            return Err(io_error(&path, error));
        }
        staged.push((path, destination));
    }
    staging.close().map_err(|error| io_error(root, error))?;
    Ok(inodes
        .values()
        .filter(|(_, links, selected, directory)| *directory || selected >= links)
        .map(|(bytes, _, _, _)| bytes)
        .sum())
}

#[cfg(test)]
mod tests;
