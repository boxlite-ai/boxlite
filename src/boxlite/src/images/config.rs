//! Container image configuration extracted from OCI images config

use serde::{Deserialize, Serialize};

/// Container image configuration extracted from OCI images.
///
/// This struct contains the configuration baked into the container image,
/// including entrypoint, command, user, environment variables, working
/// directory, and exposed ports.
///
/// Follows OCI/Docker semantics:
/// - `entrypoint` is the executable (OCI ENTRYPOINT)
/// - `cmd` provides default arguments (OCI CMD), overridable by users
/// - Final execution = entrypoint + cmd
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerImageConfig {
    /// Executable from OCI ENTRYPOINT directive (e.g., ["/bin/sh", "-c"])
    pub entrypoint: Vec<String>,

    /// Default arguments from OCI CMD directive (e.g., ["echo", "hello"])
    ///
    /// Users can override this via BoxOptions.cmd while preserving entrypoint.
    pub cmd: Vec<String>,

    /// User/group to run the container process as (e.g., "0:0", "1000", "nginx")
    ///
    /// From OCI USER directive. Defaults to "0:0" (root).
    pub user: String,

    /// Exposed ports from the images (e.g., ["8080/tcp", "443/tcp"])
    ///
    /// These are the ports declared in the images's EXPOSE directive.
    /// Format: "port/protocol" where protocol is "tcp" or "udp".
    pub exposed_ports: Vec<String>,

    /// Environment variables (e.g., ["PATH=/usr/bin", "HOME=/root"])
    pub env: Vec<String>,

    /// Working directory (e.g., "/app", "/workspace")
    pub working_dir: String,
}

impl ContainerImageConfig {
    /// Create a new ContainerImageConfig with defaults
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self::default()
    }

    /// Combined entrypoint + cmd for execution.
    ///
    /// This is what gets sent to the guest as the process args.
    pub fn final_cmd(&self) -> Vec<String> {
        let mut result = self.entrypoint.clone();
        result.extend(self.cmd.iter().cloned());
        result
    }

    /// Parse port number and protocol from exposed port string
    ///
    /// # Examples
    /// - "8080/tcp" -> Some((8080, "tcp"))
    /// - "53/udp" -> Some((53, "udp"))
    /// - "8080" -> Some((8080)) // Default to TCP
    pub fn parse_exposed_port(port_spec: &str) -> Option<(u16, &str)> {
        let parts: Vec<&str> = port_spec.split('/').collect();

        let port_str = parts.first()?;
        let port: u16 = port_str.parse().ok()?;

        let protocol = parts.get(1).copied().unwrap_or("tcp");

        Some((port, protocol))
    }

    /// Get TCP ports from exposed ports
    pub fn tcp_ports(&self) -> Vec<u16> {
        self.exposed_ports
            .iter()
            .filter_map(|spec| {
                Self::parse_exposed_port(spec).and_then(|(port, protocol)| {
                    if protocol == "tcp" { Some(port) } else { None }
                })
            })
            .collect()
    }

    /// Get UDP ports from exposed ports
    #[allow(dead_code)]
    pub fn udp_ports(&self) -> Vec<u16> {
        self.exposed_ports
            .iter()
            .filter_map(|spec| {
                Self::parse_exposed_port(spec).and_then(|(port, protocol)| {
                    if protocol == "udp" { Some(port) } else { None }
                })
            })
            .collect()
    }

    /// Merge user-provided environment variables with images environment
    ///
    /// User env vars override images env vars if they have the same key.
    /// Input format is Vec<(key, value)>, output format is Vec<"KEY=VALUE">
    pub fn merge_env(&mut self, user_env: Vec<(String, String)>) {
        use std::collections::HashMap;

        // Parse existing env into map (KEY=VALUE)
        let mut env_map: HashMap<String, String> = HashMap::new();
        for entry in &self.env {
            if let Some(pos) = entry.find('=') {
                let key = entry[..pos].to_string();
                let value = entry[pos + 1..].to_string();
                env_map.insert(key, value);
            }
        }

        // Merge user env (overwrites existing keys)
        for (key, value) in user_env {
            env_map.insert(key, value);
        }

        // Convert back to Vec<String> in sorted order for determinism
        let mut env_vec: Vec<String> = env_map
            .into_iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect();
        env_vec.sort();

        self.env = env_vec;
    }

    /// Convert OCI ImageConfiguration to ContainerImageConfig
    ///
    /// Extracts container runtime configuration from OCI images config,
    /// storing ENTRYPOINT and CMD separately for proper override support.
    ///
    /// # Arguments
    /// * `image_config` - OCI ImageConfiguration from images config.json
    ///
    /// # Returns
    /// ContainerImageConfig with extracted image configuration
    pub fn from_oci_config(
        image_config: &oci_spec::image::ImageConfiguration,
    ) -> boxlite_shared::errors::BoxliteResult<Self> {
        use boxlite_shared::errors::BoxliteError;

        let config = image_config.config().as_ref().ok_or_else(|| {
            BoxliteError::Storage("Config object missing from images config".into())
        })?;

        // Extract ENTRYPOINT and CMD separately (OCI semantics)
        let entrypoint = config
            .entrypoint()
            .as_ref()
            .map(|ep| ep.to_vec())
            .unwrap_or_default();

        let cmd = config
            .cmd()
            .as_ref()
            .map(|c| c.to_vec())
            .unwrap_or_default();

        // Extract user
        let user = config
            .user()
            .as_ref()
            .filter(|u| !u.is_empty())
            .map(|u| u.to_string())
            .unwrap_or_else(|| "0:0".to_string());

        // Extract environment variables
        let env = config.env().clone().unwrap_or_default();

        // Extract working directory
        let workdir = config
            .working_dir()
            .as_ref()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "/".to_string());

        // Extract exposed ports
        let exposed_ports = config.exposed_ports().clone().unwrap_or_default();

        Ok(ContainerImageConfig {
            entrypoint,
            cmd,
            user,
            env,
            working_dir: workdir,
            exposed_ports,
        })
    }
}

impl Default for ContainerImageConfig {
    fn default() -> Self {
        Self {
            entrypoint: vec!["/bin/sh".to_string()],
            cmd: Vec::new(),
            user: "0:0".to_string(),
            env: vec![
                "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".to_string(),
            ],
            working_dir: "/".to_string(),
            exposed_ports: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_exposed_port() {
        assert_eq!(
            ContainerImageConfig::parse_exposed_port("8080/tcp"),
            Some((8080, "tcp"))
        );
        assert_eq!(
            ContainerImageConfig::parse_exposed_port("53/udp"),
            Some((53, "udp"))
        );
        assert_eq!(
            ContainerImageConfig::parse_exposed_port("8080"),
            Some((8080, "tcp"))
        );
        assert_eq!(ContainerImageConfig::parse_exposed_port("invalid"), None);
    }

    #[test]
    fn test_tcp_ports() {
        let config = ContainerImageConfig {
            exposed_ports: vec![
                "8080/tcp".to_string(),
                "443/tcp".to_string(),
                "53/udp".to_string(),
            ],
            ..Default::default()
        };

        assert_eq!(config.tcp_ports(), vec![8080, 443]);
    }

    #[test]
    fn test_udp_ports() {
        let config = ContainerImageConfig {
            exposed_ports: vec![
                "8080/tcp".to_string(),
                "53/udp".to_string(),
                "123/udp".to_string(),
            ],
            ..Default::default()
        };

        assert_eq!(config.udp_ports(), vec![53, 123]);
    }

    #[test]
    fn test_final_cmd() {
        let config = ContainerImageConfig {
            entrypoint: vec!["dockerd-entrypoint.sh".to_string()],
            cmd: vec!["--iptables=false".to_string()],
            ..Default::default()
        };

        assert_eq!(
            config.final_cmd(),
            vec!["dockerd-entrypoint.sh", "--iptables=false"]
        );
    }

    #[test]
    fn test_final_cmd_empty_cmd() {
        let config = ContainerImageConfig {
            entrypoint: vec!["/bin/sh".to_string()],
            cmd: vec![],
            ..Default::default()
        };

        assert_eq!(config.final_cmd(), vec!["/bin/sh"]);
    }

    #[test]
    fn test_final_cmd_empty_entrypoint() {
        let config = ContainerImageConfig {
            entrypoint: vec![],
            cmd: vec!["echo".to_string(), "hello".to_string()],
            ..Default::default()
        };

        assert_eq!(config.final_cmd(), vec!["echo", "hello"]);
    }

    #[test]
    fn test_final_cmd_multiple_cmd_args() {
        let config = ContainerImageConfig {
            entrypoint: vec!["python".to_string()],
            cmd: vec![
                "-m".to_string(),
                "http.server".to_string(),
                "8080".to_string(),
            ],
            ..Default::default()
        };

        assert_eq!(
            config.final_cmd(),
            vec!["python", "-m", "http.server", "8080"]
        );
    }

    #[test]
    fn test_final_cmd_both_empty() {
        let config = ContainerImageConfig {
            entrypoint: vec![],
            cmd: vec![],
            ..Default::default()
        };

        assert!(config.final_cmd().is_empty());
    }

    // ========================================================================
    // merge_env tests
    // ========================================================================

    #[test]
    fn test_merge_env_user_overrides_image() {
        let mut config = ContainerImageConfig {
            env: vec!["PATH=/usr/bin".to_string(), "HOME=/root".to_string()],
            ..Default::default()
        };

        config.merge_env(vec![("HOME".to_string(), "/home/user".to_string())]);

        assert!(config.env.contains(&"HOME=/home/user".to_string()));
        assert!(!config.env.contains(&"HOME=/root".to_string()));
        assert!(config.env.contains(&"PATH=/usr/bin".to_string()));
    }

    #[test]
    fn test_merge_env_adds_new_vars() {
        let mut config = ContainerImageConfig {
            env: vec!["PATH=/usr/bin".to_string()],
            ..Default::default()
        };

        config.merge_env(vec![("FOO".to_string(), "bar".to_string())]);

        assert!(config.env.contains(&"FOO=bar".to_string()));
        assert!(config.env.contains(&"PATH=/usr/bin".to_string()));
    }

    #[test]
    fn test_merge_env_empty_user_env() {
        let mut config = ContainerImageConfig {
            env: vec!["PATH=/usr/bin".to_string()],
            ..Default::default()
        };

        config.merge_env(vec![]);

        assert_eq!(config.env, vec!["PATH=/usr/bin"]);
    }

    #[test]
    fn test_merge_env_result_is_sorted() {
        let mut config = ContainerImageConfig {
            env: vec!["ZZZ=last".to_string(), "AAA=first".to_string()],
            ..Default::default()
        };

        config.merge_env(vec![("MMM".to_string(), "middle".to_string())]);

        assert_eq!(config.env, vec!["AAA=first", "MMM=middle", "ZZZ=last"]);
    }

    // ========================================================================
    // Default config tests
    // ========================================================================

    #[test]
    fn test_default_config_values() {
        let config = ContainerImageConfig::default();

        assert_eq!(config.entrypoint, vec!["/bin/sh"]);
        assert!(config.cmd.is_empty());
        assert_eq!(config.user, "0:0");
        assert_eq!(config.working_dir, "/");
        assert!(config.exposed_ports.is_empty());
        assert!(!config.env.is_empty()); // Has default PATH
    }
}
