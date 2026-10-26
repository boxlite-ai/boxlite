//! A snapshot owner for tests, driven over a real control socket.

use super::*;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

/// A snapshot owner whose mutations can be held open by the test.
pub(crate) struct FakeOwner {
    state: Mutex<VmRunState>,
    /// When set, a mutation reports `entered` and waits for `release`.
    gate: Mutex<Option<(Sender<()>, Receiver<()>)>>,
    pub(crate) export_error: Mutex<Option<OwnerError>>,
    calls: Mutex<Vec<String>>,
    /// Refuse exports unless the pause declared every host writer of the
    /// shares stopped, as libkrun does for a VM with virtio-fs shares.
    has_shares: Mutex<bool>,
    writers_declared: Mutex<bool>,
    /// Restored share roots by tag, as an imported VM reports them.
    pub(crate) restored: Mutex<Vec<(String, PathBuf)>>,
    /// Bytes a successful export writes, so the host has an image to read.
    pub(crate) export_image: Mutex<Option<Vec<u8>>>,
}

impl FakeOwner {
    pub(crate) fn new(state: VmRunState) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(state),
            gate: Mutex::new(None),
            export_error: Mutex::new(None),
            calls: Mutex::new(Vec::new()),
            has_shares: Mutex::new(false),
            writers_declared: Mutex::new(false),
            restored: Mutex::new(Vec::new()),
            export_image: Mutex::new(None),
        })
    }

    /// Model a VM with virtio-fs shares (every BoxLite VM has some).
    pub(crate) fn with_shares(self: Arc<Self>) -> Arc<Self> {
        *self.has_shares.lock().unwrap() = true;
        self
    }

    /// Hold the next mutation; returns (entered, release).
    pub(crate) fn hold(&self) -> (Receiver<()>, Sender<()>) {
        let (entered_tx, entered_rx) = channel();
        let (release_tx, release_rx) = channel();
        *self.gate.lock().unwrap() = Some((entered_tx, release_rx));
        (entered_rx, release_tx)
    }

    fn wait_gate(&self) {
        let gate = self.gate.lock().unwrap().take();
        if let Some((entered, release)) = gate {
            entered.send(()).unwrap();
            let _ = release.recv();
        }
    }

    pub(crate) fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    pub(crate) fn set(&self, state: VmRunState) {
        *self.state.lock().unwrap() = state;
    }
}

impl CheckpointOwner for FakeOwner {
    fn state(&self) -> VmRunState {
        *self.state.lock().unwrap()
    }

    fn pause(&self, host_writers_stopped: bool) -> Result<(), OwnerError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("pause({host_writers_stopped})"));
        self.wait_gate();
        if self.state() != VmRunState::Running {
            return Err(OwnerError::new(FailureKind::Rejected, "not running"));
        }
        self.set(VmRunState::Paused);
        *self.writers_declared.lock().unwrap() = host_writers_stopped;
        Ok(())
    }

    fn resume(&self) -> Result<(), OwnerError> {
        self.calls.lock().unwrap().push("resume".into());
        self.wait_gate();
        self.set(VmRunState::Running);
        *self.writers_declared.lock().unwrap() = false;
        Ok(())
    }

    fn export_raw(&self, path: &Path) -> Result<(), OwnerError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("export({})", path.display()));
        self.wait_gate();
        if *self.has_shares.lock().unwrap() && !*self.writers_declared.lock().unwrap() {
            return Err(OwnerError::new(
                FailureKind::Io,
                "host writers of the shares were not declared stopped",
            ));
        }
        if let Some(error) = self.export_error.lock().unwrap().take() {
            return Err(error);
        }
        if let Some(image) = self.export_image.lock().unwrap().as_ref() {
            std::fs::write(path, image)
                .map_err(|e| OwnerError::new(FailureKind::Io, e.to_string()))?;
        }
        Ok(())
    }

    fn stop(&self) -> Result<(), OwnerError> {
        self.calls.lock().unwrap().push("stop".into());
        self.set(VmRunState::Stopped);
        Ok(())
    }

    fn restored_share(&self, tag: &str) -> Result<PathBuf, OwnerError> {
        self.restored
            .lock()
            .unwrap()
            .iter()
            .find(|(known, _)| known == tag)
            .map(|(_, path)| path.clone())
            .ok_or_else(|| OwnerError::new(FailureKind::Rejected, format!("no share {tag}")))
    }
}

/// Serve `owner` on `socket`, exporting into `export_dir`.
pub(crate) fn serve(socket: &Path, export_dir: &Path, owner: Arc<FakeOwner>) {
    ControlServer::bind(socket, export_dir)
        .unwrap()
        .serve(owner)
        .unwrap();
}
