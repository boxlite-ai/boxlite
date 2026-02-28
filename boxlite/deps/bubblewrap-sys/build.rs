//! Build script for bubblewrap-sys
//!
//! Builds bwrap from the vendored bubblewrap submodule using Meson.
//! Only builds on Linux (bubblewrap uses Linux-specific features).

use std::env;

#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::process::{Command, Stdio};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=vendor/bubblewrap");
    println!("cargo:rerun-if-env-changed=BOXLITE_DEPS_STUB");

    // Check for stub mode (for CI linting without building)
    // Set BOXLITE_DEPS_STUB=1 to skip building and emit stub directives
    if env::var("BOXLITE_DEPS_STUB").is_ok() {
        println!("cargo:warning=BOXLITE_DEPS_STUB mode: skipping bubblewrap build");
        println!("cargo:bwrap_BOXLITE_DEP=/nonexistent");
        return;
    }

    // Only build on Linux (bubblewrap is Linux-only)
    #[cfg(not(target_os = "linux"))]
    {
        println!("cargo:warning=bubblewrap-sys: skipping build (not Linux)");
        println!("cargo:bwrap_BOXLITE_DEP=/nonexistent");
    }

    #[cfg(target_os = "linux")]
    build_linux();
}

#[cfg(target_os = "linux")]
fn build_linux() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let vendor_dir = manifest_dir.join("vendor/bubblewrap");
    let build_dir = out_dir.join("bubblewrap-build");
    let bwrap_path = build_dir.join("bwrap");

    // Verify vendor submodule exists
    if !vendor_dir.join("meson.build").exists() {
        panic!(
            "bubblewrap vendor source not found at {}.\n\
             Initialize submodule: git submodule update --init --recursive",
            vendor_dir.display()
        );
    }

    // Check for meson
    if !command_exists("meson") {
        panic!(
            "meson not found. Install meson:\n\
             Ubuntu/Debian: sudo apt-get install meson\n\
             Fedora/RHEL: sudo dnf install meson\n\
             Arch: sudo pacman -S meson"
        );
    }

    // Check for ninja
    if !command_exists("ninja") {
        panic!(
            "ninja not found. Install ninja:\n\
             Ubuntu/Debian: sudo apt-get install ninja-build\n\
             Fedora/RHEL: sudo dnf install ninja-build\n\
             Arch: sudo pacman -S ninja"
        );
    }

    build_bubblewrap(&vendor_dir, &build_dir);

    println!("cargo:bwrap_BOXLITE_DEP={}", bwrap_path.display());
}

#[cfg(target_os = "linux")]
fn command_exists(cmd: &str) -> bool {
    Command::new(cmd)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn build_bubblewrap(vendor_dir: &Path, build_dir: &Path) {
    println!("cargo:warning=Building bubblewrap from source...");

    std::fs::create_dir_all(build_dir).expect("Failed to create build directory");

    // Meson setup with minimal options (no man pages, no tests, no completions)
    // We disable SELinux to avoid requiring libselinux-dev
    let setup_status = Command::new("meson")
        .args([
            "setup",
            build_dir.to_str().unwrap(),
            vendor_dir.to_str().unwrap(),
            "-Dselinux=disabled",
            "-Dman=disabled",
            "-Dtests=false",
            "-Dbash_completion=disabled",
            "-Dzsh_completion=disabled",
        ])
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .expect("Failed to run meson setup");

    if !setup_status.success() {
        panic!(
            "meson setup failed.\n\
             Ensure libcap-dev is installed:\n\
             Ubuntu/Debian: sudo apt-get install libcap-dev\n\
             Fedora/RHEL: sudo dnf install libcap-devel"
        );
    }

    // Ninja build
    let build_status = Command::new("ninja")
        .args(["-C", build_dir.to_str().unwrap()])
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .expect("Failed to run ninja");

    if !build_status.success() {
        panic!("ninja build failed");
    }

    println!("cargo:warning=bubblewrap build complete");
}
