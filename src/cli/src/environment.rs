//! Environment variable flags and resolution for CLI commands.

use anyhow::Context;
use clap::Args;
use std::fs;
use std::path::PathBuf;

/// Environment variables shared by `run`, `create`, and `exec`.
#[derive(Args, Debug, Clone, Default)]
pub struct EnvironmentFlags {
    /// Read environment variables from a file (repeatable)
    #[arg(long = "env-file", value_name = "FILE")]
    pub env_files: Vec<PathBuf>,

    /// Set environment variables
    #[arg(short = 'e', long = "env")]
    pub env: Vec<String>,
}

impl EnvironmentFlags {
    /// Resolve files first, then explicit `-e` values.
    ///
    /// Later definitions replace earlier ones while retaining deterministic
    /// output order. A bare `--env` key inherits its value from the host
    /// environment.
    pub fn resolve(&self) -> anyhow::Result<Vec<(String, String)>> {
        self.resolve_with_lookup(|key| std::env::var(key).ok())
    }

    fn resolve_with_lookup<F>(&self, lookup: F) -> anyhow::Result<Vec<(String, String)>>
    where
        F: Fn(&str) -> Option<String>,
    {
        let mut resolved = Vec::new();

        for path in &self.env_files {
            let contents = fs::read(path)
                .with_context(|| format!("failed to read environment file '{}'", path.display()))?;
            let contents = contents.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&contents);
            let entries = dotenvy::from_read_iter(contents);
            for entry in entries {
                let (key, value) = entry.with_context(|| {
                    format!("failed to parse environment file '{}'", path.display())
                })?;
                set_environment_value(&mut resolved, key, value);
            }
        }

        for entry in &self.env {
            apply_explicit_environment_entry(&mut resolved, entry, &lookup)?;
        }

        Ok(resolved)
    }
}

fn apply_explicit_environment_entry<F>(
    resolved: &mut Vec<(String, String)>,
    entry: &str,
    lookup: &F,
) -> anyhow::Result<()>
where
    F: Fn(&str) -> Option<String>,
{
    let (key, explicit_value) = match entry.split_once('=') {
        Some((key, value)) => (key, Some(value.to_string())),
        None => (entry, None),
    };

    if key.is_empty() || key.chars().any(char::is_whitespace) {
        anyhow::bail!("invalid environment variable name '{}' in --env", key);
    }

    let value = explicit_value.or_else(|| lookup(key));
    let Some(value) = value else {
        tracing::warn!(
            env_key = key,
            source = "--env",
            "Environment variable not found on host, skipping"
        );
        return Ok(());
    };

    set_environment_value(resolved, key.to_string(), value);
    Ok(())
}

fn set_environment_value(resolved: &mut Vec<(String, String)>, key: String, value: String) {
    if let Some((_, existing_value)) = resolved.iter_mut().find(|(name, _)| name == &key) {
        *existing_value = value;
    } else {
        resolved.push((key, value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn resolve_files_then_explicit_values() {
        let temp_dir = TempDir::new().unwrap();
        let base_file = temp_dir.path().join("base.env");
        let override_file = temp_dir.path().join("override.env");
        fs::write(
            &base_file,
            "# comment\nBOXLITE_DOTENV_SOURCE=one\nSHARED=base\nQUOTED='two words'\nEXPANDED=${BOXLITE_DOTENV_SOURCE}-suffix\nexport EXPORTED=yes\n",
        )
        .unwrap();
        fs::write(&override_file, "\nSHARED=override\nEMPTY=\n").unwrap();

        let flags = EnvironmentFlags {
            env_files: vec![base_file, override_file],
            env: vec!["SHARED=explicit".to_string(), "HOST_VALUE".to_string()],
        };

        let resolved = flags
            .resolve_with_lookup(|key| (key == "HOST_VALUE").then(|| "host".to_string()))
            .unwrap();

        assert_eq!(
            resolved,
            vec![
                ("BOXLITE_DOTENV_SOURCE".to_string(), "one".to_string()),
                ("SHARED".to_string(), "explicit".to_string()),
                ("QUOTED".to_string(), "two words".to_string()),
                ("EXPANDED".to_string(), "one-suffix".to_string()),
                ("EXPORTED".to_string(), "yes".to_string()),
                ("EMPTY".to_string(), String::new()),
                ("HOST_VALUE".to_string(), "host".to_string()),
            ]
        );
    }

    #[test]
    fn each_env_file_has_independent_substitution_scope() {
        let temp_dir = TempDir::new().unwrap();
        let base_file = temp_dir.path().join("base.env");
        let service_file = temp_dir.path().join("service.env");
        let source_key = format!("BOXLITE_TEST_{}", ulid::Ulid::new());
        let service_key = format!("{source_key}_SERVICE");
        fs::write(&base_file, format!("{source_key}=demo\n")).unwrap();
        fs::write(
            &service_file,
            format!("{service_key}=${{{source_key}}}-api\n"),
        )
        .unwrap();

        let flags = EnvironmentFlags {
            env_files: vec![base_file, service_file],
            env: Vec::new(),
        };

        let resolved = flags.resolve_with_lookup(|_| None).unwrap();

        assert_eq!(
            resolved,
            vec![
                (source_key, "demo".to_string()),
                (service_key, "-api".to_string()),
            ]
        );
    }

    #[test]
    fn ignores_utf8_bom_at_start_of_env_file() {
        let temp_dir = TempDir::new().unwrap();
        let env_file = temp_dir.path().join("bom.env");
        fs::write(&env_file, b"\xEF\xBB\xBFBOXLITE_BOM_VALUE=present\n").unwrap();

        let flags = EnvironmentFlags {
            env_files: vec![env_file],
            env: Vec::new(),
        };

        let resolved = flags.resolve_with_lookup(|_| None).unwrap();

        assert_eq!(
            resolved,
            vec![("BOXLITE_BOM_VALUE".to_string(), "present".to_string())]
        );
    }

    #[test]
    fn reports_file_and_invalid_line_for_parse_error() {
        let temp_dir = TempDir::new().unwrap();
        let env_file = temp_dir.path().join("invalid.env");
        fs::write(&env_file, "VALID=yes\nNOT VALID=no\n").unwrap();
        let flags = EnvironmentFlags {
            env_files: vec![env_file.clone()],
            env: Vec::new(),
        };

        let error = flags
            .resolve_with_lookup(|_| None)
            .expect_err("invalid dotenv syntax must fail");

        let message = format!("{error:#}");
        assert!(message.contains(&env_file.display().to_string()));
        assert!(message.contains("NOT VALID"));
    }

    #[test]
    fn reports_missing_file_path() {
        let temp_dir = TempDir::new().unwrap();
        let missing_file = temp_dir.path().join("missing.env");
        let flags = EnvironmentFlags {
            env_files: vec![missing_file.clone()],
            env: Vec::new(),
        };

        let error = flags
            .resolve_with_lookup(|_| None)
            .expect_err("missing environment file must fail");

        assert!(
            error
                .to_string()
                .contains(&missing_file.display().to_string())
        );
    }
}
