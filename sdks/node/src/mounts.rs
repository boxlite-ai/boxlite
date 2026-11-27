use boxlite::{MountHandle, MountInfo, MountRequest};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::map_err;

#[napi(object)]
pub struct JsMountRequest {
    pub source: String,
    pub target: String,
    pub read_only: Option<bool>,
}

#[napi(object)]
pub struct JsMountInfo {
    pub source: String,
    pub target: String,
    pub read_only: bool,
    pub state: String,
}

impl From<MountInfo> for JsMountInfo {
    fn from(info: MountInfo) -> Self {
        Self {
            source: info.source.display().to_string(),
            target: info.target.display().to_string(),
            read_only: info.read_only,
            state: info.state.to_string(),
        }
    }
}

/// Runtime directory mounts of one box, reached as `box.mount`.
///
/// A mount's `state` is `configured` while it is saved for the box's next
/// start, `preparing` until the guest confirms it, `mounted` once it is
/// visible in the container and `detaching` while its removal is incomplete.
/// No operation starts the box.
#[napi]
pub struct JsMountHandle(pub(crate) MountHandle);

#[napi]
impl JsMountHandle {
    /// Deliver a host directory into the container.
    ///
    /// A running box answers once the guest confirmed the mount. A stopped
    /// box saves it for its next start and answers `configured`.
    #[napi]
    pub async fn add(&self, request: JsMountRequest) -> Result<JsMountInfo> {
        self.0
            .add(MountRequest {
                source: request.source.into(),
                target: request.target.into(),
                read_only: request.read_only.unwrap_or_default(),
            })
            .await
            .map(JsMountInfo::from)
            .map_err(map_err)
    }

    /// Remove the mount at `target`, saved or live. Fails with code
    /// `not_found` when no mount is there.
    #[napi]
    pub async fn remove(&self, target: String) -> Result<()> {
        self.0.remove(target).await.map_err(map_err)
    }

    /// Every mount of the box, saved or live.
    #[napi]
    pub async fn list(&self) -> Result<Vec<JsMountInfo>> {
        Ok(self
            .0
            .list()
            .await
            .map_err(map_err)?
            .into_iter()
            .map(JsMountInfo::from)
            .collect())
    }

    /// The mount at `target`, or `null` when no mount is there.
    #[napi]
    pub async fn get(&self, target: String) -> Result<Option<JsMountInfo>> {
        Ok(self
            .0
            .get(target)
            .await
            .map_err(map_err)?
            .map(JsMountInfo::from))
    }
}
