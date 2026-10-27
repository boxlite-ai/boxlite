use std::sync::Arc;

use boxlite::runtime::{Domain, DomainHandle, DomainList, DomainTarget};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;

use crate::util::map_err;

/// What a domain routes to. `type` decides which fields apply; `"box"` is the
/// only kind today, with `box` (a box id or name) and `port`.
#[pyclass(name = "DomainTarget")]
#[derive(Clone)]
pub(crate) struct PyDomainTarget {
    #[pyo3(get, name = "type")]
    pub(crate) kind: String,
    /// The box id or name when binding; the box id when read back.
    #[pyo3(get, name = "box")]
    pub(crate) box_ref: String,
    #[pyo3(get)]
    pub(crate) port: u16,
}

#[pymethods]
impl PyDomainTarget {
    /// Keyword-only, so a later target kind can take other fields.
    #[new]
    #[pyo3(signature = (*, r#type, r#box, port))]
    fn new(r#type: String, r#box: String, port: u16) -> PyResult<Self> {
        if r#type != "box" {
            return Err(PyValueError::new_err(format!(
                "unsupported domain target type {type:?}; expected \"box\""
            )));
        }
        Ok(Self {
            kind: r#type,
            box_ref: r#box,
            port,
        })
    }

    fn __repr__(&self) -> String {
        format!(
            "DomainTarget(type={:?}, box={:?}, port={})",
            self.kind, self.box_ref, self.port
        )
    }
}

impl PyDomainTarget {
    fn to_core(&self) -> DomainTarget {
        DomainTarget::Box {
            box_ref: self.box_ref.clone(),
            port: self.port,
        }
    }

    fn from_core(target: DomainTarget) -> PyResult<Self> {
        match target {
            DomainTarget::Box { box_ref, port } => Ok(Self {
                kind: "box".into(),
                box_ref,
                port,
            }),
            other => Err(PyValueError::new_err(format!(
                "domain target {other:?} is newer than this SDK"
            ))),
        }
    }
}

/// One domain the organization holds and what it routes to.
#[pyclass(name = "Domain")]
#[derive(Clone)]
pub(crate) struct PyDomain {
    /// What the domain is bound by: the label of a platform name.
    #[pyo3(get)]
    pub(crate) name: String,
    #[pyo3(get)]
    pub(crate) hostname: String,
    #[pyo3(get)]
    pub(crate) url: String,
    /// None while the domain is held but unbound.
    #[pyo3(get)]
    pub(crate) target: Option<PyDomainTarget>,
}

#[pymethods]
impl PyDomain {
    fn __repr__(&self) -> String {
        format!(
            "Domain(name={:?}, url={:?}, target={})",
            self.name,
            self.url,
            self.target
                .as_ref()
                .map_or_else(|| "None".to_string(), PyDomainTarget::__repr__)
        )
    }
}

impl PyDomain {
    fn from_core(domain: Domain) -> PyResult<Self> {
        Ok(Self {
            name: domain.name,
            hostname: domain.hostname,
            url: domain.url,
            target: domain.target.map(PyDomainTarget::from_core).transpose()?,
        })
    }
}

/// Every domain the organization holds, with the allowance they count against.
#[pyclass(name = "DomainList")]
#[derive(Clone)]
pub(crate) struct PyDomainList {
    #[pyo3(get)]
    pub(crate) domains: Vec<PyDomain>,
    #[pyo3(get)]
    pub(crate) limit: u32,
    #[pyo3(get)]
    pub(crate) used: u32,
    #[pyo3(get)]
    pub(crate) remaining: u32,
    /// The shortest platform name a new claim may use.
    #[pyo3(get)]
    pub(crate) min_length: u32,
}

#[pymethods]
impl PyDomainList {
    fn __repr__(&self) -> String {
        format!(
            "DomainList(used={}, limit={}, remaining={}, min_length={}, domains={})",
            self.used,
            self.limit,
            self.remaining,
            self.min_length,
            self.domains.len()
        )
    }
}

impl PyDomainList {
    fn from_core(held: DomainList) -> PyResult<Self> {
        Ok(Self {
            domains: held
                .domains
                .into_iter()
                .map(PyDomain::from_core)
                .collect::<PyResult<_>>()?,
            limit: held.limit,
            used: held.used,
            remaining: held.remaining,
            min_length: held.min_length,
        })
    }
}

/// Runtime-scoped handle for the organization's domains. A `domain` argument
/// is a platform name (`"demo"`) or a full hostname.
#[pyclass(name = "DomainHandle")]
pub(crate) struct PyDomainHandle {
    pub(crate) handle: Arc<DomainHandle>,
}

#[pymethods]
impl PyDomainHandle {
    /// Every held domain, unbound ones included, with the allowance.
    ///
    /// Returns an awaitable that resolves to `DomainList`.
    fn list<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let held = handle.list().await.map_err(map_err)?;
            PyDomainList::from_core(held)
        })
    }

    /// Route `domain` to `target`, claiming it if new. A domain bound
    /// elsewhere in the organization moves. Returns an awaitable that
    /// resolves to the bound `Domain`.
    fn bind<'py>(
        &self,
        py: Python<'py>,
        domain: String,
        target: PyDomainTarget,
    ) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        let target = target.to_core();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let bound = handle.bind(&domain, &target).await.map_err(map_err)?;
            PyDomain::from_core(bound)
        })
    }

    /// Stop routing `domain`, keeping it for the organization. Returns an
    /// awaitable that resolves to None; a domain the organization does not
    /// hold raises.
    fn unbind<'py>(&self, py: Python<'py>, domain: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle.unbind(&domain).await.map_err(map_err)?;
            Ok(())
        })
    }

    fn __repr__(&self) -> String {
        "DomainHandle()".to_string()
    }
}
