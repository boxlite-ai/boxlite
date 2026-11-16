//! Node.js bindings for runtime directory delivery (M6).

use std::sync::Arc;

use boxlite::{LiteBox, MountInfo, MountRequest, MountState};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::map_err;

/// A request to deliver a host directory into the running container.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsMountRequest {
    pub source: String,
    pub target: String,
    #[napi(js_name = "readOnly")]
    pub read_only: bool,
}

/// A runtime mount as the outside world sees it.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsMountInfo {
    pub source: String,
    pub target: String,
    #[napi(js_name = "readOnly")]
    pub read_only: bool,
    /// `mounted` or `detaching` (a removal that has not fully converged).
    pub state: String,
}

impl From<MountInfo> for JsMountInfo {
    fn from(info: MountInfo) -> Self {
        Self {
            source: info.source.display().to_string(),
            target: info.target.display().to_string(),
            read_only: info.read_only,
            state: match info.state {
                MountState::Mounted => "mounted".into(),
                MountState::Detaching => "detaching".into(),
            },
        }
    }
}

/// Handle for runtime directory delivery on a Box.
///
/// Accessed via `box.mounts`: `await box.mounts.add(...)`,
/// `await box.mounts.list()`.
#[napi]
pub struct JsMountsHandle {
    pub(crate) handle: Arc<LiteBox>,
}

#[napi]
impl JsMountsHandle {
    /// Deliver a host directory into the running container.
    #[napi]
    pub async fn add(&self, request: JsMountRequest) -> Result<JsMountInfo> {
        let handle = Arc::clone(&self.handle);
        let request = MountRequest {
            source: request.source.into(),
            target: request.target.into(),
            read_only: request.read_only,
        };
        let info = handle.mounts().add(request).await.map_err(map_err)?;
        Ok(JsMountInfo::from(info))
    }

    /// Lazily detach the mount at a container target.
    #[napi]
    pub async fn remove(&self, target: String) -> Result<()> {
        let handle = Arc::clone(&self.handle);
        handle.mounts().remove(&target).await.map_err(map_err)
    }

    /// List every runtime mount of the current VM run.
    #[napi]
    pub async fn list(&self) -> Result<Vec<JsMountInfo>> {
        let handle = Arc::clone(&self.handle);
        let mounts = handle
            .mounts()
            .list()
            .await
            .map_err(map_err)?
            .into_iter()
            .map(JsMountInfo::from)
            .collect();
        Ok(mounts)
    }

    /// The mount at a container target, or null.
    #[napi]
    pub async fn get(&self, target: String) -> Result<Option<JsMountInfo>> {
        let handle = Arc::clone(&self.handle);
        let info = handle
            .mounts()
            .get(&target)
            .await
            .map_err(map_err)?
            .map(JsMountInfo::from);
        Ok(info)
    }
}
