//! Internal Runner integration. These bridges are not supported SDK controls.

/// Apply the control plane's saved decision before managed-runtime validation.
pub fn set_nested_virtualization(options: &mut crate::AdvancedBoxOptions, enabled: bool) {
    options.nested_virtualization = enabled;
}
