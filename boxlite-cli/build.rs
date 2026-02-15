//! Build script for boxlite-cli.
//!
//! Copies runtime to ~/.local/share/boxlite/ and sets rpath.
//! Requires: Run `./scripts/build/build-runtime.sh` first.

use std::path::{Path, PathBuf};
use std::{env, fs};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let project_root = manifest_dir.parent().unwrap();

    // Rerun triggers
    println!("cargo:rerun-if-env-changed=BOXLITE_RUNTIME_DIR");
    println!(
        "cargo:rerun-if-changed={}",
        project_root.join("target/boxlite-runtime").display()
    );

    // Find runtime directory (may be None for clippy/check)
    let Some(runtime_src) = find_runtime_dir(project_root) else {
        return;
    };

    // Get destination
    let Some(home) = dirs::home_dir() else {
        println!("cargo:warning=Could not determine home directory");
        return;
    };
    let dest = home.join(".local/share/boxlite");

    // Set rpath
    set_rpath(&dest);

    // Clean destination before copying to avoid stale binaries
    // (e.g. unsigned binaries that macOS taskgated would kill)
    if dest.exists() {
        let _ = fs::remove_dir_all(&dest);
    }

    // Copy runtime to destination
    if let Err(e) = copy_dir_all(&runtime_src, &dest) {
        println!("cargo:warning=Failed to copy runtime: {}", e);
        return;
    }

    // Bake runtime path into binary
    println!("cargo:rustc-env=BOXLITE_RUNTIME_DIR={}", dest.display());
}

fn find_runtime_dir(project_root: &Path) -> Option<PathBuf> {
    // Check BOXLITE_RUNTIME_DIR env var first
    if let Ok(dir) = env::var("BOXLITE_RUNTIME_DIR") {
        let path = PathBuf::from(&dir);
        if path.exists() {
            return Some(path);
        }
    }

    // Check default location
    let runtime_dir = project_root.join("target/boxlite-runtime");
    if runtime_dir.exists() {
        return Some(runtime_dir);
    }

    // Warn instead of panic - allows clippy/check to work without runtime
    println!("cargo:warning=Runtime not found. Run: ./scripts/build/build-runtime.sh");
    None
}

fn set_rpath(dest: &Path) {
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", dest.display());
    }
    #[cfg(target_os = "linux")]
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", dest.display());
    }
}

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
