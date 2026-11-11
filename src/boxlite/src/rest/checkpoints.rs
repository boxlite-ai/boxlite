//! REST-only checkpoint transport and SDK import dispatch.

use std::sync::Arc;

use super::client::ApiClient;
use super::litebox::RestBox;
use super::options::BoxliteRestOptions;
use super::runtime::litebox_from_rest;
use super::types::BoxResponse;
use crate::runtime::checkpoints::{CheckpointBackend, checked_name};
use crate::{BoxArchive, BoxliteError, BoxliteResult, BoxliteRuntime, LiteBox};

struct RestCheckpointBackend {
    client: ApiClient,
}

/// Construct the checkpoint capability for a REST SDK or CLI adapter.
pub fn checkpoint_backend(
    options: &BoxliteRestOptions,
) -> BoxliteResult<Arc<dyn CheckpointBackend>> {
    Ok(Arc::new(RestCheckpointBackend {
        client: ApiClient::new(options)?,
    }))
}

#[async_trait::async_trait]
impl crate::runtime::checkpoints::CheckpointBackend for RestCheckpointBackend {
    async fn create(
        &self,
        source: &str,
        name: Option<String>,
    ) -> BoxliteResult<crate::CheckpointInfo> {
        if source.is_empty() || source.contains('\0') {
            return Err(BoxliteError::InvalidArgument(
                "checkpoint source must be a box ID or name".into(),
            ));
        }
        if let Some(name) = &name {
            checked_name(name)?;
        }
        #[derive(serde::Serialize)]
        struct Capture<'a> {
            source_box_id: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            name: Option<String>,
        }
        self.client
            .post(
                "/checkpoints",
                &Capture {
                    source_box_id: source,
                    name,
                },
            )
            .await
    }

    async fn list(&self) -> BoxliteResult<Vec<crate::CheckpointInfo>> {
        #[derive(serde::Deserialize)]
        struct Page {
            checkpoints: Vec<crate::CheckpointInfo>,
            #[serde(default)]
            next_page_token: Option<String>,
        }
        let mut result = Vec::new();
        let mut token = None::<String>;
        let mut seen = std::collections::HashSet::new();
        loop {
            let query = token
                .as_deref()
                .map(|value| vec![("page_token", value)])
                .unwrap_or_default();
            let page: Page = self.client.get_with_query("/checkpoints", &query).await?;
            result.extend(page.checkpoints);
            match page.next_page_token.filter(|value| !value.is_empty()) {
                Some(value) if seen.insert(value.clone()) => token = Some(value),
                Some(_) => {
                    return Err(BoxliteError::Internal(
                        "checkpoint server repeated a pagination token".into(),
                    ));
                }
                None => return Ok(result),
            }
        }
    }

    async fn get(&self, key: &str) -> BoxliteResult<crate::CheckpointInfo> {
        checked_name(key)?;
        self.client.get(&format!("/checkpoints/{key}")).await
    }

    async fn remove(&self, key: &str, force: bool) -> BoxliteResult<()> {
        checked_name(key)?;
        let path = format!("/checkpoints/{key}");
        let result = if force {
            self.client
                .delete_with_query(&path, &[("force", "true")])
                .await
        } else {
            self.client.delete(&path).await
        };
        match result {
            Err(BoxliteError::NotFound(_)) if force => Ok(()),
            result => result,
        }
    }

    async fn import_box(
        &self,
        key: &str,
        name: Option<String>,
        box_id: Option<&str>,
    ) -> BoxliteResult<LiteBox> {
        validate_import(key, name.as_deref(), box_id)?;
        #[derive(serde::Serialize)]
        struct Import<'a> {
            checkpoint_id: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            name: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            box_id: Option<&'a str>,
        }
        let response: BoxResponse = self
            .client
            .post(
                "/boxes/import",
                &Import {
                    checkpoint_id: key,
                    name,
                    box_id,
                },
            )
            .await?;
        Ok(litebox_from_rest(Arc::new(RestBox::new(
            self.client.clone(),
            response.to_box_info()?,
        ))))
    }
}

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
        backend: Option<&dyn CheckpointBackend>,
        name: Option<String>,
    ) -> BoxliteResult<LiteBox> {
        match self {
            Self::Archive(archive) => runtime.import_box(archive, name).await,
            Self::Checkpoint {
                checkpoint_id,
                box_id,
            } => {
                validate_import(&checkpoint_id, name.as_deref(), box_id.as_deref())?;
                let backend = backend.ok_or_else(|| {
                    BoxliteError::Unsupported(
                        "checkpoints are only implemented for REST runtimes".into(),
                    )
                })?;
                backend
                    .import_box(&checkpoint_id, name, box_id.as_deref())
                    .await
            }
        }
    }
}
