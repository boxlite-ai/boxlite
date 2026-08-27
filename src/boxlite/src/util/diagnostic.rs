//! Splitting a host-side failure into the part a client may see and the part
//! only an operator may see.
//!
//! A box failure has two audiences with opposite needs. An engineer on their
//! own machine wants the console path, the shim stderr, and the exact fix
//! command. An API tenant must see none of it: the paths belong to someone
//! else's host, the commands need a shell they will never have, and the
//! component names describe internals they cannot act on.
//!
//! Both are served by routing, not by dropping: the operator half goes to
//! `tracing::error!`, which reaches the CLI's stderr layer and the runner's
//! `<home>/logs/boxlite.log`. Only the client half becomes a
//! [`BoxliteError`](boxlite_shared::errors::BoxliteError) payload.

/// A host-side failure carrying both of its audiences' messages.
///
/// Construct one wherever a failure is diagnosed, log [`operator`] at the call
/// site, and pass [`into_client`] to the `BoxliteError` variant. Keeping the
/// logging explicit at the call site — rather than hiding it in a method here —
/// is deliberate: the side effect stays visible in the diff.
///
/// [`operator`]: HostDiagnostic::operator
/// [`into_client`]: HostDiagnostic::into_client
#[derive(Debug)]
pub(crate) struct HostDiagnostic {
    /// The only half allowed to cross the API boundary. `pub(crate)` so tests
    /// can assert it is safe without a test-only accessor (which would be dead
    /// code on macOS `--all-targets` builds, where the linux-gated tests that
    /// read it are not compiled).
    pub(crate) client: String,
    operator: String,
}

impl HostDiagnostic {
    /// `client` must survive [`assert_client_safe`]: no host paths, no commands
    /// needing a host shell, no internal component names, no box identifier.
    /// `operator` may carry all of it.
    pub(crate) fn new(client: impl Into<String>, operator: impl Into<String>) -> Self {
        Self {
            client: client.into(),
            operator: operator.into(),
        }
    }

    /// The full diagnostic. Log this; never return it to a caller.
    pub(crate) fn operator(&self) -> &str {
        &self.operator
    }

    /// The only half allowed to cross the API boundary.
    pub(crate) fn into_client(self) -> String {
        self.client
    }
}

/// Tokens that must never appear in a client-facing message.
///
/// Matched case-insensitively as substrings. Grouped by what they leak:
/// host filesystem layout, on-disk artifacts, commands needing a host shell,
/// and internal component names.
#[cfg(test)]
const CLIENT_FORBIDDEN_TOKENS: &[&str] = &[
    // Host filesystem paths
    "/var/",
    "/dev/",
    "/proc/",
    "/sys/",
    "/usr/",
    "/etc/",
    "/tmp/",
    "/home/",
    "/boxes/",
    ".wslconfig",
    // macOS host layout (this crate is a first-class macOS platform too).
    // Only unambiguous home/system dirs — omitted /library/, /volumes/ and
    // /network/, which collide with docker image refs and REST paths.
    "/users/",
    "/applications/",
    "/system/",
    "/private/",
    // On-disk diagnostic artifacts
    ".log",
    "stderr",
    "console output",
    "debug files",
    // Commands that need a shell on the host
    "sudo",
    "dmesg",
    "strace",
    "rust_log",
    "modprobe",
    "lsmod",
    "usermod",
    "sysctl",
    "apparmor_parser",
    "apt install",
    "which boxlite",
    "diagnostic commands",
    // Internal component names
    "shim",
    "krun",
    "gvproxy",
    "bwrap",
    "bubblewrap",
    "apparmor",
    "boxlite-guest",
    "securityoptions",
];

/// Assert that `client` carries nothing only an operator may see.
///
/// This is the regression guard for POL-329: internal VMM diagnostics reaching
/// the public API error body. Every producer of a client-facing failure string
/// drives it, so a new leak of the same shape fails a test instead of shipping.
///
/// `box_id` is the identifier used to build the message under test; a
/// client-facing message must not carry a box identifier at all, since the
/// runtime's own id is not the one the control plane issued.
#[cfg(test)]
pub(crate) fn assert_client_safe(client: &str, box_id: &str) {
    let haystack = client.to_ascii_lowercase();
    for token in CLIENT_FORBIDDEN_TOKENS {
        assert!(
            !haystack.contains(&token.to_ascii_lowercase()),
            "client message leaks operator-only token {token:?}:\n{client}"
        );
    }
    assert!(
        !client.contains(box_id),
        "client message leaks box id {box_id:?}:\n{client}"
    );
}
