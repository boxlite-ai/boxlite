// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! The box terminal, served by the runner's box REST API.
//!
//! A terminal is not a port inside the box — it is `exec` with a TTY, attached
//! over a WebSocket. The browser reaches it through a preview hostname, so the
//! only credential it needs is the one already in that hostname; the proxy adds
//! the runner key on the far side, where headers are free. That is why the
//! browser never has to put a token on a WebSocket handshake, which it cannot
//! do.
//!
//! Only the execution lifecycle is reachable this way. The runner's box API also
//! exposes files, metrics, and network tunnels on the same prefix, and a
//! terminal link must not imply any of them.

/// The hostname label that selects the terminal, in place of a port number.
pub const LABEL: &str = "term";

/// The port the control plane scopes signed terminal tokens under.
///
/// A control-plane detail, not a hostname: `box.service.ts` keys tokens by
/// `${port}:${token}` and mints terminal tokens under this one. The proxy has to
/// ask for the same scope when resolving a `term-` hostname.
pub const TOKEN_SCOPE: &str = "22222";

/// Whether a hostname's leading label asks for the terminal rather than a port
/// inside the box.
pub fn is_terminal_label(label: &str) -> bool {
    label == LABEL
}

/// The suffix of the runner's `/v1/boxes/{id}` API a terminal hostname may
/// reach, or `None` for anything outside the execution lifecycle.
///
/// Whole-path matching rather than prefix matching: `/executions/{id}` may only
/// be followed by a known verb, so no traversal or unexpected sub-resource can
/// ride through, and the returned value is a borrow of the validated input
/// rather than something reassembled.
pub fn allowed_path(path: &str) -> Option<&str> {
    if path == "/exec" {
        return Some(path);
    }

    let rest = path.strip_prefix("/executions/")?;
    let (execution_id, verb) = match rest.split_once('/') {
        Some((id, verb)) => (id, verb),
        None => (rest, ""),
    };

    if !is_execution_id(execution_id) {
        return None;
    }

    // "" is GET status / DELETE kill on the execution itself.
    matches!(verb, "" | "attach" | "resize" | "signal").then_some(path)
}

/// Execution IDs are opaque to the proxy, so this only rejects anything that
/// could change the meaning of the URL it is spliced into.
fn is_execution_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_terminal_label_is_a_terminal() {
        assert!(is_terminal_label(LABEL));
        assert!(
            !is_terminal_label("22222"),
            "22222 is an ordinary guest port again"
        );
        assert!(!is_terminal_label("3000"));
        assert!(!is_terminal_label("terminal"));
        assert!(!is_terminal_label(""));
    }

    #[test]
    fn allows_the_execution_lifecycle() {
        for path in [
            "/exec",
            "/executions/exec-01HJK5",
            "/executions/exec-01HJK5/attach",
            "/executions/exec-01HJK5/resize",
            "/executions/exec-01HJK5/signal",
        ] {
            assert_eq!(allowed_path(path), Some(path), "{path} should be allowed");
        }
    }

    /// The runner exposes these on the same prefix; a terminal link must not
    /// reach them.
    #[test]
    fn refuses_the_rest_of_the_box_api() {
        for path in [
            "/files",
            "/metrics",
            "/network/tunnel",
            "/exec/../files",
            "/executions/exec-1/../../files",
            "/executions/exec-1/attach/extra",
            "/executions/",
            "/executions/exec-1/unknown",
            "/",
            "",
        ] {
            assert_eq!(allowed_path(path), None, "{path} should be refused");
        }
    }

    #[test]
    fn refuses_execution_ids_that_could_rewrite_the_url() {
        for id in ["..", "a/b", "a?b", "a#b", "a%2Fb", ""] {
            let path = format!("/executions/{id}/attach");
            assert_eq!(allowed_path(&path), None, "{path} should be refused");
        }
    }
}
