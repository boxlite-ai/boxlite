use std::sync::Arc;

use boxlite::BoxliteRuntime;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::box_handle::JsBox;
use crate::info::JsBoxInfo;
use crate::metrics::JsRuntimeMetrics;
use crate::options::{JsBoxOptions, JsOptions};
use crate::util::map_err;

/// BoxLite runtime instance.
///
/// The main entry point for creating and managing boxes. Each runtime
/// instance manages a separate data directory with its own boxes, images,
/// and configuration.
#[napi]
pub struct JsBoxlite {
    runtime: Arc<BoxliteRuntime>,
}

#[napi]
impl JsBoxlite {
    /// Create a new runtime with custom options.
    ///
    /// # Arguments
    /// * `options` - Runtime configuration (e.g., custom home directory)
    ///
    /// # Example
    /// ```javascript
    /// const runtime = new Boxlite({ homeDir: '/custom/path' });
    /// ```
    #[napi(constructor)]
    pub fn new(options: JsOptions) -> Result<Self> {
        let runtime = BoxliteRuntime::new(options.into()).map_err(map_err)?;

        Ok(Self {
            runtime: Arc::new(runtime),
        })
    }

    /// Get the default runtime instance.
    ///
    /// Uses ~/.boxlite as the home directory. This is the recommended
    /// way to get a runtime for most use cases.
    ///
    /// # Example
    /// ```javascript
    /// const runtime = Boxlite.withDefaultConfig();
    /// ```
    #[napi(factory)]
    pub fn with_default_config() -> Result<Self> {
        let runtime = BoxliteRuntime::default_runtime();
        Ok(Self {
            runtime: Arc::new(runtime.clone()),
        })
    }

    /// Initialize the default runtime with custom options.
    ///
    /// This must be called before any calls to `Boxlite.withDefaultConfig()` if you
    /// want to customize the default runtime's configuration.
    ///
    /// # Arguments
    /// * `options` - Runtime configuration
    ///
    /// # Example
    /// ```javascript
    /// Boxlite.initDefault({ homeDir: '/custom/path' });
    /// const runtime = Boxlite.withDefaultConfig(); // Uses /custom/path
    /// ```
    #[napi]
    pub fn init_default(options: JsOptions) -> Result<()> {
        BoxliteRuntime::init_default_runtime(options.into()).map_err(map_err)
    }

    /// Create a new box.
    ///
    /// This asynchronously pulls the container image (if needed), prepares
    /// the rootfs, spawns the VM, and waits for the guest agent to be ready.
    ///
    /// # Arguments
    /// * `options` - Box configuration (image, resources, volumes, etc.)
    /// * `name` - Optional user-defined name for the box
    ///
    /// # Returns
    /// A `Promise<JsBox>` that resolves to a box handle
    ///
    /// # Example
    /// ```javascript
    /// const box = await runtime.create({
    ///   image: 'python:slim',
    ///   memoryMib: 512,
    ///   cpus: 2
    /// }, 'my-python-box');
    /// ```
    #[napi]
    pub async fn create(&self, options: JsBoxOptions, name: Option<String>) -> Result<JsBox> {
        let runtime = Arc::clone(&self.runtime);
        let handle = runtime
            .create(options.into(), name)
            .await
            .map_err(map_err)?;

        Ok(JsBox {
            handle: Arc::new(handle),
        })
    }

    /// Get an existing box by name, or create a new one if it doesn't exist.
    ///
    /// Returns an object with `box` (the box handle) and `created` (true if
    /// newly created, false if an existing box was found).
    ///
    /// When an existing box is returned, the provided options are ignored.
    ///
    /// # Arguments
    /// * `options` - Box configuration (used only if creating a new box)
    /// * `name` - Name to look up or assign to the new box
    ///
    /// # Example
    /// ```javascript
    /// const result = await runtime.getOrCreate({ image: 'python:slim' }, 'my-worker');
    /// console.log(`Created: ${result.created}`);
    /// const box = result.box;
    /// ```
    #[napi]
    pub async fn get_or_create(
        &self,
        options: JsBoxOptions,
        name: Option<String>,
    ) -> Result<JsGetOrCreateResult> {
        let runtime = Arc::clone(&self.runtime);
        let (handle, created) = runtime
            .get_or_create(options.into(), name)
            .await
            .map_err(map_err)?;

        Ok(JsGetOrCreateResult {
            inner_handle: Arc::new(handle),
            inner_created: created,
        })
    }

    /// List all boxes managed by this runtime.
    ///
    /// Returns metadata for all boxes, including stopped and failed boxes.
    ///
    /// # Returns
    /// Array of box information objects
    ///
    /// # Example
    /// ```javascript
    /// const boxes = await runtime.listInfo();
    /// boxes.forEach(box => {
    ///   console.log(`${box.id}: ${box.status}`);
    /// });
    /// ```
    #[napi]
    pub async fn list_info(&self) -> Result<Vec<JsBoxInfo>> {
        let runtime = Arc::clone(&self.runtime);
        let infos = runtime.list_info().await.map_err(map_err)?;

        Ok(infos.into_iter().map(JsBoxInfo::from).collect())
    }

    /// Get information about a specific box by ID or name.
    ///
    /// # Arguments
    /// * `id_or_name` - Either a box ID (ULID) or user-defined name
    ///
    /// # Returns
    /// Box information if found, null otherwise
    ///
    /// # Example
    /// ```javascript
    /// const info = await runtime.getInfo('my-python-box');
    /// if (info) {
    ///   console.log(`Status: ${info.status}`);
    /// }
    /// ```
    #[napi]
    pub async fn get_info(&self, id_or_name: String) -> Result<Option<JsBoxInfo>> {
        let runtime = Arc::clone(&self.runtime);
        Ok(runtime
            .get_info(&id_or_name)
            .await
            .map_err(map_err)?
            .map(JsBoxInfo::from))
    }

    /// Get a box handle by ID or name (for reattach or restart).
    ///
    /// This allows you to reconnect to a box that was created in a previous
    /// session or by another process.
    ///
    /// # Arguments
    /// * `id_or_name` - Either a box ID (ULID) or user-defined name
    ///
    /// # Returns
    /// Box handle if found, null otherwise
    ///
    /// # Example
    /// ```javascript
    /// const box = await runtime.get('my-python-box');
    /// if (box) {
    ///   await box.exec('python', ['--version']);
    /// }
    /// ```
    #[napi]
    pub async fn get(&self, id_or_name: String) -> Result<Option<JsBox>> {
        tracing::trace!("JsBoxlite.get() called with id_or_name={}", id_or_name);

        let runtime = Arc::clone(&self.runtime);
        let result = runtime.get(&id_or_name).await.map_err(map_err)?;

        tracing::trace!("Rust get() returned: is_some={}", result.is_some());

        let js_box = result.map(|handle| {
            tracing::trace!("Wrapping LiteBox in JsBox for id_or_name={}", id_or_name);
            JsBox {
                handle: Arc::new(handle),
            }
        });

        tracing::trace!(
            "Returning JsBox to JavaScript: is_some={}",
            js_box.is_some()
        );
        Ok(js_box)
    }

    /// Get runtime metrics.
    ///
    /// Returns aggregated statistics about all boxes managed by this runtime.
    ///
    /// # Example
    /// ```javascript
    /// const metrics = await runtime.metrics();
    /// console.log(`Boxes created: ${metrics.boxesCreatedTotal}`);
    /// console.log(`Running: ${metrics.numRunningBoxes}`);
    /// ```
    #[napi]
    pub async fn metrics(&self) -> napi::Result<JsRuntimeMetrics> {
        let runtime = Arc::clone(&self.runtime);
        let metrics = runtime.metrics().await.map_err(map_err)?;
        Ok(JsRuntimeMetrics::from(metrics))
    }

    /// Remove a box by ID or name.
    ///
    /// This stops the box (if running) and deletes all associated files
    /// (rootfs, disk, configuration).
    ///
    /// # Arguments
    /// * `id_or_name` - Either a box ID (ULID) or user-defined name
    /// * `force` - If true, stop the box first if running (default: false)
    ///
    /// # Example
    /// ```javascript
    /// await runtime.remove('my-python-box', true);
    /// ```
    #[napi]
    pub async fn remove(&self, id_or_name: String, force: Option<bool>) -> Result<()> {
        let runtime = Arc::clone(&self.runtime);
        runtime
            .remove(&id_or_name, force.unwrap_or(false))
            .await
            .map_err(map_err)
    }

    /// Close the runtime (no-op, provided for API compatibility).
    ///
    /// BoxLite doesn't require explicit cleanup, but this method is provided
    /// for consistency with other SDKs.
    #[napi]
    pub fn close(&self) -> Result<()> {
        Ok(())
    }

    /// Gracefully shutdown all boxes in this runtime.
    ///
    /// This method stops all running boxes, waiting up to `timeout` seconds
    /// for each box to stop gracefully before force-killing it.
    ///
    /// After calling this method, the runtime is permanently shut down and
    /// will return errors for any new operations (like `create()`).
    ///
    /// # Arguments
    /// * `timeout` - Seconds to wait before force-killing each box:
    ///   - `null/undefined` - Use default timeout (10 seconds)
    ///   - Positive number - Wait that many seconds
    ///   - `-1` - Wait indefinitely (no timeout)
    ///
    /// # Example
    /// ```javascript
    /// // Default 10s timeout
    /// await runtime.shutdown();
    ///
    /// // Custom 30s timeout
    /// await runtime.shutdown(30);
    ///
    /// // Wait indefinitely
    /// await runtime.shutdown(-1);
    /// ```
    #[napi]
    pub async fn shutdown(&self, timeout: Option<i32>) -> Result<()> {
        let runtime = Arc::clone(&self.runtime);
        runtime.shutdown(timeout).await.map_err(map_err)
    }
}

/// Result of a `getOrCreate` operation.
#[napi]
pub struct JsGetOrCreateResult {
    inner_handle: Arc<boxlite::LiteBox>,
    inner_created: bool,
}

#[napi]
impl JsGetOrCreateResult {
    /// Whether the box was newly created (true) or already existed (false).
    #[napi(getter)]
    pub fn created(&self) -> bool {
        self.inner_created
    }

    /// The box handle.
    #[napi(getter, js_name = "box")]
    pub fn get_box(&self) -> JsBox {
        JsBox {
            handle: Arc::clone(&self.inner_handle),
        }
    }
}
