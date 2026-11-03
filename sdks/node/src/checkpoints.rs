//! Memory checkpoint catalogs and caller-local inspection.

use std::collections::HashMap;
use std::sync::Arc;

use boxlite::{CheckpointDependencies, CheckpointInfo, LiteBox};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;

use crate::util::map_err;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn safe_integer(value: u64, field: &str) -> Result<i64> {
    if value > MAX_SAFE_INTEGER {
        return Err(map_err(boxlite::BoxliteError::InvalidArgument(format!(
            "checkpoint {field} exceeds JavaScript's safe integer range"
        ))));
    }
    Ok(value as i64)
}

// Opaque native dependency records may contain 64-bit inode/handle values too.
fn check_json_numbers(value: &Value) -> Result<()> {
    match value {
        Value::Number(number) => {
            if number
                .as_u64()
                .is_some_and(|value| value > MAX_SAFE_INTEGER)
                || number
                    .as_i64()
                    .is_some_and(|value| value < -(MAX_SAFE_INTEGER as i64))
            {
                return Err(map_err(boxlite::BoxliteError::InvalidArgument(
                    "checkpoint dependency exceeds JavaScript's safe integer range".into(),
                )));
            }
        }
        Value::Array(values) => {
            for value in values {
                check_json_numbers(value)?;
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                check_json_numbers(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsPauseOptions {
    pub host_writers_stopped: Option<bool>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsCheckpointImportOptions {
    pub name: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsCheckpointInfo {
    pub id: String,
    pub box_id: String,
    pub name: String,
    pub status: String,
    pub error: Option<String>,
    pub created_at: i64,
    pub cpus: u16,
    pub memory_bytes: i64,
    pub container_disk_bytes: i64,
    pub size_bytes: i64,
}

impl TryFrom<CheckpointInfo> for JsCheckpointInfo {
    type Error = Error;
    fn try_from(info: CheckpointInfo) -> Result<Self> {
        if info.created_at.unsigned_abs() > MAX_SAFE_INTEGER {
            return Err(map_err(boxlite::BoxliteError::InvalidArgument(
                "checkpoint created_at exceeds JavaScript's safe integer range".into(),
            )));
        }
        Ok(Self {
            id: info.id,
            box_id: info.box_id,
            name: info.name,
            status: info.status,
            error: info.error,
            created_at: info.created_at,
            cpus: info.cpus,
            memory_bytes: safe_integer(info.memory_bytes, "memory_bytes")?,
            container_disk_bytes: safe_integer(info.container_disk_bytes, "container_disk_bytes")?,
            size_bytes: safe_integer(info.size_bytes, "size_bytes")?,
        })
    }
}

/// Top-level fields use camelCase; opaque share/state records retain the native schema.
#[napi(object)]
pub struct JsCheckpointDependencies {
    pub version: u32,
    pub cpus: u16,
    pub memory_bytes: i64,
    pub boot_memory_mib: u32,
    pub max_memory_mib: u32,
    pub container_disk_bytes: i64,
    pub boot_disk_bytes: i64,
    pub boot_disk_sha256: String,
    pub qcow2_bytes: i64,
    pub qcow2_sha256: String,
    pub shares: Vec<Value>,
    pub local_roots: HashMap<String, String>,
    pub boot_disk_path: Option<String>,
    pub disk_dependencies: Value,
}

impl TryFrom<CheckpointDependencies> for JsCheckpointDependencies {
    type Error = Error;
    fn try_from(info: CheckpointDependencies) -> Result<Self> {
        let shares = info
            .shares
            .into_iter()
            .map(|share| {
                let value = serde_json::to_value(share)
                    .map_err(|error| Error::from_reason(error.to_string()))?;
                check_json_numbers(&value)?;
                Ok(value)
            })
            .collect::<Result<Vec<_>>>()?;
        check_json_numbers(&info.disk_dependencies)?;
        Ok(Self {
            version: info.version,
            cpus: info.cpus,
            memory_bytes: safe_integer(info.memory_bytes, "memory_bytes")?,
            boot_memory_mib: info.boot_memory_mib,
            max_memory_mib: info.max_memory_mib,
            container_disk_bytes: safe_integer(info.container_disk_bytes, "container_disk_bytes")?,
            boot_disk_bytes: safe_integer(info.boot_disk_bytes, "boot_disk_bytes")?,
            boot_disk_sha256: info.boot_disk_sha256,
            qcow2_bytes: safe_integer(info.qcow2_bytes, "qcow2_bytes")?,
            qcow2_sha256: info.qcow2_sha256,
            shares,
            local_roots: info
                .local_roots
                .into_iter()
                .map(|(tag, path)| (tag, path.to_string_lossy().into_owned()))
                .collect(),
            boot_disk_path: info
                .boot_disk_path
                .map(|path| path.to_string_lossy().into_owned()),
            disk_dependencies: info.disk_dependencies,
        })
    }
}

#[napi]
pub struct JsCheckpointHandle {
    pub(crate) handle: Arc<LiteBox>,
}

#[napi]
impl JsCheckpointHandle {
    #[napi]
    pub async fn create(&self, name: Option<String>) -> Result<JsCheckpointInfo> {
        self.handle
            .checkpoints()
            .create(name)
            .await
            .map_err(map_err)?
            .try_into()
    }
    #[napi]
    pub async fn list(&self) -> Result<Vec<JsCheckpointInfo>> {
        self.handle
            .checkpoints()
            .list()
            .await
            .map_err(map_err)?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }
    #[napi]
    pub async fn get(&self, id_or_name: String) -> Result<Option<JsCheckpointInfo>> {
        self.handle
            .checkpoints()
            .get(&id_or_name)
            .await
            .map_err(map_err)?
            .map(TryInto::try_into)
            .transpose()
    }
    #[napi]
    pub async fn remove(&self, id_or_name: String, force: Option<bool>) -> Result<()> {
        self.handle
            .checkpoints()
            .remove(&id_or_name, force.unwrap_or(false))
            .await
            .map_err(map_err)
    }
}

#[napi]
pub struct JsRuntimeCheckpointHandle {
    pub(crate) handle: boxlite::RuntimeCheckpointHandle,
}

#[napi]
impl JsRuntimeCheckpointHandle {
    #[napi]
    pub async fn list(&self) -> Result<Vec<JsCheckpointInfo>> {
        self.handle
            .list()
            .await
            .map_err(map_err)?
            .into_iter()
            .map(TryInto::try_into)
            .collect()
    }
    #[napi]
    pub async fn get(&self, id_or_name: String) -> Result<JsCheckpointInfo> {
        self.handle
            .get(&id_or_name)
            .await
            .map_err(map_err)?
            .try_into()
    }
    #[napi]
    pub async fn remove(&self, id_or_name: String, force: Option<bool>) -> Result<()> {
        self.handle
            .remove(&id_or_name, force.unwrap_or(false))
            .await
            .map_err(map_err)
    }
}
