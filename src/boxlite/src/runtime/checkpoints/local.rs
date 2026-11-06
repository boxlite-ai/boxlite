//! Managed archives compose the existing disk export and import operations.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;

use super::{
    CheckpointArchiveSource, CheckpointBackend, CheckpointInfo, PreparedCheckpointArchive, archive,
    catalog::{Catalog, Recovery},
};
use crate::runtime::options::{BoxArchive, ExportOptions};
use crate::runtime::rt_impl::SharedRuntimeImpl;
use crate::{BoxliteError, BoxliteResult, LiteBox};

pub(crate) struct LocalCheckpoints {
    runtime: SharedRuntimeImpl,
    catalog: Catalog,
}

impl LocalCheckpoints {
    pub(crate) fn new(runtime: SharedRuntimeImpl, directory: PathBuf) -> Self {
        runtime.checkpoint_lifecycle.register(directory.clone());
        Self {
            runtime,
            catalog: Catalog::new(directory),
        }
    }
}

#[async_trait]
impl CheckpointBackend for LocalCheckpoints {
    async fn prepare_archive(
        &self,
        source: CheckpointArchiveSource,
        platform_env: Option<std::collections::BTreeMap<String, String>>,
    ) -> BoxliteResult<PreparedCheckpointArchive> {
        let runtime = Arc::clone(&self.runtime);
        tokio::spawn(async move {
            let directory = runtime.layout.temp_dir();
            let prepared =
                blocking(move || archive::prepare_source(&source, platform_env, &directory))
                    .await?;
            verify_startup(&runtime, &prepared).await?;
            Ok(prepared)
        })
        .await
        .map_err(task_error)?
    }
    async fn create(&self, source: &str, name: Option<String>) -> BoxliteResult<CheckpointInfo> {
        let runtime = Arc::clone(&self.runtime);
        let catalog = self.catalog.clone();
        let source = source.to_owned();
        // The accepted task owns staging until native export finishes, even
        // when the caller stops waiting. No late-result cleanup removes a box.
        tokio::spawn(async move {
            let info = runtime
                .get_info(&source)
                .await?
                .ok_or_else(|| BoxliteError::NotFound(format!("box '{source}'")))?;
            let (config, _) = runtime
                .box_manager
                .box_by_id(&info.id)?
                .ok_or_else(|| BoxliteError::NotFound(format!("box '{source}'")))?;
            let pinned = archive::pinned_image(&config.options, info.resolved_image.as_ref())?;
            let _ownership = runtime
                .checkpoint_lifecycle
                .read(Some(info.id.as_ref()), info.name.as_deref())?;
            let lock_catalog = catalog.clone();
            let lock_id = info.id.to_string();
            let _operation = blocking(move || lock_catalog.box_operation(&lock_id)).await?;
            if runtime.get_info(&source).await?.map(|current| current.id) != Some(info.id.clone()) {
                return Err(BoxliteError::InvalidState(
                    "checkpoint source was replaced before export".into(),
                ));
            }
            let stage_catalog = catalog.clone();
            let stage = blocking(move || stage_catalog.stage()).await?;
            let destination = Catalog::archive_path(&stage);
            let bx = runtime
                .get(&source)
                .await?
                .ok_or_else(|| BoxliteError::NotFound(format!("box '{source}'")))?;
            bx.export(ExportOptions::default(), &destination).await?;
            blocking(move || catalog.publish(stage, name, info.id.to_string(), pinned)).await
        })
        .await
        .map_err(task_error)?
    }

    async fn list(&self) -> BoxliteResult<Vec<CheckpointInfo>> {
        let catalog = self.catalog.clone();
        blocking(move || catalog.list()).await
    }

    async fn get(&self, key: &str) -> BoxliteResult<CheckpointInfo> {
        let catalog = self.catalog.clone();
        let key = key.to_owned();
        blocking(move || catalog.info(&key)).await
    }

    async fn remove(&self, key: &str, force: bool) -> BoxliteResult<()> {
        let catalog = self.catalog.clone();
        let key = key.to_owned();
        blocking(move || catalog.remove(&key, force)).await
    }

    async fn create_box(&self, key: &str, name: Option<String>) -> BoxliteResult<LiteBox> {
        let catalog = self.catalog.clone();
        let key = key.to_owned();
        let directory = self.runtime.layout.temp_dir();
        let runtime = Arc::clone(&self.runtime);
        tokio::spawn(async move {
            let prepared =
                blocking(move || archive::prepare(catalog.get(&key)?, &directory)).await?;
            // A moved tag must never supply defaults for the captured disk.
            verify_startup(&runtime, &prepared).await?;
            let bx = runtime
                .import_box(BoxArchive::new(prepared.path.clone()), name)
                .await?;
            drop(prepared);
            Ok(bx)
        })
        .await
        .map_err(task_error)?
    }

    async fn recover_box(&self, key: &str, target: &str) -> BoxliteResult<LiteBox> {
        let runtime = Arc::clone(&self.runtime);
        let catalog = self.catalog.clone();
        let key = key.to_owned();
        let target = target.to_owned();
        tokio::spawn(async move { recover(runtime, catalog, key, target).await })
            .await
            .map_err(task_error)?
    }
}

async fn recover(
    runtime: SharedRuntimeImpl,
    catalog: Catalog,
    key: String,
    target: String,
) -> BoxliteResult<LiteBox> {
    let lookup = catalog.clone();
    let lookup_key = key.clone();
    let lease = blocking(move || lookup.get(&lookup_key)).await?;
    let checkpoint_id = lease.record.info.id.clone();
    let lookup = catalog.clone();
    let lookup_target = target.clone();
    let previous = blocking(move || lookup.recovery(&lookup_target)).await?;
    let resuming = previous.is_some();
    let current = runtime.get_info(&target).await?;
    let mut recovery = match previous {
        Some(record) if record.checkpoint_id == checkpoint_id => record,
        Some(_) => {
            return Err(BoxliteError::InvalidState(
                "target has an unfinished recovery from another checkpoint".into(),
            ));
        }
        None => {
            let info = current
                .as_ref()
                .ok_or_else(|| BoxliteError::NotFound(format!("box '{target}'")))?;
            Recovery {
                original_id: info.id.to_string(),
                name: info.name.clone(),
                checkpoint_id,
                import_id: None,
                accepted_id: None,
            }
        }
    };
    let lock_catalog = catalog.clone();
    let lock_id = recovery.original_id.clone();
    let ownership = runtime
        .checkpoint_lifecycle
        .reserve(&lock_id, recovery.name.as_deref())?;
    let _operation = blocking(move || lock_catalog.box_operation(&lock_id)).await?;
    // Re-read after ownership acquisition; another recovery may have committed
    // since the first lookup, and its accepted native box must be reused.
    match catalog.recovery(&recovery.original_id)? {
        Some(record) if record.checkpoint_id != recovery.checkpoint_id => {
            return Err(BoxliteError::InvalidState(
                "target has an unfinished recovery from another checkpoint".into(),
            ));
        }
        Some(record) => recovery = record,
        None if resuming => {
            return Err(BoxliteError::InvalidState(
                "checkpoint recovery was cancelled before acquiring target ownership".into(),
            ));
        }
        None => {}
    }
    if let Some(accepted) = &recovery.accepted_id {
        return runtime
            .get(accepted)
            .await?
            .ok_or_else(|| BoxliteError::NotFound(format!("recovered box '{accepted}'")));
    }
    let import_id = match &recovery.import_id {
        Some(id) => crate::BoxID::parse(id)
            .ok_or_else(|| BoxliteError::Internal("invalid recovery import ID".into()))?,
        None => crate::BoxIDMint::mint(),
    };
    let _import_ownership = runtime
        .checkpoint_lifecycle
        .reserve(import_id.as_str(), None)?;
    let old = runtime.get_info(&recovery.original_id).await?;
    if let Some(id) = &recovery.import_id
        && let Some(info) = runtime.get_info(id).await?
    {
        if old.is_some() || info.name != recovery.name {
            return Err(BoxliteError::InvalidState(
                "recovery import identity conflicts with the target".into(),
            ));
        }
        let bx = runtime
            .get(id)
            .await?
            .ok_or_else(|| BoxliteError::NotFound(format!("recovered box '{id}'")))?;
        return finish_recovery(catalog, recovery, bx).await;
    }
    if old.is_none() && !resuming {
        return Err(BoxliteError::NotFound(format!(
            "box '{}'",
            recovery.original_id
        )));
    }
    if let Some(info) = &old {
        if !matches!(
            info.status,
            crate::BoxStatus::Stopped | crate::BoxStatus::Failed
        ) || info.pid.is_some()
        {
            return Err(BoxliteError::InvalidState(
                "checkpoint recovery requires an idle stopped or failed box".into(),
            ));
        }
    } else if let Some(name) = &recovery.name
        && runtime.get_info(name).await?.is_some()
    {
        return Err(BoxliteError::InvalidState(
            "another native box now owns the recovery target name; it will not be removed".into(),
        ));
    }

    let directory = runtime.layout.temp_dir();
    let prepared = blocking(move || archive::prepare(lease, &directory)).await?;
    verify_startup(&runtime, &prepared).await?;
    // Publish the replacement identity before removal/import, so a lost final
    // receipt can adopt only this operation's persisted native result.
    recovery.import_id = Some(import_id.to_string());
    let save_catalog = catalog.clone();
    let save_record = recovery.clone();
    blocking(move || save_catalog.save_recovery(&save_record)).await?;
    if old.is_some() {
        let id = crate::BoxID::parse(&recovery.original_id)
            .ok_or_else(|| BoxliteError::Internal("invalid recovery target ID".into()))?;
        runtime.remove_box(&id, false)?;
    }
    let bx = super::super::import::import_checkpoint_box(
        &runtime,
        BoxArchive::new(prepared.path.clone()),
        recovery.name.clone(),
        import_id,
        &ownership,
    )
    .await?;
    finish_recovery(catalog, recovery, bx).await
}

async fn finish_recovery(
    catalog: Catalog,
    mut recovery: Recovery,
    bx: LiteBox,
) -> BoxliteResult<LiteBox> {
    recovery.accepted_id = Some(bx.id().to_string());
    let accepted_id = bx.id().to_string();
    if let Err(error) = blocking(move || catalog.save_recovery(&recovery)).await {
        return Err(BoxliteError::Storage(format!(
            "checkpoint import succeeded as box {accepted_id}, but recording recovery completion failed: {error}"
        )));
    }
    Ok(bx)
}

async fn verify_startup(
    runtime: &SharedRuntimeImpl,
    prepared: &PreparedCheckpointArchive,
) -> BoxliteResult<()> {
    runtime
        .experimental_features
        .require_for_options(&prepared.options)?;
    runtime
        .image_manager
        .pull(&prepared.pinned_image)
        .await?
        .load_config()
        .await?;
    Ok(())
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> BoxliteResult<T> + Send + 'static,
) -> BoxliteResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(task_error)?
}

fn task_error(error: tokio::task::JoinError) -> BoxliteError {
    BoxliteError::Internal(format!("checkpoint operation failed: {error}"))
}

#[cfg(test)]
mod tests;
