//! Credential file I/O for `boxlite auth {login,logout,status}`.
//!
//! Stores the `default` profile at `<BOXLITE_HOME>/credentials.toml`
//! (defaults to `~/.boxlite/credentials.toml`, matching the `~/.aws/credentials`
//! / `~/.docker/config.json` / `~/.kube/config` convention used by infra
//! tools). The `[profiles.default]` table is reserved from day one so that
//! adding a `--profile NAME` flag later does not require a file-format
//! migration.

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use boxlite::BoxliteRestOptions;
use serde::{Deserialize, Serialize};

/// Credential set for a single profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    pub url: String,
    /// Long-lived dashboard-issued API key.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub api_key: Option<String>,
}

/// On-disk file shape: `[profiles.<name>]` tables. v1 only reads/writes
/// `default`; the map keeps multi-profile forward compatibility.
#[derive(Debug, Default, Serialize, Deserialize)]
struct CredentialsFile {
    #[serde(default)]
    profiles: std::collections::BTreeMap<String, Profile>,
}

const DEFAULT_PROFILE: &str = "default";

/// Absolute path to the credentials file.
///
/// Resolution order: `$BOXLITE_HOME/credentials.toml` →
/// `~/.boxlite/credentials.toml`. Matches the AWS / Docker / kubectl
/// convention of consolidating per-tool state under a single dotdir, and
/// keeps the credentials co-located with the rest of `$BOXLITE_HOME`
/// (images, runtime state) so `--home PATH` users have one place to look.
pub fn path() -> Result<PathBuf> {
    if let Some(env_home) = std::env::var_os("BOXLITE_HOME") {
        let env_home = PathBuf::from(env_home);
        if env_home.is_absolute() {
            return Ok(env_home.join("credentials.toml"));
        }
    }
    let home =
        dirs::home_dir().ok_or_else(|| anyhow!("could not determine home directory for $HOME"))?;
    Ok(home.join(".boxlite").join("credentials.toml"))
}

/// Load the `default` profile. `Ok(None)` when the file does not exist;
/// parse errors propagate.
pub fn load() -> Result<Option<Profile>> {
    let file_path = path()?;
    if !file_path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&file_path)
        .with_context(|| format!("reading credentials file {}", file_path.display()))?;
    let parsed: CredentialsFile = toml::from_str(&raw)
        .with_context(|| format!("parsing credentials file {}", file_path.display()))?;
    Ok(parsed.profiles.get(DEFAULT_PROFILE).cloned())
}

/// Save `profile` as the `default` profile, replacing any existing one.
/// On Unix, the file is created with mode `0o600` and the parent dir with
/// `0o700`. On non-Unix platforms the file is local-only — no perms set.
pub fn save(profile: &Profile) -> Result<()> {
    let file_path = path()?;
    let parent = file_path
        .parent()
        .ok_or_else(|| anyhow!("credentials path has no parent: {}", file_path.display()))?;
    create_secure_dir(parent)?;

    let mut existing: CredentialsFile = if file_path.exists() {
        let raw = fs::read_to_string(&file_path)
            .with_context(|| format!("reading credentials file {}", file_path.display()))?;
        // Tolerate an empty file but not malformed TOML — corrupt state
        // should surface, not be silently overwritten.
        toml::from_str(&raw)
            .with_context(|| format!("parsing credentials file {}", file_path.display()))?
    } else {
        CredentialsFile::default()
    };
    existing
        .profiles
        .insert(DEFAULT_PROFILE.to_string(), profile.clone());

    let serialized =
        toml::to_string_pretty(&existing).context("serializing credentials to TOML")?;
    write_secure(&file_path, serialized.as_bytes())?;
    Ok(())
}

/// Delete the credentials file. Returns `Ok(true)` if a file was removed,
/// `Ok(false)` if nothing existed; `Err` only for unexpected I/O issues.
pub fn delete() -> Result<bool> {
    let file_path = path()?;
    match fs::remove_file(&file_path) {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => {
            Err(err).with_context(|| format!("removing credentials file {}", file_path.display()))
        }
    }
}

/// Convert a stored `Profile` into `BoxliteRestOptions`.
pub fn into_rest_options(profile: Profile) -> BoxliteRestOptions {
    let mut options = BoxliteRestOptions::new(profile.url);
    if let Some(key) = profile.api_key {
        options = options.with_api_key(key);
    }
    options
}

#[cfg(unix)]
fn create_secure_dir(dir: &std::path::Path) -> Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    if dir.exists() {
        return Ok(());
    }
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .with_context(|| format!("creating directory {}", dir.display()))
}

#[cfg(not(unix))]
fn create_secure_dir(dir: &std::path::Path) -> Result<()> {
    fs::create_dir_all(dir).with_context(|| format!("creating directory {}", dir.display()))
}

#[cfg(unix)]
fn write_secure(path: &std::path::Path, data: &[u8]) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    // Truncate-then-write rather than rename-from-tempfile: the file is
    // user-private and the directory has `0o700`, so a partial write is
    // not externally observable. Keeps the secret material out of a
    // sibling tempfile that might survive a crash.
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("opening credentials file {}", path.display()))?;
    file.write_all(data)
        .with_context(|| format!("writing credentials file {}", path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn write_secure(path: &std::path::Path, data: &[u8]) -> Result<()> {
    fs::write(path, data).with_context(|| format!("writing credentials file {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::defaults::LOCAL_SERVE_URL;
    use std::sync::Mutex;
    use tempfile::TempDir;

    // `std::env::set_var` mutates process-global state. Serializing the
    // tests that touch `$BOXLITE_HOME` keeps them deterministic when run
    // with `--test-threads >= 2`.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// RAII guard restoring `$BOXLITE_HOME` on drop so one test cannot
    /// leak its override into another's view of `path()`.
    struct BoxliteHomeGuard {
        previous: Option<std::ffi::OsString>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl BoxliteHomeGuard {
        fn set(dir: &std::path::Path) -> Self {
            let lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            let previous = std::env::var_os("BOXLITE_HOME");
            // SAFETY: tests serialize on ENV_LOCK before mutating env vars.
            unsafe { std::env::set_var("BOXLITE_HOME", dir) };
            Self {
                previous,
                _lock: lock,
            }
        }
    }

    impl Drop for BoxliteHomeGuard {
        fn drop(&mut self) {
            // SAFETY: still holding ENV_LOCK via `_lock`.
            unsafe {
                match self.previous.take() {
                    Some(value) => std::env::set_var("BOXLITE_HOME", value),
                    None => std::env::remove_var("BOXLITE_HOME"),
                }
            }
        }
    }

    fn sample_api_key_profile() -> Profile {
        Profile {
            url: LOCAL_SERVE_URL.to_string(),
            api_key: Some("opaque-key-123".to_string()),
        }
    }

    #[test]
    fn round_trip_default_profile() {
        let tmp = TempDir::new().unwrap();
        let _guard = BoxliteHomeGuard::set(tmp.path());

        let profile = sample_api_key_profile();
        save(&profile).expect("save");
        let loaded = load().expect("load").expect("profile present");
        assert_eq!(loaded, profile);
    }

    #[test]
    fn load_missing_returns_none() {
        let tmp = TempDir::new().unwrap();
        let _guard = BoxliteHomeGuard::set(tmp.path());

        assert!(load().expect("load ok").is_none());
    }

    #[test]
    fn delete_idempotent() {
        let tmp = TempDir::new().unwrap();
        let _guard = BoxliteHomeGuard::set(tmp.path());

        save(&sample_api_key_profile()).expect("save");
        assert!(delete().expect("first delete"), "first call removed file");
        assert!(
            !delete().expect("second delete"),
            "second call reports nothing to delete"
        );
    }

    #[cfg(unix)]
    #[test]
    fn save_sets_0600_perms() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let _guard = BoxliteHomeGuard::set(tmp.path());

        save(&sample_api_key_profile()).expect("save");
        let file_path = path().expect("path");
        let meta = std::fs::metadata(&file_path).expect("stat");
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "file mode should be 0600, got {:o}", mode);
    }

    #[tokio::test]
    async fn into_rest_options_uses_api_key() {
        let profile = sample_api_key_profile();
        let options = into_rest_options(profile);
        let cred = options.credential.expect("credential set");
        let tok = cred.get_token().await.expect("get_token");
        assert_eq!(tok.token, "opaque-key-123");
        assert!(tok.expires_at.is_none(), "API keys must not carry expiry");
    }

    #[test]
    fn into_rest_options_no_creds_is_none() {
        let profile = Profile {
            url: LOCAL_SERVE_URL.to_string(),
            api_key: None,
        };
        let options = into_rest_options(profile);
        assert!(options.credential.is_none());
    }
}
