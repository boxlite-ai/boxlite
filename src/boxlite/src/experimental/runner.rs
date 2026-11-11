//! Internal Cloud Runner integration; ordinary local runtime behavior is unchanged.

/// Apply a transient Cloud policy to this cold start, without changing saved options.
pub fn start(
    box_handle: &crate::LiteBox,
    nested_virtualization: bool,
) -> futures::future::BoxFuture<'static, boxlite_shared::errors::BoxliteResult<()>> {
    box_handle.runner_start(nested_virtualization)
}
