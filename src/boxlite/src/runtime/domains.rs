//! Domains an organization holds — platform names like `demo.<user domain>` —
//! and what each routes to.
//!
//! A domain is the organization's, not a box's, so it is listed, bound and
//! unbound from the runtime; a box port is only what a domain routes to.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::{BoxliteError, BoxliteResult};

/// What a domain routes to. `type` on the wire names the variant.
///
/// Non-exhaustive: an `App` target joins `Box` once apps exist, without
/// changing [`DomainHandle::bind`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
#[non_exhaustive]
pub enum DomainTarget {
    /// A guest port of a box. `box_ref` is the box's id or name when binding
    /// (serialized as `box`; `box` is a Rust keyword) and its id when read back.
    Box {
        #[serde(rename = "box")]
        box_ref: String,
        port: u16,
    },
}

/// One domain the organization holds and what it currently routes to.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Domain {
    /// What the domain is bound by: the label of a platform name, e.g. `demo`.
    pub name: String,
    /// The full hostname, such as `demo.apps.example`.
    pub hostname: String,
    pub url: String,
    /// `None` while the domain is held but unbound.
    pub target: Option<DomainTarget>,
}

/// Every domain the organization holds, with the allowance they count against.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct DomainList {
    pub domains: Vec<Domain>,
    /// How many domains the organization may hold, bound or not.
    pub limit: u32,
    pub used: u32,
    pub remaining: u32,
    /// The shortest platform name a new claim may use.
    pub min_length: u32,
}

/// Backend abstraction for the organization's domains.
///
/// Implemented by the REST backend only; a local runtime publishes nothing.
#[allow(
    clippy::double_must_use,
    reason = "async_trait generates a must-use boxed future"
)]
#[async_trait]
pub(crate) trait DomainBackend: Send + Sync {
    async fn list_domains(&self) -> BoxliteResult<DomainList>;
    async fn bind_domain(&self, domain: &str, target: &DomainTarget) -> BoxliteResult<Domain>;
    async fn unbind_domain(&self, domain: &str) -> BoxliteResult<()>;
}

/// Runtime-scoped handle for the organization's domains.
///
/// Obtained from [`BoxliteRuntime::domains`](crate::BoxliteRuntime::domains).
/// A `domain` argument is a platform name (`demo`) or a full hostname
/// (`demo.apps.example`); the server applies the naming rules.
#[derive(Clone)]
pub struct DomainHandle {
    backend: Arc<dyn DomainBackend>,
}

impl DomainHandle {
    /// Internal constructor used by `BoxliteRuntime`.
    pub(crate) fn new(backend: Arc<dyn DomainBackend>) -> Self {
        Self { backend }
    }

    /// Every domain the organization holds, unbound ones included, with its
    /// allowance. An unbound domain still counts, so this is how a caller
    /// finds one to bind again.
    pub async fn list(&self) -> BoxliteResult<DomainList> {
        self.backend.list_domains().await
    }

    /// Route `domain` to `target`, claiming it if the organization does not
    /// hold it yet. A domain bound elsewhere in the organization moves; other
    /// domains on the target port stay. The port is not made public: the
    /// domain answers once the port's tunnel is declared. Repeating it is a
    /// no-op.
    pub async fn bind(&self, domain: &str, target: &DomainTarget) -> BoxliteResult<Domain> {
        let domain = path_segment(domain)?;
        match target {
            DomainTarget::Box { box_ref, port } => {
                if box_ref.trim().is_empty() {
                    return Err(BoxliteError::InvalidArgument(
                        "domain target box must not be empty".into(),
                    ));
                }
                if *port == 0 {
                    return Err(BoxliteError::InvalidArgument(
                        "domain target port must be non-zero".into(),
                    ));
                }
            }
        }
        self.backend.bind_domain(domain, target).await
    }

    /// Stop routing `domain`, keeping it for the organization. Safe to repeat
    /// on a held domain; one the organization does not hold is `NotFound`.
    pub async fn unbind(&self, domain: &str) -> BoxliteResult<()> {
        self.backend.unbind_domain(path_segment(domain)?).await
    }
}

/// `domain` trimmed, if it can only name a domain: it is sent as one path
/// segment, so anything beyond hostname characters is refused here rather
/// than reshaping the request path. Empty labels are refused too, which keeps
/// out the dot segments `.` and `..` that a URL parser would collapse; one
/// trailing root dot is allowed.
fn path_segment(domain: &str) -> BoxliteResult<&str> {
    let domain = domain.trim();
    let labels = domain.strip_suffix('.').unwrap_or(domain);
    if labels.split('.').any(str::is_empty)
        || !labels
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'.')
    {
        return Err(BoxliteError::InvalidArgument(format!(
            "invalid domain {domain:?}: use a name like `demo` or a hostname like `demo.apps.example`"
        )));
    }
    Ok(domain)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_box_target_serializes_with_its_type_tag() {
        let target = DomainTarget::Box {
            box_ref: "web-a".into(),
            port: 3000,
        };
        assert_eq!(
            serde_json::to_value(&target).unwrap(),
            serde_json::json!({"type": "box", "box": "web-a", "port": 3000})
        );
    }

    #[test]
    fn deserializes_the_rest_list_with_unbound_domains() {
        let json = r#"{
            "domains": [
                {"name": "demo1", "hostname": "demo1.app.test", "url": "https://demo1.app.test",
                 "target": {"type": "box", "box": "AbCdEf123456", "port": 3000}},
                {"name": "spare", "hostname": "spare.app.test", "url": "https://spare.app.test", "target": null}
            ],
            "limit": 2, "used": 2, "remaining": 0, "min_length": 5
        }"#;
        let held: DomainList = serde_json::from_str(json).unwrap();
        assert_eq!(
            held.domains[0].target,
            Some(DomainTarget::Box {
                box_ref: "AbCdEf123456".into(),
                port: 3000
            })
        );
        assert_eq!(held.domains[1].target, None);
        assert_eq!(
            (held.limit, held.used, held.remaining, held.min_length),
            (2, 2, 0, 5)
        );
    }

    #[test]
    fn only_hostname_characters_reach_the_request_path() {
        assert_eq!(path_segment(" demo.app.test ").unwrap(), "demo.app.test");
        assert_eq!(path_segment("demo.app.test.").unwrap(), "demo.app.test.");
        // `.` and `..` are dot segments: the URL parser collapses them, so
        // `/domains/../target` would reach `/target` instead.
        for domain in [
            "",
            "  ",
            "demo/target",
            "demo?x=1",
            "../boxes",
            "demo%2f",
            ".",
            "..",
            ".demo",
            "a..b",
        ] {
            assert!(
                matches!(path_segment(domain), Err(BoxliteError::InvalidArgument(_))),
                "{domain:?} was accepted"
            );
        }
    }
}
