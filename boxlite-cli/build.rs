//! Build script for boxlite-cli.
//!
//! Copies runtime files to ~/.local/share/boxlite/ and sets rpath.

use std::path::{Path, PathBuf};
use std::{env, fs};

fn main() {
    let runtime_dir = find_runtime_dir();

    // Re-run if runtime directory changes
    if let Some(ref dir) = runtime_dir {
        println!("cargo:rerun-if-changed={}", dir.display());
    }
    println!("cargo:rerun-if-env-changed=BOXLITE_RUNTIME_DIR");

    // Re-run if destination doesn't exist or changes
    if let Some(home) = dirs::home_dir() {
        let dest = home.join(".local/share/boxlite");
        println!("cargo:rerun-if-changed={}", dest.display());
    }

    // Set rpath
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");
        if let Some(home) = dirs::home_dir() {
            let runtime_path = home.join(".local/share/boxlite");
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", runtime_path.display());
        }
    }

    #[cfg(target_os = "linux")]
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
        if let Some(home) = dirs::home_dir() {
            let runtime_path = home.join(".local/share/boxlite");
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", runtime_path.display());
        }
    }

    // Copy runtime to ~/.local/share/boxlite/
    if let Some(src) = runtime_dir {
        if let Some(home) = dirs::home_dir() {
            let dest = home.join(".local/share/boxlite");
            if let Err(e) = copy_dir_all(&src, &dest) {
                println!("cargo:warning=Failed to copy runtime: {}", e);
            } else {
                println!("cargo:warning=Copied runtime to: {}", dest.display());
            }
            // Bake runtime path into binary
            println!("cargo:rustc-env=BOXLITE_RUNTIME_DIR={}", dest.display());
        }
    } else {
        println!("cargo:warning=Runtime directory not found");
        println!(
            "cargo:warning=Set BOXLITE_RUNTIME_DIR or run ./scripts/build/build-runtime.sh first"
        );
    }
}

/// Recursively copy a directory.
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let dst_path = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &dst_path)?;
        } else {
            fs::copy(entry.path(), &dst_path)?;
        }
    }
    Ok(())
}

/// Find the runtime directory from environment or default location.
fn find_runtime_dir() -> Option<PathBuf> {
    // 1. Explicit override via environment variable
    if let Ok(dir) = env::var("BOXLITE_RUNTIME_DIR") {
        let path = PathBuf::from(&dir);
        if path.exists() {
            return Some(path);
        }
        println!(
            "cargo:warning=BOXLITE_RUNTIME_DIR set but not found: {}",
            dir
        );
    }

    // 2. Default location relative to project root
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let project_root = manifest_dir.parent()?;

    let candidates = [
        project_root.join("target/boxlite-runtime"),
        project_root.join("target/release/boxlite-runtime"),
        project_root.join("target/debug/boxlite-runtime"),
    ];

    candidates
        .into_iter()
        .find(|candidate| candidate.exists() && candidate.join("boxlite-shim").exists())
}
