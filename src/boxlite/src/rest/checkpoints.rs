//! Checkpoint source selection shared by REST SDK and CLI adapters.

use crate::runtime::checkpoints::checked_name;
use crate::{BoxArchive, BoxliteError, BoxliteResult, BoxliteRuntime, LiteBox};

fn validate_import(key: &str, name: Option<&str>, box_id: Option<&str>) -> BoxliteResult<()> {
    checked_name(key)?;
    if name.is_some() && box_id.is_some() {
        return Err(BoxliteError::InvalidArgument(
            "name and box_id are mutually exclusive".into(),
        ));
    }
    if let Some(name) = name {
        checked_name(name)?;
    }
    if let Some(target) = box_id
        && (target.is_empty() || target.contains('\0'))
    {
        return Err(BoxliteError::InvalidArgument(
            "import target must be a box ID or name".into(),
        ));
    }
    Ok(())
}

/// Source selection in SDK adapters; native runtime import accepts only BoxArchive.
#[derive(Debug, Clone)]
pub enum BoxImportSource {
    Archive(BoxArchive),
    Checkpoint {
        checkpoint_id: String,
        box_id: Option<String>,
    },
}

impl BoxImportSource {
    /// Select exactly one source; only checkpoints support replacing a Box.
    pub fn from_options(
        archive: Option<BoxArchive>,
        checkpoint_id: Option<String>,
        box_id: Option<String>,
    ) -> BoxliteResult<Self> {
        match (archive, checkpoint_id, box_id) {
            (Some(archive), None, None) => Ok(Self::Archive(archive)),
            (None, Some(checkpoint_id), box_id) => Ok(Self::Checkpoint { checkpoint_id, box_id }),
            _ => Err(BoxliteError::InvalidArgument(
                "specify exactly one of archive_path or checkpoint_id; box_id requires a checkpoint".into(),
            )),
        }
    }

    /// Dispatch SDK requests without changing the native runtime archive contract.
    pub async fn import_box(
        self,
        runtime: &BoxliteRuntime,
        name: Option<String>,
    ) -> BoxliteResult<LiteBox> {
        match self {
            Self::Archive(archive) => runtime.import_box(archive, name).await,
            Self::Checkpoint {
                checkpoint_id,
                box_id,
            } => {
                validate_import(&checkpoint_id, name.as_deref(), box_id.as_deref())?;
                runtime
                    .checkpoints()
                    .backend()?
                    .import_box(&checkpoint_id, name, box_id.as_deref())
                    .await
            }
        }
    }
}
