// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! Parsing of preview hostnames: `<port>-<boxId | signedToken>.<baseHost>`.

use http::Uri;

use crate::error::{ProxyError, Result};

/// Box IDs encoded into a hostname are hex so that a signed token and a raw box
/// ID can never be confused; `d-` marks the encoded form.
const DIRECT_BOX_ID_PREFIX: &str = "d-";
const DIRECT_BOX_ID_LENGTH: usize = 12;

#[derive(Debug, PartialEq, Eq)]
pub struct PreviewHost {
    pub target_port: String,
    /// Either a raw box ID or a signed preview token — which one is only known
    /// after the API resolves it.
    pub box_id_or_token: String,
    pub base_host: String,
}

/// Splits `1234-some-id.proxy.domain` into its port, box reference, and base host.
pub fn parse_host(host: &str) -> Result<PreviewHost> {
    if host.is_empty() {
        return Err(ProxyError::bad_request("host is required"));
    }

    let (prefix, base_host) = host
        .split_once('.')
        .ok_or_else(|| ProxyError::bad_request("invalid host format: must have subdomain"))?;

    let (target_port, box_id_or_token) = prefix
        .split_once('-')
        .ok_or_else(|| ProxyError::bad_request("invalid host format: port and box ID not found"))?;

    if target_port.parse::<i64>().is_err() {
        return Err(ProxyError::bad_request(format!(
            "invalid port '{target_port}': must be numeric"
        )));
    }

    Ok(PreviewHost {
        target_port: target_port.to_string(),
        box_id_or_token: box_id_or_token.to_string(),
        base_host: base_host.to_string(),
    })
}

/// Decodes the hex-encoded `d-<hex>` box ID form.
///
/// `Ok(None)` means the value is not in that form and must be treated as a raw
/// box ID or signed token; a value that *is* hex-encoded but decodes to
/// something unusable is an error rather than a fallthrough, so a malformed
/// encoding can never be smuggled through as a literal box ID.
pub fn decode_direct_box_id(value: &str) -> Result<Option<String>> {
    let Some(encoded) = value.strip_prefix(DIRECT_BOX_ID_PREFIX) else {
        return Ok(None);
    };
    let Ok(decoded) = hex::decode(encoded) else {
        return Ok(None);
    };
    if decoded.is_empty() {
        return Err(ProxyError::bad_request(
            "invalid direct preview box ID: empty decoded box ID",
        ));
    }

    let box_id = String::from_utf8(decoded)
        .map_err(|_| ProxyError::bad_request("invalid direct preview box ID"))?;
    if !is_valid_direct_box_id(&box_id) {
        return Err(ProxyError::bad_request("invalid direct preview box ID"));
    }

    Ok(Some(box_id))
}

fn is_valid_direct_box_id(value: &str) -> bool {
    value.len() == DIRECT_BOX_ID_LENGTH && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

/// The port a client reached us on, for `X-Forwarded-Port`.
pub fn forwarded_port_from_host(host: &str, proto: &str) -> String {
    if let Some((_, port)) = split_host_port(host) {
        return port.to_string();
    }
    if proto.eq_ignore_ascii_case("https") {
        return "443".to_string();
    }
    if proto.eq_ignore_ascii_case("http") {
        return "80".to_string();
    }
    String::new()
}

/// Splits `host:port`, tolerating bracketed IPv6 literals. `None` when the
/// authority carries no port.
pub fn split_host_port(authority: &str) -> Option<(&str, &str)> {
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, rest) = rest.split_once(']')?;
        return rest.strip_prefix(':').map(|port| (host, port));
    }
    let (host, port) = authority.rsplit_once(':')?;
    if host.contains(':') {
        return None; // bare IPv6 literal, no port
    }
    Some((host, port))
}

/// Reads one query parameter, decoding it the way a browser encodes one:
/// percent-escapes plus `+` for space.
pub fn query_param(uri: &Uri, name: &str) -> Option<String> {
    uri.query()?.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        if key != name {
            return None;
        }
        percent_encoding::percent_decode_str(&value.replace('+', " "))
            .decode_utf8()
            .ok()
            .map(|decoded| decoded.into_owned())
    })
}

/// Whether `target` is safe to redirect a browser to, given the host it is
/// currently on.
///
/// Safe means: a relative path, the same host, or a subdomain of it — a login
/// started on `3000-box.proxy.test` returns to the base host `proxy.test` and
/// back again. Anything else is a redirect off the proxy entirely, which is how
/// a redirect endpoint becomes a phishing primitive.
pub fn is_same_site(target: &str, host: &str) -> bool {
    // A browser does not read this string the way a URL parser does, and the gap
    // between the two readings is the whole attack. Before deciding anything,
    // reduce the target to what a browser will actually resolve:
    //
    //   * tab, CR and LF are stripped from a URL anywhere they appear, so
    //     `/<TAB>/evil.test` becomes `//evil.test` — protocol-relative, and off
    //     this host. These arrive as literal control characters because the
    //     query parameter carrying the target is percent-decoded before it gets
    //     here.
    //   * for http(s), `\` is treated as `/`, so `/\evil.test` is likewise
    //     protocol-relative.
    let browser_reading: String = target
        .chars()
        .filter(|character| !matches!(character, '\t' | '\r' | '\n'))
        .map(|character| if character == '\\' { '/' } else { character })
        .collect();

    // Anything else in the C0 range has no business in a redirect target.
    if browser_reading
        .chars()
        .any(|character| character.is_control())
    {
        return false;
    }

    if browser_reading.starts_with("//") {
        return false;
    }
    if browser_reading.starts_with('/') {
        return true;
    }

    let Ok(parsed) = browser_reading.parse::<Uri>() else {
        return false;
    };
    let Some(authority) = parsed.authority() else {
        return false;
    };

    let target_host = authority.host();
    let host = host.split(':').next().unwrap_or(host);
    target_host == host || target_host.ends_with(&format!(".{host}"))
}

/// The escaped request path, exactly as the client sent it.
///
/// Percent-escapes must survive untouched: `/files/a%2Fb` addresses one segment
/// containing a slash, not two segments.
pub fn escaped_path(uri: &Uri) -> String {
    let path = uri.path();
    if path.is_empty() {
        return "/".to_string();
    }
    if !path.starts_with('/') {
        return format!("/{path}");
    }
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_port_box_and_base_host() {
        let parsed = parse_host("3999-token.proxy.dev.boxlite.ai").expect("valid host");
        assert_eq!(
            parsed,
            PreviewHost {
                target_port: "3999".into(),
                box_id_or_token: "token".into(),
                base_host: "proxy.dev.boxlite.ai".into(),
            }
        );
    }

    #[test]
    fn rejects_hosts_without_a_numeric_port_prefix() {
        for host in ["", "proxy", "abc-token.proxy.test", "3999token.proxy.test"] {
            assert!(
                parse_host(host).is_err(),
                "expected {host:?} to be rejected"
            );
        }
    }

    #[test]
    fn keeps_the_box_id_when_it_contains_dashes() {
        let parsed = parse_host("3000-some-id-uuid.proxy.test").expect("valid host");
        assert_eq!(parsed.box_id_or_token, "some-id-uuid");
    }

    #[test]
    fn decodes_hex_encoded_direct_box_id() {
        let decoded = decode_direct_box_id("d-35334d4f5a336a70355a7531").expect("decodes");
        assert_eq!(decoded.as_deref(), Some("53MOZ3jp5Zu1"));
    }

    #[test]
    fn rejects_decoded_path_characters() {
        // hex for "53MOZ3jp/../" — a traversal attempt through the box ID.
        assert!(decode_direct_box_id("d-35334d4f5a336a702f2e2e2f").is_err());
    }

    #[test]
    fn rejects_decoded_wrong_length() {
        assert!(decode_direct_box_id("d-35334d4f5a336a70355a75").is_err());
        assert!(decode_direct_box_id("d-35334d4f5a336a70355a7500").is_err());
    }

    #[test]
    fn keeps_raw_values_that_are_not_hex_encoded() {
        assert_eq!(decode_direct_box_id("legacyboxid").expect("ok"), None);
        assert_eq!(decode_direct_box_id("abcdef0123456789").expect("ok"), None);
    }

    #[test]
    fn forwarded_port_prefers_explicit_port_then_scheme_default() {
        let cases = [
            ("3999-token.proxy.dev.boxlite.ai:8443", "https", "8443"),
            ("3999-token.proxy.dev.boxlite.ai", "https", "443"),
            ("3999-token.proxy.dev.boxlite.ai", "http", "80"),
            ("3999-token.proxy.dev.boxlite.ai", "tcp", ""),
        ];
        for (host, proto, want) in cases {
            assert_eq!(
                forwarded_port_from_host(host, proto),
                want,
                "{host} {proto}"
            );
        }
    }

    #[test]
    fn splits_ipv6_authority() {
        assert_eq!(split_host_port("[::1]:443"), Some(("::1", "443")));
        assert_eq!(split_host_port("::1"), None);
        assert_eq!(split_host_port("host"), None);
    }

    #[test]
    fn query_param_decodes_percent_escapes_and_plus() {
        let uri: Uri = "/callback?error_description=user+said+no&next=%2Fapp%3Fa%3D1&other=x"
            .parse()
            .expect("valid uri");

        assert_eq!(
            query_param(&uri, "error_description").as_deref(),
            Some("user said no")
        );
        assert_eq!(query_param(&uri, "next").as_deref(), Some("/app?a=1"));
        assert_eq!(query_param(&uri, "missing"), None);
        assert_eq!(query_param(&"/callback".parse::<Uri>().unwrap(), "x"), None);
    }

    #[test]
    fn same_site_accepts_the_host_and_its_subdomains() {
        assert!(is_same_site("/app", "proxy.test"));
        assert!(is_same_site("https://proxy.test/callback", "proxy.test"));
        assert!(is_same_site(
            "https://3000-box.proxy.test/app",
            "proxy.test"
        ));
        assert!(is_same_site(
            "https://3000-box.proxy.test/app",
            "3000-box.proxy.test:443"
        ));
    }

    #[test]
    fn same_site_rejects_anything_off_the_proxy() {
        assert!(!is_same_site("https://evil.test/phish", "proxy.test"));
        // Suffix that is not a subdomain boundary.
        assert!(!is_same_site("https://notproxy.test/phish", "proxy.test"));
        // Protocol-relative: absolute to a browser, no scheme to a parser.
        assert!(!is_same_site("//evil.test/phish", "proxy.test"));
        assert!(!is_same_site("https://proxy.test.evil.test/", "proxy.test"));
        assert!(!is_same_site("not a url", "proxy.test"));
    }

    /// Each of these reads as a relative path to a naive parser and as an
    /// absolute off-site URL to a browser.
    #[test]
    fn same_site_rejects_targets_a_browser_reads_differently() {
        // http(s) treats a backslash as a slash.
        assert!(!is_same_site("/\\evil.test/phish", "proxy.test"));
        assert!(!is_same_site("\\\\evil.test/phish", "proxy.test"));
        // Tab, CR and LF are stripped from a URL before it is resolved. They
        // arrive literal because the query parameter was percent-decoded.
        assert!(!is_same_site("/\t/evil.test", "proxy.test"));
        assert!(!is_same_site("/\r\n/evil.test", "proxy.test"));
        assert!(!is_same_site("/\\\t\\evil.test", "proxy.test"));
        // A path that merely contains a backslash later on is still relative.
        assert!(is_same_site("/app/a\\b", "proxy.test"));
    }

    #[test]
    fn escaped_path_preserves_encoded_slash() {
        let uri: Uri = "https://3999-token.proxy.test/files/a%2Fb?download=1"
            .parse()
            .expect("valid uri");
        assert_eq!(escaped_path(&uri), "/files/a%2Fb");
    }

    #[test]
    fn escaped_path_defaults_to_root() {
        // Authority-form, as a CONNECT carries: there is no path at all.
        let uri: Uri = "proxy.test:443".parse().expect("valid uri");
        assert_eq!(uri.path(), "", "precondition: authority-form has no path");
        assert_eq!(escaped_path(&uri), "/");
    }
}
