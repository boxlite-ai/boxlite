//! Explicit opt-ins for release-candidate BoxLite capabilities.
//!
//! Experimental features are unavailable by default and may change before
//! becoming stable. CLI users opt in through
//! [`BOXLITE_EXPERIMENTAL`](EXPERIMENTAL_FEATURES_ENV); Rust callers use
//! [`RuntimeBuilder`] so capability state is explicit and runtime-scoped.

use crate::runtime::options::{BoxOptions, BoxliteOptions};
use crate::{BoxliteError, BoxliteResult, BoxliteRuntime};
use std::collections::BTreeSet;

pub mod custom_kernel;
pub mod nested_virtualization;

/// Comma-separated list of release-candidate features enabled for this process.
pub const EXPERIMENTAL_FEATURES_ENV: &str = "BOXLITE_EXPERIMENTAL";

/// A release-candidate capability that can be enabled independently.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
#[non_exhaustive]
pub enum ExperimentalFeature {
    CustomKernel,
    NestedVirtualization,
}

impl ExperimentalFeature {
    /// Stable token used in [`EXPERIMENTAL_FEATURES_ENV`].
    pub const fn token(self) -> &'static str {
        match self {
            Self::CustomKernel => "custom-kernel",
            Self::NestedVirtualization => "nested-virtualization",
        }
    }

    const fn description(self) -> &'static str {
        match self {
            Self::CustomKernel => "custom kernel support",
            Self::NestedVirtualization => "nested virtualization support",
        }
    }
}

/// Parsed, granular release-candidate feature opt-ins.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ExperimentalFeatures {
    enabled: BTreeSet<ExperimentalFeature>,
}

impl ExperimentalFeatures {
    /// Parse a comma-separated feature list.
    pub fn parse(value: &str) -> BoxliteResult<Self> {
        if value.trim().is_empty() {
            return Ok(Self::default());
        }

        let mut enabled = BTreeSet::new();
        for token in value.split(',').map(str::trim) {
            let feature = match token {
                "custom-kernel" => ExperimentalFeature::CustomKernel,
                "nested-virtualization" => ExperimentalFeature::NestedVirtualization,
                "" => {
                    return Err(BoxliteError::Config(format!(
                        "{EXPERIMENTAL_FEATURES_ENV} contains an empty feature name"
                    )));
                }
                unknown => {
                    return Err(BoxliteError::Config(format!(
                        "unknown feature '{unknown}' in {EXPERIMENTAL_FEATURES_ENV}; supported values: custom-kernel, nested-virtualization"
                    )));
                }
            };
            enabled.insert(feature);
        }

        Ok(Self { enabled })
    }

    /// Whether a specific RC capability is enabled.
    pub fn is_enabled(&self, feature: ExperimentalFeature) -> bool {
        self.enabled.contains(&feature)
    }

    /// Fail with activation guidance unless a specific capability is enabled.
    pub fn require(&self, feature: ExperimentalFeature) -> BoxliteResult<()> {
        if self.is_enabled(feature) {
            return Ok(());
        }

        Err(BoxliteError::Config(format!(
            "{} is an RC feature and is disabled; enable ExperimentalFeature::{:?} when constructing the runtime (CLI: set {EXPERIMENTAL_FEATURES_ENV}={})",
            feature.description(),
            feature,
            feature.token()
        )))
    }

    pub(crate) fn require_for_options(&self, options: &BoxOptions) -> BoxliteResult<()> {
        if options.advanced.kernel.is_some() {
            self.require(ExperimentalFeature::CustomKernel)?;
        }
        if options.advanced.nested_virtualization {
            self.require(ExperimentalFeature::NestedVirtualization)?;
        }
        Ok(())
    }
}

/// Runtime-scoped capability declarations supplied by the embedder.
///
/// Grouped into one type so adding a capability does not grow every runtime
/// constructor's argument list.
#[derive(Clone, Debug, Default)]
pub struct RuntimeCapabilities {
    /// Release-candidate options this runtime will accept.
    pub features: ExperimentalFeatures,

    /// Whether the embedder runs a lifecycle sweeper that will act on the
    /// `auto_stop` / `auto_delete` deadlines.
    ///
    /// The engine never sweeps on its own. Accepting a deadline nothing acts on
    /// would store policy that is silently inert, so a runtime without a sweeper
    /// refuses an explicit deadline instead of pretending to honour it.
    /// `boxlite serve` sets this; a bare embedded runtime leaves it false.
    pub lifecycle_sweeper: bool,
}

/// Builder for a local runtime with explicit release-candidate capabilities.
#[derive(Clone, Debug)]
#[must_use]
pub struct RuntimeBuilder {
    options: BoxliteOptions,
    capabilities: RuntimeCapabilities,
}

impl RuntimeBuilder {
    /// Start configuring an experimental local runtime.
    pub fn new(options: BoxliteOptions) -> Self {
        Self {
            options,
            capabilities: RuntimeCapabilities::default(),
        }
    }

    /// Enable one release-candidate capability for this runtime.
    pub fn enable(mut self, feature: ExperimentalFeature) -> Self {
        self.capabilities.features.enabled.insert(feature);
        self
    }

    /// Replace the capabilities enabled for this runtime.
    pub fn with_features(mut self, features: ExperimentalFeatures) -> Self {
        self.capabilities.features = features;
        self
    }

    /// Declare that this embedder enforces lifecycle deadlines.
    ///
    /// Without this, `auto_stop` and `auto_delete` are refused rather than
    /// stored inertly. Set it only when a sweeper really runs.
    pub fn with_lifecycle_sweeper(mut self, enabled: bool) -> Self {
        self.capabilities.lifecycle_sweeper = enabled;
        self
    }

    /// Construct the local runtime with the selected capabilities.
    pub fn build(self) -> BoxliteResult<BoxliteRuntime> {
        BoxliteRuntime::new_with_capabilities(self.options, self.capabilities)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use custom_kernel::KernelOptions;

    #[test]
    fn feature_tokens_are_granular_and_trimmed() {
        let features =
            ExperimentalFeatures::parse(" custom-kernel, nested-virtualization ").unwrap();

        assert!(features.is_enabled(ExperimentalFeature::CustomKernel));
        assert!(features.is_enabled(ExperimentalFeature::NestedVirtualization));
    }

    #[test]
    fn empty_feature_list_enables_nothing() {
        let features = ExperimentalFeatures::parse("  ").unwrap();

        assert!(!features.is_enabled(ExperimentalFeature::CustomKernel));
        assert!(!features.is_enabled(ExperimentalFeature::NestedVirtualization));
    }

    #[test]
    fn unknown_feature_is_rejected() {
        let error = ExperimentalFeatures::parse("custom-kernel,unknown")
            .expect_err("unknown feature must fail closed");

        assert!(error.to_string().contains("unknown feature 'unknown'"));
    }

    #[test]
    fn custom_kernel_types_are_owned_by_the_experimental_api() {
        assert_eq!(
            std::any::type_name::<custom_kernel::KernelFormat>(),
            "boxlite::experimental::custom_kernel::KernelFormat"
        );
        assert_eq!(
            std::any::type_name::<custom_kernel::KernelOptions>(),
            "boxlite::experimental::custom_kernel::KernelOptions"
        );
    }

    #[test]
    fn custom_kernel_options_require_the_matching_token() {
        let mut options = BoxOptions::default();
        options.advanced.kernel = Some(KernelOptions::new("/tmp/vmlinux"));

        let error = ExperimentalFeatures::default()
            .require_for_options(&options)
            .expect_err("custom kernels must be disabled by default");

        assert!(
            error
                .to_string()
                .contains("BOXLITE_EXPERIMENTAL=custom-kernel")
        );
    }

    #[test]
    fn nested_virtualization_options_require_the_matching_token() {
        let mut options = BoxOptions::default();
        nested_virtualization::configure(&mut options);

        let error = ExperimentalFeatures::default()
            .require_for_options(&options)
            .expect_err("nested virtualization must be disabled by default");

        assert!(
            error
                .to_string()
                .contains("BOXLITE_EXPERIMENTAL=nested-virtualization")
        );

        let enabled = ExperimentalFeatures::parse("nested-virtualization").unwrap();
        enabled.require_for_options(&options).unwrap();
    }

    #[test]
    fn privileged_shape_does_not_require_an_experimental_token() {
        let mut options = BoxOptions::default();
        options.advanced.privileged = true;
        ExperimentalFeatures::default()
            .require_for_options(&options)
            .expect("privileged mode is a regular box option");
    }
}
