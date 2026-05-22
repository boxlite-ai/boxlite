use boxlite::{CopyOutOutcome, CopyOutPair};
use napi_derive::napi;

/// Options for copyIn/copyOut. All fields are optional; defaults follow core CopyOptions.
#[napi(object)]
pub struct JsCopyOptions {
    pub recursive: Option<bool>,
    pub overwrite: Option<bool>,
    pub follow_symlinks: Option<bool>,
    pub include_parent: Option<bool>,
}

pub fn into_copy_options(opts: Option<JsCopyOptions>) -> boxlite::CopyOptions {
    let mut o = boxlite::CopyOptions::default();
    if let Some(opt) = opts {
        if let Some(v) = opt.recursive {
            o.recursive = v;
        }
        if let Some(v) = opt.overwrite {
            o.overwrite = v;
        }
        if let Some(v) = opt.follow_symlinks {
            o.follow_symlinks = v;
        }
        if let Some(v) = opt.include_parent {
            o.include_parent = v;
        }
    }
    o
}

/// One container_src → host_dst pair for bulk copy-out. Caller controls
/// destinations per file, so duplicate container_src entries don't collide.
#[napi(object)]
#[derive(Clone)]
pub struct JsCopyOutPair {
    pub container_src: String,
    pub host_dst: String,
}

impl From<&JsCopyOutPair> for CopyOutPair {
    fn from(p: &JsCopyOutPair) -> Self {
        CopyOutPair {
            container_src: p.container_src.clone(),
            host_dst: std::path::PathBuf::from(&p.host_dst),
        }
    }
}

/// Per-pair outcome from copyOutMany. `error === null` means the file
/// landed at host_dst; otherwise the string carries the server's error
/// text or the local write failure reason.
#[napi(object)]
#[derive(Clone)]
pub struct JsCopyOutOutcome {
    pub container_src: String,
    pub host_dst: String,
    pub error: Option<String>,
}

impl From<CopyOutOutcome> for JsCopyOutOutcome {
    fn from(o: CopyOutOutcome) -> Self {
        Self {
            container_src: o.container_src,
            host_dst: o.host_dst.to_string_lossy().into_owned(),
            error: o.error,
        }
    }
}
