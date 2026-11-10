//! Internal Runner integration. These bridges are not supported SDK controls.

/// Apply the control plane's saved decision before managed-runtime validation.
pub fn set_nested_virtualization(options: &mut crate::AdvancedBoxOptions, enabled: bool) {
    options.nested_virtualization = enabled;
}

/// Start a managed box, preserving saved nesting and applying an optional upgrade.
pub fn start(
    box_handle: &crate::LiteBox,
    nested_virtualization: bool,
) -> futures::future::BoxFuture<'static, boxlite_shared::errors::BoxliteResult<()>> {
    box_handle.runner_start(nested_virtualization)
}
