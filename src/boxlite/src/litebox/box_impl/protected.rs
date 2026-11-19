//! Protected bootstrap admission under the Box lifecycle lock.

use super::{BoxImpl, BoxStatus};
use crate::litebox::protected_boot::{
    ProtectedBootAttempt, ProtectedBootKey, ProtectedBootOutcome, ProtectedBootReceipt,
    ProtectedBootRequest,
};
use crate::net::{NetworkBackendConfig, OutboundApplicationState, OutboundRevision};
use crate::runtime::options::NetworkSpec;
use crate::util::{PidFileReader, PidRecord, process_start_time};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

impl BoxImpl {
    pub(crate) async fn has_protected_boot(&self) -> BoxliteResult<bool> {
        self.with_operation(async {
            Ok(self
                .runtime
                .box_manager
                .protected_boot(self.id())?
                .is_some())
        })
        .await
    }

    pub(crate) async fn bootstrap_protected(
        &self,
        request: ProtectedBootRequest,
    ) -> BoxliteResult<ProtectedBootReceipt> {
        request.key.policy.policy.validate()?;
        self.with_operation(async {
            let manager = &self.runtime.box_manager;
            let mut record = manager.protected_boot(self.id())?.unwrap_or_default();
            let key = request.key.clone();
            if record
                .retired
                .iter()
                .any(|receipt| receipt.key.attempt_id == key.attempt_id)
            {
                return Err(conflict("Protected bootstrap attempt is retired"));
            }
            if let Some(active) = record.active.as_ref() {
                if active.key != key {
                    return Err(conflict(
                        "A different protected bootstrap attempt is admitted",
                    ));
                }
                return self.confirm_protected_boot(&key).await;
            }
            {
                let state = self.state.read();
                if !self.can_admit_protected_boot(state.status, !record.retired.is_empty())
                    || state.pid.is_some()
                    || has_shim(&self.layout.pid_file_path())
                {
                    return Err(conflict(
                        "Protected bootstrap requires a fresh Guest network and disabled automatic removal",
                    ));
                }
            }
            let attempt = ProtectedBootAttempt {
                key: key.clone(),
                epoch: OutboundRevision::fresh(),
                spawning: false,
                owner: None,
                confirmed: false,
            };
            let launch = request.into_launch(attempt.binding());
            record.active = Some(attempt);
            manager.save_protected_boot(self.id(), &record)?;
            self.start_with_network(Some(launch)).await?;
            self.confirm_protected_boot(&key).await
        })
        .await
    }

    pub(crate) async fn protected_boot_receipt(
        &self,
        key: &ProtectedBootKey,
    ) -> BoxliteResult<ProtectedBootReceipt> {
        self.with_operation(async {
            let record = self
                .runtime
                .box_manager
                .protected_boot(self.id())?
                .unwrap_or_default();
            if let Some(receipt) = record
                .retired
                .into_iter()
                .find(|receipt| &receipt.key == key)
            {
                return Ok(receipt);
            }
            let active = record
                .active
                .filter(|active| &active.key == key && active.confirmed)
                .ok_or_else(|| conflict("Protected startup is unconfirmed"))?;
            self.verify_protected_boot(&active).await?;
            Ok(active.receipt(ProtectedBootOutcome::Confirmed))
        })
        .await
    }

    pub(crate) async fn retire_protected_boot(
        &self,
        key: ProtectedBootKey,
    ) -> BoxliteResult<ProtectedBootReceipt> {
        key.policy.policy.validate()?;
        self.with_operation(async {
            let manager = &self.runtime.box_manager;
            let mut record = manager.protected_boot(self.id())?.unwrap_or_default();
            if let Some(receipt) = record
                .retired
                .iter()
                .find(|receipt| receipt.key.attempt_id == key.attempt_id)
            {
                return if receipt.key == key {
                    Ok(receipt.clone())
                } else {
                    Err(conflict("Retired attempt identity differs"))
                };
            }
            let state = self.state.read();
            if record.active.is_none()
                && !self.can_admit_protected_boot(state.status, !record.retired.is_empty())
            {
                return Err(conflict(
                    "Protected bootstrap requires a fresh Guest network and disabled automatic removal",
                ));
            }
            if state.status.is_active()
                || state.pid.is_some()
                || has_shim(&self.layout.pid_file_path())
            {
                return Err(conflict("Protected bootstrap child may still be live"));
            }
            let epoch = match record.active.take() {
                Some(attempt) => {
                    if attempt.key != key || !termination_confirmed(self.id(), &attempt) {
                        return Err(conflict("Protected bootstrap retirement is unconfirmed"));
                    }
                    Some(attempt.epoch)
                }
                None => None,
            };
            let receipt = ProtectedBootReceipt {
                key,
                epoch,
                outcome: ProtectedBootOutcome::Retired,
            };
            record.retired.push(receipt.clone());
            manager.save_protected_boot(self.id(), &record)?;
            Ok(receipt)
        })
        .await
    }

    fn can_admit_protected_boot(&self, status: BoxStatus, has_retirement: bool) -> bool {
        matches!(self.config.options.network, NetworkSpec::Disabled)
            && !self.config.options.removes_on_stop()
            && status.can_start()
            && (has_retirement || status == BoxStatus::Configured)
    }

    async fn confirm_protected_boot(
        &self,
        key: &ProtectedBootKey,
    ) -> BoxliteResult<ProtectedBootReceipt> {
        let manager = &self.runtime.box_manager;
        let mut record = manager.protected_boot(self.id())?.unwrap_or_default();
        let attempt = record
            .active
            .as_mut()
            .filter(|attempt| &attempt.key == key)
            .ok_or_else(|| conflict("Protected bootstrap attempt differs"))?;
        self.verify_protected_boot(attempt).await?;
        let receipt = attempt.receipt(ProtectedBootOutcome::Confirmed);
        if !attempt.confirmed {
            attempt.confirmed = true;
            manager.save_protected_boot(self.id(), &record)?;
        }
        Ok(receipt)
    }

    pub(super) async fn verify_protected_boot(
        &self,
        attempt: &ProtectedBootAttempt,
    ) -> BoxliteResult<()> {
        let owner = attempt
            .owner
            .ok_or_else(|| conflict("Missing protected bootstrap process owner"))?;
        let state = self.runtime.box_manager.update_box(self.id())?;
        if state.status != BoxStatus::Running || state.pid != Some(owner.pid) || !owns_shim(owner) {
            return Err(conflict("Protected Guest readiness is unconfirmed"));
        }
        let backend = crate::net::gvproxy::GvproxyBackend::from_config(&NetworkBackendConfig {
            outbound_disabled: true,
            socket_path: self.layout.net_backend_socket_path(),
            ca_dir: self.layout.ca_dir(),
            allow_net: Vec::new(),
            secrets: Vec::new(),
            rate_limit: Default::default(),
        });
        let observed = backend.managed_proxy_status().await?;
        if observed.status.application_state != OutboundApplicationState::Confirmed
            || observed.status.snapshot != attempt.key.policy
            || observed.binding != attempt.binding()
            || !owns_shim(owner)
        {
            return Err(conflict(
                "Installed proxy snapshot does not confirm protected startup",
            ));
        }
        Ok(())
    }
}

fn has_shim(path: &std::path::Path) -> bool {
    !matches!(
        PidFileReader::at(path).process_identity(),
        crate::util::ProcessIdentity::Absent
    )
}

fn owns_shim(owner: PidRecord) -> bool {
    owner.start_time.is_some()
        && process_start_time(owner.pid) == owner.start_time
        && crate::util::is_process_alive(owner.pid)
}

fn termination_confirmed(box_id: &crate::BoxID, attempt: &ProtectedBootAttempt) -> bool {
    let Some(owner) = attempt.owner else {
        return !attempt.spawning;
    };
    if owner.pid <= 1 || owns_shim(owner) {
        return false;
    }
    crate::jailer::protected_processes_terminated(box_id, owner.pid)
}

fn conflict(message: &str) -> BoxliteError {
    BoxliteError::InvalidState(message.into())
}
