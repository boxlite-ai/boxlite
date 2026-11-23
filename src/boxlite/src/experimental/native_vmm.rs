//! Release-candidate selection of BoxLite's own VMM as the box engine.

/// Run a box on the native VMM instead of libkrun.
///
/// The runtime must also enable
/// [`ExperimentalFeature::NativeVmm`](crate::experimental::ExperimentalFeature::NativeVmm),
/// and the box needs a kernel through the custom-kernel RC until the runtime
/// bundles one. Devices the native VMM lacks make the box fail to start.
pub fn configure(options: &mut crate::BoxOptions) {
    options.advanced.engine = Some(crate::vmm::VmmKind::Native);
}
