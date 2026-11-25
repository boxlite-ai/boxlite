//! The Rust request boundary for the shared outbound rule grammar.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

pub(super) const MAX_RULES: usize = 64;
pub(super) const LEGACY_RULES: usize = 10;

pub(super) struct Rule {
    pub canonical: String,
    pub native_ipv6: bool,
    pub has_port: bool,
}

pub(crate) fn outbound_rule_has_port(rule: &str) -> bool {
    parse(rule).is_ok_and(|rule| rule.has_port)
}

fn invalid(rule: &str) -> BoxliteError {
    BoxliteError::InvalidArgument(format!("invalid outbound rule {rule:?}"))
}

pub(super) fn parse(rule: &str) -> BoxliteResult<Rule> {
    let text = rule.trim();
    if let Some((canonical, native_ipv6)) = address(text) {
        return Ok(Rule {
            canonical,
            native_ipv6,
            has_port: false,
        });
    }

    let (host, port, bracketed) = match text.strip_prefix('[') {
        Some(inner) => {
            let (host, suffix) = inner.split_once("]:").ok_or_else(|| invalid(rule))?;
            if !host.contains(':') {
                return Err(invalid(rule));
            }
            (
                host,
                Some(parse_port(suffix).ok_or_else(|| invalid(rule))?),
                true,
            )
        }
        None => match text.split_once(':') {
            Some((host, suffix)) => (
                host,
                Some(parse_port(suffix).ok_or_else(|| invalid(rule))?),
                false,
            ),
            None => (text, None, false),
        },
    };
    let (canonical, native_ipv6) = if let Some(address) = address(host) {
        address
    } else if !bracketed && is_hostname(host) {
        (host.to_ascii_lowercase(), false)
    } else {
        return Err(invalid(rule));
    };
    let canonical = match port {
        Some(port) if native_ipv6 => format!("[{canonical}]:{port}"),
        Some(port) => format!("{canonical}:{port}"),
        None => canonical,
    };
    Ok(Rule {
        canonical,
        native_ipv6,
        has_port: port.is_some(),
    })
}

fn parse_port(text: &str) -> Option<u16> {
    text.bytes()
        .all(|byte| byte.is_ascii_digit())
        .then_some(())?;
    text.parse().ok().filter(|port| *port > 0)
}

fn address(text: &str) -> Option<(String, bool)> {
    let (ip, prefix) = if let Some((ip, prefix)) = text.split_once('/') {
        if (prefix.len() > 1 && prefix.starts_with('0'))
            || !prefix.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        (ip, Some(prefix.parse::<u8>().ok()?))
    } else {
        (text, None)
    };
    match ip.parse::<IpAddr>().ok()? {
        IpAddr::V4(ip) => ipv4(ip, prefix),
        IpAddr::V6(ip) => match ip.to_ipv4_mapped() {
            Some(mapped) => match prefix {
                Some(prefix) => ipv4(mapped, Some(prefix.checked_sub(96)?)),
                None => ipv4(mapped, None),
            },
            None if prefix.is_none() => Some((ip.to_string(), true)),
            None => {
                let bits = prefix.filter(|bits| *bits <= 128)?;
                let mask = u128::MAX.checked_shl(u32::from(128 - bits)).unwrap_or(0);
                Some((
                    format!("{}/{bits}", Ipv6Addr::from_bits(ip.to_bits() & mask)),
                    true,
                ))
            }
        },
    }
}

fn ipv4(ip: Ipv4Addr, prefix: Option<u8>) -> Option<(String, bool)> {
    let Some(bits) = prefix else {
        return Some((ip.to_string(), false));
    };
    if bits > 32 {
        return None;
    }
    let mask = u32::MAX.checked_shl(u32::from(32 - bits)).unwrap_or(0);
    Some((
        format!("{}/{bits}", Ipv4Addr::from_bits(ip.to_bits() & mask)),
        false,
    ))
}

fn is_hostname(text: &str) -> bool {
    let host = text.strip_prefix("*.").unwrap_or(text);
    host.len() <= 253
        && !(host.split('.').count() == 4 && host.bytes().all(|c| c == b'.' || c.is_ascii_digit()))
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
}

#[cfg(test)]
#[path = "tests/outbound_rules.rs"]
mod tests;
