//! Credential file I/O for `boxlite auth {login,logout,status}`.
//!
//! Stores the `default` profile at `~/.config/boxlite/credentials.toml`
//! (XDG-aware via `$XDG_CONFIG_HOME`). The `[profiles.default]` table is
//! reserved from day one so that adding a `--profile NAME` flag later does
//! not require a file-format migration.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow};
use boxlite::{BoxliteRestOptions, OAuthTokens};
use chrono::{DateTime, Utc};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

/// Credential set for a single profile.
///
/// The two credential paths (`api_key` and `oauth`) are mutually exclusive
/// at the application layer: `login` writes one, `into_rest_options` reads
/// whichever is present (OAuth takes precedence if both somehow appear).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    pub url: String,
    /// Long-lived dashboard-issued API key. Mutually exclusive with `oauth`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub api_key: Option<String>,
    /// OAuth device-flow tokens. Mutually exclusive with `api_key`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub oauth: Option<OAuthCredentials>,
}

/// OAuth tokens persisted to the credentials file. `expires_at` is RFC 3339
/// UTC so it round-trips cleanly through TOML.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OAuthCredentials {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: String,
}

impl OAuthCredentials {
    pub fn from_sdk(tokens: &OAuthTokens) -> Self {
        Self {
            access_token: tokens.access_token.clone(),
            refresh_token: tokens.refresh_token.clone(),
            expires_at: rfc3339_from_system_time(tokens.expires_at),
        }
    }

    pub fn to_sdk(&self) -> OAuthTokens {
        OAuthTokens {
            access_token: self.access_token.clone(),
            refresh_token: self.refresh_token.clone(),
            expires_at: system_time_from_rfc3339(&self.expires_at)
                .unwrap_or_else(|| SystemTime::now() - Duration::from_secs(1)),
        }
    }
}

fn rfc3339_from_system_time(st: SystemTime) -> String {
    let dt: DateTime<Utc> = st.into();
    dt.to_rfc3339()
}

fn system_time_from_rfc3339(s: &str) -> Option<SystemTime> {
    DateTime::parse_from_rfc3339(s).ok().map(|dt| {
        let secs = dt.timestamp();
        if secs >= 0 {
            UNIX_EPOCH + Duration::from_secs(secs as u64)
        } else {
            UNIX_EPOCH - Duration::from_secs((-secs) as u64)
        }
    })
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
/// Resolution order: `$XDG_CONFIG_HOME/boxlite/credentials.toml` →
/// `ProjectDirs::from("", "", "boxlite").config_dir()/credentials.toml`
/// (`~/.config/boxlite/...` on Linux, `~/Library/Application Support/...`
/// on macOS, `%AppData%\...` on Windows). XDG is honored first on all
/// platforms because the docs and CI rely on `$XDG_CONFIG_HOME` as the
/// single override knob.
pub fn path() -> Result<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        let xdg = PathBuf::from(xdg);
        if xdg.is_absolute() {
            return Ok(xdg.join("boxlite").join("credentials.toml"));
        }
    }
    let dirs = ProjectDirs::from("", "", "boxlite")
        .ok_or_else(|| anyhow!("could not determine config directory for boxlite"))?;
    Ok(dirs.config_dir().join("credentials.toml"))
}

/// Load the `default` profile. `Ok(None)` when the file does not exist;
/// parse errors propagate.
///
/// Migration: if the raw TOML contains legacy `client_id` / `client_secret`
/// keys (from the pre-`/v1/me` OAuth2 client_credentials shape), they are
/// dropped silently — the on-disk profile is returned with only `url` +
/// `api_key`. A warning is emitted exactly once per load so the user knows
/// to re-run `boxlite auth login`.
pub fn load() -> Result<Option<Profile>> {
    let file_path = path()?;
    if !file_path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&file_path)
        .with_context(|| format!("reading credentials file {}", file_path.display()))?;
    if raw.contains("client_id") || raw.contains("client_secret") {
        tracing::warn!(
            "Legacy `client_id`/`client_secret` entries in {} are ignored. \
             Re-run `boxlite auth login` to store a dashboard API key.",
            file_path.display()
        );
    }
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

/// Convert a stored `Profile` into `BoxliteRestOptions`. OAuth wins if
/// both fields are set (defense against corrupted on-disk state).
pub fn into_rest_options(profile: Profile) -> BoxliteRestOptions {
    let mut options = BoxliteRestOptions::new(profile.url);
    if let Some(oauth) = profile.oauth {
        options = options.with_oauth_tokens(oauth.to_sdk());
    } else if let Some(key) = profile.api_key {
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
    use boxlite::Credential;
    use std::sync::Mutex;
    use tempfile::TempDir;

    // `std::env::set_var` mutates process-global state. Serializing the
    // tests that touch `$XDG_CONFIG_HOME` keeps them deterministic when
    // run with `--test-threads >= 2`.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// RAII guard restoring `$XDG_CONFIG_HOME` on drop so one test cannot
    /// leak its override into another's view of `path()`.
    struct XdgGuard {
        previous: Option<std::ffi::OsString>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl XdgGuard {
        fn set(dir: &std::path::Path) -> Self {
            let lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            let previous = std::env::var_os("XDG_CONFIG_HOME");
            // SAFETY: tests serialize on ENV_LOCK before mutating env vars.
            unsafe { std::env::set_var("XDG_CONFIG_HOME", dir) };
            Self {
                previous,
                _lock: lock,
            }
        }
    }

    impl Drop for XdgGuard {
        fn drop(&mut self) {
            // SAFETY: still holding ENV_LOCK via `_lock`.
            unsafe {
                match self.previous.take() {
                    Some(value) => std::env::set_var("XDG_CONFIG_HOME", value),
                    None => std::env::remove_var("XDG_CONFIG_HOME"),
                }
            }
        }
    }

    fn sample_api_key_profile() -> Profile {
        Profile {
            url: "https://dev.boxlite.ai/api".to_string(),
            api_key: Some("opaque-key-123".to_string()),
            oauth: None,
        }
    }

    fn sample_oauth_profile() -> Profile {
        Profile {
            url: "https://dev.boxlite.ai/api".to_string(),
            api_key: None,
            oauth: Some(OAuthCredentials {
                access_token: "blo_acc".into(),
                refresh_token: "blr_ref".into(),
                expires_at: "2099-01-01T00:00:00+00:00".into(),
            }),
        }
    }

    #[test]
    fn round_trip_default_profile() {
        let tmp = TempDir::new().unwrap();
        let _guard = XdgGuard::set(tmp.path());

        let profile = sample_api_key_profile();
        save(&profile).expect("save");
        let loaded = load().expect("load").expect("profile present");
        assert_eq!(loaded, profile);
    }

    #[test]
    fn load_missing_returns_none() {
        let tmp = TempDir::new().unwrap();
        let _guard = XdgGuard::set(tmp.path());

        assert!(load().expect("load ok").is_none());
    }

    #[test]
    fn delete_idempotent() {
        let tmp = TempDir::new().unwrap();
        let _guard = XdgGuard::set(tmp.path());

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
        let _guard = XdgGuard::set(tmp.path());

        save(&sample_api_key_profile()).expect("save");
        let file_path = path().expect("path");
        let meta = std::fs::metadata(&file_path).expect("stat");
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "file mode should be 0600, got {:o}", mode);
    }

    #[test]
    fn into_rest_options_uses_api_key() {
        let profile = sample_api_key_profile();
        let options = into_rest_options(profile);
        match options.credential {
            Some(Credential::ApiKey { key }) => assert_eq!(key, "opaque-key-123"),
            other => panic!(
                "expected Credential::ApiKey, got is_some={}",
                other.is_some()
            ),
        }
    }

    #[test]
    fn into_rest_options_no_creds_is_none() {
        let profile = Profile {
            url: "https://dev.boxlite.ai/api".to_string(),
            api_key: None,
            oauth: None,
        };
        let options = into_rest_options(profile);
        assert!(options.credential.is_none());
    }

    #[test]
    fn into_rest_options_oauth_path() {
        use boxlite::Credential;
        let profile = sample_oauth_profile();
        let options = into_rest_options(profile);
        assert!(matches!(options.credential, Some(Credential::OAuth(_))));
    }

    #[test]
    fn oauth_round_trip_through_disk() {
        let tmp = TempDir::new().unwrap();
        let _guard = XdgGuard::set(tmp.path());
        let profile = sample_oauth_profile();
        save(&profile).expect("save");
        let loaded = load().expect("load").expect("profile present");
        assert_eq!(loaded, profile);
    }
}
