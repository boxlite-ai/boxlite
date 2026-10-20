//! Proxy settings for registry clients.
//!
//! [`validate`] checks an [`ImageRegistryProxy`] once, at runtime creation:
//! reqwest drops a proxy URL with an unknown scheme without an error, and the
//! pull then goes direct.

use boxlite_shared::{BoxliteError, BoxliteResult};
use oci_client::client::ClientConfig;

use crate::runtime::options::ImageRegistryProxy;

/// Reject settings that reqwest would ignore or misread.
pub(crate) fn validate(proxy: &ImageRegistryProxy) -> BoxliteResult<()> {
    validate_proxy_url("http_proxy", proxy.http_proxy.as_deref())?;
    validate_proxy_url("https_proxy", proxy.https_proxy.as_deref())?;
    if proxy.no_proxy.is_some() && proxy.http_proxy.is_none() && proxy.https_proxy.is_none() {
        return Err(invalid("no_proxy requires http_proxy or https_proxy"));
    }

    // reqwest parses the URLs only when a client is built.
    let mut config = ClientConfig::default();
    apply(Some(proxy), &mut config);
    oci_client::Client::try_from(config).map_err(|e| invalid(&e.to_string()))?;
    Ok(())
}

/// Copy the proxy settings into one registry client's configuration. `None`
/// leaves proxying to the environment variables.
pub(super) fn apply(proxy: Option<&ImageRegistryProxy>, config: &mut ClientConfig) {
    if let Some(proxy) = proxy {
        config.http_proxy = proxy.http_proxy.clone();
        config.https_proxy = proxy.https_proxy.clone();
        config.no_proxy = proxy.no_proxy.clone();
    }
}

fn validate_proxy_url(field: &str, url: Option<&str>) -> BoxliteResult<()> {
    let scheme = url.map(|url| url.split_once("://").map_or("", |(scheme, _)| scheme));
    match scheme.map(str::to_ascii_lowercase).as_deref() {
        None | Some("http" | "https") => Ok(()),
        Some(_) => Err(invalid(&format!(
            "{field} must be an http:// or https:// URL"
        ))),
    }
}

fn invalid(reason: &str) -> BoxliteError {
    BoxliteError::Config(format!("invalid image_registry_proxy: {reason}"))
}
