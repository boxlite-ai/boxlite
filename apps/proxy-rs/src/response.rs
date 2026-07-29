// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! Small builders for the responses the proxy generates itself.

use cookie::{Cookie, SameSite};
use http::header::{CONTENT_TYPE, LOCATION, SET_COOKIE};
use http::{HeaderMap, HeaderValue, Response, StatusCode};

use crate::body::{self, Body};

pub fn redirect(status: StatusCode, location: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(
            LOCATION,
            HeaderValue::from_str(location).unwrap_or(HeaderValue::from_static("/")),
        )
        .body(body::empty())
        .expect("a status and one header always build a valid response")
}

pub fn html(markup: String) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "text/html; charset=utf-8")
        .body(body::full(markup))
        .expect("a status and one header always build a valid response")
}

pub fn json(status: StatusCode, payload: &serde_json::Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .body(body::full(payload.to_string()))
        .expect("a status and one header always build a valid response")
}

/// How a cookie the proxy issues is scoped. `max_age` of `None` expires it.
pub struct CookieOptions<'a> {
    pub domain: &'a str,
    pub max_age: Option<std::time::Duration>,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: Option<SameSite>,
}

pub fn set_cookie(response: &mut Response<Body>, name: &str, value: &str, options: CookieOptions) {
    let mut cookie = Cookie::build((name.to_string(), value.to_string()))
        .path("/")
        .domain(options.domain.to_string())
        .secure(options.secure)
        .http_only(options.http_only);

    // A cleared cookie needs an expiry in the past, not an absent Max-Age.
    cookie = match options.max_age {
        Some(max_age) => cookie.max_age(
            cookie::time::Duration::try_from(max_age).unwrap_or(cookie::time::Duration::ZERO),
        ),
        None => cookie.max_age(cookie::time::Duration::seconds(-1)),
    };

    if let Some(same_site) = options.same_site {
        cookie = cookie.same_site(same_site);
    }

    if let Ok(value) = HeaderValue::from_str(&cookie.build().to_string()) {
        response.headers_mut().append(SET_COOKIE, value);
    }
}

/// Merges proxy-generated headers into a response without dropping what is
/// already there — several `Set-Cookie` or `Vary` headers must all survive.
pub fn merge_headers(response: &mut Response<Body>, headers: HeaderMap) {
    for (name, value) in headers {
        let Some(name) = name else { continue };
        response.headers_mut().append(name, value);
    }
}

/// Reads one cookie out of the request's `Cookie` headers.
pub fn read_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(http::header::COOKIE)
        .iter()
        .filter_map(|header| header.to_str().ok())
        .flat_map(Cookie::split_parse_encoded)
        .filter_map(Result::ok)
        .find(|cookie| cookie.name() == name)
        .map(|cookie| cookie.value().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_named_cookie_from_a_combined_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            http::header::COOKIE,
            HeaderValue::from_static("a=1; boxlite-box-auth-abc=signed%7Cvalue; b=2"),
        );

        assert_eq!(
            read_cookie(&headers, "boxlite-box-auth-abc").as_deref(),
            Some("signed|value")
        );
        assert_eq!(read_cookie(&headers, "missing"), None);
    }

    #[test]
    fn clearing_a_cookie_sets_a_past_max_age() {
        let mut response = html(String::new());
        set_cookie(
            &mut response,
            "pkce_verifier",
            "",
            CookieOptions {
                domain: ".proxy.test",
                max_age: None,
                secure: true,
                http_only: true,
                same_site: None,
            },
        );

        let header = response
            .headers()
            .get(SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(header.contains("Max-Age=-1"), "got {header}");
        // The leading dot is normalised away; RFC 6265 §5.2.3 ignores it either
        // way, so the cookie still covers every subdomain.
        assert!(header.contains("Domain=proxy.test"), "got {header}");
    }
}
