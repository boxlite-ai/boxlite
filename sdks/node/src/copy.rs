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
