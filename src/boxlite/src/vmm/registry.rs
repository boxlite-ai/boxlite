//! Engine factory using the inventory pattern for compile-time registration.
//!
//! Engine implementations register themselves at compile time using `inventory::submit!`.
//! No manual registration, HashMap, or singleton pattern needed - just pure inventory.

use crate::vmm::{Vmm, VmmConfig, VmmKind};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// Type alias for engine factory functions.
pub type EngineFactoryFn = fn(VmmConfig) -> BoxliteResult<Box<dyn Vmm>>;

/// Registration entry submitted by engine implementations via inventory.
///
/// Each engine implementation creates one of these and submits it using
/// `inventory::submit!` macro, which collects all registrations at compile time.
pub struct EngineFactoryRegistration {
    pub kind: VmmKind,
    pub factory: EngineFactoryFn,
}

// Collect all engine registrations at compile time
inventory::collect!(EngineFactoryRegistration);

/// Create an engine instance by looking up the registered factory.
///
/// This function iterates over all compile-time registered factories
/// and invokes the one matching the requested engine kind.
///
/// # Arguments
/// * `kind` - The type of engine to create
/// * `options` - Configuration options for the engine
///
/// # Returns
/// * `Ok(Box<dyn Vmm>)` - Successfully created engine instance
/// * `Err(BoxliteError::Unsupported)` - Engine kind not registered in this build
/// * `Err(BoxliteError::Engine)` - Engine creation failed
///
/// # Example
/// ```rust,no_run
/// use boxlite_runtime::vmm::{self, VmmKind, VmmConfig};
///
/// let options = VmmConfig::default();
/// let engine = vmm::create_engine(VmmKind::Libkrun, options)?;
/// # Ok::<(), boxlite_runtime::errors::BoxliteError>(())
/// ```
pub fn create_engine(kind: VmmKind, options: VmmConfig) -> BoxliteResult<Box<dyn Vmm>> {
    // Iterate over all registered factories
    for registration in inventory::iter::<EngineFactoryRegistration> {
        if registration.kind == kind {
            tracing::debug!(engine = ?kind, "Creating engine instance");
            return (registration.factory)(options);
        }
    }

    // Engine not found - list available engines for helpful error message
    let available: Vec<_> = inventory::iter::<EngineFactoryRegistration>()
        .map(|r| r.kind)
        .collect();

    Err(BoxliteError::Unsupported(format!(
        "engine {kind:?} is not available in this build; available engines: {available:?}"
    )))
}

/// Check if an engine kind is registered.
pub fn is_registered(kind: VmmKind) -> bool {
    inventory::iter::<EngineFactoryRegistration>().any(|r| r.kind == kind)
}

/// Get a list of all registered engine kinds.
pub fn available_engines() -> Vec<VmmKind> {
    inventory::iter::<EngineFactoryRegistration>()
        .map(|r| r.kind)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(feature = "krun")]
    fn test_libkrun_registered() {
        // At minimum, libkrun should be registered
        assert!(is_registered(VmmKind::Libkrun));

        let available = available_engines();
        assert!(!available.is_empty());
        assert!(available.contains(&VmmKind::Libkrun));
    }

    #[test]
    fn test_unregistered_engine() {
        let options = VmmConfig::default();

        // Firecracker might not be implemented yet
        if !is_registered(VmmKind::Firecracker) {
            let result = create_engine(VmmKind::Firecracker, options);
            match result {
                Err(BoxliteError::Unsupported(message)) => {
                    assert!(message.contains("not available in this build"), "{message}");
                }
                other => panic!("expected Unsupported, got {:?}", other.map(|_| ())),
            }
        }
    }

    #[test]
    #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
    fn the_native_engine_is_registered() {
        assert!(is_registered(VmmKind::Native));
        assert!(create_engine(VmmKind::Native, VmmConfig::default()).is_ok());
    }

    #[test]
    #[cfg(feature = "krun")]
    fn test_create_libkrun_engine() {
        let options = VmmConfig::default();
        let result = create_engine(VmmKind::Libkrun, options);

        // Should succeed (engine is registered)
        assert!(result.is_ok());
    }
}
