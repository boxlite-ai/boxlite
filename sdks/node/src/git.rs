//! Node.js bindings for git operations.

use std::sync::Arc;

use boxlite::LiteBox;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::map_err;

/// Handle for git operations on a box.
///
/// Accessed as a property: `box.git.configureUser(...)`.
#[napi]
pub struct JsGitHandle {
    pub(crate) handle: Arc<LiteBox>,
}

#[napi]
impl JsGitHandle {
    /// Set `user.name` and `user.email` for commits in this box.
    #[napi]
    pub async fn configure_user(
        &self,
        name: String,
        email: String,
        scope: Option<String>,
        path: Option<String>,
    ) -> Result<()> {
        let handle = Arc::clone(&self.handle);
        handle
            .git()
            .configure_user(&name, &email, scope.as_deref(), path.as_deref())
            .await
            .map_err(map_err)
    }

    /// Write a git config value. `scope` is `"global"` (default), `"local"`,
    /// or `"system"`; `"local"` requires `path`.
    #[napi]
    pub async fn set_config(
        &self,
        key: String,
        value: String,
        scope: Option<String>,
        path: Option<String>,
    ) -> Result<()> {
        let handle = Arc::clone(&self.handle);
        handle
            .git()
            .set_config(&key, &value, scope.as_deref(), path.as_deref())
            .await
            .map_err(map_err)
    }

    /// Read a git config value. Same `scope` / `path` rules as `setConfig`.
    #[napi]
    pub async fn get_config(
        &self,
        key: String,
        scope: Option<String>,
        path: Option<String>,
    ) -> Result<String> {
        let handle = Arc::clone(&self.handle);
        handle
            .git()
            .get_config(&key, scope.as_deref(), path.as_deref())
            .await
            .map_err(map_err)
    }
}
