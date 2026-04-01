//! Build script to compile Protocol Buffer definitions.

use std::process::Command;

fn get_protoc_version() -> Result<(u32, u32), Box<dyn std::error::Error>> {
    let output = Command::new("protoc").arg("--version").output()?;

    if !output.status.success() {
        return Err("protoc --version failed".into());
    }

    let version_str = String::from_utf8_lossy(&output.stdout);
    // Parse "libprotoc 3.12.4" or "protoc 3.15.0"
    let version = version_str
        .split_whitespace()
        .nth(1)
        .ok_or("Invalid protoc version output")?;

    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() < 2 {
        return Err("Invalid protoc version format".into());
    }

    let major: u32 = parts[0].parse()?;
    let minor: u32 = parts[1].parse()?;
    Ok((major, minor))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut config = tonic_build::configure()
        .build_server(true)
        .build_client(true);

    // proto3 optional fields require protoc >= 3.12
    // For 3.12-3.14, we need --experimental_allow_proto3_optional
    // For 3.15+, it's enabled by default
    match get_protoc_version() {
        Ok((major, minor)) if major == 3 && (12..=14).contains(&minor) => {
            config = config.protoc_arg("--experimental_allow_proto3_optional");
        }
        Ok((major, minor)) if major < 3 || (major == 3 && minor < 12) => {
            return Err(format!(
                "protoc version {}.{} is not supported. boxlite requires protoc >= 3.12 for proto3 optional support.",
                major, minor
            ).into());
        }
        Err(e) => {
            return Err(format!(
                "Failed to determine protoc version: {}. boxlite requires protoc >= 3.12.",
                e
            )
            .into());
        }
        _ => {
            // Version 3.15+ or future versions - no special handling needed
        }
    }

    config.compile_protos(&["proto/boxlite/v1/service.proto"], &["proto"])?;

    println!("cargo:rerun-if-changed=proto/");
    Ok(())
}
