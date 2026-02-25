use std::sync::Arc;

use boxlite::{BoxCommand, CloneOptions, ExportOptions, LiteBox};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::copy::{JsCopyOptions, into_copy_options};
use crate::exec::JsExecution;
use crate::info::JsBoxInfo;
use crate::metrics::JsBoxMetrics;
use crate::snapshot_options::{JsCloneOptions, JsExportOptions};
use crate::snapshots::JsSnapshotHandle;
use crate::util::map_err;

/// Box handle for interacting with a running container.
///
/// Provides methods to execute commands, get status, and stop the box.
/// Each box runs in an isolated VM with its own rootfs and resources.
#[napi]
pub struct JsBox {
    pub(crate) handle: Arc<LiteBox>,
}

#[napi]
impl JsBox {
    /// Get the box's unique identifier (ULID).
    #[napi(getter)]
    pub fn id(&self) -> String {
        self.handle.id().to_string()
    }

    /// Get the box's user-defined name (if set).
    #[napi(getter)]
    pub fn name(&self) -> Option<String> {
        self.handle.name().map(|s| s.to_string())
    }

    /// Get box metadata (synchronous).
    #[napi]
    pub fn info(&self) -> JsBoxInfo {
        JsBoxInfo::from(self.handle.info())
    }

    /// Execute a command inside the box.
    ///
    /// # Arguments
    /// * `command` - Command to execute (path or name)
    /// * `args` - Command arguments (optional)
    /// * `env` - Environment variables as array of [key, value] tuples (optional)
    /// * `tty` - Enable TTY mode for interactive programs (optional, default: false)
    /// * `user` - Run as specified user (optional)
    /// * `timeoutSecs` - Execution timeout in seconds (optional)
    /// * `workingDir` - Working directory inside the container (optional)
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub async fn exec(
        &self,
        command: String,
        args: Option<Vec<String>>,
        env: Option<Vec<Vec<String>>>,
        tty: Option<bool>,
        user: Option<String>,
        timeout_secs: Option<f64>,
        working_dir: Option<String>,
    ) -> Result<JsExecution> {
        let handle = Arc::clone(&self.handle);

        let args = args.unwrap_or_default();
        let tty = tty.unwrap_or(false);

        let mut cmd = BoxCommand::new(command);
        cmd = cmd.args(args);

        if let Some(env_vars) = env {
            for env_var in env_vars {
                if env_var.len() == 2 {
                    cmd = cmd.env(env_var[0].clone(), env_var[1].clone());
                }
            }
        }

        if tty {
            cmd = cmd.tty(true);
        }

        if let Some(user) = user {
            cmd = cmd.user(user);
        }

        if let Some(secs) = timeout_secs {
            cmd = cmd.timeout(std::time::Duration::from_secs_f64(secs));
        }

        if let Some(dir) = working_dir {
            cmd = cmd.working_dir(dir);
        }

        let execution = handle.exec(cmd).await.map_err(map_err)?;

        Ok(JsExecution {
            execution: Arc::new(tokio::sync::Mutex::new(execution)),
        })
    }

    /// Get the snapshot handle for this box.
    #[napi(getter)]
    pub fn snapshot(&self) -> JsSnapshotHandle {
        JsSnapshotHandle {
            handle: Arc::clone(&self.handle),
        }
    }

    /// Clone this box, creating a new box with copied disks.
    #[napi(js_name = "cloneBox")]
    pub async fn clone_box(
        &self,
        options: Option<JsCloneOptions>,
        name: Option<String>,
    ) -> Result<JsBox> {
        let handle = Arc::clone(&self.handle);
        let opts: CloneOptions = options.map(Into::into).unwrap_or_default();
        let cloned = handle.clone_box(opts, name).await.map_err(map_err)?;
        Ok(JsBox {
            handle: Arc::new(cloned),
        })
    }

    /// Export this box as a portable `.boxlite` archive.
    #[napi]
    pub async fn export(&self, dest: String, options: Option<JsExportOptions>) -> Result<String> {
        let handle = Arc::clone(&self.handle);
        let opts: ExportOptions = options.map(Into::into).unwrap_or_default();
        let archive = handle
            .export(opts, std::path::Path::new(&dest))
            .await
            .map_err(map_err)?;
        Ok(archive.path().to_string_lossy().to_string())
    }

    /// Start or restart a stopped box.
    #[napi]
    pub async fn start(&self) -> Result<()> {
        self.handle.start().await.map_err(map_err)
    }

    /// Stop the box (preserves state for restart).
    #[napi]
    pub async fn stop(&self) -> Result<()> {
        self.handle.stop().await.map_err(map_err)
    }

    /// Get box metrics.
    #[napi]
    pub async fn metrics(&self) -> Result<JsBoxMetrics> {
        let metrics = self.handle.metrics().await.map_err(map_err)?;
        Ok(JsBoxMetrics::from(metrics))
    }

    /// Copy files from host into the box's container rootfs.
    #[napi(js_name = "copyIn")]
    pub async fn copy_in(
        &self,
        host_path: String,
        container_dest: String,
        options: Option<JsCopyOptions>,
    ) -> Result<()> {
        let opts = into_copy_options(options);

        self.handle
            .copy_into(std::path::Path::new(&host_path), &container_dest, opts)
            .await
            .map_err(map_err)
    }

    /// Copy files from the box's container rootfs to host.
    #[napi(js_name = "copyOut")]
    pub async fn copy_out(
        &self,
        container_src: String,
        host_dest: String,
        options: Option<JsCopyOptions>,
    ) -> Result<()> {
        let opts = into_copy_options(options);

        self.handle
            .copy_out(&container_src, std::path::Path::new(&host_dest), opts)
            .await
            .map_err(map_err)
    }
}
