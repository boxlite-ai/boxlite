//! VMM Factory pattern for dependency management and engine creation.

use crate::vmm::{Vmm, VmmConfig};
use boxlite_shared::errors::BoxliteResult;

/// Factory trait for creating VMM engines.
pub trait VmmFactory {
    type Engine: Vmm;

    /// Create engine instance with the provided options
    fn create(options: VmmConfig) -> BoxliteResult<Self::Engine>;
}
