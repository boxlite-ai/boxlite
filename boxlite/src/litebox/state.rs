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
/// State machine (Docker/Podman-style):
/// ```text
/// create() → Configured (persisted to DB, no VM)
/// start()  → Running (VM initialized)
/// stop()   → Stopped (VM terminated, can restart)
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

    /// Box is being snapshotted (transient state).
    Snapshotting,

    /// Box is being restored from a snapshot (transient state).
    Restoring,

    /// Box is being exported (transient state).
    Exporting,
}

impl BoxStatus {
    /// Check if this status represents an active VM (process is running).
    pub fn is_active(&self) -> bool {
        matches!(self, BoxStatus::Running)
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

    /// Check if this status represents a transient state.
    pub fn is_transient(&self) -> bool {
        matches!(
            self,
            BoxStatus::Stopping
                | BoxStatus::Snapshotting
                | BoxStatus::Restoring
                | BoxStatus::Exporting
        )
    }

    /// Check if start() can be called from this state.
    /// Configured boxes need first start, Stopped boxes can restart.
    pub fn can_start(&self) -> bool {
        matches!(self, BoxStatus::Configured | BoxStatus::Stopped)
    }

    /// Check if stop() can be called from this state.
    /// Only running boxes can be stopped.
    pub fn can_stop(&self) -> bool {
        matches!(self, BoxStatus::Running)
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
            // Running → Stopping (graceful) or Stopped (crash)
            (Running, Stopping) |
            (Running, Stopped) |
            (Running, Unknown) |
            // Stopping → Stopped (complete) or Unknown (error)
            (Stopping, Stopped) |
            (Stopping, Unknown) |
            // Stopped → Running (restart) or transient operation states
            (Stopped, Running) |
            (Stopped, Snapshotting) |
            (Stopped, Restoring) |
            (Stopped, Exporting) |
            (Stopped, Unknown) |
            // Transient operation states → Stopped (on completion or error)
            (Snapshotting, Stopped) |
            (Snapshotting, Unknown) |
            (Restoring, Stopped) |
            (Restoring, Unknown) |
            (Exporting, Stopped) |
            (Exporting, Unknown)
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
            BoxStatus::Snapshotting => "snapshotting",
            BoxStatus::Restoring => "restoring",
            BoxStatus::Exporting => "exporting",
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
            "snapshotting" => Ok(BoxStatus::Snapshotting),
            "restoring" => Ok(BoxStatus::Restoring),
            "exporting" => Ok(BoxStatus::Exporting),
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
    /// Active boxes become Stopped since VM rootfs is preserved.
    /// PID is cleared since all processes are gone after reboot.
    pub fn reset_for_reboot(&mut self) {
        if self.status.is_active() {
            self.status = BoxStatus::Stopped;
        }
        self.pid = None;
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
        // Only Running is active (VM process running)
        assert!(!BoxStatus::Configured.is_active());
        assert!(BoxStatus::Running.is_active());
        assert!(!BoxStatus::Stopping.is_active());
        assert!(!BoxStatus::Stopped.is_active());
        assert!(!BoxStatus::Unknown.is_active());
    }

    #[test]
    fn test_status_is_configured() {
        assert!(BoxStatus::Configured.is_configured());
        assert!(!BoxStatus::Running.is_configured());
        assert!(!BoxStatus::Stopping.is_configured());
        assert!(!BoxStatus::Stopped.is_configured());
        assert!(!BoxStatus::Unknown.is_configured());
    }

    #[test]
    fn test_status_can_start() {
        // Configured and Stopped can be started
        assert!(BoxStatus::Configured.can_start());
        assert!(!BoxStatus::Running.can_start());
        assert!(!BoxStatus::Stopping.can_start());
        assert!(BoxStatus::Stopped.can_start());
        assert!(!BoxStatus::Unknown.can_start());
    }

    #[test]
    fn test_status_can_stop() {
        // Only Running boxes can be stopped
        assert!(!BoxStatus::Configured.can_stop());
        assert!(BoxStatus::Running.can_stop());
        assert!(!BoxStatus::Stopping.can_stop());
        assert!(!BoxStatus::Stopped.can_stop());
        assert!(!BoxStatus::Unknown.can_stop());
    }

    #[test]
    fn test_status_can_exec() {
        // Configured and Stopped trigger implicit start
        assert!(BoxStatus::Configured.can_exec());
        assert!(BoxStatus::Running.can_exec());
        assert!(!BoxStatus::Stopping.can_exec());
        assert!(BoxStatus::Stopped.can_exec());
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
        assert!(!BoxStatus::Running.can_transition_to(BoxStatus::Configured));

        // Stopping transitions
        assert!(BoxStatus::Stopping.can_transition_to(BoxStatus::Stopped));
        assert!(!BoxStatus::Stopping.can_transition_to(BoxStatus::Running));
        assert!(!BoxStatus::Stopping.can_transition_to(BoxStatus::Configured));

        // Stopped transitions
        assert!(BoxStatus::Stopped.can_transition_to(BoxStatus::Running));
        assert!(BoxStatus::Stopped.can_transition_to(BoxStatus::Snapshotting));
        assert!(BoxStatus::Stopped.can_transition_to(BoxStatus::Restoring));
        assert!(BoxStatus::Stopped.can_transition_to(BoxStatus::Exporting));
        assert!(!BoxStatus::Stopped.can_transition_to(BoxStatus::Configured));
        assert!(!BoxStatus::Stopped.can_transition_to(BoxStatus::Stopping));

        // Transient operation states → Stopped
        assert!(BoxStatus::Snapshotting.can_transition_to(BoxStatus::Stopped));
        assert!(!BoxStatus::Snapshotting.can_transition_to(BoxStatus::Running));
        assert!(BoxStatus::Restoring.can_transition_to(BoxStatus::Stopped));
        assert!(!BoxStatus::Restoring.can_transition_to(BoxStatus::Running));
        assert!(BoxStatus::Exporting.can_transition_to(BoxStatus::Stopped));
        assert!(!BoxStatus::Exporting.can_transition_to(BoxStatus::Running));

        // Unknown can go anywhere (recovery)
        assert!(BoxStatus::Unknown.can_transition_to(BoxStatus::Configured));
        assert!(BoxStatus::Unknown.can_transition_to(BoxStatus::Running));
        assert!(BoxStatus::Unknown.can_transition_to(BoxStatus::Stopped));
    }

    #[test]
    fn test_state_transition() {
        let mut state = BoxState::new();
        assert_eq!(state.status, BoxStatus::Configured);

        // Valid: Configured → Running
        assert!(state.transition_to(BoxStatus::Running).is_ok());
        assert_eq!(state.status, BoxStatus::Running);

        // Valid: Running → Stopping
        assert!(state.transition_to(BoxStatus::Stopping).is_ok());
        assert_eq!(state.status, BoxStatus::Stopping);

        // Valid: Stopping → Stopped
        assert!(state.transition_to(BoxStatus::Stopped).is_ok());
        assert_eq!(state.status, BoxStatus::Stopped);

        // Valid: Stopped → Running (direct restart)
        assert!(state.transition_to(BoxStatus::Running).is_ok());
        assert_eq!(state.status, BoxStatus::Running);
    }

    #[test]
    fn test_invalid_transition() {
        let mut state = BoxState::new();
        state.status = BoxStatus::Configured;

        // Invalid: Configured → Stopping (must go through Running)
        let result = state.transition_to(BoxStatus::Stopping);
        assert!(result.is_err());
        assert_eq!(state.status, BoxStatus::Configured); // Unchanged
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
    fn test_reset_for_reboot_stopped() {
        let mut state = BoxState::new();
        state.status = BoxStatus::Stopped;
        state.pid = None;

        state.reset_for_reboot();

        // Stopped stays stopped
        assert_eq!(state.status, BoxStatus::Stopped);
    }

    #[test]
    fn test_reset_for_reboot_configured() {
        let mut state = BoxState::new();
        // Configured is not active, should stay configured
        assert_eq!(state.status, BoxStatus::Configured);

        state.reset_for_reboot();

        // Configured stays configured (no VM was running)
        assert_eq!(state.status, BoxStatus::Configured);
    }

    #[test]
    fn test_status_as_str() {
        assert_eq!(BoxStatus::Unknown.as_str(), "unknown");
        assert_eq!(BoxStatus::Configured.as_str(), "configured");
        assert_eq!(BoxStatus::Running.as_str(), "running");
        assert_eq!(BoxStatus::Stopping.as_str(), "stopping");
        assert_eq!(BoxStatus::Stopped.as_str(), "stopped");
        assert_eq!(BoxStatus::Snapshotting.as_str(), "snapshotting");
        assert_eq!(BoxStatus::Restoring.as_str(), "restoring");
        assert_eq!(BoxStatus::Exporting.as_str(), "exporting");
    }

    #[test]
    fn test_status_from_str() {
        assert_eq!("unknown".parse(), Ok(BoxStatus::Unknown));
        assert_eq!("configured".parse(), Ok(BoxStatus::Configured));
        // Legacy support: "starting" maps to Configured
        assert_eq!("starting".parse(), Ok(BoxStatus::Configured));
        assert_eq!("running".parse(), Ok(BoxStatus::Running));
        assert_eq!("stopping".parse(), Ok(BoxStatus::Stopping));
        assert_eq!("stopped".parse(), Ok(BoxStatus::Stopped));
        assert_eq!("snapshotting".parse(), Ok(BoxStatus::Snapshotting));
        assert_eq!("restoring".parse(), Ok(BoxStatus::Restoring));
        assert_eq!("exporting".parse(), Ok(BoxStatus::Exporting));
        assert!("invalid".parse::<BoxStatus>().is_err());
    }
}
