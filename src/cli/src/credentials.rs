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
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};

/// How the credentials in this profile were obtained. Drives which token
/// field `into_rest_options` reads and how `auth status` reports the source.
///
/// Older `credentials.toml` files written before OIDC support did not include
/// this field; the `Default` impl maps them to `ApiKey`, which is the only
/// auth method the legacy schema could represent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethod {
    #[default]
    ApiKey,
    Oidc,
}

/// `secrecy::SecretString` deliberately does NOT implement `Serialize` —
/// secrets must not be serialized by accident. The credentials file is the
/// one place that legitimately needs to write them to disk, so we opt in
/// explicitly via `#[serde(with = "secret_string_opt")]` on each field.
mod secret_string_opt {
    use secrecy::{ExposeSecret, SecretString};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(
        secret: &Option<SecretString>,
        ser: S,
    ) -> Result<S::Ok, S::Error> {
        match secret {
            // skip_serializing_if = Option::is_none means we never hit None here,
            // but handle it defensively to keep the function total.
            Some(s) => ser.serialize_some(s.expose_secret()),
            None => ser.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(de: D) -> Result<Option<SecretString>, D::Error> {
        let opt = Option::<String>::deserialize(de)?;
        Ok(opt.map(SecretString::from))
    }
}

/// Credential set for a single profile.
///
/// Schema is additive: every new field is optional with a `serde(default)`,
/// so a `credentials.toml` written by an older boxlite (just `url` + `api_key`)
/// keeps loading. Secret-bearing fields use `secrecy::SecretString` — `Debug`
/// auto-redacts, so `tracing::debug!(?profile)` is safe by construction.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Profile {
    pub url: String,
    /// Long-lived dashboard-issued API key.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "secret_string_opt"
    )]
    pub api_key: Option<SecretString>,

    // ---- OIDC fields (populated only when `auth_method == Oidc`) ----
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "secret_string_opt"
    )]
    pub access_token: Option<SecretString>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "secret_string_opt"
    )]
    pub refresh_token: Option<SecretString>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "secret_string_opt"
    )]
    pub id_token: Option<SecretString>,
    /// Absolute moment the access_token stops being accepted.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub oidc_issuer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub client_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub audience: Option<String>,

    /// Discriminator the loader stamps so downstream code does not have to
    /// guess from `Option` shape. Defaulted to `ApiKey` so legacy files
    /// (which have no `auth_method` key) load with the only behavior they
    /// could ever have meant.
    #[serde(default)]
    pub auth_method: AuthMethod,

    /// Routing-slot value captured from `Principal.path_prefix` at
    /// login. Opaque — the server decides what goes here (org id,
    /// workspace, catalog, …). `None` means the deployment doesn't
    /// use a routing slot (e.g. `boxlite serve`); URL builder skips
    /// the segment in that case (`/v1/boxes/…`).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub path_prefix: Option<String>,
}

/// On-disk file shape: `[profiles.<name>]` tables. v1 only reads/writes
/// `default`; the map keeps multi-profile forward compatibility.
#[derive(Debug, Default, Serialize, Deserialize)]
struct CredentialsFile {
    #[serde(default)]
    profiles: std::collections::BTreeMap<String, Profile>,
}

/// Name used when `--profile` / `BOXLITE_PROFILE` are unset. Public so the
/// CLI flag layer at `GlobalFlags::resolved_profile` can avoid duplicating
/// the string.
pub const DEFAULT_PROFILE: &str = "default";

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

/// Load the named profile from the credentials file. `Ok(None)` when either
/// the file is absent or the requested profile is not in it; parse errors
/// propagate so a corrupted file surfaces instead of being silently treated
/// as "no credentials".
pub fn load_named(name: &str) -> Result<Option<Profile>> {
    let file_path = path()?;
    if !file_path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&file_path)
        .with_context(|| format!("reading credentials file {}", file_path.display()))?;
    let parsed: CredentialsFile = toml::from_str(&raw)
        .with_context(|| format!("parsing credentials file {}", file_path.display()))?;
    Ok(parsed.profiles.get(name).cloned())
}

/// Save `profile` under `name`, replacing any existing profile with that
/// name and preserving every other profile in the file. On Unix, the file
/// is created with mode `0o600` and the parent dir with `0o700`. On
/// non-Unix platforms the file is local-only — no perms set.
pub fn save_named(name: &str, profile: &Profile) -> Result<()> {
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
    existing.profiles.insert(name.to_string(), profile.clone());

    let serialized =
        toml::to_string_pretty(&existing).context("serializing credentials to TOML")?;
    write_secure(&file_path, serialized.as_bytes())?;
    Ok(())
}

/// Remove the named profile from the credentials file, leaving the rest
/// intact. Returns `Ok(true)` if the profile existed and was removed,
/// `Ok(false)` if either the file or the profile was absent. If removing
/// the last profile leaves the file empty, the file itself is deleted so
/// `auth status` reports "Not logged in" instead of finding an empty stub.
pub fn delete_named(name: &str) -> Result<bool> {
    let file_path = path()?;
    if !file_path.exists() {
        return Ok(false);
    }
    let raw = fs::read_to_string(&file_path)
        .with_context(|| format!("reading credentials file {}", file_path.display()))?;
    let mut parsed: CredentialsFile = toml::from_str(&raw)
        .with_context(|| format!("parsing credentials file {}", file_path.display()))?;
    if parsed.profiles.remove(name).is_none() {
        return Ok(false);
    }
    if parsed.profiles.is_empty() {
        // No profiles left — collapse the file so the absence is visible to
        // `path().exists()` and to humans `ls`-ing the dotdir.
        fs::remove_file(&file_path)
            .with_context(|| format!("removing empty credentials file {}", file_path.display()))?;
        return Ok(true);
    }
    let serialized = toml::to_string_pretty(&parsed).context("serializing credentials to TOML")?;
    write_secure(&file_path, serialized.as_bytes())?;
    Ok(true)
}

/// Load `name`, refresh its OIDC tokens if they're within five minutes of
/// expiry, persist any refreshed material, and return the
/// `BoxliteRestOptions` to use for an authenticated REST call.
///
/// This is the chokepoint every authenticated command flows through —
/// keep the network round-trip + on-disk update in one place so callers
/// never see a fresh-from-disk Profile that is already stale.
///
/// `Ok(None)` means "no profile by that name" (use the unauthenticated
/// runtime / env vars instead). `Err` is reserved for actual problems
/// (corrupt file, broken IdP) that should surface to the user.
pub async fn load_active(name: &str, http: &reqwest::Client) -> Result<Option<BoxliteRestOptions>> {
    let Some(mut profile) = load_named(name)? else {
        return Ok(None);
    };
    if crate::commands::auth::oidc::refresh::refresh_needed(&profile) {
        crate::commands::auth::oidc::refresh::refresh(&mut profile, http).await?;
        save_named(name, &profile)?;
    }
    Ok(Some(into_rest_options(profile)))
}

/// Convert a stored `Profile` into `BoxliteRestOptions`.
///
/// The bearer slot is filled from a single source per profile, picked by
/// `auth_method`:
///  - `ApiKey` → `api_key`
///  - `Oidc`   → `access_token`
///
/// `expose_secret()` is called exactly here (the boundary where the value
/// has to leave the `SecretString` wrapper to become an HTTP header). The
/// resulting `BoxliteRestOptions` ends up storing the raw `String` because
/// `with_api_key` takes `impl Into<String>` — that is unavoidable until the
/// REST options type itself adopts `SecretString`. Tracking it here keeps
/// the leak surface to one line.
pub fn into_rest_options(profile: Profile) -> BoxliteRestOptions {
    let mut options = BoxliteRestOptions::new(profile.url);
    let bearer = match profile.auth_method {
        AuthMethod::ApiKey => profile.api_key.as_ref(),
        AuthMethod::Oidc => profile.access_token.as_ref(),
    };
    if let Some(secret) = bearer {
        options = options.with_api_key(secret.expose_secret().to_string());
    }
    if let Some(path_prefix) = profile.path_prefix {
        options = options.with_path_prefix(path_prefix);
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
            api_key: Some(SecretString::from("opaque-key-123".to_string())),
            ..Profile::default()
        }
    }

    fn sample_oidc_profile() -> Profile {
        Profile {
            url: "https://api.boxlite.ai/api".to_string(),
            access_token: Some(SecretString::from("at-abc".to_string())),
            refresh_token: Some(SecretString::from("rt-xyz".to_string())),
            id_token: Some(SecretString::from("eyJhbGciOi...".to_string())),
            expires_at: Some(
                chrono::DateTime::<chrono::Utc>::from_timestamp(1_800_000_000, 0).unwrap(),
            ),
            oidc_issuer: Some("https://dex.boxlite.ai/dex".to_string()),
            client_id: Some("boxlite".to_string()),
            audience: Some("boxlite-api".to_string()),
            auth_method: AuthMethod::Oidc,
            api_key: None,
            path_prefix: Some("acme".to_string()),
        }
    }

    /// `SecretString` intentionally does not implement `PartialEq` (to keep
    /// secrets from leaking through `assert_eq!` diffs). Compare field-by-field
    /// via `expose_secret()`, which is the only place outside `into_rest_options`
    /// that touches the inner value.
    fn assert_profiles_equal(actual: &Profile, expected: &Profile) {
        assert_eq!(actual.url, expected.url, "url");
        assert_eq!(
            actual.api_key.as_ref().map(|s| s.expose_secret()),
            expected.api_key.as_ref().map(|s| s.expose_secret()),
            "api_key"
        );
        assert_eq!(
            actual.access_token.as_ref().map(|s| s.expose_secret()),
            expected.access_token.as_ref().map(|s| s.expose_secret()),
            "access_token"
        );
        assert_eq!(
            actual.refresh_token.as_ref().map(|s| s.expose_secret()),
            expected.refresh_token.as_ref().map(|s| s.expose_secret()),
            "refresh_token"
        );
        assert_eq!(
            actual.id_token.as_ref().map(|s| s.expose_secret()),
            expected.id_token.as_ref().map(|s| s.expose_secret()),
            "id_token"
        );
        assert_eq!(actual.expires_at, expected.expires_at, "expires_at");
        assert_eq!(actual.oidc_issuer, expected.oidc_issuer, "oidc_issuer");
        assert_eq!(actual.client_id, expected.client_id, "client_id");
        assert_eq!(actual.audience, expected.audience, "audience");
        assert_eq!(actual.auth_method, expected.auth_method, "auth_method");
        assert_eq!(actual.path_prefix, expected.path_prefix, "path_prefix");
    }

    #[test]
    fn round_trip_default_profile() {
        let tmp = TempDir::new().unwrap();
        let _guard = BoxliteHomeGuard::set(tmp.path());

        let profile = sample_api_key_profile();
        save_named(DEFAULT_PROFILE, &profile).expect("save");
        let loaded = load_named(DEFAULT_PROFILE)
            .expect("load")
            .expect("profile present");
        assert_profiles_equal(&loaded, &profile);
    }

    #[test]
    fn round_trip_oidc_profile() {
        let tmp = TempDir::new().unwrap();
        let _guard = BoxliteHomeGuard::set(tmp.path());

        let profile = sample_oidc_profile();
        save_named(DEFAULT_PROFILE, &profile).expect("save");
        let loaded = load_named(DEFAULT_PROFILE)
            .expect("load")
            .expect("profile present");
        assert_profiles_equal(&loaded, &profile);
    }

    /// Files written by older boxlite have just `url` and `api_key`. Loading
    /// such a file must yield `auth_method = ApiKey` with all OIDC fields
    /// absent — no migration, no error. This is the contract that lets us
    /// ship the schema change without coordinating a release window.
    #[test]
    fn loads_legacy_api_key_only_file() {
        let tmp = TempDir::new().unwrap();
        let _guard = BoxliteHomeGuard::set(tmp.path());

        let legacy = format!(
            "[profiles.default]\nurl = \"{}\"\napi_key = \"legacy-key\"\n",
            LOCAL_SERVE_URL
        );
        let file_path = path().expect("path");
        std::fs::create_dir_all(file_path.parent().unwrap()).expect("mkdir");
        std::fs::write(&file_path, legacy).expect("write legacy file");

        let loaded = load_named(DEFAULT_PROFILE)
            .expect("load")
            .expect("profile present");
        assert_eq!(loaded.url, LOCAL_SERVE_URL);
        assert_eq!(
            loaded.api_key.as_ref().map(|s| s.expose_secret()),
            Some("legacy-key")
        );
        assert_eq!(loaded.auth_method, AuthMethod::ApiKey);
        assert!(loaded.access_token.is_none());
        assert!(loaded.refresh_token.is_none());
        assert!(loaded.expires_at.is_none());
        assert!(
            loaded.path_prefix.is_none(),
            "legacy file has no path_prefix → load as None; URL builder skips the segment"
        );
    }

    /// `into_rest_options` must thread `profile.path_prefix` into the
    /// REST options' `path_prefix` field — this is what wires
    /// routing-slot substitution through. Locks in the contract so a
    /// future refactor can't drop the assignment and silently produce
    /// prefix-less URLs against a server that expects one.
    #[tokio::test]
    async fn into_rest_options_propagates_path_prefix() {
        let profile = Profile {
            url: "https://api.boxlite.ai/api".to_string(),
            api_key: Some(SecretString::from("blk_live_x".to_string())),
            path_prefix: Some("acme".to_string()),
            ..Profile::default()
        };
        let opts = into_rest_options(profile);
        assert_eq!(opts.path_prefix.as_deref(), Some("acme"));
    }

    /// `SecretString` redacts its inner value in `Debug` — proves
    /// `tracing::debug!(?profile)` cannot leak secrets even if a future caller
    /// forgets they are sensitive.
    #[test]
    fn debug_does_not_leak_secrets() {
        let profile = sample_oidc_profile();
        let rendered = format!("{:?}", profile);
        assert!(
            !rendered.contains("at-abc"),
            "access_token leaked through Debug: {}",
            rendered
        );
        assert!(
            !rendered.contains("rt-xyz"),
            "refresh_token leaked through Debug: {}",
            rendered
        );
        assert!(
            !rendered.contains("eyJhbGciOi"),
            "id_token leaked through Debug: {}",
            rendered
        );
    }

    /// On-disk format must keep the legacy `api_key` field name and never
    /// serialize `None` OIDC fields — older clients reading the same file
    /// during a roll-out must still see exactly the keys they understand.
    #[test]
    fn serialized_form_keeps_legacy_keys_only_for_api_key_profile() {
        let tmp = TempDir::new().unwrap();
        let _guard = BoxliteHomeGuard::set(tmp.path());

        save_named(DEFAULT_PROFILE, &sample_api_key_profile()).expect("save");
        let raw = std::fs::read_to_string(path().expect("path")).expect("read");
        assert!(raw.contains("api_key"), "api_key key missing: {}", raw);
        assert!(
            !raw.contains("access_token"),
            "None OIDC fields should not serialize: {}",
            raw
        );
        assert!(
            !raw.contains("refresh_token"),
            "None OIDC fields should not serialize: {}",
            raw
        );
    }

    #[test]
    fn load_missing_returns_none() {
        let tmp = TempDir::new().unwrap();
        let _guard = BoxliteHomeGuard::set(tmp.path());

        assert!(load_named(DEFAULT_PROFILE).expect("load ok").is_none());
    }

    #[test]
    fn delete_idempotent() {
        let tmp = TempDir::new().unwrap();
        let _guard = BoxliteHomeGuard::set(tmp.path());

        save_named(DEFAULT_PROFILE, &sample_api_key_profile()).expect("save");
        assert!(
            delete_named(DEFAULT_PROFILE).expect("first delete"),
            "first call removed the profile"
        );
        assert!(
            !delete_named(DEFAULT_PROFILE).expect("second delete"),
            "second call reports nothing to delete"
        );
    }

    #[cfg(unix)]
    #[test]
    fn save_sets_0600_perms() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let _guard = BoxliteHomeGuard::set(tmp.path());

        save_named(DEFAULT_PROFILE, &sample_api_key_profile()).expect("save");
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
            ..Profile::default()
        };
        let options = into_rest_options(profile);
        assert!(options.credential.is_none());
    }

    /// Two profiles must coexist in the same file and be readable independently.
    /// Locks in the multi-profile guarantee that lets `boxlite --profile cloud`
    /// hold a separate login from `boxlite --profile local`.
    #[test]
    fn save_named_preserves_other_profiles() {
        let tmp = TempDir::new().unwrap();
        let _guard = BoxliteHomeGuard::set(tmp.path());

        let local = sample_api_key_profile();
        let cloud = sample_oidc_profile();
        save_named("local", &local).expect("save local");
        save_named("cloud", &cloud).expect("save cloud");

        let loaded_local = load_named("local")
            .expect("load local")
            .expect("local present");
        let loaded_cloud = load_named("cloud")
            .expect("load cloud")
            .expect("cloud present");
        assert_profiles_equal(&loaded_local, &local);
        assert_profiles_equal(&loaded_cloud, &cloud);
    }

    /// Removing one profile must not disturb the other. The final empty file
    /// is collapsed on disk so `auth status` reports the offline state cleanly.
    #[test]
    fn delete_named_only_removes_target_profile() {
        let tmp = TempDir::new().unwrap();
        let _guard = BoxliteHomeGuard::set(tmp.path());

        save_named("local", &sample_api_key_profile()).expect("save local");
        save_named("cloud", &sample_oidc_profile()).expect("save cloud");

        assert!(delete_named("local").expect("delete local"));
        assert!(load_named("local").expect("load local").is_none());
        assert!(load_named("cloud").expect("load cloud").is_some());

        // Removing the last profile collapses the file.
        assert!(delete_named("cloud").expect("delete cloud"));
        assert!(!path().expect("path").exists(), "file should be removed");

        // Idempotent.
        assert!(!delete_named("cloud").expect("delete missing"));
    }

    /// `load_named("nonexistent")` is `Ok(None)`, not an error — matches the
    /// load-or-fall-back pattern used in `GlobalFlags::create_runtime`.
    #[test]
    fn load_named_unknown_profile_returns_none() {
        let tmp = TempDir::new().unwrap();
        let _guard = BoxliteHomeGuard::set(tmp.path());
        save_named("default", &sample_api_key_profile()).expect("save");
        assert!(load_named("does-not-exist").expect("load ok").is_none());
    }

    /// `auth_method = Oidc` must read `access_token`, not `api_key` — even if
    /// both happen to be set. Guards against a future refactor that drops the
    /// dispatch and silently uses the wrong field.
    #[tokio::test]
    async fn into_rest_options_oidc_uses_access_token() {
        let profile = Profile {
            url: "https://api.boxlite.ai/api".to_string(),
            api_key: Some(SecretString::from("should-not-be-used".to_string())),
            access_token: Some(SecretString::from("oidc-at".to_string())),
            auth_method: AuthMethod::Oidc,
            ..Profile::default()
        };
        let options = into_rest_options(profile);
        let cred = options.credential.expect("credential set");
        let tok = cred.get_token().await.expect("get_token");
        assert_eq!(tok.token, "oidc-at");
    }
}
