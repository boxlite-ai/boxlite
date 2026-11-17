//! Strong If-Match comparison; validate the complete field before accepting it.
use axum::http::{HeaderMap, header::IF_MATCH};
use boxlite::net::OutboundRevision;

pub(super) fn matches(
    headers: &HeaderMap,
    current: &OutboundRevision,
) -> Result<bool, &'static str> {
    let mut value = Vec::new();
    for field in headers.get_all(IF_MATCH) {
        if !value.is_empty() {
            value.push(b',');
        }
        value.extend_from_slice(field.as_bytes());
    }
    compare(&value, current.as_str().as_bytes())
}

fn ows(value: &[u8]) -> &[u8] {
    let start = value
        .iter()
        .position(|c| !matches!(c, b' ' | b'\t'))
        .unwrap_or(value.len());
    &value[start..]
}

fn compare(value: &[u8], current: &[u8]) -> Result<bool, &'static str> {
    const INVALID: &str = "invalid If-Match field";
    let mut rest = ows(value);
    if let Some(tail) = rest.strip_prefix(b"*") {
        return if ows(tail).is_empty() {
            Ok(true)
        } else {
            Err(INVALID)
        };
    }
    let mut matched = false;
    loop {
        let weak = rest.starts_with(b"W/");
        if weak {
            rest = &rest[2..];
        }
        rest = rest.strip_prefix(b"\"").ok_or(INVALID)?;
        let end = rest.iter().position(|c| *c == b'"').ok_or(INVALID)?;
        let tag = &rest[..end];
        if !tag
            .iter()
            .all(|c| *c == 0x21 || (0x23..=0x7e).contains(c) || *c >= 0x80)
        {
            return Err(INVALID);
        }
        matched |= !weak && tag == current;
        rest = ows(&rest[end + 1..]);
        if rest.is_empty() {
            return Ok(matched);
        }
        rest = ows(rest.strip_prefix(b",").ok_or(INVALID)?);
        if rest.is_empty() {
            return Err(INVALID);
        }
    }
}

#[cfg(test)]
#[path = "../tests/outbound_precondition.rs"]
mod tests;
