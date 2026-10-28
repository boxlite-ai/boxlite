//! Control-test owner; no VM, filesystem capture or continuation is simulated.
use super::protocol::DescriptorRequest;
use super::*;
use std::os::fd::OwnedFd;
use std::path::Path;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

pub(crate) struct FakeOwner {
    state: Mutex<VmRunState>,
    gate: Mutex<Option<(Sender<()>, Receiver<()>)>>,
    calls: Mutex<Vec<String>>,
    capture: Mutex<Option<(u64, bool, OwnedFd)>>,
    pub(crate) export_error: Mutex<Option<OwnerError>>,
}
impl FakeOwner {
    pub(crate) fn new(state: VmRunState) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(state),
            gate: Mutex::new(None),
            calls: Mutex::new(Vec::new()),
            capture: Mutex::new(None),
            export_error: Mutex::new(None),
        })
    }
    pub(crate) fn hold(&self) -> (Receiver<()>, Sender<()>) {
        let (entered, receive) = channel();
        let (release, wait) = channel();
        *self.gate.lock().unwrap() = Some((entered, wait));
        (receive, release)
    }
    fn wait_gate(&self) {
        if let Some((entered, release)) = self.gate.lock().unwrap().take() {
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
    fn descriptors(
        &self,
        request: DescriptorRequest,
        mut files: Vec<OwnedFd>,
    ) -> Result<(serde_json::Value, Vec<OwnedFd>), OwnerError> {
        let rejected = || {
            OwnerError::new(
                FailureKind::Rejected,
                "invalid control-test capture request",
            )
        };
        match request {
            DescriptorRequest::Capabilities => Ok((
                serde_json::json!({"protocol":2,"capabilities":7}),
                Vec::new(),
            )),
            DescriptorRequest::Begin { disk_only } => {
                let mut capture = self.capture.lock().unwrap();
                if capture.is_some() {
                    return Err(OwnerError::new(FailureKind::Busy, "capture in progress"));
                }
                if files.len() != 1
                    || self.state()
                        != if disk_only {
                            VmRunState::Running
                        } else {
                            VmRunState::Paused
                        }
                {
                    return Err(rejected());
                }
                *capture = Some((1, disk_only, files.remove(0)));
                Ok((serde_json::json!({"token":1}), Vec::new()))
            }
            DescriptorRequest::Prepare { token } => {
                if self
                    .capture
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|capture| capture.0)
                    != Some(token)
                {
                    return Err(rejected());
                }
                // Disk-copy failure fixtures need no filesystem objects.
                Ok((serde_json::Value::Null, Vec::new()))
            }
            DescriptorRequest::Export { token, .. } => {
                if files.len() != 2
                    || self
                        .capture
                        .lock()
                        .unwrap()
                        .as_ref()
                        .map(|capture| capture.0)
                        != Some(token)
                {
                    return Err(rejected());
                }
                self.calls.lock().unwrap().push("export_fd".into());
                self.wait_gate();
                if let Some(error) = self.export_error.lock().unwrap().take() {
                    return Err(error);
                }
                Ok((serde_json::Value::Null, Vec::new()))
            }
            DescriptorRequest::End { token, cancel } => {
                let mut capture = self.capture.lock().unwrap();
                if capture.as_ref().map(|capture| capture.0) != Some(token) {
                    return Err(rejected());
                }
                let (_, disk_only, _peer) = capture.take().unwrap();
                if cancel {
                    self.set(VmRunState::Stopped);
                } else if disk_only {
                    self.set(VmRunState::Running);
                }
                Ok((serde_json::Value::Null, Vec::new()))
            }
            _ => Err(rejected()),
        }
    }
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
        Ok(())
    }
    fn resume(&self) -> Result<(), OwnerError> {
        self.calls.lock().unwrap().push("resume".into());
        self.wait_gate();
        self.set(VmRunState::Running);
        Ok(())
    }
    fn stop(&self) -> Result<(), OwnerError> {
        self.calls.lock().unwrap().push("stop".into());
        self.set(VmRunState::Stopped);
        Ok(())
    }
}
pub(crate) fn serve(socket: &Path, owner: Arc<FakeOwner>) {
    ControlServer::bind(socket).unwrap().serve(owner).unwrap();
}
