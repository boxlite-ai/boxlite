//! High-level sandbox runtime structures.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use crate::litebox::LiteBox;
use crate::metrics::RuntimeMetrics;
use crate::runtime::backend::RuntimeBackend;
use crate::runtime::options::{BoxOptions, BoxliteOptions};
use crate::runtime::rt_impl::{LocalRuntime, RuntimeImpl};
use crate::runtime::signal_handler::install_signal_handler;
use crate::runtime::types::BoxInfo;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
// ============================================================================
// GLOBAL DEFAULT RUNTIME
// ============================================================================

/// Global default runtime singleton (lazy initialization).
///
/// This runtime uses `BoxliteOptions::default()` for configuration.
/// Most applications should use this instead of creating custom runtimes.
static DEFAULT_RUNTIME: OnceLock<BoxliteRuntime> = OnceLock::new();

/// Flag to ensure atexit handler is only registered once.
static ATEXIT_INSTALLED: AtomicBool = AtomicBool::new(false);

/// Atexit handler: stops non-detached boxes on normal process exit.
///
/// The default runtime is `static` (never drops), so `Drop` won't fire.
/// This atexit handler covers the normal exit path. Signal handler covers
/// SIGTERM/SIGINT. Together they ensure all exit paths are handled.
extern "C" fn shutdown_on_exit() {
    if let Some(rt) = DEFAULT_RUNTIME.get() {
        rt.backend.shutdown_sync();
    }
}
// ============================================================================
// PUBLIC API
// ============================================================================

/// BoxliteRuntime provides the main entry point for creating and managing Boxes.
///
/// **Architecture**: Backend-agnostic — delegates to a `RuntimeBackend` implementation.
/// The default backend manages local VMs. Alternative backends (e.g., REST API)
/// can be selected via named constructors.
///
/// **Lock Behavior** (local backend): Only one local runtime can use a given
/// `BOXLITE_HOME` directory at a time. The filesystem lock is automatically
/// released when dropped.
///
/// **Cloning**: Runtime is cheaply cloneable via `Arc` - all clones share the same state.
#[derive(Clone)]
pub struct BoxliteRuntime {
    backend: Arc<dyn RuntimeBackend>,
    image_manager: Option<Arc<dyn crate::runtime::images::ImageManager>>,
}

// ============================================================================
// RUNTIME IMPLEMENTATION
// ============================================================================

impl BoxliteRuntime {
    /// Create a new BoxliteRuntime with the provided options (local backend).
    ///
    /// **Prepare Before Execute**: All setup (filesystem, locks, managers) completes
    /// before returning. No partial initialization states.
    ///
    /// # Errors
    ///
    /// Returns error if:
    /// - Another `BoxliteRuntime` is already using the same home directory
    /// - Filesystem initialization fails
    /// - Image API initialization fails
    pub fn new(options: BoxliteOptions) -> BoxliteResult<Self> {
        let local = LocalRuntime(RuntimeImpl::new(options)?);
        let backend_arc = Arc::new(local);
        let image_manager =
            Arc::clone(&backend_arc) as Arc<dyn crate::runtime::images::ImageManager>;
        Ok(Self {
            backend: backend_arc,
            image_manager: Some(image_manager),
        })
    }

    /// Create a REST-backed runtime connecting to a remote BoxLite API server.
    ///
    /// All box operations are delegated to the remote server via HTTP.
    /// The server manages its own VM lifecycle — this client just sends requests.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use boxlite::runtime::BoxliteRuntime;
    /// use boxlite::BoxliteRestOptions;
    ///
    /// let runtime = BoxliteRuntime::rest(
    ///     BoxliteRestOptions::new("https://api.example.com")
    ///         .with_credentials("client-id".into(), "secret".into())
    /// )?;
    /// # Ok::<(), Box<dyn std::error::Error>>(())
    /// ```
    #[cfg(feature = "rest")]
    pub fn rest(config: crate::rest::options::BoxliteRestOptions) -> BoxliteResult<Self> {
        let rest_runtime = crate::rest::runtime::RestRuntime::new(&config)?;
        Ok(Self {
            backend: Arc::new(rest_runtime),
            image_manager: None, // REST runtime doesn't support image operations
        })
    }

    /// Create a new runtime with default options.
    ///
    /// This is equivalent to `BoxliteRuntime::new(BoxliteOptions::default())`
    /// but returns a `Result` instead of panicking.
    ///
    /// Prefer `default_runtime()` for most use cases (shares global instance).
    /// Use this when you need an owned, non-global runtime with default config.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use boxlite::runtime::BoxliteRuntime;
    ///
    /// let runtime = BoxliteRuntime::with_defaults()?;
    /// # Ok::<(), Box<dyn std::error::Error>>(())
    /// ```
    pub fn with_defaults() -> BoxliteResult<Self> {
        Self::new(BoxliteOptions::default())
    }

    /// Get or initialize the default global runtime with automatic signal handling.
    ///
    /// This runtime uses `BoxliteOptions::default()` for configuration.
    /// The runtime is created lazily on first access and reused for all
    /// subsequent calls.
    ///
    /// **Signal Handling**: On first call, this also installs SIGTERM and SIGINT
    /// handlers that will gracefully shutdown all boxes before exiting. This is
    /// the recommended way to use BoxLite for simple applications.
    ///
    /// For applications that need custom signal handling, use `BoxliteRuntime::new()`
    /// instead and call `shutdown()` manually in your signal handler.
    ///
    /// # Panics
    ///
    /// Panics if runtime initialization fails. This indicates a serious
    /// system issue (e.g., cannot create home directory, filesystem lock).
    ///
    /// # Example
    ///
    /// ```no_run
    /// use boxlite::runtime::BoxliteRuntime;
    ///
    /// let runtime = BoxliteRuntime::default_runtime();
    /// // SIGTERM/SIGINT will automatically trigger graceful shutdown
    /// // All subsequent calls return the same runtime
    /// let same_runtime = BoxliteRuntime::default_runtime();
    /// ```
    pub fn default_runtime() -> &'static Self {
        let rt = DEFAULT_RUNTIME.get_or_init(|| {
            Self::with_defaults().expect("Failed to initialize default BoxliteRuntime")
        });

        // Register atexit handler (once) for normal exit cleanup.
        // The default runtime is static (never drops), so Drop won't fire.
        // This covers normal process exit; signal handler covers SIGTERM/SIGINT.
        if ATEXIT_INSTALLED
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            unsafe {
                libc::atexit(shutdown_on_exit);
            }
        }

        // Install signal handler for graceful shutdown.
        // Thread-based: works from any context (sync or async, with or without Tokio).
        // When signal is received, the shutdown callback stops all boxes gracefully.
        let backend = rt.backend.clone();
        install_signal_handler(move || async move {
            let _ = backend.shutdown(None).await;
        });

        rt
    }

    /// Try to get the default runtime if it's been initialized.
    ///
    /// Returns `None` if the default runtime hasn't been created yet.
    /// Useful for checking if default runtime exists without creating it.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use boxlite::runtime::BoxliteRuntime;
    ///
    /// if let Some(runtime) = BoxliteRuntime::try_default_runtime() {
    ///     println!("Default runtime already exists");
    /// } else {
    ///     println!("Default runtime not yet created");
    /// }
    /// ```
    pub fn try_default_runtime() -> Option<&'static Self> {
        DEFAULT_RUNTIME.get()
    }

    /// Initialize the default runtime with custom options.
    ///
    /// This must be called before the first use of `default_runtime()`.
    /// Returns an error if the default runtime has already been initialized.
    ///
    /// # Errors
    ///
    /// Returns error if:
    /// - Default runtime already initialized (call this early in main!)
    /// - Runtime initialization fails (filesystem, lock, etc.)
    ///
    /// # Example
    ///
    /// ```no_run
    /// use boxlite::runtime::{BoxliteRuntime, BoxliteOptions};
    /// use std::path::PathBuf;
    ///
    /// fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let mut opts = BoxliteOptions::default();
    ///     opts.home_dir = PathBuf::from("/custom/boxlite");
    ///
    ///     BoxliteRuntime::init_default_runtime(opts)?;
    ///
    ///     // All subsequent default_runtime() calls use custom config
    ///     let runtime = BoxliteRuntime::default_runtime();
    ///     Ok(())
    /// }
    /// ```
    pub fn init_default_runtime(options: BoxliteOptions) -> BoxliteResult<()> {
        let runtime = Self::new(options)?;
        DEFAULT_RUNTIME
            .set(runtime)
            .map_err(|_| BoxliteError::Internal(
                "Default runtime already initialized. Call init_default_runtime() before any use of default_runtime().".into()
            ))
    }

    // ========================================================================
    // BOX LIFECYCLE OPERATIONS (delegate to backend)
    // ========================================================================

    /// Create a box handle.
    ///
    /// Allocates a lock, persists the box to database with `Configured` status,
    /// and returns a LiteBox handle. The VM is not started until `start()` or
    /// `exec()` is called.
    ///
    /// The box is immediately visible in `list_info()` after creation.
    pub async fn create(
        &self,
        options: BoxOptions,
        name: Option<String>,
    ) -> BoxliteResult<LiteBox> {
        self.backend.create(options, name).await
    }

    /// Get an existing box by name, or create a new one if it doesn't exist.
    ///
    /// Returns `(LiteBox, true)` if a new box was created, or `(LiteBox, false)`
    /// if an existing box with the given name was found. When an existing box is
    /// returned, the provided `options` are ignored (no config drift validation).
    pub async fn get_or_create(
        &self,
        options: BoxOptions,
        name: Option<String>,
    ) -> BoxliteResult<(LiteBox, bool)> {
        self.backend.get_or_create(options, name).await
    }

    /// Get a handle to an existing box by ID or name.
    ///
    /// The `id_or_name` parameter can be either:
    /// - A box ID (ULID format, 26 characters)
    /// - A user-defined box name
    pub async fn get(&self, id_or_name: &str) -> BoxliteResult<Option<LiteBox>> {
        self.backend.get(id_or_name).await
    }

    /// Get information about a specific box by ID or name (without creating a handle).
    pub async fn get_info(&self, id_or_name: &str) -> BoxliteResult<Option<BoxInfo>> {
        self.backend.get_info(id_or_name).await
    }

    /// List all boxes, sorted by creation time (newest first).
    pub async fn list_info(&self) -> BoxliteResult<Vec<BoxInfo>> {
        self.backend.list_info().await
    }

    /// Check if a box with the given ID or name exists.
    pub async fn exists(&self, id_or_name: &str) -> BoxliteResult<bool> {
        self.backend.exists(id_or_name).await
    }

    /// Get runtime-wide metrics.
    pub async fn metrics(&self) -> BoxliteResult<RuntimeMetrics> {
        self.backend.metrics().await
    }

    /// Remove a box completely by ID or name.
    pub async fn remove(&self, id_or_name: &str, force: bool) -> BoxliteResult<()> {
        self.backend.remove(id_or_name, force).await
    }

    // ========================================================================
    // SHUTDOWN OPERATIONS
    // ========================================================================

    /// Gracefully shutdown all boxes in this runtime.
    ///
    /// This method stops all running boxes, waiting up to `timeout` seconds
    /// for each box to stop gracefully before force-killing it.
    ///
    /// After calling this method, the runtime is permanently shut down and
    /// will return errors for any new operations (like `create()`).
    ///
    /// # Arguments
    ///
    /// * `timeout` - Seconds to wait before force-killing each box:
    ///   - `None` - Use default timeout (10 seconds)
    ///   - `Some(n)` where n > 0 - Wait n seconds
    ///   - `Some(-1)` - Wait indefinitely (no timeout)
    ///
    /// # Example
    ///
    /// ```no_run
    /// use boxlite::runtime::BoxliteRuntime;
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let runtime = BoxliteRuntime::new(Default::default())?;
    ///
    ///     // ... create and use boxes ...
    ///
    ///     // On signal or shutdown request:
    ///     runtime.shutdown(None).await?; // Default 10s timeout
    ///     // or
    ///     runtime.shutdown(Some(30)).await?; // 30s timeout
    ///     // or
    ///     runtime.shutdown(Some(-1)).await?; // Wait forever
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn shutdown(&self, timeout: Option<i32>) -> BoxliteResult<()> {
        self.backend.shutdown(timeout).await
    }

    // ========================================================================
    // IMAGE OPERATIONS (via ImageHandle)
    // ========================================================================

    /// Get a handle for image operations (pull, list).
    ///
    /// Returns an `ImageHandle` that provides methods for pulling and listing images.
    /// This abstraction separates image management from runtime management,
    /// following the same pattern as `LiteBox` for box operations.
    ///
    /// # Errors
    ///
    /// Returns `BoxliteError::Unsupported` if called on a REST runtime,
    /// as image operations are only supported for local runtimes.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use boxlite::runtime::BoxliteRuntime;
    ///
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let runtime = BoxliteRuntime::with_defaults()?;
    /// let images = runtime.images()?;
    ///
    /// // Pull an image
    /// let image = images.pull("alpine:latest").await?;
    /// println!("Pulled: {}", image.reference());
    ///
    /// // List all images
    /// let all_images = images.list().await?;
    /// println!("Total images: {}", all_images.len());
    /// # Ok(())
    /// # }
    /// ```
    pub fn images(&self) -> BoxliteResult<crate::runtime::ImageHandle> {
        match &self.image_manager {
            Some(manager) => Ok(crate::runtime::ImageHandle::new(Arc::clone(manager))),
            None => Err(BoxliteError::Unsupported(
                "Image operations not supported over REST API".to_string(),
            )),
        }
    }
}

// ============================================================================
// DEBUG
// ============================================================================

impl std::fmt::Debug for BoxliteRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BoxliteRuntime").finish_non_exhaustive()
    }
}

// ============================================================================
// THREAD SAFETY ASSERTIONS
// ============================================================================

// Compile-time assertions to ensure BoxliteRuntime is Send + Sync
// This is critical for multithreaded usage (e.g., Python GIL release)
const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    let _ = assert_send_sync::<BoxliteRuntime>;
};
