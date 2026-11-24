//! REST-managed checkpoints. Local runtimes return Unsupported.

use std::sync::Arc;

use boxlite::{BoxliteError, CheckpointHandle, CheckpointInfo, CheckpointKind, CheckpointOptions};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::map_err;

#[napi(object, object_from_js = false)]
#[derive(Debug)]
pub struct JsCheckpointOptions {
    #[napi(ts_type = "\"disk\" | \"full\" | null")]
    pub kind: Option<String>,
}

impl ValidateNapiValue for JsCheckpointOptions {}

impl FromNapiValue for JsCheckpointOptions {
    unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
        // SAFETY: napi provides an environment and value from the same JS call.
        let value = unsafe { Unknown::from_napi_value(env, value)? };
        if value.get_type()? != ValueType::Object || value.is_array()? {
            return Err(map_err(BoxliteError::InvalidArgument(
                "checkpoint options must be an object".into(),
            )));
        }
        // SAFETY: the value has been checked to be an object.
        let object: Object = unsafe { value.cast()? };
        // Read through Option so both an omitted property and null select the default.
        let kind = object.get::<Option<String>>("kind")?.flatten();
        Ok(Self { kind })
    }
}

impl TryFrom<JsCheckpointOptions> for CheckpointOptions {
    type Error = BoxliteError;

    fn try_from(options: JsCheckpointOptions) -> std::result::Result<Self, Self::Error> {
        let kind = match options.kind.as_deref() {
            None => None,
            Some("disk") => Some(CheckpointKind::Disk),
            Some("full") => Some(CheckpointKind::Full),
            Some(other) => {
                return Err(BoxliteError::InvalidArgument(format!(
                    "checkpoint kind must be disk or full, got {other:?}"
                )));
            }
        };
        Ok(Self { kind })
    }
}

#[napi(object)]
pub struct JsCheckpointInfo {
    pub id: String,
    pub name: String,
    #[napi(js_name = "sourceBoxId")]
    pub source_box_id: String,
    #[napi(js_name = "createdAt")]
    pub created_at: String,
    #[napi(js_name = "sizeBytes")]
    pub size_bytes: i64,
    pub kind: String,
    #[napi(js_name = "memorySizeBytes")]
    pub memory_size_bytes: Option<i64>,
    pub state: String,
    #[napi(js_name = "errorReason")]
    pub error_reason: Option<String>,
}

impl From<CheckpointInfo> for JsCheckpointInfo {
    fn from(info: CheckpointInfo) -> Self {
        Self {
            id: info.id,
            name: info.name,
            source_box_id: info.source_box_id,
            created_at: info.created_at.to_rfc3339(),
            size_bytes: i64::try_from(info.size_bytes).unwrap_or(i64::MAX),
            kind: info.kind.as_str().to_string(),
            memory_size_bytes: info
                .memory_size_bytes
                .map(|n| i64::try_from(n).unwrap_or(i64::MAX)),
            state: format!("{:?}", info.state).to_lowercase(),
            error_reason: info.error_reason,
        }
    }
}

#[napi]
pub struct JsCheckpointHandle {
    pub(crate) handle: Arc<CheckpointHandle>,
}

#[napi]
impl JsCheckpointHandle {
    #[napi]
    pub async fn create(
        &self,
        source: String,
        name: Option<String>,
        options: Option<JsCheckpointOptions>,
    ) -> Result<JsCheckpointInfo> {
        let parsed = options
            .map(CheckpointOptions::try_from)
            .transpose()
            .map_err(map_err)?
            .unwrap_or_default();
        Ok(self
            .handle
            .create_with_options(&source, name, parsed)
            .await
            .map_err(map_err)?
            .into())
    }

    #[napi]
    pub async fn list(&self) -> Result<Vec<JsCheckpointInfo>> {
        Ok(self
            .handle
            .list()
            .await
            .map_err(map_err)?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    #[napi]
    pub async fn get(&self, key: String) -> Result<JsCheckpointInfo> {
        Ok(self.handle.get(&key).await.map_err(map_err)?.into())
    }

    /// Force ignores absence and never bypasses active use.
    #[napi]
    pub async fn remove(&self, key: String, force: Option<bool>) -> Result<()> {
        self.handle
            .remove(&key, force.unwrap_or(false))
            .await
            .map_err(map_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_checkpoint_options() {
        for (kind, expected) in [
            (None, None),
            (Some("disk"), Some(CheckpointKind::Disk)),
            (Some("full"), Some(CheckpointKind::Full)),
        ] {
            let options = JsCheckpointOptions {
                kind: kind.map(str::to_owned),
            };
            assert_eq!(CheckpointOptions::try_from(options).unwrap().kind, expected);
        }
        for kind in ["", "unknown", "bogus"] {
            let error = CheckpointOptions::try_from(JsCheckpointOptions {
                kind: Some(kind.into()),
            })
            .unwrap_err();
            assert!(matches!(error, BoxliteError::InvalidArgument(_)));
            assert!(map_err(error).reason.starts_with("invalid argument: "));
        }
    }

    #[test]
    fn converts_checkpoint_metadata() {
        for (kind, memory_size_bytes, expected_kind, expected_size) in [
            (CheckpointKind::Disk, None, "disk", None),
            (CheckpointKind::Full, Some(0), "full", Some(0)),
            (CheckpointKind::Full, Some(4096), "full", Some(4096)),
            (CheckpointKind::Unknown, None, "unknown", None),
        ] {
            let info = JsCheckpointInfo::from(CheckpointInfo {
                id: "checkpoint-1".into(),
                name: "backup".into(),
                source_box_id: "source-1".into(),
                created_at: Default::default(),
                size_bytes: 4096,
                state: Default::default(),
                error_reason: None,
                kind,
                memory_size_bytes,
            });
            assert_eq!(info.kind, expected_kind);
            assert_eq!(info.memory_size_bytes, expected_size);
        }
    }
}
