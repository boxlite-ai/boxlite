//! Release-candidate nested virtualization configuration.

/// Require nested virtualization for a box.
///
/// The runtime must also enable
/// [`ExperimentalFeature::NestedVirtualization`](crate::experimental::ExperimentalFeature::NestedVirtualization).
/// Box startup fails rather than falling back when the host cannot provide the
/// requested virtualization support.
pub fn configure(options: &mut crate::BoxOptions) {
    options.advanced.nested_virtualization = true;
}
