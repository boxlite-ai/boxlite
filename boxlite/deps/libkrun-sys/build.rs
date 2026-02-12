use std::collections::HashMap;
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

// libkrunfw release configuration (v5.1.0)
// Source: https://github.com/boxlite-ai/libkrunfw (fork with prebuilt releases)

// macOS: Download prebuilt kernel.c, compile locally to .dylib
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const LIBKRUNFW_PREBUILT_URL: &str =
    "https://github.com/boxlite-ai/libkrunfw/releases/download/v5.1.0/libkrunfw-prebuilt-aarch64.tgz";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const LIBKRUNFW_SHA256: &str = "2b2801d2e414140d8d0a30d7e30a011077b7586eabbbecdca42aea804b59de8b";

// Linux: Download pre-compiled .so directly (no build needed)
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const LIBKRUNFW_SO_URL: &str =
    "https://github.com/boxlite-ai/libkrunfw/releases/download/v5.1.0/libkrunfw-x86_64.tgz";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const LIBKRUNFW_SHA256: &str = "faca64a3581ce281498b8ae7eccc6bd0da99b167984f9ee39c47754531d4b37d";

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const LIBKRUNFW_SO_URL: &str =
    "https://github.com/boxlite-ai/libkrunfw/releases/download/v5.1.0/libkrunfw-aarch64.tgz";
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const LIBKRUNFW_SHA256: &str = "e254bc3fb07b32e26a258d9958967b2f22eb6c3136cfedf358c332308b6d35ea";

// libkrun build features (NET=1 BLK=1 enables network and block device support)
const LIBKRUN_BUILD_FEATURES: &[(&str, &str)] = &[("NET", "1"), ("BLK", "1")];

// Library directory name differs by platform
#[cfg(target_os = "macos")]
const LIB_DIR: &str = "lib";
#[cfg(target_os = "linux")]
const LIB_DIR: &str = "lib64";

/// Returns libkrun build environment with features enabled.
fn libkrun_build_env(libkrunfw_install: &Path) -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert(
        "PKG_CONFIG_PATH".to_string(),
        format!("{}/{}/pkgconfig", libkrunfw_install.display(), LIB_DIR),
    );
    for (key, value) in LIBKRUN_BUILD_FEATURES {
        env.insert(key.to_string(), value.to_string());
    }
    env
}

/// Verifies vendored sources exist.
fn verify_vendored_sources(manifest_dir: &Path, require_libkrunfw: bool) {
    let libkrun_src = manifest_dir.join("vendor/libkrun");
    let libkrunfw_src = manifest_dir.join("vendor/libkrunfw");

    // Submodule directories can exist but be empty if `git submodule update` wasn't run.
    // Check for a marker file (Makefile) instead of just the directory.
    let missing_libkrun = !libkrun_src.join("Makefile").exists();
    let missing_libkrunfw = require_libkrunfw && !libkrunfw_src.join("Makefile").exists();

    if missing_libkrun || missing_libkrunfw {
        eprintln!("ERROR: Vendored sources not found");
        eprintln!();
        eprintln!("Initialize git submodules:");
        eprintln!("  git submodule update --init --recursive");
        std::process::exit(1);
    }
}

fn main() {
    // Rebuild if vendored sources change
    println!("cargo:rerun-if-changed=vendor/libkrun");
    println!("cargo:rerun-if-changed=vendor/libkrunfw");
    println!("cargo:rerun-if-env-changed=BOXLITE_DEPS_STUB");
    #[cfg(target_os = "macos")]
    println!("cargo:rerun-if-env-changed=BOXLITE_LIBKRUN_CC_LINUX");

    // Check for stub mode (for CI linting without building)
    // Set BOXLITE_DEPS_STUB=1 to skip building and emit stub link directives
    if env::var("BOXLITE_DEPS_STUB").is_ok() {
        println!("cargo:warning=BOXLITE_DEPS_STUB mode: skipping libkrun build");
        // Emit minimal link directives that won't actually link anything
        // This allows cargo check/clippy to pass without building libkrun
        println!("cargo:rustc-link-lib=dylib=krun");
        // Use a non-existent path - linking will fail but check/clippy won't try to link
        println!("cargo:LIBKRUN_BOXLITE_DEP=/nonexistent");
        println!("cargo:LIBKRUNFW_BOXLITE_DEP=/nonexistent");
        return;
    }

    build();
}

/// Runs a command and panics with a helpful message if it fails.
#[allow(unused)]
fn run_command(cmd: &mut Command, description: &str) {
    let status = cmd
        .status()
        .unwrap_or_else(|e| panic!("Failed to execute {}: {}", description, e));

    if !status.success() {
        panic!("{} failed with exit code: {:?}", description, status.code());
    }
}

/// Checks if a directory contains any library file matching the given prefix.
/// Returns true if a file like "prefix.*.{dylib,so}" exists.
#[allow(unused)]
fn has_library(dir: &Path, prefix: &str) -> bool {
    let extensions = if cfg!(target_os = "macos") {
        vec!["dylib"]
    } else if cfg!(target_os = "linux") {
        vec!["so"]
    } else {
        vec!["dll"]
    };

    dir.read_dir()
        .ok()
        .map(|entries| {
            entries.filter_map(Result::ok).any(|entry| {
                let filename = entry.file_name().to_string_lossy().to_string();
                filename.starts_with(prefix)
                    && extensions
                        .iter()
                        .any(|ext| entry.path().extension().is_some_and(|e| e == *ext))
            })
        })
        .unwrap_or(false)
}

/// Creates a make command with common configuration.
#[allow(unused)]
fn make_command(
    source_dir: &Path,
    install_dir: &Path,
    extra_env: &HashMap<String, String>,
) -> Command {
    let mut cmd = Command::new("make");
    cmd.stdout(Stdio::inherit());
    cmd.stderr(Stdio::inherit());
    cmd.args(["-j", &num_cpus::get().to_string()])
        .arg("MAKEFLAGS=") // Clear MAKEFLAGS to prevent -w flag issues in submakes
        .env("PREFIX", install_dir)
        .current_dir(source_dir);

    // Apply extra environment variables
    for (key, value) in extra_env {
        cmd.env(key, value);
    }

    cmd
}

/// Builds a library using Make with the specified parameters.
#[allow(unused)]
fn build_with_make(
    source_dir: &Path,
    install_dir: &Path,
    lib_name: &str,
    extra_env: HashMap<String, String>,
) {
    build_with_make_args(source_dir, install_dir, lib_name, extra_env, &[]);
}

/// Builds a library using Make with additional Make arguments.
#[allow(unused)]
fn build_with_make_args(
    source_dir: &Path,
    install_dir: &Path,
    lib_name: &str,
    extra_env: HashMap<String, String>,
    extra_make_args: &[String],
) {
    println!("cargo:warning=Building {} from source...", lib_name);

    std::fs::create_dir_all(install_dir)
        .unwrap_or_else(|e| panic!("Failed to create install directory: {}", e));

    // Build
    let mut make_cmd = make_command(source_dir, install_dir, &extra_env);
    make_cmd.args(extra_make_args);
    run_command(&mut make_cmd, &format!("make {}", lib_name));

    // Install
    let mut install_cmd = make_command(source_dir, install_dir, &extra_env);
    install_cmd.args(extra_make_args);
    install_cmd.arg("install");
    run_command(&mut install_cmd, &format!("make install {}", lib_name));
}

/// Configure linking for libkrun.
///
/// Note: libkrunfw is NOT linked here - it's dlopened by libkrun at runtime.
/// We only expose the library directory so downstream crates can bundle it.
fn configure_linking(libkrun_dir: &Path, libkrunfw_dir: &Path) {
    println!("cargo:rustc-link-search=native={}", libkrun_dir.display());
    println!("cargo:rustc-link-lib=dylib=krun");

    // Expose library directories to downstream crates (used by boxlite/build.rs)
    // Convention: {LIBNAME}_BOXLITE_DEP=<path> for auto-discovery
    println!("cargo:LIBKRUN_BOXLITE_DEP={}", libkrun_dir.display());
    println!("cargo:LIBKRUNFW_BOXLITE_DEP={}", libkrunfw_dir.display());
}

/// Fixes the install_name on macOS to use an absolute path.
/// This allows install_name_tool to modify the library path during wheel repair.
#[cfg(target_os = "macos")]
fn fix_install_name(lib_name: &str, lib_path: &Path) {
    let status = Command::new("install_name_tool")
        .args([
            "-id",
            &format!("@rpath/{}", lib_name),
            lib_path.to_str().unwrap(),
        ])
        .status()
        .expect("Failed to execute install_name_tool");

    if !status.success() {
        panic!("Failed to set install_name for {}", lib_name);
    }
}

#[cfg(target_os = "linux")]
fn fix_install_name(lib_name: &str, lib_path: &Path) {
    let lib_path_str = lib_path.to_str().expect("Invalid library path");

    println!("cargo:warning=Fixing {} in {}", lib_name, lib_path_str);

    let status = Command::new("patchelf")
        .args([
            "--set-soname",
            lib_name, // On Linux, SONAME is just the library name, not @rpath/name
            lib_path_str,
        ])
        .status()
        .expect("Failed to execute patchelf");

    if !status.success() {
        panic!("Failed to set install_name for {}", lib_name);
    }
}

/// Extract SONAME from versioned library filename
/// e.g., libkrunfw.so.4.9.0 -> Some("libkrunfw.so.4")
///       libkrun.so.1.15.1 -> Some("libkrun.so.1")
#[allow(dead_code)]
fn extract_major_soname(filename: &str) -> Option<String> {
    // Find ".so." pattern
    if let Some(so_pos) = filename.find(".so.") {
        let base = &filename[..so_pos + 3]; // "libkrunfw.so"
        let versions = &filename[so_pos + 4..]; // "4.9.0"

        // Get first number (major version)
        if let Some(major) = versions.split('.').next() {
            return Some(format!("{}.{}", base, major)); // "libkrunfw.so.4"
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn fix_linux_libs(src_dir: &Path, lib_prefix: &str) -> Result<(), String> {
    use std::fs;

    // First pass: copy regular files and record symlinks
    for entry in
        fs::read_dir(src_dir).map_err(|e| format!("Failed to read source directory: {}", e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        let filename = path.file_name().unwrap().to_string_lossy().to_string();

        if filename.starts_with(lib_prefix) && filename.contains(".so") {
            // Check if it's a symlink
            let metadata = fs::symlink_metadata(&path)
                .map_err(|e| format!("Failed to get metadata: {}", e))?;

            if metadata.file_type().is_symlink() {
                continue;
            } else {
                // For libkrunfw only: rename to major version
                if lib_prefix == "libkrunfw" {
                    if let Some(soname) = extract_major_soname(&filename) {
                        if soname != filename {
                            let new_path = src_dir.join(&soname);
                            fs::rename(&path, &new_path)
                                .map_err(|e| format!("Failed to rename file: {}", e))?;
                            println!("cargo:warning=Renamed {} to {}", filename, soname);

                            // Fix install_name on renamed file
                            fix_install_name(&soname, &new_path);
                            continue;
                        }
                    }
                }

                // Fix install_name (only for non-symlinks)
                fix_install_name(&filename, &path);
            }
        }
    }

    Ok(())
}

/// Downloads a file from URL to the specified path.
fn download_file(url: &str, dest: &Path) -> io::Result<()> {
    println!("cargo:warning=Downloading {}...", url);

    let output = Command::new("curl")
        .args(["-fsSL", "-o", dest.to_str().unwrap(), url])
        .output()?;

    if !output.status.success() {
        return Err(io::Error::other(format!(
            "curl failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    Ok(())
}

/// Verifies SHA256 checksum of a file.
fn verify_sha256(file: &Path, expected: &str) -> io::Result<()> {
    // Use sha256sum on Linux, shasum on macOS
    let (cmd, args): (&str, Vec<&str>) = if cfg!(target_os = "linux") {
        ("sha256sum", vec![file.to_str().unwrap()])
    } else {
        ("shasum", vec!["-a", "256", file.to_str().unwrap()])
    };

    let output = Command::new(cmd).args(&args).output()?;

    if !output.status.success() {
        return Err(io::Error::other(format!("{} failed", cmd)));
    }

    let actual = String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();

    if actual != expected {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("SHA256 mismatch: expected {}, got {}", expected, actual),
        ));
    }

    println!("cargo:warning=SHA256 verified: {}", expected);
    Ok(())
}

/// Extracts a tarball to the specified directory.
fn extract_tarball(tarball: &Path, dest: &Path) -> io::Result<()> {
    fs::create_dir_all(dest)?;

    let status = Command::new("tar")
        .args([
            "-xzf",
            tarball.to_str().unwrap(),
            "-C",
            dest.to_str().unwrap(),
        ])
        .status()?;

    if !status.success() {
        return Err(io::Error::other("tar extraction failed"));
    }

    Ok(())
}

/// Downloads and extracts the prebuilt libkrunfw tarball (macOS).
/// Returns the path to the extracted source directory containing kernel.c.
#[cfg(target_os = "macos")]
fn download_libkrunfw_prebuilt(out_dir: &Path) -> PathBuf {
    let tarball_path = out_dir.join("libkrunfw-prebuilt.tar.gz");
    let extract_dir = out_dir.join("libkrunfw-src");
    // boxlite-ai/libkrunfw prebuilt tarball extracts to "libkrunfw/" directory
    let src_dir = extract_dir.join("libkrunfw");

    // Check if already extracted
    if src_dir.join("kernel.c").exists() {
        println!("cargo:warning=Using cached libkrunfw source");
        return src_dir;
    }

    // Download if not cached
    if !tarball_path.exists() {
        download_file(LIBKRUNFW_PREBUILT_URL, &tarball_path)
            .unwrap_or_else(|e| panic!("Failed to download libkrunfw: {}", e));

        verify_sha256(&tarball_path, LIBKRUNFW_SHA256)
            .unwrap_or_else(|e| panic!("Failed to verify libkrunfw checksum: {}", e));
    }

    // Extract
    if extract_dir.exists() {
        fs::remove_dir_all(&extract_dir).ok();
    }
    extract_tarball(&tarball_path, &extract_dir)
        .unwrap_or_else(|e| panic!("Failed to extract libkrunfw: {}", e));

    println!("cargo:warning=Extracted libkrunfw to {}", src_dir.display());
    src_dir
}

/// Downloads pre-compiled libkrunfw .so files (Linux).
/// Extracts directly to the install directory - no build step needed.
#[cfg(target_os = "linux")]
fn download_libkrunfw_so(install_dir: &Path) {
    let lib_dir = install_dir.join(LIB_DIR);

    // Check if already extracted
    if has_library(&lib_dir, "libkrunfw") {
        println!("cargo:warning=Using cached libkrunfw.so");
        return;
    }

    // Create install directory first (required before download)
    fs::create_dir_all(install_dir)
        .unwrap_or_else(|e| panic!("Failed to create install dir: {}", e));

    let tarball_path = install_dir.join("libkrunfw.tgz");

    // Download if not cached
    if !tarball_path.exists() {
        download_file(LIBKRUNFW_SO_URL, &tarball_path)
            .unwrap_or_else(|e| panic!("Failed to download libkrunfw: {}", e));

        verify_sha256(&tarball_path, LIBKRUNFW_SHA256)
            .unwrap_or_else(|e| panic!("Failed to verify libkrunfw checksum: {}", e));
    }

    // Extract (tarball contains lib64/ directory)
    extract_tarball(&tarball_path, install_dir)
        .unwrap_or_else(|e| panic!("Failed to extract libkrunfw: {}", e));

    println!(
        "cargo:warning=Extracted libkrunfw.so to {}",
        lib_dir.display()
    );
}

/// Builds libkrunfw from the prebuilt source.
#[cfg(target_os = "macos")]
fn build_libkrunfw_macos(src_dir: &Path, install_dir: &Path) {
    build_with_make(src_dir, install_dir, "libkrunfw", HashMap::new());
}

/// Sets LIBCLANG_PATH for bindgen if not already set.
/// This is needed when llvm is installed via brew but not linked (keg-only).
#[cfg(target_os = "macos")]
fn setup_libclang_path() {
    // Skip if LIBCLANG_PATH already set or llvm-config is in PATH
    if env::var("LIBCLANG_PATH").is_ok() {
        return;
    }
    if Command::new("llvm-config")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
    {
        return;
    }

    // Try common Homebrew locations (useful when `brew` itself can't be executed).
    for prefix in ["/opt/homebrew/opt/llvm", "/usr/local/opt/llvm"] {
        let lib_path = Path::new(prefix).join("lib");
        if lib_path.join("libclang.dylib").exists() {
            env::set_var("LIBCLANG_PATH", &lib_path);
            return;
        }
    }

    // Try to find brew's llvm
    if let Ok(output) = Command::new("brew").args(["--prefix", "llvm"]).output() {
        if output.status.success() {
            let prefix = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let lib_path = format!("{}/lib", prefix);
            if Path::new(&lib_path).join("libclang.dylib").exists() {
                env::set_var("LIBCLANG_PATH", &lib_path);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn brew_prefix(formula: &str) -> Option<PathBuf> {
    let output = Command::new("brew")
        .args(["--prefix", formula])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let prefix = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if prefix.is_empty() {
        return None;
    }

    Some(PathBuf::from(prefix))
}

#[cfg(target_os = "macos")]
fn find_non_apple_clang_in_path() -> Option<PathBuf> {
    let version = Command::new("clang").arg("--version").output().ok()?;
    if !version.status.success() {
        return None;
    }

    let version_stdout = String::from_utf8_lossy(&version.stdout);
    if version_stdout.starts_with("Apple clang") {
        return None;
    }

    let output = Command::new("which").arg("clang").output().ok()?;
    if !output.status.success() {
        return None;
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return None;
    }

    let path = PathBuf::from(path);
    path.exists().then_some(path)
}

#[cfg(target_os = "macos")]
fn find_llvm_clang() -> Option<PathBuf> {
    // If the user has already put a non-Apple clang first in PATH, prefer that.
    if let Some(clang) = find_non_apple_clang_in_path() {
        return Some(clang);
    }

    // If llvm-config is available, use it.
    if let Ok(output) = Command::new("llvm-config").arg("--bindir").output() {
        if output.status.success() {
            let bindir = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !bindir.is_empty() {
                let clang = PathBuf::from(bindir).join("clang");
                if clang.exists() {
                    return Some(clang);
                }
            }
        }
    }

    // Common Homebrew locations (useful when `brew` itself can't be executed).
    for prefix in ["/opt/homebrew/opt/llvm", "/usr/local/opt/llvm"] {
        let clang = Path::new(prefix).join("bin/clang");
        if clang.exists() {
            return Some(clang);
        }
    }

    // Homebrew llvm is keg-only; locate it via brew.
    brew_prefix("llvm")
        .map(|prefix| prefix.join("bin/clang"))
        .filter(|clang| clang.exists())
}

#[cfg(target_os = "macos")]
fn lld_bin_dir() -> Option<PathBuf> {
    // If ld.lld is already in PATH, we're good.
    if Command::new("ld.lld")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
    {
        return None;
    }

    // Common Homebrew locations (useful when `brew` itself can't be executed).
    for prefix in ["/opt/homebrew/opt/lld", "/usr/local/opt/lld"] {
        let ld_lld = Path::new(prefix).join("bin/ld.lld");
        if ld_lld.exists() {
            return ld_lld.parent().map(Path::to_path_buf);
        }
    }

    // Otherwise, try locating via Homebrew.
    let ld_lld = brew_prefix("lld")
        .map(|prefix| prefix.join("bin/ld.lld"))
        .filter(|path| path.exists())?;

    ld_lld.parent().map(Path::to_path_buf)
}

#[cfg(target_os = "macos")]
fn prepend_path_dirs(path_dirs: &[PathBuf]) -> Option<String> {
    if path_dirs.is_empty() {
        return None;
    }

    let existing = env::var("PATH").unwrap_or_default();
    let mut merged = String::new();
    for dir in path_dirs {
        if merged.is_empty() {
            merged.push_str(&dir.to_string_lossy());
        } else {
            merged.push(':');
            merged.push_str(&dir.to_string_lossy());
        }
    }

    if existing.is_empty() {
        return Some(merged);
    }

    merged.push(':');
    merged.push_str(&existing);
    Some(merged)
}

#[cfg(target_os = "macos")]
fn resolve_cc_linux_make_arg() -> Result<(String, HashMap<String, String>), String> {
    if let Ok(cc_linux) = env::var("BOXLITE_LIBKRUN_CC_LINUX") {
        let cc_linux = cc_linux.trim().to_string();
        if cc_linux.is_empty() {
            return Err("BOXLITE_LIBKRUN_CC_LINUX is set but empty".to_string());
        }
        return Ok((format!("CC_LINUX={}", cc_linux), HashMap::new()));
    }

    let clang = find_llvm_clang().ok_or_else(|| {
        "libkrun cross-compilation on macOS requires LLVM clang + lld. Run `make setup` (or `brew install llvm lld`) and retry."
            .to_string()
    })?;

    let mut path_dirs = Vec::new();
    if let Some(dir) = clang.parent() {
        path_dirs.push(dir.to_path_buf());
    }
    if let Some(lld_dir) = lld_bin_dir() {
        path_dirs.push(lld_dir);
    }

    let path_override = prepend_path_dirs(&path_dirs);

    // Ensure ld.lld is available (either already in PATH or via brew lld).
    let mut ld_lld_cmd = Command::new("ld.lld");
    ld_lld_cmd
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(ref path) = path_override {
        ld_lld_cmd.env("PATH", path);
    }

    if !ld_lld_cmd.status().is_ok_and(|s| s.success()) {
        return Err(
            "Missing `ld.lld` (LLVM linker). Install it with `make setup` (or `brew install lld`)."
                .to_string(),
        );
    }

    println!(
        "cargo:warning=Using LLVM clang for libkrun init cross-compile: {}",
        clang.display()
    );

    let linux_target_triple = match env::var("CARGO_CFG_TARGET_ARCH")
        .unwrap_or_else(|_| "$(ARCH)".to_string())
        .as_str()
    {
        // libkrun's sysroot is extracted from Debian arm64 packages, which use the GNU triplet
        // `aarch64-linux-gnu` for libgcc/crt objects. Using `arm64-linux-gnu` can prevent clang
        // from finding those files inside the sysroot.
        "arm64" | "aarch64" => "aarch64-linux-gnu".to_string(),
        "x86_64" => "x86_64-linux-gnu".to_string(),
        arch => format!("{arch}-linux-gnu"),
    };

    // vendor/libkrun hardcodes `/usr/bin/clang` for CC_LINUX on macOS; override it.
    // Shell-escape the clang path so that spaces or special characters do not break the Make command.
    let clang_escaped = {
        let s = clang.to_string_lossy();
        // Use single-quote shell escaping: each ' becomes '\'' and the whole string is wrapped in single quotes.
        format!("'{}'", s.replace('\'', "'\\''"))
    };
    let cc_linux = format!(
        "{} -target {} -fuse-ld=lld -Wl,-strip-debug --sysroot $(SYSROOT_LINUX) -Wno-c23-extensions",
        clang_escaped,
        linux_target_triple
    );

    let mut env_overrides = HashMap::new();
    if let Some(path) = path_override {
        env_overrides.insert("PATH".to_string(), path);
    }

    Ok((format!("CC_LINUX={}", cc_linux), env_overrides))
}

/// Builds libkrun from vendored source with cross-compilation support.
#[cfg(target_os = "macos")]
fn build_libkrun_macos(src_dir: &Path, install_dir: &Path, libkrunfw_install: &Path) {
    // Setup LIBCLANG_PATH for bindgen if needed
    setup_libclang_path();

    let (cc_linux_make_arg, env_overrides) =
        resolve_cc_linux_make_arg().unwrap_or_else(|e| panic!("{}", e));

    let mut extra_env = libkrun_build_env(libkrunfw_install);
    extra_env.extend(env_overrides);

    build_with_make_args(
        src_dir,
        install_dir,
        "libkrun",
        extra_env,
        &[cc_linux_make_arg],
    );
}

/// Fixes install names and re-signs libraries in a directory.
#[cfg(target_os = "macos")]
fn fix_macos_libs(lib_dir: &Path, lib_prefix: &str) -> Result<(), String> {
    for entry in fs::read_dir(lib_dir).map_err(|e| format!("Failed to read lib dir: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        let filename = path.file_name().unwrap().to_string_lossy().to_string();

        if filename.starts_with(lib_prefix) && filename.contains(".dylib") {
            let metadata = fs::symlink_metadata(&path)
                .map_err(|e| format!("Failed to get metadata: {}", e))?;

            // Skip symlinks
            if metadata.file_type().is_symlink() {
                continue;
            }

            // Fix install_name to use @rpath
            fix_install_name(&filename, &path);

            // Re-sign after modifying
            let sign_status = Command::new("codesign")
                .args(["-s", "-", "--force"])
                .arg(&path)
                .status()
                .map_err(|e| format!("Failed to run codesign: {}", e))?;

            if !sign_status.success() {
                return Err(format!("codesign failed for {}", filename));
            }

            println!("cargo:warning=Fixed and signed {}", filename);
        }
    }

    Ok(())
}

/// macOS: Build libkrun and libkrunfw from source
#[cfg(target_os = "macos")]
fn build() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    let libkrunfw_install = out_dir.join("libkrunfw");
    let libkrun_install = out_dir.join("libkrun");
    let libkrunfw_lib = libkrunfw_install.join(LIB_DIR);
    let libkrun_lib = libkrun_install.join(LIB_DIR);

    println!("cargo:warning=Building libkrun-sys for macOS (from source)");

    // Verify vendored libkrun source exists (libkrunfw is downloaded as prebuilt)
    verify_vendored_sources(&manifest_dir, false);

    let libkrun_src = manifest_dir.join("vendor/libkrun");

    // 1. Download and extract prebuilt libkrunfw
    let libkrunfw_src = download_libkrunfw_prebuilt(&out_dir);

    // 2. Build libkrunfw
    build_libkrunfw_macos(&libkrunfw_src, &libkrunfw_install);

    // 3. Build libkrun from vendored source
    build_libkrun_macos(&libkrun_src, &libkrun_install, &libkrunfw_install);

    // 4. Fix install names for @rpath
    fix_macos_libs(&libkrunfw_lib, "libkrunfw")
        .unwrap_or_else(|e| panic!("Failed to fix libkrunfw: {}", e));

    fix_macos_libs(&libkrun_lib, "libkrun")
        .unwrap_or_else(|e| panic!("Failed to fix libkrun: {}", e));

    // 5. Configure linking
    configure_linking(&libkrun_lib, &libkrunfw_lib);
}

/// Linux: Build libkrun (libkrunfw is downloaded pre-compiled)
/// By default, downloads pre-compiled libkrunfw.so to avoid ~20min kernel build.
/// Set BOXLITE_BUILD_LIBKRUNFW=1 to build libkrunfw from source.
#[cfg(target_os = "linux")]
fn build() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    let libkrunfw_install = out_dir.join("libkrunfw");
    let libkrun_install = out_dir.join("libkrun");
    let libkrunfw_lib_dir = libkrunfw_install.join(LIB_DIR);
    let libkrun_lib_dir = libkrun_install.join(LIB_DIR);

    // Check if user wants to build libkrunfw from source (slow, ~20 min)
    let build_from_source = env::var("BOXLITE_BUILD_LIBKRUNFW").is_ok();

    if build_from_source {
        println!(
            "cargo:warning=Building libkrun-sys for Linux (from source, BOXLITE_BUILD_LIBKRUNFW=1)"
        );
        // Verify vendored sources exist
        verify_vendored_sources(&manifest_dir, true);

        let libkrunfw_src = manifest_dir.join("vendor/libkrunfw");

        // Build libkrunfw from source (~20 min kernel build)
        build_with_make(
            &libkrunfw_src,
            &libkrunfw_install,
            "libkrunfw",
            HashMap::new(),
        );
    } else {
        println!("cargo:warning=Building libkrun-sys for Linux (using pre-compiled .so)");
        // Verify only libkrun vendored source exists (libkrunfw is downloaded)
        verify_vendored_sources(&manifest_dir, false);

        // Download pre-compiled libkrunfw.so directly (no build needed)
        download_libkrunfw_so(&libkrunfw_install);
    }

    // Build libkrun from vendored source (always)
    let libkrun_src = manifest_dir.join("vendor/libkrun");
    build_with_make(
        &libkrun_src,
        &libkrun_install,
        "libkrun",
        libkrun_build_env(&libkrunfw_install),
    );

    // Fix library names
    fix_linux_libs(&libkrun_lib_dir, "libkrun")
        .unwrap_or_else(|e| panic!("Failed to fix libkrun: {}", e));

    fix_linux_libs(&libkrunfw_lib_dir, "libkrunfw")
        .unwrap_or_else(|e| panic!("Failed to fix libkrunfw: {}", e));

    configure_linking(&libkrun_lib_dir, &libkrunfw_lib_dir);
}
