use std::sync::Arc;

use boxlite::runtime::{Domain, DomainHandle, DomainList, DomainTarget};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::map_err;

/// What a domain routes to. `type` decides which fields apply; `"box"` is the
/// only kind today, with `box` (a box id or name) and `port`.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsDomainTarget {
    #[napi(js_name = "type")]
    pub kind: String,
    /// The box id or name when binding; the box id when read back.
    #[napi(js_name = "box")]
    pub box_ref: String,
    pub port: u16,
}

impl JsDomainTarget {
    fn into_core(self) -> Result<DomainTarget> {
        if self.kind != "box" {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "unsupported domain target type {:?}; expected \"box\"",
                    self.kind
                ),
            ));
        }
        Ok(DomainTarget::Box {
            box_ref: self.box_ref,
            port: self.port,
        })
    }

    fn from_core(target: DomainTarget) -> Result<Self> {
        match target {
            DomainTarget::Box { box_ref, port } => Ok(Self {
                kind: "box".into(),
                box_ref,
                port,
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
    /// What the domain is bound by: the label of a platform name.
    pub name: String,
    pub hostname: String,
    pub url: String,
    /// Null while the domain is held but unbound.
    pub target: Option<JsDomainTarget>,
}

impl JsDomain {
    fn from_core(domain: Domain) -> Result<Self> {
        Ok(Self {
            name: domain.name,
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

/// Runtime-scoped handle for the organization's domains. A `domain` argument
/// is a platform name (`"demo"`) or a full hostname.
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

    /// Stop routing `domain`, keeping it for the organization.
    #[napi]
    pub async fn unbind(&self, domain: String) -> Result<()> {
        self.handle.unbind(&domain).await.map_err(map_err)
    }
}
