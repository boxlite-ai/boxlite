//! A failed replacement must retain its target identity for an import retry.

use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(in crate::runtime::checkpoints) struct Recovery {
    pub original_id: String,
    pub name: Option<String>,
    pub checkpoint_id: String,
    #[serde(default)]
    pub import_id: Option<String>,
    pub accepted_id: Option<String>,
}

impl Recovery {
    fn pending_target(&self, target: &str) -> bool {
        self.accepted_id.is_none()
            && (self.original_id == target
                || self.name.as_deref() == Some(target)
                || self.import_id.as_deref() == Some(target))
    }
}

impl Catalog {
    pub(in crate::runtime::checkpoints) fn box_operation(&self, id: &str) -> BoxliteResult<File> {
        require_box_id(id)?;
        self.prepare()?;
        lock(&self.root.join(".locks").join(format!("box-{id}")), true)
    }

    pub(in crate::runtime::checkpoints) fn recovery(
        &self,
        target: &str,
    ) -> BoxliteResult<Option<Recovery>> {
        if !self.root.try_exists().map_err(storage)? {
            return Ok(None);
        }
        let _catalog = self.catalog_lock(false)?;
        for record in self.recovery_records()? {
            if record.original_id == target || record.pending_target(target) {
                return Ok(Some(record));
            }
        }
        Ok(None)
    }

    pub(in crate::runtime::checkpoints) fn owns_target(&self, target: &str) -> BoxliteResult<bool> {
        Ok(self.recovery(target)?.is_some())
    }

    pub(in crate::runtime::checkpoints) fn cancel_recoveries(
        &self,
        target: &str,
    ) -> BoxliteResult<Vec<String>> {
        if !self.root.try_exists().map_err(storage)? {
            return Ok(Vec::new());
        }
        let _catalog = self.catalog_lock(true)?;
        let mut ids = Vec::new();
        for record in self.recovery_records()? {
            if record.pending_target(target) {
                fs::remove_file(
                    self.root
                        .join(format!(".recover-{}.json", record.original_id)),
                )
                .map_err(storage)?;
                ids.push(record.original_id);
            }
        }
        if !ids.is_empty() {
            sync_directory(&self.root)?;
        }
        Ok(ids)
    }

    pub(super) fn recovery_records(&self) -> BoxliteResult<Vec<Recovery>> {
        let mut records = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(storage)? {
            let entry = entry.map_err(storage)?;
            let filename = entry.file_name();
            let filename = filename.to_string_lossy();
            if !filename.starts_with(".recover-") || !filename.ends_with(".json") {
                continue;
            }
            let record = read(&entry.path())?;
            if filename != format!(".recover-{}.json", record.original_id) {
                return Err(storage("recovery record filename does not match target"));
            }
            records.push(record);
        }
        Ok(records)
    }

    pub(in crate::runtime::checkpoints) fn save_recovery(
        &self,
        record: &Recovery,
    ) -> BoxliteResult<()> {
        require_box_id(&record.original_id)?;
        if let Some(id) = &record.accepted_id {
            require_box_id(id)?;
        }
        self.directory(&record.checkpoint_id)?;
        let _catalog = self.catalog_lock(true)?;
        let path = self
            .root
            .join(format!(".recover-{}.json", record.original_id));
        if path.try_exists().map_err(storage)? {
            let previous = read(&path)?;
            if previous.checkpoint_id != record.checkpoint_id {
                return Err(BoxliteError::InvalidState(
                    "target has an unfinished recovery from another checkpoint".into(),
                ));
            }
        }
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root).map_err(storage)?;
        temporary
            .write_all(&serde_json::to_vec(record).map_err(storage)?)
            .map_err(storage)?;
        temporary.as_file().sync_all().map_err(storage)?;
        temporary.persist(path).map_err(storage)?;
        sync_directory(&self.root)
    }
}

fn read(path: &Path) -> BoxliteResult<Recovery> {
    let file = private_read(path)?;
    if file.metadata().map_err(storage)?.len() > RECORD_LIMIT {
        return Err(storage("recovery record exceeds 64 KiB"));
    }
    let record: Recovery = serde_json::from_reader(file.take(RECORD_LIMIT + 1)).map_err(storage)?;
    require_box_id(&record.original_id)?;
    if let Some(id) = &record.import_id {
        require_box_id(id)?;
        if id == &record.original_id
            || record
                .accepted_id
                .as_ref()
                .is_some_and(|accepted| accepted != id)
        {
            return Err(storage(
                "recovery import identity does not match its receipt",
            ));
        }
    }
    if let Some(id) = &record.accepted_id {
        require_box_id(id)?;
    }
    uuid::Uuid::parse_str(&record.checkpoint_id).map_err(storage)?;
    Ok(record)
}

fn require_box_id(id: &str) -> BoxliteResult<()> {
    crate::BoxID::parse(id).ok_or_else(|| storage("invalid recovery target ID"))?;
    Ok(())
}
