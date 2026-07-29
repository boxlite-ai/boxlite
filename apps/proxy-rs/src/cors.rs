// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! Permissive CORS for preview URLs.
//!
//! A preview box is reached from arbitrary origins — a dashboard iframe, a
//! user's own app, a local dev server — so every origin is reflected and
//! credentials are allowed. That is deliberate: the box itself is the security
//! boundary (it is only reachable with a preview token or a signed cookie), not
//! the browser's same-origin policy.

use http::header::{HeaderName, HeaderValue, VARY};
use http::{HeaderMap, Method, Request};

/// Lets a caller opt out entirely, for clients that set their own CORS headers.
pub const DISABLE_HEADER: &str = "X-BoxLite-Disable-CORS";

const ALLOW_METHODS: &str = "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS";
const MAX_AGE_SECONDS: &str = "43200";

/// Headers to add to the response, plus whether the request was a preflight
/// that the proxy should answer itself instead of forwarding.
#[derive(Debug, Default)]
pub struct CorsHeaders {
    pub headers: HeaderMap,
    pub is_preflight: bool,
}

/// Returns the CORS headers this request calls for, or `None` when CORS does not
/// apply: no `Origin`, same-origin, or the caller opted out.
pub fn evaluate<B>(request: &Request<B>, request_host: &str) -> Option<CorsHeaders> {
    if request
        .headers()
        .get(DISABLE_HEADER)
        .is_some_and(|value| value == "true")
    {
        return None;
    }

    let origin = request.headers().get(http::header::ORIGIN)?.to_str().ok()?;
    if origin == format!("http://{request_host}") || origin == format!("https://{request_host}") {
        return None;
    }

    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("access-control-allow-credentials"),
        HeaderValue::from_static("true"),
    );
    let Ok(origin) = HeaderValue::from_str(origin) else {
        return None;
    };
    headers.insert(
        HeaderName::from_static("access-control-allow-origin"),
        origin,
    );

    let is_preflight = request.method() == Method::OPTIONS;
    if !is_preflight {
        headers.insert(VARY, HeaderValue::from_static("Origin"));
        return Some(CorsHeaders {
            headers,
            is_preflight,
        });
    }

    headers.insert(
        HeaderName::from_static("access-control-allow-methods"),
        HeaderValue::from_static(ALLOW_METHODS),
    );
    if let Ok(allow_headers) = HeaderValue::from_str(&allowed_headers(request.headers())) {
        headers.insert(
            HeaderName::from_static("access-control-allow-headers"),
            allow_headers,
        );
    }
    headers.insert(
        HeaderName::from_static("access-control-max-age"),
        HeaderValue::from_static(MAX_AGE_SECONDS),
    );
    for vary in [
        "Origin",
        "Access-Control-Request-Method",
        "Access-Control-Request-Headers",
    ] {
        headers.append(VARY, HeaderValue::from_static(vary));
    }

    Some(CorsHeaders {
        headers,
        is_preflight,
    })
}

/// Echoes back everything the client sent or asked to send. Enumerating an
/// allow-list would break arbitrary user apps running inside a box.
fn allowed_headers(request_headers: &HeaderMap) -> String {
    let mut names: Vec<String> = request_headers
        .keys()
        .map(|name| name.as_str().to_string())
        .collect();

    for requested in request_headers.get_all("access-control-request-headers") {
        if let Ok(requested) = requested.to_str() {
            names.push(requested.to_string());
        }
    }

    names.join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: Method, headers: &[(&str, &str)]) -> Request<()> {
        let mut builder = Request::builder().method(method).uri("http://box.test/");
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder.body(()).expect("valid request")
    }

    #[test]
    fn ignores_requests_without_an_origin() {
        assert!(evaluate(&request(Method::GET, &[]), "3000-box.proxy.test").is_none());
    }

    #[test]
    fn ignores_same_origin_requests() {
        let request = request(Method::GET, &[("origin", "https://3000-box.proxy.test")]);
        assert!(evaluate(&request, "3000-box.proxy.test").is_none());
    }

    #[test]
    fn honours_the_opt_out_header() {
        let request = request(
            Method::GET,
            &[("origin", "https://app.test"), (DISABLE_HEADER, "true")],
        );
        assert!(evaluate(&request, "3000-box.proxy.test").is_none());
    }

    #[test]
    fn reflects_the_origin_with_credentials() {
        let request = request(Method::GET, &[("origin", "https://app.test")]);
        let cors = evaluate(&request, "3000-box.proxy.test").expect("cors applies");

        assert!(!cors.is_preflight);
        assert_eq!(
            cors.headers.get("access-control-allow-origin").unwrap(),
            "https://app.test"
        );
        assert_eq!(
            cors.headers
                .get("access-control-allow-credentials")
                .unwrap(),
            "true"
        );
    }

    #[test]
    fn preflight_echoes_requested_headers() {
        let request = request(
            Method::OPTIONS,
            &[
                ("origin", "https://app.test"),
                ("access-control-request-method", "POST"),
                ("access-control-request-headers", "x-custom,authorization"),
            ],
        );
        let cors = evaluate(&request, "3000-box.proxy.test").expect("cors applies");

        assert!(cors.is_preflight);
        let allowed = cors
            .headers
            .get("access-control-allow-headers")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(
            allowed.contains("x-custom,authorization"),
            "got {allowed:?}"
        );
        assert!(
            allowed.contains("origin"),
            "inbound header names too: {allowed:?}"
        );
        assert_eq!(cors.headers.get("access-control-max-age").unwrap(), "43200");
    }
}
