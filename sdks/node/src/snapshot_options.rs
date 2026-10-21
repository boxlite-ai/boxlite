//! Node.js bindings for snapshot, export, and clone options.

use boxlite::{CloneOptions, ExportOptions, SnapshotOptions};
use napi_derive::napi;

/// Select filesystem capture or the reserved memory contract.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsSnapshotOptions {
    #[napi(js_name = "snapshotType")]
    pub snapshot_type: Option<String>,
}

impl TryFrom<JsSnapshotOptions> for SnapshotOptions {
    type Error = boxlite::BoxliteError;
    fn try_from(js: JsSnapshotOptions) -> Result<Self, Self::Error> {
        let snapshot_type = match js.snapshot_type.as_deref().unwrap_or("filesystem") {
            "filesystem" => boxlite::SnapshotType::Filesystem,
            "memory" => boxlite::SnapshotType::Memory,
            _ => {
                return Err(boxlite::BoxliteError::InvalidArgument(
                    "snapshotType must be filesystem or memory".into(),
                ));
            }
        };
        Ok(SnapshotOptions { snapshot_type })
    }
}

/// Options for exporting a box (forward-compatible placeholder).
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsExportOptions {}

impl From<JsExportOptions> for ExportOptions {
    fn from(_js: JsExportOptions) -> Self {
        ExportOptions {}
    }
}

/// Options for cloning a box (forward-compatible placeholder).
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsCloneOptions {}

impl From<JsCloneOptions> for CloneOptions {
    fn from(_js: JsCloneOptions) -> Self {
        CloneOptions {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_options_from_js() {
        let js = JsSnapshotOptions {
            snapshot_type: None,
        };
        let _opts: SnapshotOptions = js.try_into().unwrap();
    }

    #[test]
    fn export_options_from_js() {
        let js = JsExportOptions {};
        let _opts: ExportOptions = js.into();
    }

    #[test]
    fn clone_options_from_js() {
        let js = JsCloneOptions {};
        let _opts: CloneOptions = js.into();
    }
}
