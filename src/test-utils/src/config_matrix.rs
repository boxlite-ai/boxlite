//! Multi-configuration test runner for boxlite.
//!
//! Adapts RocksDB's `do/while(ChangeOptions())` pattern. Runs one test body
//! across multiple [`BoxOptions`] configurations.
//!
//! # Key types
//!
//! - [`BoxConfig`] — named configuration with skip conditions
//! - [`SkipCondition`] — platform/CI skip conditions
//! - [`default_configs()`] — standard config matrix (~8 configs)
//!
//! # Key functions
//!
//! - [`run_config_matrix()`] — sequential runner
//! - [`config_matrix_tests!`] — generates individual `#[tokio::test]` per config

use boxlite::runtime::advanced_options::{AdvancedBoxOptions, SecurityOptions};
use boxlite::runtime::options::{BoxOptions, RootfsSpec};

// ============================================================================
// SKIP CONDITIONS
// ============================================================================

/// Conditions under which a config should be skipped.
#[derive(Clone, Debug, Default)]
pub struct SkipCondition {
    /// Skip on macOS.
    pub macos: bool,
    /// Skip on Linux.
    pub linux: bool,
    /// Skip in CI environments (`CI` env var is set).
    pub ci: bool,
    /// Skip when jailer is not available on the platform.
    pub no_jailer: bool,
}

impl SkipCondition {
    /// Check whether this config should be skipped on the current platform.
    pub fn should_skip(&self) -> Option<&'static str> {
        if self.macos && cfg!(target_os = "macos") {
            return Some("skipped on macOS");
        }
        if self.linux && cfg!(target_os = "linux") {
            return Some("skipped on Linux");
        }
        if self.ci && std::env::var("CI").is_ok() {
            return Some("skipped in CI");
        }
        if self.no_jailer && !SecurityOptions::is_full_isolation_available() {
            return Some("skipped: no jailer support");
        }
        None
    }
}

// ============================================================================
// BOX CONFIG
// ============================================================================

/// A named `BoxOptions` configuration for multi-config testing.
#[derive(Clone, Debug)]
pub struct BoxConfig {
    /// Human-readable name (e.g., "default", "jailer_enabled").
    pub name: &'static str,
    /// The `BoxOptions` to use.
    pub options: BoxOptions,
    /// When to skip this config.
    pub skip_on: SkipCondition,
}

// ============================================================================
// DEFAULT CONFIGS
// ============================================================================

/// Standard configuration matrix (~8 configs).
///
/// Covers common option combinations:
/// - `default` — all defaults
/// - `jailer_enabled` — explicit jailer on
/// - `jailer_disabled` — jailer off (development mode)
/// - `small_memory` — 256 MiB memory
/// - `large_disk` — 4 GB disk
/// - `auto_remove_false` — keep box after stop
/// - `detach_mode` — detached box
/// - `max_security` — maximum security preset
pub fn default_configs() -> Vec<BoxConfig> {
    vec![
        BoxConfig {
            name: "default",
            options: BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_remove: false,
                ..Default::default()
            },
            skip_on: SkipCondition::default(),
        },
        BoxConfig {
            name: "jailer_enabled",
            options: BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_remove: false,
                advanced: AdvancedBoxOptions {
                    security: SecurityOptions::standard(),
                    ..Default::default()
                },
                ..Default::default()
            },
            skip_on: SkipCondition::default(),
        },
        BoxConfig {
            name: "jailer_disabled",
            options: BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_remove: false,
                advanced: AdvancedBoxOptions {
                    security: SecurityOptions::development(),
                    ..Default::default()
                },
                ..Default::default()
            },
            skip_on: SkipCondition::default(),
        },
        BoxConfig {
            name: "small_memory",
            options: BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                memory_mib: Some(256),
                auto_remove: false,
                ..Default::default()
            },
            skip_on: SkipCondition::default(),
        },
        BoxConfig {
            name: "large_disk",
            options: BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                disk_size_gb: Some(4),
                auto_remove: false,
                ..Default::default()
            },
            skip_on: SkipCondition::default(),
        },
        BoxConfig {
            name: "auto_remove_false",
            options: BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_remove: false,
                ..Default::default()
            },
            skip_on: SkipCondition::default(),
        },
        BoxConfig {
            name: "detach_mode",
            options: BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_remove: false,
                detach: true,
                ..Default::default()
            },
            skip_on: SkipCondition::default(),
        },
        BoxConfig {
            name: "max_security",
            options: BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_remove: false,
                advanced: AdvancedBoxOptions {
                    security: SecurityOptions::maximum(),
                    ..Default::default()
                },
                ..Default::default()
            },
            skip_on: SkipCondition::default(),
        },
    ]
}

/// Get a config by name from `default_configs()`.
pub fn config_by_name(name: &str) -> Option<BoxConfig> {
    default_configs().into_iter().find(|c| c.name == name)
}

// ============================================================================
// SKIP MASKS
// ============================================================================

/// Skip mask constants for `run_config_matrix`.
pub mod skip {
    /// No configs skipped.
    pub const NONE: u32 = 0;
    /// Skip the `jailer_enabled` config.
    pub const JAILER_ENABLED: u32 = 1 << 0;
    /// Skip the `jailer_disabled` config.
    pub const JAILER_DISABLED: u32 = 1 << 1;
    /// Skip the `max_security` config.
    pub const MAX_SECURITY: u32 = 1 << 2;
    /// Skip the `detach_mode` config.
    pub const DETACH_MODE: u32 = 1 << 3;
    /// Skip the `small_memory` config.
    pub const SMALL_MEMORY: u32 = 1 << 4;
    /// Skip the `large_disk` config.
    pub const LARGE_DISK: u32 = 1 << 5;

    /// Map config name to skip mask bit.
    pub fn mask_for(name: &str) -> u32 {
        match name {
            "jailer_enabled" => JAILER_ENABLED,
            "jailer_disabled" => JAILER_DISABLED,
            "max_security" => MAX_SECURITY,
            "detach_mode" => DETACH_MODE,
            "small_memory" => SMALL_MEMORY,
            "large_disk" => LARGE_DISK,
            _ => 0,
        }
    }
}

// ============================================================================
// SEQUENTIAL RUNNER
// ============================================================================

/// Run a test body across all default configs, skipping those masked out.
///
/// The test body receives a reference to `BoxliteRuntime` and the current `BoxConfig`.
/// Each config is run sequentially. On skip, a message is printed to stderr.
///
/// # Example
///
/// ```ignore
/// use boxlite_test_utils::config_matrix::{run_config_matrix, skip};
///
/// #[tokio::test]
/// async fn exec_echo_across_configs() {
///     run_config_matrix(skip::NONE, |runtime, config| async move {
///         let handle = runtime.create(config.options.clone(), None).await.unwrap();
///         handle.start().await.unwrap();
///         // ... test body ...
///         handle.stop().await.unwrap();
///     }).await;
/// }
/// ```
pub async fn run_config_matrix<F, Fut>(skip_mask: u32, test_body: F)
where
    F: Fn(boxlite::BoxliteRuntime, BoxConfig) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    use boxlite::runtime::options::BoxliteOptions;

    let configs = default_configs();

    for config in configs {
        // Check skip mask
        if skip_mask & skip::mask_for(config.name) != 0 {
            eprintln!("[config_matrix] skipping {} (skip mask)", config.name);
            continue;
        }

        // Check platform skip conditions
        if let Some(reason) = config.skip_on.should_skip() {
            eprintln!("[config_matrix] skipping {} ({reason})", config.name);
            continue;
        }

        eprintln!("[config_matrix] running config: {}", config.name);

        let home = crate::home::PerTestBoxHome::new();
        let runtime = boxlite::BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: crate::test_registries(),
        })
        .expect("create runtime for config matrix");

        test_body(runtime, config).await;

        // home dropped here → cleanup
        drop(home);
    }
}

// ============================================================================
// PER-CONFIG TEST MACRO
// ============================================================================

/// Generate individual `#[tokio::test]` functions per config.
///
/// Each generated test has its own name (`{name}__{config}`), enabling
/// parallel execution with `cargo nextest`.
///
/// # Example
///
/// ```ignore
/// use boxlite_test_utils::config_matrix_tests;
///
/// config_matrix_tests! {
///     name: exec_echo,
///     configs: [default, jailer_disabled],
///     body: |runtime, config| async move {
///         let handle = runtime.create(config.options.clone(), None).await.unwrap();
///         handle.start().await.unwrap();
///         handle.stop().await.unwrap();
///     }
/// }
/// // Generates:
/// //   #[tokio::test] async fn exec_echo__default() { ... }
/// //   #[tokio::test] async fn exec_echo__jailer_disabled() { ... }
/// ```
#[macro_export]
macro_rules! config_matrix_tests {
    (
        name: $test_name:ident,
        configs: [$($config_name:ident),+ $(,)?],
        body: $body:expr
    ) => {
        $(
            ::paste::paste! {
                #[tokio::test]
                async fn [<$test_name __ $config_name>]() {
                    let config = $crate::config_matrix::config_by_name(
                        stringify!($config_name)
                    ).unwrap_or_else(|| panic!(
                        "unknown config: {}",
                        stringify!($config_name)
                    ));

                    if let Some(reason) = config.skip_on.should_skip() {
                        eprintln!(
                            "[config_matrix] skipping {} ({})",
                            stringify!([<$test_name __ $config_name>]),
                            reason,
                        );
                        return;
                    }

                    let home = $crate::home::PerTestBoxHome::new();
                    let runtime = ::boxlite::BoxliteRuntime::new(
                        ::boxlite::runtime::options::BoxliteOptions {
                            home_dir: home.path.clone(),
                            image_registries: $crate::test_registries(),
                        }
                    ).expect("create runtime for config matrix test");

                    let test_fn = $body;
                    test_fn(runtime, config).await;

                    drop(home);
                }
            }
        )+
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_configs_has_expected_count() {
        let configs = default_configs();
        assert_eq!(configs.len(), 8);
    }

    #[test]
    fn default_configs_have_unique_names() {
        let configs = default_configs();
        let mut names: Vec<_> = configs.iter().map(|c| c.name).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), configs.len(), "duplicate config names found");
    }

    #[test]
    fn config_by_name_finds_existing() {
        assert!(config_by_name("default").is_some());
        assert!(config_by_name("jailer_enabled").is_some());
        assert!(config_by_name("max_security").is_some());
    }

    #[test]
    fn config_by_name_returns_none_for_unknown() {
        assert!(config_by_name("nonexistent").is_none());
    }

    #[test]
    fn skip_mask_filters_configs() {
        let mask = skip::JAILER_ENABLED | skip::MAX_SECURITY;
        assert_ne!(mask & skip::mask_for("jailer_enabled"), 0);
        assert_ne!(mask & skip::mask_for("max_security"), 0);
        assert_eq!(mask & skip::mask_for("default"), 0);
        assert_eq!(mask & skip::mask_for("jailer_disabled"), 0);
    }

    #[test]
    fn skip_condition_none_by_default() {
        let cond = SkipCondition::default();
        assert!(cond.should_skip().is_none());
    }

    #[test]
    fn skip_condition_platform() {
        let cond = SkipCondition {
            #[cfg(target_os = "macos")]
            macos: true,
            #[cfg(target_os = "linux")]
            linux: true,
            ..Default::default()
        };
        // On either platform this should skip
        assert!(cond.should_skip().is_some());
    }
}
