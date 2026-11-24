//! Python wrappers for Cloud organization proxy management.

use boxlite::{OutboundProxyHandle, ProxyCredential, ProxyCredentialChange};
use pyo3::{exceptions::PyRuntimeError, prelude::*};

use crate::util::map_err;

pyo3::import_exception!(boxlite.errors, ManagedCreateError);

pub(crate) fn map_managed_create_error(error: boxlite::ManagedCreateError) -> PyErr {
    ManagedCreateError::new_err((
        error.admission.as_str(),
        error.http_status,
        error.box_id.as_ref().map(|id| id.as_str().to_owned()),
        error.source.to_string(),
    ))
}

pub(crate) fn public_value(value: impl serde::Serialize) -> PyResult<Py<PyAny>> {
    let json = serde_json::to_string(&value)
        .map_err(|_| PyRuntimeError::new_err("invalid public proxy response"))?;
    Python::attach(|py| Ok(py.import("json")?.call_method1("loads", (json,))?.unbind()))
}

#[pyclass(name = "ProxyCredential")]
pub(crate) struct PyProxyCredential(ProxyCredential);

#[pymethods]
impl PyProxyCredential {
    #[new]
    fn new(username: String, password: String) -> PyResult<Self> {
        ProxyCredential::new(username, password)
            .map(Self)
            .map_err(map_err)
    }

    fn __repr__(&self) -> &'static str {
        "ProxyCredential([redacted])"
    }
}

#[pyclass(name = "OutboundProxyHandle")]
pub(crate) struct PyOutboundProxyHandle(pub(crate) OutboundProxyHandle);

#[pymethods]
impl PyOutboundProxyHandle {
    fn list<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let registry = self.0.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            public_value(registry.list().await.map_err(map_err)?)
        })
    }

    fn get<'py>(&self, py: Python<'py>, name: String) -> PyResult<Bound<'py, PyAny>> {
        let registry = self.0.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            public_value(registry.get(&name).await.map_err(map_err)?)
        })
    }

    #[pyo3(signature = (name, url, credential=None))]
    fn create<'py>(
        &self,
        py: Python<'py>,
        name: String,
        url: String,
        credential: Option<PyRef<'_, PyProxyCredential>>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let registry = self.0.clone();
        let credential = credential.map(|credential| credential.0.clone());
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            public_value(
                registry
                    .create(&name, &url, credential.as_ref())
                    .await
                    .map_err(map_err)?,
            )
        })
    }

    #[pyo3(signature = (name, *, url=None, credential=None, clear_credential=false))]
    fn update<'py>(
        &self,
        py: Python<'py>,
        name: String,
        url: Option<String>,
        credential: Option<PyRef<'_, PyProxyCredential>>,
        clear_credential: bool,
    ) -> PyResult<Bound<'py, PyAny>> {
        let change = match (credential, clear_credential) {
            (Some(_), true) => {
                return Err(map_err(boxlite::BoxliteError::InvalidArgument(
                    "choose either to clear or replace the proxy credential".into(),
                )));
            }
            (Some(credential), false) => ProxyCredentialChange::Set(credential.0.clone()),
            (None, true) => ProxyCredentialChange::Clear,
            (None, false) => ProxyCredentialChange::Keep,
        };
        let registry = self.0.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            public_value(
                registry
                    .update(&name, url.as_deref(), change)
                    .await
                    .map_err(map_err)?,
            )
        })
    }

    fn remove<'py>(&self, py: Python<'py>, name: String) -> PyResult<Bound<'py, PyAny>> {
        let registry = self.0.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            public_value(registry.remove(&name).await.map_err(map_err)?)
        })
    }
}
