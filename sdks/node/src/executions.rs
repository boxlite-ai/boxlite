//! Node.js bindings for the live execution namespace of one box.
//!
//! Mirrors `boxlite::ExecutionsHandle`: listing and recovery never start the
//! box, and attaching output stays on `box.attach()`'s contract.

use std::sync::Arc;

use boxlite::LiteBox;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::exec::{JsExecution, JsExecutionInfo};
use crate::util::map_err;

/// Live execution sessions of one box, reached as `box.executions()`.
///
/// Discovering and recovering sessions never starts or restarts the box.
#[napi]
pub struct JsExecutions {
    pub(crate) handle: Arc<LiteBox>,
}

#[napi]
impl JsExecutions {
    /// List live guest executions without starting a stopped box.
    #[napi]
    pub async fn list(&self) -> Result<Vec<JsExecutionInfo>> {
        let executions = self.handle.executions().list().await.map_err(map_err)?;
        Ok(executions.into_iter().map(JsExecutionInfo::from).collect())
    }

    /// Recover control without claiming the session's output reader.
    #[napi]
    pub async fn get(&self, execution_id: String) -> Result<JsExecution> {
        let execution = self
            .handle
            .executions()
            .get(&execution_id)
            .await
            .map_err(map_err)?;
        Ok(JsExecution {
            execution: Arc::new(tokio::sync::Mutex::new(execution)),
        })
    }

    /// Attach to a discovered live execution without starting the box.
    #[napi]
    pub async fn attach(&self, execution_id: String, stdin: Option<bool>) -> Result<JsExecution> {
        let mut options = boxlite::AttachOptions::execution(execution_id);
        if stdin == Some(false) {
            options = options.read_only();
        }
        let execution = self.handle.attach(options).await.map_err(map_err)?;
        Ok(JsExecution {
            execution: Arc::new(tokio::sync::Mutex::new(execution)),
        })
    }
}
