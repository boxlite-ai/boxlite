//! Query routing keeps ordinary Runtime initialization first and falls back
//! only for local home-lock contention, never for other startup errors.

use boxlite::runtime::query::ReadOnlyRuntime;
use boxlite::runtime::types::ImageInfo;
use boxlite::{BoxInfo, BoxliteError, BoxliteRuntime};

enum Backend {
    Runtime(BoxliteRuntime),
    ReadOnly(ReadOnlyRuntime),
}

pub(crate) struct QueryRuntime(Backend);

impl QueryRuntime {
    pub(crate) fn from_runtime(result: anyhow::Result<BoxliteRuntime>) -> anyhow::Result<Self> {
        match result {
            Ok(runtime) => Ok(Self(Backend::Runtime(runtime))),
            Err(error) => match error.downcast_ref::<BoxliteError>() {
                Some(BoxliteError::RuntimeInUse { home_dir }) => Ok(Self(Backend::ReadOnly(
                    ReadOnlyRuntime::new(home_dir.clone()),
                ))),
                _ => Err(error),
            },
        }
    }

    pub(crate) async fn list_info(&self) -> anyhow::Result<Vec<BoxInfo>> {
        Ok(match &self.0 {
            Backend::Runtime(runtime) => runtime.list_info().await?,
            Backend::ReadOnly(runtime) => runtime.list_info().await?,
        })
    }

    pub(crate) async fn list_images(&self) -> anyhow::Result<Vec<ImageInfo>> {
        Ok(match &self.0 {
            Backend::Runtime(runtime) => runtime.images()?.list().await?,
            Backend::ReadOnly(runtime) => runtime.list_images().await?,
        })
    }

    pub(crate) async fn info(&self) -> anyhow::Result<(Vec<BoxInfo>, usize)> {
        Ok(match &self.0 {
            Backend::Runtime(runtime) => (
                runtime.list_info().await?,
                runtime.images()?.list().await?.len(),
            ),
            Backend::ReadOnly(runtime) => runtime.info().await?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unrelated_initialization_errors_propagate_even_with_lock_text() {
        let error =
            BoxliteError::Storage("Another BoxliteRuntime is already using directory".into());
        let result = QueryRuntime::from_runtime(Err(error.into()));
        assert!(matches!(
            result.err().unwrap().downcast_ref::<BoxliteError>(),
            Some(BoxliteError::Storage(_))
        ));
    }
}
