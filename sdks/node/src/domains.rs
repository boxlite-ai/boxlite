use std::sync::Arc;

use boxlite::runtime::{Domain, DomainHandle, DomainList, DomainTarget};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::map_err;

/// A Box port or a reserved App reference. App binding is not yet supported.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsDomainTarget {
    #[napi(js_name = "type")]
    pub kind: String,
    /// The box id or name when binding; the box id when read back.
    #[napi(js_name = "box")]
    pub box_ref: Option<String>,
    pub port: Option<u16>,
    pub app: Option<String>,
}

impl JsDomainTarget {
    fn into_core(self) -> Result<DomainTarget> {
        match (self.kind.as_str(), self.box_ref, self.port, self.app) {
            ("box", Some(box_ref), Some(port), None) => Ok(DomainTarget::Box { box_ref, port }),
            ("app", None, None, Some(app_ref)) => Ok(DomainTarget::App { app_ref }),
            _ => Err(Error::new(
                Status::InvalidArg,
                "domain target type and fields disagree",
            )),
        }
    }

    fn from_core(target: DomainTarget) -> Result<Self> {
        match target {
            DomainTarget::Box { box_ref, port } => Ok(Self {
                kind: "box".into(),
                box_ref: Some(box_ref),
                port: Some(port),
                app: None,
            }),
            DomainTarget::App { app_ref } => Ok(Self {
                kind: "app".into(),
                box_ref: None,
                port: None,
                app: Some(app_ref),
            }),
            other => Err(Error::from_reason(format!(
                "domain target {other:?} is newer than this SDK"
            ))),
        }
    }
}

/// One domain the organization holds and what it routes to.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsDomain {
    pub hostname: String,
    pub url: String,
    /// Null while the domain is held but unbound.
    pub target: Option<JsDomainTarget>,
}

impl JsDomain {
    fn from_core(domain: Domain) -> Result<Self> {
        Ok(Self {
            hostname: domain.hostname,
            url: domain.url,
            target: domain.target.map(JsDomainTarget::from_core).transpose()?,
        })
    }
}

/// Every domain the organization holds, with the allowance they count against.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsDomainList {
    pub domains: Vec<JsDomain>,
    pub limit: u32,
    pub used: u32,
    pub remaining: u32,
    /// The shortest platform name a new claim may use.
    #[napi(js_name = "minLength")]
    pub min_length: u32,
}

impl JsDomainList {
    fn from_core(held: DomainList) -> Result<Self> {
        Ok(Self {
            domains: held
                .domains
                .into_iter()
                .map(JsDomain::from_core)
                .collect::<Result<_>>()?,
            limit: held.limit,
            used: held.used,
            remaining: held.remaining,
            min_length: held.min_length,
        })
    }
}

/// Bind accepts a platform name or full hostname; unbind requires a full hostname.
#[napi]
pub struct JsDomainHandle {
    pub(crate) handle: Arc<DomainHandle>,
}

#[napi]
impl JsDomainHandle {
    /// Every held domain, unbound ones included, with the allowance.
    #[napi]
    pub async fn list(&self) -> Result<JsDomainList> {
        let held = self.handle.list().await.map_err(map_err)?;
        JsDomainList::from_core(held)
    }

    /// Route `domain` to `target`, claiming it if new. A domain bound
    /// elsewhere in the organization moves.
    #[napi]
    pub async fn bind(&self, domain: String, target: JsDomainTarget) -> Result<JsDomain> {
        let target = target.into_core()?;
        let bound = self.handle.bind(&domain, &target).await.map_err(map_err)?;
        JsDomain::from_core(bound)
    }

    /// Stop routing a full hostname, keeping it for the organization.
    #[napi]
    pub async fn unbind(&self, domain: String) -> Result<()> {
        self.handle.unbind(&domain).await.map_err(map_err)
    }
}
