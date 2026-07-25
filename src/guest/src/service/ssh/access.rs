//! In-memory SSH access snapshot and public-key authentication.
//!
//! Phase 1 only needs an injectable snapshot -- Phase 2 adds the typed
//! `Ssh.ReplaceAccessSet` RPC that calls [`AccessState::replace`] from the
//! host side. The snapshot itself, and the full-replace/generation rules,
//! are already the real production contract so nothing here needs to change
//! when that RPC lands.

use russh::keys::{Algorithm, HashAlg, PublicKey};
use std::sync::{Arc, RwLock};
use std::time::SystemTime;

/// Only `root` may authenticate over SSH in this design.
pub(crate) const SSH_UNIX_USER: &str = "root";

/// Upper bound on an accepted OpenSSH public-key line, so a client can't
/// hand the guest an unbounded string before authentication even starts.
///
/// Phase 1 has no external caller for this yet (only tests inject
/// snapshots directly) -- Phase 2's `Ssh.ReplaceAccessSet` RPC handler is
/// the first non-test caller, at which point `#[allow(dead_code)]` below
/// comes off.
#[allow(dead_code)]
const MAX_PUBLIC_KEY_LINE_BYTES: usize = 8192;

/// One box-scoped temporary SSH credential, as synced from the authoritative
/// Hosted API snapshot (see design doc section 6.2, `TemporarySshCredential`).
#[derive(Clone, Debug)]
pub(crate) struct AccessEntry {
    pub credential_id: String,
    pub grant_id: String,
    pub fingerprint: String,
    pub public_key: PublicKey,
    pub unix_user: String,
    pub expires_at: SystemTime,
}

impl PartialEq for AccessEntry {
    fn eq(&self, other: &Self) -> bool {
        self.credential_id == other.credential_id
            && self.grant_id == other.grant_id
            && self.fingerprint == other.fingerprint
            && self.public_key.key_data() == other.public_key.key_data()
            && self.unix_user == other.unix_user
            && self.expires_at == other.expires_at
    }
}

/// An immutable, versioned access snapshot. `ReplaceAccessSet` swaps this
/// wholesale -- there is no incremental mutation.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct AccessSnapshot {
    pub generation: u64,
    pub entries: Vec<AccessEntry>,
}

#[derive(Debug)]
#[allow(dead_code)] // constructed by AccessState::replace, see its own allow(dead_code) note
pub(crate) enum ReplaceError {
    /// `generation` is older than the currently applied one.
    StaleGeneration { current: u64, attempted: u64 },
    /// `generation` matches the current one but the content differs -- only
    /// a byte-identical retry of the same generation is idempotent.
    ConflictingGeneration { generation: u64 },
}

impl std::fmt::Display for ReplaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReplaceError::StaleGeneration { current, attempted } => write!(
                f,
                "stale generation: attempted {attempted}, current {current}"
            ),
            ReplaceError::ConflictingGeneration { generation } => {
                write!(
                    f,
                    "generation {generation} already applied with different content"
                )
            }
        }
    }
}

impl std::error::Error for ReplaceError {}

/// Shared, swappable access snapshot consulted by every authentication
/// attempt. Reads never hold the lock across `.await` -- `current()` clones
/// the `Arc` and releases the lock immediately.
pub(crate) struct AccessState {
    snapshot: RwLock<Arc<AccessSnapshot>>,
}

impl AccessState {
    pub(crate) fn new() -> Self {
        Self {
            snapshot: RwLock::new(Arc::new(AccessSnapshot::default())),
        }
    }

    pub(crate) fn current(&self) -> Arc<AccessSnapshot> {
        self.snapshot
            .read()
            .expect("access snapshot lock poisoned")
            .clone()
    }

    /// Full-set replace. Accepts a strictly newer generation, or the same
    /// generation with byte-identical content (idempotent retry); rejects
    /// anything older or conflicting.
    ///
    /// Phase 1's only caller is tests (an injectable snapshot, per the
    /// design's Phase 1 scope) -- Phase 2's `Ssh.ReplaceAccessSet` RPC
    /// handler is the production caller.
    #[allow(dead_code)]
    pub(crate) fn replace(&self, new: AccessSnapshot) -> Result<(), ReplaceError> {
        let current = self.current();
        if new.generation < current.generation {
            return Err(ReplaceError::StaleGeneration {
                current: current.generation,
                attempted: new.generation,
            });
        }
        if new.generation == current.generation {
            if *current == new {
                return Ok(());
            }
            return Err(ReplaceError::ConflictingGeneration {
                generation: new.generation,
            });
        }
        *self
            .snapshot
            .write()
            .expect("access snapshot lock poisoned") = Arc::new(new);
        Ok(())
    }

    /// True iff `user`/`key` match an active, unexpired entry as of `now`.
    /// Never leaks which part failed (wrong user vs. wrong/expired key) --
    /// callers must treat every rejection identically.
    pub(crate) fn authenticate(&self, user: &str, key: &PublicKey, now: SystemTime) -> bool {
        if user != SSH_UNIX_USER {
            return false;
        }
        let snapshot = self.current();
        snapshot.entries.iter().any(|entry| {
            entry.unix_user == user
                && entry.expires_at > now
                && entry.public_key.key_data() == key.key_data()
        })
    }
}

impl Default for AccessState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug)]
#[allow(dead_code)] // returned by parse_authorized_public_key, see its own allow(dead_code) note
pub(crate) enum KeyParseError {
    TooLarge,
    Malformed(String),
    UnsupportedAlgorithm(String),
}

impl std::fmt::Display for KeyParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyParseError::TooLarge => write!(f, "public key exceeds size limit"),
            KeyParseError::Malformed(e) => write!(f, "malformed public key: {e}"),
            KeyParseError::UnsupportedAlgorithm(a) => write!(f, "unsupported key algorithm: {a}"),
        }
    }
}

impl std::error::Error for KeyParseError {}

/// True for the algorithms this design accepts: Ed25519, and RSA signed with
/// RSA-SHA2 (SHA-256/512). Rejects DSA, ECDSA, legacy SHA-1 `ssh-rsa`,
/// FIDO/U2F keys, and anything unrecognized.
pub(crate) fn is_supported_algorithm(algorithm: &Algorithm) -> bool {
    matches!(
        algorithm,
        Algorithm::Ed25519
            | Algorithm::Rsa {
                hash: Some(HashAlg::Sha256) | Some(HashAlg::Sha512)
            }
    )
}

/// Parse and validate a canonical OpenSSH public-key line (e.g.
/// `"ssh-ed25519 AAAA... comment"`), rejecting oversized input and
/// unsupported algorithms up front. This is the single parser both the
/// Phase 1 test/injection path and the future `ReplaceAccessSet` RPC use.
#[allow(dead_code)]
pub(crate) fn parse_authorized_public_key(line: &str) -> Result<PublicKey, KeyParseError> {
    if line.len() > MAX_PUBLIC_KEY_LINE_BYTES {
        return Err(KeyParseError::TooLarge);
    }
    let key = PublicKey::from_openssh(line).map_err(|e| KeyParseError::Malformed(e.to_string()))?;
    if !is_supported_algorithm(&key.algorithm()) {
        return Err(KeyParseError::UnsupportedAlgorithm(
            key.algorithm().to_string(),
        ));
    }
    Ok(key)
}

/// SHA-256 fingerprint string (`SHA256:...`) for logs/UI -- never the key body.
pub(crate) fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use russh::keys::PrivateKey;

    pub(crate) fn generate_ed25519() -> PrivateKey {
        PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()
    }

    pub(crate) fn entry_for(
        private: &PrivateKey,
        credential_id: &str,
        expires_at: SystemTime,
    ) -> AccessEntry {
        let public_key = private.public_key().clone();
        AccessEntry {
            credential_id: credential_id.to_string(),
            grant_id: format!("grant-{credential_id}"),
            fingerprint: fingerprint(&public_key),
            public_key,
            unix_user: SSH_UNIX_USER.to_string(),
            expires_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use std::time::Duration;

    fn future(secs: u64) -> SystemTime {
        SystemTime::now() + Duration::from_secs(secs)
    }

    fn past(secs: u64) -> SystemTime {
        SystemTime::now() - Duration::from_secs(secs)
    }

    #[test]
    fn rejects_all_auth_until_a_snapshot_is_applied() {
        let state = AccessState::new();
        let key = generate_ed25519();
        assert!(!state.authenticate(SSH_UNIX_USER, key.public_key(), SystemTime::now()));
    }

    #[test]
    fn accepts_matching_active_unexpired_entry() {
        let state = AccessState::new();
        let key = generate_ed25519();
        let entry = entry_for(&key, "cred-1", future(300));
        state
            .replace(AccessSnapshot {
                generation: 1,
                entries: vec![entry],
            })
            .unwrap();

        assert!(state.authenticate(SSH_UNIX_USER, key.public_key(), SystemTime::now()));
    }

    #[test]
    fn rejects_wrong_key() {
        let state = AccessState::new();
        let key = generate_ed25519();
        let other = generate_ed25519();
        let entry = entry_for(&key, "cred-1", future(300));
        state
            .replace(AccessSnapshot {
                generation: 1,
                entries: vec![entry],
            })
            .unwrap();

        assert!(!state.authenticate(SSH_UNIX_USER, other.public_key(), SystemTime::now()));
    }

    #[test]
    fn rejects_wrong_user() {
        let state = AccessState::new();
        let key = generate_ed25519();
        let entry = entry_for(&key, "cred-1", future(300));
        state
            .replace(AccessSnapshot {
                generation: 1,
                entries: vec![entry],
            })
            .unwrap();

        assert!(!state.authenticate("guest", key.public_key(), SystemTime::now()));
    }

    #[test]
    fn rejects_expired_entry_even_if_control_plane_never_revoked_it() {
        let state = AccessState::new();
        let key = generate_ed25519();
        let entry = entry_for(&key, "cred-1", past(1));
        state
            .replace(AccessSnapshot {
                generation: 1,
                entries: vec![entry],
            })
            .unwrap();

        assert!(!state.authenticate(SSH_UNIX_USER, key.public_key(), SystemTime::now()));
    }

    #[test]
    fn revoke_via_replace_rejects_new_auth_immediately() {
        let state = AccessState::new();
        let key = generate_ed25519();
        let entry = entry_for(&key, "cred-1", future(300));
        state
            .replace(AccessSnapshot {
                generation: 1,
                entries: vec![entry],
            })
            .unwrap();
        assert!(state.authenticate(SSH_UNIX_USER, key.public_key(), SystemTime::now()));

        state
            .replace(AccessSnapshot {
                generation: 2,
                entries: vec![],
            })
            .unwrap();
        assert!(!state.authenticate(SSH_UNIX_USER, key.public_key(), SystemTime::now()));
    }

    #[test]
    fn rejects_stale_generation() {
        let state = AccessState::new();
        state
            .replace(AccessSnapshot {
                generation: 5,
                entries: vec![],
            })
            .unwrap();

        let err = state
            .replace(AccessSnapshot {
                generation: 3,
                entries: vec![],
            })
            .unwrap_err();
        assert!(matches!(
            err,
            ReplaceError::StaleGeneration {
                current: 5,
                attempted: 3
            }
        ));
    }

    #[test]
    fn same_generation_identical_content_is_idempotent() {
        let state = AccessState::new();
        let key = generate_ed25519();
        let entry = entry_for(&key, "cred-1", future(300));
        let snapshot = AccessSnapshot {
            generation: 1,
            entries: vec![entry],
        };

        state.replace(snapshot.clone()).unwrap();
        state.replace(snapshot).unwrap();
        assert_eq!(state.current().generation, 1);
    }

    #[test]
    fn same_generation_different_content_is_rejected() {
        let state = AccessState::new();
        let key = generate_ed25519();
        state
            .replace(AccessSnapshot {
                generation: 1,
                entries: vec![entry_for(&key, "cred-1", future(300))],
            })
            .unwrap();

        let err = state
            .replace(AccessSnapshot {
                generation: 1,
                entries: vec![entry_for(&key, "cred-2", future(300))],
            })
            .unwrap_err();
        assert!(matches!(
            err,
            ReplaceError::ConflictingGeneration { generation: 1 }
        ));
    }

    #[test]
    fn parses_ed25519_key() {
        let key = generate_ed25519();
        let line = key.public_key().to_openssh().unwrap();
        let parsed = parse_authorized_public_key(&line).unwrap();
        assert_eq!(parsed.key_data(), key.public_key().key_data());
    }

    #[test]
    fn rejects_dsa_key() {
        // A well-formed but unsupported-algorithm key: DSA.
        let dsa_line = "ssh-dss AAAAB3NzaC1kc3MAAACBAIC+FhOEzTuEmm3QDsyfWpaJ+ntTKZ9uKiZ7z9GeD8V0kh9d8ZgVAWWKTOJUxRnZjqzSqQEt2fjO9ByS/GcRDdmnWkbdEvhpvVJTHy+1z+p9EGgVbtjLIfXQmz9hK6t0GK1M3zBnMhUiWa/oT4tRAAAAFQCyG0lSNVEmZOxTsG21A8fbNRD0iQAAAIB2qWs+3TE2s0uK9WhvOMFMuUdvzu2fH7lLA1kZQnA8sSTdCn8KVSPYE9+GYy8XiUvKf+7XlCFkNSlZuJlKPZmdEt1e9DK+16WGxTPRXcO7C3M9zHc+ZI73pM2/9y+eQnQagIyEQnkFjK6fq3Uj/6bfnJmt2xJk5vvkFLM5nSMwGwAAAIEAo4TmqEXV49BvSpvhk3+4S6l6dS6VtOnbXCcVwLNwLM8oaZQNQ/8Q6MzWSyVOwXZfAdgB3UzFa60o2VZuP4/BdgKQGuUipHwjZKZ33FzOkxg8hy/4OSrmwLnP3Kwd7kOSw3+9x1PpV6+xNo3vv4Y19hzGqU1lKZmVKjjV2FCz8b0= comment";
        let err = parse_authorized_public_key(dsa_line);
        assert!(err.is_err());
    }

    #[test]
    fn rejects_malformed_key() {
        let err = parse_authorized_public_key("not-a-key at all").unwrap_err();
        assert!(matches!(err, KeyParseError::Malformed(_)));
    }

    #[test]
    fn rejects_oversized_key_line() {
        let huge = format!("ssh-ed25519 {}", "A".repeat(MAX_PUBLIC_KEY_LINE_BYTES + 1));
        let err = parse_authorized_public_key(&huge).unwrap_err();
        assert!(matches!(err, KeyParseError::TooLarge));
    }

    #[test]
    fn fingerprint_is_stable_for_same_key() {
        let key = generate_ed25519();
        assert_eq!(fingerprint(key.public_key()), fingerprint(key.public_key()));
    }
}
