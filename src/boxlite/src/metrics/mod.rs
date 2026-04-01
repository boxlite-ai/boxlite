//! Metrics collection for Boxlite runtime.
//!
//! This module provides a two-level metrics hierarchy inspired by Tokio:
//! - **RuntimeMetrics**: Aggregate metrics across all boxes (like Tokio's RuntimeMetrics)
//! - **BoxMetrics**: Per-box metrics for individual LiteBox instances (like Tokio's TaskMetrics)
//!
//! # Design
//!
//! All counters are monotonic (never decrease). Delta calculation is the caller's
//! responsibility. Future `boxlite-metrics` crate may provide helpers (deferred).
//!
//! # Example
//!
//! ```rust,no_run
//! use boxlite_runtime::BoxliteRuntime;
//!
//! # async fn example() -> Result<(), Box<dyn std::error::Error>> {
//! let runtime = BoxliteRuntime::new(Default::default())?;
//!
//! // Level 1: Runtime-wide metrics
//! let rt_metrics = runtime.metrics();
//! println!("Boxes created: {}", rt_metrics.boxes_created_total());
//! println!("Running boxes: {}", rt_metrics.num_running_boxes());
//!
//! // Level 2: Per-box metrics
//! let (box_id, litebox) = runtime.create(Default::default()).await?;
//! let box_metrics = litebox.metrics().await?;
//! println!("Box boot time: {}ms", box_metrics.guest_boot_duration_ms().unwrap_or(0));
//! # Ok(())
//! # }
//! ```

mod box_metrics;
mod runtime_metrics;

pub use box_metrics::{BoxMetrics, BoxMetricsStorage};
pub use runtime_metrics::{RuntimeMetrics, RuntimeMetricsStorage};
