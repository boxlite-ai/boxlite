//! Resolve local manifest IDs against one raw cache-index snapshot.

use crate::db::CachedImage;
use boxlite_shared::{BoxliteError, BoxliteResult};
use std::collections::BTreeSet;

pub(super) fn resolve_id(id: &str, entries: &[(String, CachedImage)]) -> BoxliteResult<String> {
    let prefix = id.strip_prefix("sha256:").unwrap_or(id);
    if prefix.is_empty()
        || prefix.len() > 64
        || (id.starts_with("sha256:") && prefix.len() != 64)
        || !prefix
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(BoxliteError::InvalidArgument(
            "pass a full sha256 image ID or a nonempty lowercase hexadecimal prefix".into(),
        ));
    }
    let matches: BTreeSet<&str> = entries
        .iter()
        .map(|(_, image)| image.manifest_digest.as_str())
        .filter(|digest| {
            digest
                .strip_prefix("sha256:")
                .is_some_and(|hex| hex.starts_with(prefix))
        })
        .collect();
    match matches.len() {
        0 => Err(BoxliteError::NotFound(format!("local image ID {id}"))),
        1 => Ok(matches.into_iter().next().unwrap().to_string()),
        _ => Err(BoxliteError::AmbiguousImageId(format!(
            "{id} matches {}; use a longer ID",
            matches.into_iter().collect::<Vec<_>>().join(", ")
        ))),
    }
}
