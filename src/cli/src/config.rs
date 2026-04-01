//! Configuration loading for BoxLite CLI.
//!
//! Handles loading configuration from JSON files.
//! Uses `BoxliteOptions` directly to avoid maintaining duplicate config structures.

use anyhow::{Context, Result, bail};
use boxlite::runtime::options::BoxliteOptions;
use std::path::Path;

/// Load configuration from a JSON file.
///
/// # Arguments
///
/// * `path` - Path to the configuration file
///
/// # Errors
///
/// Returns an error if:
/// - The file does not exist
/// - The file cannot be read or parsed
pub fn load_config(path: &Path) -> Result<BoxliteOptions> {
    if !path.exists() {
        bail!("Configuration file not found: {}", path.display());
    }

    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read config file {}", path.display()))?;

    serde_json::from_str::<BoxliteOptions>(&content)
        .with_context(|| format!("Failed to parse config file {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use tempfile::TempDir;

    #[test]
    fn test_load_config() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("config.json");
        let config_content = r#"{"image_registries": ["ghcr.io", "docker.io"]}"#;
        fs::write(&config_path, config_content).unwrap();

        let config = load_config(&config_path).unwrap();
        assert_eq!(config.image_registries, vec!["ghcr.io", "docker.io"]);
        // home_dir gets a default value from BoxliteOptions, not None
    }

    #[test]
    fn test_load_config_with_home_dir() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("config.json");
        let config_content = r#"{"home_dir": "/custom/home", "image_registries": ["docker.io"]}"#;
        fs::write(&config_path, config_content).unwrap();

        let config = load_config(&config_path).unwrap();
        assert_eq!(config.home_dir, PathBuf::from("/custom/home"));
        assert_eq!(config.image_registries, vec!["docker.io"]);
    }

    #[test]
    fn test_load_empty_config() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("empty.json");
        let config_content = r#"{}"#;
        fs::write(&config_path, config_content).unwrap();

        let config = load_config(&config_path).unwrap();
        // home_dir gets a default value, image_registries is empty
        assert!(config.image_registries.is_empty());
    }

    #[test]
    fn test_config_missing_fails() {
        let temp_dir = TempDir::new().unwrap();
        let missing_path = temp_dir.path().join("missing.json");

        let result = load_config(&missing_path);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("not found"));
    }

    #[test]
    fn test_config_invalid_fails() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("invalid.json");
        fs::write(&config_path, "invalid json").unwrap();

        let result = load_config(&config_path);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Failed to parse"));
    }
}
