//! Node.js bindings for snapshot, export, and clone options.

use boxlite::{CloneOptions, ExportOptions, SnapshotOptions};
use napi_derive::napi;

/// Options for creating a snapshot (forward-compatible placeholder).
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsSnapshotOptions {}

impl From<JsSnapshotOptions> for SnapshotOptions {
    fn from(_js: JsSnapshotOptions) -> Self {
        SnapshotOptions {}
    }
}

/// Options for exporting a box archive. The default exports disks only.
#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct JsExportOptions {
    pub include_memory: Option<bool>,
}

impl From<JsExportOptions> for ExportOptions {
    fn from(js: JsExportOptions) -> Self {
        Self {
            include_memory: js.include_memory.unwrap_or(false),
        }
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
        let js = JsSnapshotOptions {};
        let _opts: SnapshotOptions = js.into();
    }

    #[test]
    fn export_options_from_js() {
        for (include_memory, expected) in [(None, false), (Some(false), false), (Some(true), true)]
        {
            let opts: ExportOptions = JsExportOptions { include_memory }.into();
            assert_eq!(opts.include_memory, expected);
        }
    }

    #[test]
    fn clone_options_from_js() {
        let js = JsCloneOptions {};
        let _opts: CloneOptions = js.into();
    }
}
