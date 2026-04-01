//! Box lifecycle status and state machine.
//!
//! Defines the possible states of a box and valid transitions between them.

use crate::ContainerID;
use crate::lock::LockId;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Lifecycle status of a box.
///
/// Represents the current operational state of a VM box.
/// Transitions between states are validated by the state machine.
///
/// State machine:
/// ```text
/// create()  → Configured (persisted to DB, no VM)
/// start()   → Running (VM initialized)
/// SIGSTOP   → Paused (VM frozen, used during export/snapshot)
/// SIGCONT   → Running (VM resumed)
/// stop()    → Stopped (VM terminated, can restart)
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BoxStatus {
    /// Cannot determine box state (error recovery).
    Unknown,

    /// Box is created and persisted, but VM not yet started.
    /// No VM process allocated. Call start() or exec() to initialize.
    Configured,

    /// Box is running and guest server is accepting commands.
    Running,

    /// Box is shutting down gracefully (transient state).
    Stopping,

    /// Box is not running. VM process terminated.
    /// Rootfs is preserved, box can be restarted.
    Stopped,

    /// Box VM is frozen via SIGSTOP (all vCPUs and virtio backends paused).
    /// Used during export/snapshot for point-in-time consistency.
    /// Equivalent to Docker's cgroup freezer pause.
    Paused,
}

impl BoxStatus {
    /// Check if this status represents an active VM (process is running or paused).
    pub fn is_active(&self) -> bool {
        matches!(self, BoxStatus::Running | BoxStatus::Paused)
    }

    pub fn is_running(&self) -> bool {
        matches!(self, BoxStatus::Running)
    }

    pub fn is_configured(&self) -> bool {
        matches!(self, BoxStatus::Configured)
    }

    pub fn is_stopped(&self) -> bool {
        matches!(self, BoxStatus::Stopped)
    }

    pub fn is_paused(&self) -> bool {
        matches!(self, BoxStatus::Paused)
    }

    /// Check if this status represents a transient state.
    pub fn is_transient(&self) -> bool {
        matches!(self, BoxStatus::Stopping)
    }

    /// Check if start() can be called from this state.
    /// Configured boxes need first start, Stopped boxes can restart.
    pub fn can_start(&self) -> bool {
        matches!(self, BoxStatus::Configured | BoxStatus::Stopped)
    }

    /// Check if stop() can be called from this state.
    /// Running and Paused boxes can be stopped.
    pub fn can_stop(&self) -> bool {
        matches!(self, BoxStatus::Running | BoxStatus::Paused)
    }

    /// Check if remove() can be called from this state.
    /// Configured, Stopped, and Unknown boxes can be removed.
    pub fn can_remove(&self) -> bool {
        matches!(
            self,
            BoxStatus::Configured | BoxStatus::Stopped | BoxStatus::Unknown
        )
    }

    /// Check if exec() can be called from this state.
    /// Configured and Stopped will trigger implicit start().
    pub fn can_exec(&self) -> bool {
        matches!(
            self,
            BoxStatus::Configured | BoxStatus::Running | BoxStatus::Stopped
        )
    }

    /// Check if transition to target state is valid.
    pub fn can_transition_to(&self, target: BoxStatus) -> bool {
        use BoxStatus::*;
        matches!(
            (self, target),
            // Unknown can transition to any state (recovery)
            (Unknown, _) |
            // Configured → Running (start success) or Stopped (start failed)
            (Configured, Running) |
            (Configured, Stopped) |
            (Configured, Unknown) |
            // Running → Stopping (graceful), Stopped (crash), or Paused (SIGSTOP)
            (Running, Stopping) |
            (Running, Stopped) |
            (Running, Paused) |
            (Running, Unknown) |
            // Stopping → Stopped (complete) or Unknown (error)
            (Stopping, Stopped) |
            (Stopping, Unknown) |
            // Stopped → Running (restart)
            (Stopped, Running) |
            (Stopped, Unknown) |
            // Paused → Running (SIGCONT resume) or Stopped (killed while paused)
            (Paused, Running) |
            (Paused, Stopped) |
            (Paused, Unknown)
        )
    }

    /// Convert to string for database storage.
    pub fn as_str(&self) -> &'static str {
        match self {
            BoxStatus::Unknown => "unknown",
            BoxStatus::Configured => "configured",
            BoxStatus::Running => "running",
            BoxStatus::Stopping => "stopping",
            BoxStatus::Stopped => "stopped",
            BoxStatus::Paused => "paused",
        }
    }
}

impl std::str::FromStr for BoxStatus {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "unknown" => Ok(BoxStatus::Unknown),
            "configured" => Ok(BoxStatus::Configured),
            // Legacy: support "starting" for backward compatibility with existing databases
            "starting" => Ok(BoxStatus::Configured),
            "running" => Ok(BoxStatus::Running),
            "stopping" => Ok(BoxStatus::Stopping),
            "stopped" => Ok(BoxStatus::Stopped),
            "paused" => Ok(BoxStatus::Paused),
            // Legacy: old transient statuses map to Stopped (DB backward compat)
            "snapshotting" | "restoring" | "exporting" | "cloning" => Ok(BoxStatus::Stopped),
            _ => Err(()),
        }
    }
}

impl std::fmt::Display for BoxStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Dynamic box state (changes during lifecycle).
///
/// This is updated frequently and persisted to database.
/// State transitions are validated before applying.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoxState {
    /// Current lifecycle status.
    pub status: BoxStatus,
    pub pid: Option<u32>,
    pub container_id: Option<ContainerID>,
    /// Last state change timestamp (UTC).
    pub last_updated: DateTime<Utc>,
    /// Lock ID for multiprocess-safe locking.
    ///
    /// Allocated when the box is first initialized (not at creation time).
    /// Used to retrieve the lock across process restarts.
    pub lock_id: Option<LockId>,
    /// Health status.
    #[serde(default)]
    pub health_status: HealthStatus,
}

/// Health status of a box.
///
/// Tracks the current health state and consecutive failure count.
/// Similar to Docker's health check status.
#[derive(Debug, Copy, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthStatus {
    /// Current health state.
    pub state: HealthState,
    /// Consecutive health check failures.
    pub failures: u32,
    /// Last health check timestamp.
    pub last_check: Option<DateTime<Utc>>,
}

impl HealthStatus {
    /// Create a new health status with no health check configured.
    pub fn new() -> Self {
        Self {
            state: HealthState::None,
            failures: 0,
            last_check: None,
        }
    }

    /// Initialize health status (called when box starts with health check configured).
    pub fn init(&mut self) {
        self.state = HealthState::Starting;
        self.failures = 0;
        self.last_check = Some(Utc::now());
    }

    /// Update health status after a successful check.
    pub fn mark_success(&mut self) {
        self.state = HealthState::Healthy;
        self.failures = 0;
        self.last_check = Some(Utc::now());
    }

    /// Update health status after a failed check.
    /// Returns true if the box should be marked unhealthy.
    pub fn mark_failure(&mut self, retries: u32) -> bool {
        self.failures += 1;
        self.last_check = Some(Utc::now());

        if self.failures >= retries {
            self.state = HealthState::Unhealthy;
            return true;
        }
        false
    }

    /// Clear health status (called when box stops).
    pub fn clear(&mut self) {
        self.state = HealthState::None;
        self.failures = 0;
        self.last_check = None;
    }
}

impl Default for HealthStatus {
    fn default() -> Self {
        Self::new()
    }
}

/// Health state of a box.
///
/// Docker-compatible health states:
/// - None: No health check configured
/// - Starting: Within start_period, not yet checked
/// - Healthy: Last health check passed
/// - Unhealthy: Failed `retries` consecutive checks
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HealthState {
    /// No health check configured.
    None,
    /// Within start_period, not yet checked.
    Starting,
    /// Last health check passed.
    Healthy,
    /// Failed retries consecutive checks.
    Unhealthy,
}

impl BoxState {
    /// Create initial state for a new box.
    /// Box starts in Configured status (persisted, no VM yet).
    pub fn new() -> Self {
        Self {
            status: BoxStatus::Configured,
            pid: None,
            container_id: None,
            last_updated: Utc::now(),
            lock_id: None,
            health_status: HealthStatus::new(),
        }
    }

    /// Set lock ID and update timestamp.
    pub fn set_lock_id(&mut self, lock_id: LockId) {
        self.lock_id = Some(lock_id);
        self.last_updated = Utc::now();
    }

    /// Attempt state transition with validation.
    ///
    /// Returns error if the transition is not valid.
    pub fn transition_to(&mut self, new_status: BoxStatus) -> BoxliteResult<()> {
        if !self.status.can_transition_to(new_status) {
            return Err(BoxliteError::InvalidState(format!(
                "Cannot transition from {} to {}",
                self.status, new_status
            )));
        }

        self.status = new_status;
        self.last_updated = Utc::now();
        Ok(())
    }

    /// Force set status without validation (for recovery/internal use).
    pub fn force_status(&mut self, status: BoxStatus) {
        self.status = status;
        self.last_updated = Utc::now();
    }

    /// Set status directly (alias for force_status, used by manager).
    pub fn set_status(&mut self, status: BoxStatus) {
        self.force_status(status);
    }

    /// Set PID and update timestamp.
    pub fn set_pid(&mut self, pid: Option<u32>) {
        self.pid = pid;
        self.last_updated = Utc::now();
    }

    /// Mark box as crashed (sets status to Stopped since VM is no longer running).
    ///
    /// In our simplified state model, crashed VMs become Stopped
    /// since the rootfs is preserved and can be restarted.
    /// PID is cleared since the process is no longer alive.
    pub fn mark_stop(&mut self) {
        self.status = BoxStatus::Stopped;
        self.pid = None;
        self.last_updated = Utc::now();
    }

    /// Reset state after system reboot.
    ///
    /// Active boxes (Running or Paused) become Stopped since VM rootfs is preserved.
    /// PID is cleared since all processes are gone after reboot.
    pub fn reset_for_reboot(&mut self) {
        if self.status.is_active() {
            self.status = BoxStatus::Stopped;
        }
        self.pid = None;
        self.last_updated = Utc::now();
    }

    /// Initialize health status (called when box starts with health check configured).
    pub fn init_health_status(&mut self) {
        self.health_status.init();
        self.last_updated = Utc::now();
    }

    /// Update health status after a successful check.
    pub fn mark_health_check_success(&mut self) {
        self.health_status.mark_success();
        self.last_updated = Utc::now();
    }

    /// Update health status after a failed check.
    /// Returns true if the box should be marked unhealthy.
    pub fn mark_health_check_failure(&mut self, retries: u32) -> bool {
        let became_unhealthy = self.health_status.mark_failure(retries);
        self.last_updated = Utc::now();
        became_unhealthy
    }

    /// Clear health status (called when box stops).
    pub fn clear_health_status(&mut self) {
        self.health_status.clear();
        self.last_updated = Utc::now();
    }
}

impl Default for BoxState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_status_is_active() {
        assert!(!BoxStatus::Configured.is_active());
        assert!(BoxStatus::Running.is_active());
        assert!(!BoxStatus::Stopping.is_active());
        assert!(!BoxStatus::Stopped.is_active());
        assert!(BoxStatus::Paused.is_active());
        assert!(!BoxStatus::Unknown.is_active());
    }

    #[test]
    fn test_status_is_configured() {
        assert!(BoxStatus::Configured.is_configured());
        assert!(!BoxStatus::Running.is_configured());
        assert!(!BoxStatus::Stopped.is_configured());
    }

    #[test]
    fn test_status_is_paused() {
        assert!(BoxStatus::Paused.is_paused());
        assert!(!BoxStatus::Running.is_paused());
        assert!(!BoxStatus::Stopped.is_paused());
    }

    #[test]
    fn test_status_can_start() {
        assert!(BoxStatus::Configured.can_start());
        assert!(!BoxStatus::Running.can_start());
        assert!(!BoxStatus::Stopping.can_start());
        assert!(BoxStatus::Stopped.can_start());
        assert!(!BoxStatus::Paused.can_start());
        assert!(!BoxStatus::Unknown.can_start());
    }

    #[test]
    fn test_status_can_stop() {
        assert!(!BoxStatus::Configured.can_stop());
        assert!(BoxStatus::Running.can_stop());
        assert!(!BoxStatus::Stopping.can_stop());
        assert!(!BoxStatus::Stopped.can_stop());
        assert!(BoxStatus::Paused.can_stop());
        assert!(!BoxStatus::Unknown.can_stop());
    }

    #[test]
    fn test_status_can_exec() {
        assert!(BoxStatus::Configured.can_exec());
        assert!(BoxStatus::Running.can_exec());
        assert!(!BoxStatus::Stopping.can_exec());
        assert!(BoxStatus::Stopped.can_exec());
        assert!(!BoxStatus::Paused.can_exec());
        assert!(!BoxStatus::Unknown.can_exec());
    }

    #[test]
    fn test_valid_transitions() {
        // Configured transitions
        assert!(BoxStatus::Configured.can_transition_to(BoxStatus::Running));
        assert!(BoxStatus::Configured.can_transition_to(BoxStatus::Stopped));
        assert!(!BoxStatus::Configured.can_transition_to(BoxStatus::Stopping));

        // Running transitions
        assert!(BoxStatus::Running.can_transition_to(BoxStatus::Stopping));
        assert!(BoxStatus::Running.can_transition_to(BoxStatus::Stopped));
        assert!(BoxStatus::Running.can_transition_to(BoxStatus::Paused));
        assert!(!BoxStatus::Running.can_transition_to(BoxStatus::Configured));

        // Stopping transitions
        assert!(BoxStatus::Stopping.can_transition_to(BoxStatus::Stopped));
        assert!(!BoxStatus::Stopping.can_transition_to(BoxStatus::Running));

        // Stopped transitions
        assert!(BoxStatus::Stopped.can_transition_to(BoxStatus::Running));
        assert!(!BoxStatus::Stopped.can_transition_to(BoxStatus::Configured));
        assert!(!BoxStatus::Stopped.can_transition_to(BoxStatus::Stopping));
        assert!(!BoxStatus::Stopped.can_transition_to(BoxStatus::Paused));

        // Paused transitions
        assert!(BoxStatus::Paused.can_transition_to(BoxStatus::Running));
        assert!(BoxStatus::Paused.can_transition_to(BoxStatus::Stopped));
        assert!(!BoxStatus::Paused.can_transition_to(BoxStatus::Configured));

        // Unknown can go anywhere (recovery)
        assert!(BoxStatus::Unknown.can_transition_to(BoxStatus::Configured));
        assert!(BoxStatus::Unknown.can_transition_to(BoxStatus::Running));
        assert!(BoxStatus::Unknown.can_transition_to(BoxStatus::Stopped));
        assert!(BoxStatus::Unknown.can_transition_to(BoxStatus::Paused));
    }

    #[test]
    fn test_state_transition() {
        let mut state = BoxState::new();
        assert_eq!(state.status, BoxStatus::Configured);

        assert!(state.transition_to(BoxStatus::Running).is_ok());
        assert_eq!(state.status, BoxStatus::Running);

        // Running → Paused
        assert!(state.transition_to(BoxStatus::Paused).is_ok());
        assert_eq!(state.status, BoxStatus::Paused);

        // Paused → Running
        assert!(state.transition_to(BoxStatus::Running).is_ok());
        assert_eq!(state.status, BoxStatus::Running);

        assert!(state.transition_to(BoxStatus::Stopping).is_ok());
        assert!(state.transition_to(BoxStatus::Stopped).is_ok());
        assert!(state.transition_to(BoxStatus::Running).is_ok());
    }

    #[test]
    fn test_invalid_transition() {
        let mut state = BoxState::new();
        state.status = BoxStatus::Configured;

        let result = state.transition_to(BoxStatus::Stopping);
        assert!(result.is_err());
        assert_eq!(state.status, BoxStatus::Configured);
    }

    #[test]
    fn test_reset_for_reboot() {
        let mut state = BoxState::new();
        state.status = BoxStatus::Running;
        state.pid = Some(12345);
        state.reset_for_reboot();
        assert_eq!(state.status, BoxStatus::Stopped);
        assert_eq!(state.pid, None);
    }

    #[test]
    fn test_reset_for_reboot_paused() {
        let mut state = BoxState::new();
        state.status = BoxStatus::Paused;
        state.pid = Some(12345);
        state.reset_for_reboot();
        assert_eq!(state.status, BoxStatus::Stopped);
        assert_eq!(state.pid, None);
    }

    #[test]
    fn test_reset_for_reboot_stopped() {
        let mut state = BoxState::new();
        state.status = BoxStatus::Stopped;
        state.reset_for_reboot();
        assert_eq!(state.status, BoxStatus::Stopped);
    }

    #[test]
    fn test_reset_for_reboot_configured() {
        let mut state = BoxState::new();
        assert_eq!(state.status, BoxStatus::Configured);
        state.reset_for_reboot();
        assert_eq!(state.status, BoxStatus::Configured);
    }

    #[test]
    fn test_status_as_str() {
        assert_eq!(BoxStatus::Unknown.as_str(), "unknown");
        assert_eq!(BoxStatus::Configured.as_str(), "configured");
        assert_eq!(BoxStatus::Running.as_str(), "running");
        assert_eq!(BoxStatus::Stopping.as_str(), "stopping");
        assert_eq!(BoxStatus::Stopped.as_str(), "stopped");
        assert_eq!(BoxStatus::Paused.as_str(), "paused");
    }

    #[test]
    fn test_status_from_str() {
        assert_eq!("unknown".parse(), Ok(BoxStatus::Unknown));
        assert_eq!("configured".parse(), Ok(BoxStatus::Configured));
        assert_eq!("starting".parse(), Ok(BoxStatus::Configured));
        assert_eq!("running".parse(), Ok(BoxStatus::Running));
        assert_eq!("stopping".parse(), Ok(BoxStatus::Stopping));
        assert_eq!("stopped".parse(), Ok(BoxStatus::Stopped));
        assert_eq!("paused".parse(), Ok(BoxStatus::Paused));
        // Legacy transient statuses map to Stopped
        assert_eq!("snapshotting".parse(), Ok(BoxStatus::Stopped));
        assert_eq!("restoring".parse(), Ok(BoxStatus::Stopped));
        assert_eq!("exporting".parse(), Ok(BoxStatus::Stopped));
        assert_eq!("cloning".parse(), Ok(BoxStatus::Stopped));
        assert!("invalid".parse::<BoxStatus>().is_err());
    }

    // ========================================================================
    // HealthStatus Tests
    // ========================================================================

    #[test]
    fn test_health_status_new() {
        let status = HealthStatus::new();
        assert_eq!(status.state, HealthState::None);
        assert_eq!(status.failures, 0);
        assert!(status.last_check.is_none());
    }

    #[test]
    fn test_health_status_init() {
        let mut status = HealthStatus::new();
        status.init();

        assert_eq!(status.state, HealthState::Starting);
        assert_eq!(status.failures, 0);
        assert!(status.last_check.is_some());

        // Verify timestamp is recent (within last second)
        let elapsed = Utc::now() - status.last_check.unwrap();
        assert!(elapsed.num_seconds() <= 1);
    }

    #[test]
    fn test_health_status_mark_success() {
        let mut status = HealthStatus::new();
        status.init();

        // After success, should be Healthy with zero failures
        status.mark_success();

        assert_eq!(status.state, HealthState::Healthy);
        assert_eq!(status.failures, 0);
        assert!(status.last_check.is_some());
    }

    #[test]
    fn test_health_status_mark_failure_within_retries() {
        let mut status = HealthStatus::new();
        status.init();
        status.mark_success(); // Transition to Healthy first

        // First failure (retries=3)
        let became_unhealthy = status.mark_failure(3);

        assert!(!became_unhealthy);
        assert_eq!(status.state, HealthState::Healthy); // Still healthy
        assert_eq!(status.failures, 1);
    }

    #[test]
    fn test_health_status_mark_failure_at_threshold() {
        let mut status = HealthStatus::new();
        status.mark_success(); // Start from Healthy state

        // Failures up to threshold (retries=3)
        assert!(!status.mark_failure(3)); // failure 1
        assert_eq!(status.failures, 1);

        assert!(!status.mark_failure(3)); // failure 2
        assert_eq!(status.failures, 2);

        let became_unhealthy = status.mark_failure(3); // failure 3
        assert!(became_unhealthy);
        assert_eq!(status.state, HealthState::Unhealthy);
        assert_eq!(status.failures, 3);
    }

    #[test]
    fn test_health_status_mark_failure_exceeds_threshold() {
        let mut status = HealthStatus::new();
        status.mark_success();

        // Exceed threshold (retries=3, but fail 4 times)
        status.mark_failure(3); // failure 1
        status.mark_failure(3); // failure 2
        status.mark_failure(3); // failure 3 → becomes unhealthy
        status.mark_failure(3); // failure 4 → already unhealthy

        assert_eq!(status.state, HealthState::Unhealthy);
        assert_eq!(status.failures, 4);
    }

    #[test]
    fn test_health_status_zero_retries() {
        let mut status = HealthStatus::new();
        status.init();

        // With retries=0, first failure should mark unhealthy immediately
        let became_unhealthy = status.mark_failure(0);
        assert!(became_unhealthy);
        assert_eq!(status.state, HealthState::Unhealthy);
        assert_eq!(status.failures, 1);
    }

    #[test]
    fn test_health_status_one_retry() {
        let mut status = HealthStatus::new();
        status.mark_success();

        // With retries=1, first failure marks unhealthy
        let became_unhealthy = status.mark_failure(1);
        assert!(became_unhealthy);
        assert_eq!(status.state, HealthState::Unhealthy);
        assert_eq!(status.failures, 1);
    }

    #[test]
    fn test_health_status_clear() {
        let mut status = HealthStatus::new();
        status.init();
        status.mark_success();

        // Clear should reset to initial state
        status.clear();

        assert_eq!(status.state, HealthState::None);
        assert_eq!(status.failures, 0);
        assert!(status.last_check.is_none());
    }

    #[test]
    fn test_health_status_recovery_after_failure() {
        let mut status = HealthStatus::new();
        status.mark_success();

        // Fail twice (below threshold of 3)
        status.mark_failure(3);
        status.mark_failure(3);
        assert_eq!(status.failures, 2);
        assert_eq!(status.state, HealthState::Healthy);

        // Successful check resets failures
        status.mark_success();
        assert_eq!(status.failures, 0);
        assert_eq!(status.state, HealthState::Healthy);

        // New failures start from 0 again
        status.mark_failure(3);
        assert_eq!(status.failures, 1);
        assert_eq!(status.state, HealthState::Healthy);
    }

    #[test]
    fn test_health_status_full_lifecycle() {
        let mut status = HealthStatus::new();

        // 1. Initial state
        assert_eq!(status.state, HealthState::None);

        // 2. Box starts with health check
        status.init();
        assert_eq!(status.state, HealthState::Starting);

        // 3. First successful check
        status.mark_success();
        assert_eq!(status.state, HealthState::Healthy);

        // 4. Health check fails (but within retries)
        status.mark_failure(3);
        assert_eq!(status.state, HealthState::Healthy);
        assert_eq!(status.failures, 1);

        // 5. More failures push it over threshold
        status.mark_failure(3);
        status.mark_failure(3);
        assert_eq!(status.state, HealthState::Unhealthy);
        assert_eq!(status.failures, 3);

        // 6. Box stops
        status.clear();
        assert_eq!(status.state, HealthState::None);
        assert_eq!(status.failures, 0);
    }

    #[test]
    fn test_health_status_default() {
        let status = HealthStatus::default();
        assert_eq!(status.state, HealthState::None);
        assert_eq!(status.failures, 0);
        assert!(status.last_check.is_none());
    }

    #[test]
    fn test_health_state_equality() {
        let status1 = HealthStatus::new();
        let status2 = HealthStatus::new();

        // Two new instances should be equal
        assert_eq!(status1, status2);

        // After different state changes, they should not be equal
        let mut status3 = HealthStatus::new();
        let mut status4 = HealthStatus::new();
        status3.init();
        status4.mark_success();

        assert_ne!(status3, status4);
        assert_eq!(status3.state, HealthState::Starting);
        assert_eq!(status4.state, HealthState::Healthy);
    }

    // ========================================================================
    // BoxState Health Check Integration Tests
    // ========================================================================

    #[test]
    fn test_box_state_init_health_status() {
        let mut state = BoxState::new();

        state.init_health_status();

        assert_eq!(state.health_status.state, HealthState::Starting);
        assert_eq!(state.health_status.failures, 0);
        assert!(state.health_status.last_check.is_some());
        assert!(state.last_updated > Utc::now() - chrono::Duration::seconds(1));
    }

    #[test]
    fn test_box_state_mark_health_check_success() {
        let mut state = BoxState::new();
        state.init_health_status();

        state.mark_health_check_success();

        assert_eq!(state.health_status.state, HealthState::Healthy);
        assert_eq!(state.health_status.failures, 0);
    }

    #[test]
    fn test_box_state_mark_health_check_failure() {
        let mut state = BoxState::new();
        state.init_health_status();
        state.mark_health_check_success(); // Start from healthy

        // First failure (within retries)
        let should_mark_unhealthy = state.mark_health_check_failure(3);
        assert!(!should_mark_unhealthy);
        assert_eq!(state.health_status.failures, 1);

        // More failures to cross threshold
        state.mark_health_check_failure(3);
        let should_mark_unhealthy = state.mark_health_check_failure(3);

        assert!(should_mark_unhealthy);
        assert_eq!(state.health_status.state, HealthState::Unhealthy);
        assert_eq!(state.health_status.failures, 3);
    }

    #[test]
    fn test_box_state_clear_health_status() {
        let mut state = BoxState::new();
        state.init_health_status();
        state.mark_health_check_success();

        state.clear_health_status();

        assert_eq!(state.health_status.state, HealthState::None);
        assert_eq!(state.health_status.failures, 0);
        assert!(state.health_status.last_check.is_none());
    }

    #[test]
    fn test_box_state_new_has_default_health_status() {
        let state = BoxState::new();
        assert_eq!(state.health_status.state, HealthState::None);
        assert_eq!(state.health_status.failures, 0);
    }

    #[test]
    fn deserialize_box_state_without_health_status() {
        // JSON from before PR #266 (no health_status field).
        // Old database rows lack this field; serde(default) must fill it in.
        let old_json = r#"{
            "status": "configured",
            "pid": null,
            "container_id": null,
            "last_updated": "2026-02-26T00:00:00Z",
            "lock_id": null
        }"#;
        let state: BoxState = serde_json::from_str(old_json).unwrap();
        assert_eq!(state.status, BoxStatus::Configured);
        assert_eq!(state.health_status.state, HealthState::None);
        assert_eq!(state.health_status.failures, 0);
        assert!(state.health_status.last_check.is_none());
    }
}
