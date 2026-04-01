//! Krun engine factory implementation.

use crate::vmm::{
    VmmConfig, VmmKind, factory::VmmFactory, krun::Krun, registry::EngineFactoryRegistration,
};
use boxlite_shared::errors::BoxliteResult;

pub struct KrunFactory;

impl VmmFactory for KrunFactory {
    type Engine = Krun;

    fn create(options: VmmConfig) -> BoxliteResult<Self::Engine> {
        Krun::new(options)
    }
}

// Auto-register this factory with the global registry at compile time
inventory::submit! {
    EngineFactoryRegistration {
        kind: VmmKind::Libkrun,
        factory: |options| {
            Ok(Box::new(KrunFactory::create(options)?))
        }
    }
}
