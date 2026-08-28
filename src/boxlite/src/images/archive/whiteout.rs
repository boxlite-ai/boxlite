//! OCI whiteout marker naming.
//!
//! Two code paths consume layers and must agree on which names are markers:
//! the tar extractor (`super::extractor`) and the copy-based layer merge
//! (`crate::rootfs`). The rule lives here so it cannot drift between them.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// Marker hiding every lower-layer entry of the directory holding it.
pub(crate) const OPAQUE_MARKER: &str = ".wh..wh..opq";

const PREFIX: &str = ".wh.";

pub(crate) enum Whiteout<'a> {
    /// `.wh..wh..opq`: hide what lower layers put in this directory.
    Opaque,
    /// `.wh.<name>`: hide the sibling entry `<name>`.
    Remove(&'a str),
}

/// Classify the base name of a layer entry that is a **regular file** — only
/// regular files are markers, so a directory or symlink named `.wh.foo` is
/// ordinary content (umoci `oci/layer/tar_extract.go`, and boxlite's own
/// `extractor::apply_whiteout` gate on `EntryType::Regular`).
///
/// `Ok(None)` is ordinary content. `Err` is a marker-shaped name OCI forbids:
/// `.wh.`, `.wh..` and `.wh...` name `""`, `"."` and `".."` as their victim,
/// i.e. the directory holding the marker or its parent — obeying them lets one
/// layer erase the whole tree below it.
pub(crate) fn classify(base: &str) -> BoxliteResult<Option<Whiteout<'_>>> {
    if base == OPAQUE_MARKER {
        return Ok(Some(Whiteout::Opaque));
    }

    let Some(target) = base.strip_prefix(PREFIX) else {
        return Ok(None);
    };

    if target.is_empty() || target == "." || target == ".." {
        return Err(BoxliteError::Storage(format!(
            "Invalid whiteout name: {}",
            base
        )));
    }

    Ok(Some(Whiteout::Remove(target)))
}
