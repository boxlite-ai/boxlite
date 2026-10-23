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
        let js = JsSnapshotOptions {};
        let _opts: SnapshotOptions = js.into();
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
