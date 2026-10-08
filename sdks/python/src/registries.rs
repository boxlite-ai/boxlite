use std::sync::Arc;

use boxlite::runtime::{NewRegistryCredential, RegistryCredential, RegistryHandle};
use pyo3::prelude::*;

use crate::util::map_err;

/// A registry login the server pulls private images with. It has no
/// password field: the server never returns one.
#[pyclass(name = "RegistryCredential")]
#[derive(Clone)]
pub(crate) struct PyRegistryCredential {
    /// UUID that `remove` takes.
    #[pyo3(get)]
    pub(crate) id: String,
    #[pyo3(get)]
    pub(crate) registry_host: String,
    /// Whole path segments ending in "/"; empty for the whole registry.
    #[pyo3(get)]
    pub(crate) repository_prefix: String,
    #[pyo3(get)]
    pub(crate) username: String,
    /// The user who added it, when the server knows.
    #[pyo3(get)]
    pub(crate) created_by: Option<String>,
    /// RFC 3339.
    #[pyo3(get)]
    pub(crate) created_at: String,
}

#[pymethods]
impl PyRegistryCredential {
    fn __repr__(&self) -> String {
        format!(
            "RegistryCredential(id={:?}, registry_host={:?}, repository_prefix={:?}, username={:?})",
            self.id, self.registry_host, self.repository_prefix, self.username
        )
    }
}

impl From<RegistryCredential> for PyRegistryCredential {
    fn from(credential: RegistryCredential) -> Self {
        Self {
            id: credential.id,
            registry_host: credential.registry_host,
            repository_prefix: credential.repository_prefix,
            username: credential.username,
            created_by: credential.created_by,
            created_at: credential.created_at.to_rfc3339(),
        }
    }
}

/// The server's registry logins. REST runtimes only.
#[pyclass(name = "RegistryHandle")]
pub(crate) struct PyRegistryHandle {
    pub(crate) handle: Arc<RegistryHandle>,
}

#[pymethods]
impl PyRegistryHandle {
    /// Every login the organization holds, oldest first.
    fn list<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let logins = handle.list().await.map_err(map_err)?;
            Ok(logins
                .into_iter()
                .map(PyRegistryCredential::from)
                .collect::<Vec<_>>())
        })
    }

    /// Add a login. Raises AlreadyExistsError while one is held for the same
    /// registry and prefix. Keyword-only, so a password cannot land in the
    /// username's place.
    #[pyo3(signature = (*, registry_host, username, password, repository_prefix=None))]
    fn create<'py>(
        &self,
        py: Python<'py>,
        registry_host: String,
        username: String,
        password: String,
        repository_prefix: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        let login = NewRegistryCredential {
            registry_host,
            repository_prefix,
            username,
            password,
        };
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let created = handle.create(&login).await.map_err(map_err)?;
            Ok(PyRegistryCredential::from(created))
        })
    }

    /// Remove a login by id. Raises InvalidStateError, naming the boxes,
    /// while a box still pulls through it.
    fn remove<'py>(&self, py: Python<'py>, id: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle.remove(&id).await.map_err(map_err)?;
            Ok(())
        })
    }

    fn __repr__(&self) -> String {
        "RegistryHandle()".to_string()
    }
}
