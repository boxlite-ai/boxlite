//! Guest agent arguments as every engine passes them: the host hands the agent
//! Unix socket URIs, and the engine bridges them to the guest's vsock ports.

use crate::runtime::constants::network;
use boxlite_shared::BoxTransport;

/// Rewrites `--listen unix://…` and `--notify unix://…` to the guest's vsock
/// ports; other arguments pass through unchanged.
pub(crate) fn transform_guest_args(mut guest_args: Vec<String>) -> Vec<String> {
    transform_arg_unix_to_vsock(&mut guest_args, "listen", network::GUEST_AGENT_PORT);
    transform_arg_unix_to_vsock(&mut guest_args, "notify", network::GUEST_READY_PORT);
    guest_args
}

/// Transform Unix socket URIs to vsock URIs in a shell command string.
///
/// Replaces `--{arg_name} unix://...` with `--{arg_name} vsock://PORT`
fn transform_shell_arg_unix_to_vsock(input: &str, arg_name: &str, vsock_port: u32) -> String {
    let vsock_uri = BoxTransport::vsock(vsock_port).to_uri();
    let pattern = format!("--{} unix://", arg_name);

    let mut result = String::new();
    let mut chars = input.chars().peekable();
    let mut pos = 0;

    while let Some(c) = chars.next() {
        // Check if we're at the start of the pattern
        if c == '-' && input[pos..].starts_with(&pattern) {
            // Copy "--{arg_name} "
            result.push_str(&format!("--{} ", arg_name));

            // Skip past the pattern
            let skip_len = pattern.len() - 1; // -1 because we already consumed '-'
            for _ in 0..skip_len {
                chars.next();
            }
            pos += pattern.len();

            // Skip the rest of the unix path until whitespace
            while let Some(&next) = chars.peek() {
                if next.is_whitespace() {
                    break;
                }
                chars.next();
                pos += 1;
            }

            // Add the vsock URI
            result.push_str(&vsock_uri);
        } else {
            result.push(c);
            pos += c.len_utf8();
        }
    }

    result
}

/// Transform a single Unix socket argument to vsock.
///
/// Handles two cases:
/// 1. Separate arguments: ["--{arg_name}", "unix://..."]
/// 2. Shell command string: ["-c", "... --{arg_name} unix://... "]
fn transform_arg_unix_to_vsock(guest_args: &mut [String], arg_name: &str, vsock_port: u32) {
    let vsock_uri = BoxTransport::vsock(vsock_port).to_uri();
    let pattern = format!("--{} unix://", arg_name);

    for i in 0..guest_args.len() {
        // Case 1: Separate arguments ["--{arg_name}", "unix://..."]
        if guest_args[i] == format!("--{}", arg_name)
            && i + 1 < guest_args.len()
            && guest_args[i + 1].starts_with("unix://")
        {
            tracing::debug!(
                arg = arg_name,
                original = %guest_args[i + 1],
                transformed = %vsock_uri,
                "Transforming Unix socket to vsock URI"
            );
            guest_args[i + 1] = vsock_uri;
            return;
        }

        // Case 2: Shell command string (e.g., -c "... --{arg_name} unix://... ")
        if guest_args[i].contains(&pattern) {
            let transformed =
                transform_shell_arg_unix_to_vsock(&guest_args[i], arg_name, vsock_port);
            tracing::debug!(
                arg = arg_name,
                original = %guest_args[i],
                transformed = %transformed,
                "Transforming shell command string"
            );
            guest_args[i] = transformed;
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn separate_arguments_are_rewritten_to_vsock() {
        let rewritten = transform_guest_args(args(&[
            "--listen",
            "unix:///tmp/bl/box.sock",
            "--notify",
            "unix:///tmp/bl/ready.sock",
        ]));
        assert_eq!(
            rewritten,
            args(&["--listen", "vsock://2695", "--notify", "vsock://2696"])
        );
    }

    #[test]
    fn shell_command_strings_are_rewritten_in_place() {
        let rewritten = transform_guest_args(args(&[
            "-c",
            "exec agent --listen unix:///tmp/a.sock --notify unix:///tmp/b.sock --tty",
        ]));
        assert_eq!(
            rewritten[1],
            "exec agent --listen vsock://2695 --notify vsock://2696 --tty"
        );
    }

    #[test]
    fn unrelated_arguments_pass_through() {
        let original = args(&["--listen", "tcp://127.0.0.1:8080", "--verbose"]);
        assert_eq!(transform_guest_args(original.clone()), original);
    }
}
