use std::collections::HashMap;
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

// ── Constants ────────────────────────────────────────────────────────────────

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

// Library directory name differs by platform
#[cfg(target_os = "macos")]
const LIB_DIR: &str = "lib";
#[cfg(target_os = "linux")]
const LIB_DIR: &str = "lib64";

// ── Core utilities ───────────────────────────────────────────────────────────

/// Runs a command and panics with a helpful message if it fails.
fn run_command(cmd: &mut Command, description: &str) {
    let status = cmd
        .status()
        .unwrap_or_else(|e| panic!("Failed to execute {}: {}", description, e));

    if !status.success() {
        panic!("{} failed with exit code: {:?}", description, status.code());
    }
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

// ── Fetcher: download, verify, extract ───────────────────────────────────────

struct Fetcher;

impl Fetcher {
    /// Downloads, verifies, and extracts a tarball.
    /// Skips download if tarball already exists at `tarball_path`.
    pub fn fetch(
        url: &str,
        sha256: &str,
        tarball_path: &Path,
        extract_dir: &Path,
    ) -> io::Result<()> {
        if !tarball_path.exists() {
            Self::download(url, tarball_path)?;
            Self::verify_sha256(tarball_path, sha256)?;
        }
        Self::extract_tarball(tarball_path, extract_dir)
    }

    /// Downloads a file from URL to the specified path.
    fn download(url: &str, dest: &Path) -> io::Result<()> {
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

    // Clean stale extraction before re-extracting
    if extract_dir.exists() {
        fs::remove_dir_all(&extract_dir).ok();
    }

    Fetcher::fetch(
        LIBKRUNFW_PREBUILT_URL,
        LIBKRUNFW_SHA256,
        &tarball_path,
        &extract_dir,
    )
    .unwrap_or_else(|e| panic!("Failed to fetch libkrunfw: {}", e));

    println!("cargo:warning=Extracted libkrunfw to {}", src_dir.display());
    src_dir
}

/// Downloads pre-compiled libkrunfw .so files (Linux).
/// Extracts directly to the install directory - no build step needed.
#[cfg(target_os = "linux")]
fn download_libkrunfw_so(install_dir: &Path) {
    let lib_dir = install_dir.join(LIB_DIR);

    // Check if already extracted
    let already_cached = lib_dir
        .read_dir()
        .ok()
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .any(|e| e.file_name().to_string_lossy().starts_with("libkrunfw.so"))
        })
        .unwrap_or(false);

    if already_cached {
        println!("cargo:warning=Using cached libkrunfw.so");
        return;
    }

    // Create install directory first (required before download)
    fs::create_dir_all(install_dir)
        .unwrap_or_else(|e| panic!("Failed to create install dir: {}", e));

    let tarball_path = install_dir.join("libkrunfw.tgz");

    Fetcher::fetch(
        LIBKRUNFW_SO_URL,
        LIBKRUNFW_SHA256,
        &tarball_path,
        install_dir,
    )
    .unwrap_or_else(|e| panic!("Failed to fetch libkrunfw: {}", e));

    println!(
        "cargo:warning=Extracted libkrunfw.so to {}",
        lib_dir.display()
    );
}

// ── Make utilities ───────────────────────────────────────────────────────────

/// Creates a make command with common configuration.
fn make_command(source_dir: &Path, extra_env: &HashMap<String, String>) -> Command {
    let mut cmd = Command::new("make");
    cmd.stdout(Stdio::inherit());
    cmd.stderr(Stdio::inherit());
    cmd.args(["-j", &num_cpus::get().to_string()])
        .arg("MAKEFLAGS=") // Clear MAKEFLAGS to prevent -w flag issues in submakes
        .current_dir(source_dir);

    // Apply extra environment variables
    for (key, value) in extra_env {
        cmd.env(key, value);
    }

    cmd
}

/// Builds a library using Make with the specified parameters.
fn build_with_make(
    source_dir: &Path,
    install_dir: &Path,
    lib_name: &str,
    extra_env: &HashMap<String, String>,
    extra_make_args: &[String],
) {
    println!("cargo:warning=Building {} from source...", lib_name);

    fs::create_dir_all(install_dir)
        .unwrap_or_else(|e| panic!("Failed to create install directory: {}", e));

    // Build
    let mut make_cmd = make_command(source_dir, extra_env);
    make_cmd.env("PREFIX", install_dir);
    make_cmd.args(extra_make_args);
    run_command(&mut make_cmd, &format!("make {}", lib_name));

    // Install
    let mut install_cmd = make_command(source_dir, extra_env);
    install_cmd.env("PREFIX", install_dir);
    install_cmd.args(extra_make_args);
    install_cmd.arg("install");
    run_command(&mut install_cmd, &format!("make install {}", lib_name));
}

// ── LibBuilder: libkrun build operations ─────────────────────────────────────

struct LibBuilder;

impl LibBuilder {
    /// Builds libkrun end-to-end: init binary → static library → linking configuration.
    pub fn build(
        libkrun_src: &Path,
        libkrun_install: &Path,
        libkrunfw_install: &Path,
        init_env: &HashMap<String, String>,
        init_make_args: &[String],
    ) {
        Self::build_init_binary(libkrun_src, init_env, init_make_args);
        Self::build_libkrun_static(libkrun_src, libkrun_install, libkrunfw_install);
        let libkrun_lib = libkrun_install.join(LIB_DIR);
        let libkrunfw_lib = libkrunfw_install.join(LIB_DIR);
        Self::configure_linking(&libkrun_lib, &libkrunfw_lib);
    }

    /// Builds only the init binary from the libkrun Makefile.
    ///
    /// The init binary (init/init) is a static C program that runs inside the VM.
    /// It is embedded into libkrun via include_bytes! and must be built before
    /// the Rust library.
    fn build_init_binary(
        libkrun_src: &Path,
        extra_env: &HashMap<String, String>,
        extra_make_args: &[String],
    ) {
        println!("cargo:warning=Building init binary...");

        let mut cmd = make_command(libkrun_src, extra_env);
        cmd.args(extra_make_args);
        cmd.arg("init/init");

        run_command(&mut cmd, "make init/init");
    }

    /// Builds libkrun as a static library using `cargo rustc --crate-type staticlib`.
    ///
    /// This overrides libkrun's Cargo.toml crate-type (cdylib) at the command line,
    /// producing libkrun.a without modifying the vendored source code.
    fn build_libkrun_static(libkrun_src: &Path, install_dir: &Path, libkrunfw_install: &Path) {
        println!("cargo:warning=Building libkrun as static library...");

        let lib_dir = install_dir.join(LIB_DIR);
        fs::create_dir_all(&lib_dir)
            .unwrap_or_else(|e| panic!("Failed to create lib directory: {}", e));

        // Read the outer build's TARGET to propagate cross-compilation (e.g., musl)
        let target = env::var("TARGET").ok();

        let mut cmd = Command::new("cargo");
        cmd.args([
            "rustc",
            "-p",
            "libkrun",
            "--release",
            "--crate-type",
            "staticlib",
        ]);
        // Features must be forwarded to internal dependency crates explicitly when
        // using -p, since libkrun's Cargo.toml doesn't propagate them (net = [], blk = []).
        // Without -p, workspace-level feature unification handles this automatically,
        // but cargo rustc -p requires explicit dep/feature syntax.
        cmd.args([
            "--features",
            "net,blk,vmm/net,vmm/blk,devices/net,devices/blk",
        ]);

        // Propagate target for cross-compilation (e.g., x86_64-unknown-linux-musl)
        if let Some(ref target) = target {
            cmd.args(["--target", target]);
        }

        cmd.current_dir(libkrun_src);
        cmd.env(
            "PKG_CONFIG_PATH",
            format!("{}/{}/pkgconfig", libkrunfw_install.display(), LIB_DIR),
        );
        cmd.stdout(Stdio::inherit());
        cmd.stderr(Stdio::inherit());

        run_command(&mut cmd, "cargo rustc (libkrun staticlib)");

        // Determine output path (differs when --target is specified)
        let output_dir = if let Some(ref target) = target {
            libkrun_src.join(format!("target/{}/release", target))
        } else {
            libkrun_src.join("target/release")
        };

        let src = output_dir.join("libkrun.a");
        let dst = lib_dir.join("libkrun.a");
        fs::copy(&src, &dst).unwrap_or_else(|e| {
            panic!(
                "Failed to copy libkrun.a from {} to {}: {}",
                src.display(),
                dst.display(),
                e
            )
        });

        println!("cargo:warning=Built static libkrun at {}", dst.display());
    }

    /// Configure linking for libkrun (static) and expose library paths.
    ///
    /// Note: libkrunfw is NOT linked here — it's dlopened by libkrun at runtime.
    /// We only expose the library directory so downstream crates can bundle it.
    fn configure_linking(libkrun_dir: &Path, libkrunfw_dir: &Path) {
        println!("cargo:rustc-link-search=native={}", libkrun_dir.display());
        println!("cargo:rustc-link-lib=static=krun");

        // Transitive dependencies from libkrun (now statically linked, these were
        // previously resolved by the dynamic linker inside libkrun.so/dylib)
        #[cfg(target_os = "macos")]
        {
            println!("cargo:rustc-link-lib=framework=Hypervisor");
        }

        // libkrun.a is a Rust staticlib that bundles its own std. When linked into
        // another Rust binary, std symbols (rust_eh_personality, etc.) are duplicated.
        // Tell the linker to use the first definition.
        #[cfg(target_os = "linux")]
        println!("cargo:rustc-link-arg=-Wl,--allow-multiple-definition");

        // Expose library directories to downstream crates (used by boxlite/build.rs)
        // Convention: {LIBNAME}_BOXLITE_DEP=<path> for auto-discovery
        // Note: LIBKRUN dir now contains .a (not bundled at runtime), but the path
        // is still exposed for consistency. Only LIBKRUNFW .so/.dylib gets bundled.
        println!("cargo:LIBKRUN_BOXLITE_DEP={}", libkrun_dir.display());
        println!("cargo:LIBKRUNFW_BOXLITE_DEP={}", libkrunfw_dir.display());
    }
}

// ── LibFixup: post-build library fixup ───────────────────────────────────────

struct LibFixup;

impl LibFixup {
    /// Fixes the shared library name (install_name on macOS, SONAME on Linux).
    fn fix_install_name(lib_name: &str, lib_path: &Path) {
        let lib_path_str = lib_path.to_str().expect("Invalid library path");

        #[cfg(target_os = "macos")]
        let mut cmd = {
            let mut c = Command::new("install_name_tool");
            c.args(["-id", &format!("@rpath/{}", lib_name), lib_path_str]);
            c
        };

        #[cfg(target_os = "linux")]
        let mut cmd = {
            println!("cargo:warning=Fixing {} in {}", lib_name, lib_path_str);
            let mut c = Command::new("patchelf");
            c.args(["--set-soname", lib_name, lib_path_str]);
            c
        };

        run_command(&mut cmd, &format!("fix install name for {}", lib_name));
    }

    /// Extract SONAME from versioned library filename.
    /// e.g., libkrunfw.so.4.9.0 -> Some("libkrunfw.so.4")
    #[cfg(target_os = "linux")]
    fn extract_major_soname(filename: &str) -> Option<String> {
        if let Some(so_pos) = filename.find(".so.") {
            let base = &filename[..so_pos + 3];
            let versions = &filename[so_pos + 4..];

            if let Some(major) = versions.split('.').next() {
                return Some(format!("{}.{}", base, major));
            }
        }
        None
    }

    /// Fixes install names and re-signs libraries in a directory.
    pub fn fix(lib_dir: &Path, lib_prefix: &str) -> Result<(), String> {
        let ext = if cfg!(target_os = "macos") {
            ".dylib"
        } else {
            ".so"
        };

        for entry in
            fs::read_dir(lib_dir).map_err(|e| format!("Failed to read directory: {}", e))?
        {
            let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
            let path = entry.path();
            let filename = path.file_name().unwrap().to_string_lossy().to_string();

            if filename.starts_with(lib_prefix) && filename.contains(ext) {
                let metadata = fs::symlink_metadata(&path)
                    .map_err(|e| format!("Failed to get metadata: {}", e))?;

                if metadata.file_type().is_symlink() {
                    continue;
                }

                // Linux: rename libkrunfw to major-version soname
                #[cfg(target_os = "linux")]
                if lib_prefix == "libkrunfw" {
                    if let Some(soname) = Self::extract_major_soname(&filename) {
                        if soname != filename {
                            let new_path = lib_dir.join(&soname);
                            fs::rename(&path, &new_path)
                                .map_err(|e| format!("Failed to rename file: {}", e))?;
                            println!("cargo:warning=Renamed {} to {}", filename, soname);
                            Self::fix_install_name(&soname, &new_path);
                            continue;
                        }
                    }
                }

                Self::fix_install_name(&filename, &path);

                // macOS: re-sign after modifying
                #[cfg(target_os = "macos")]
                {
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
        }

        Ok(())
    }
}

// ── MacToolchain: macOS toolchain discovery ──────────────────────────────────

#[cfg(target_os = "macos")]
struct MacToolchain {
    clang: PathBuf,
    path_dirs: Vec<PathBuf>,
}

#[cfg(target_os = "macos")]
impl MacToolchain {
    /// Sets LIBCLANG_PATH for bindgen if not already set.
    /// This is needed when llvm is installed via brew but not linked (keg-only).
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

    fn find_llvm_clang() -> Option<PathBuf> {
        // If the user has already put a non-Apple clang first in PATH, prefer that.
        if let Some(clang) = Self::find_non_apple_clang_in_path() {
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
        Self::brew_prefix("llvm")
            .map(|prefix| prefix.join("bin/clang"))
            .filter(|clang| clang.exists())
    }

    fn find_lld_bin_dir() -> Option<PathBuf> {
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
        let ld_lld = Self::brew_prefix("lld")
            .map(|prefix| prefix.join("bin/ld.lld"))
            .filter(|path| path.exists())?;

        ld_lld.parent().map(Path::to_path_buf)
    }

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

    /// Discovers the LLVM clang and lld paths, storing them as intermediate state.
    fn discover() -> Result<Self, String> {
        if let Ok(cc_linux) = env::var("BOXLITE_LIBKRUN_CC_LINUX") {
            let cc_linux = cc_linux.trim().to_string();
            if cc_linux.is_empty() {
                return Err("BOXLITE_LIBKRUN_CC_LINUX is set but empty".to_string());
            }
            // User-provided override — no clang discovery needed, but we still
            // need a valid PathBuf. Store the raw string as the clang path.
            return Ok(Self {
                clang: PathBuf::from(cc_linux),
                path_dirs: Vec::new(),
            });
        }

        let clang = Self::find_llvm_clang().ok_or_else(|| {
            "libkrun cross-compilation on macOS requires LLVM clang + lld. Run `make setup` (or `brew install llvm lld`) and retry."
                .to_string()
        })?;

        let mut path_dirs = Vec::new();
        if let Some(dir) = clang.parent() {
            path_dirs.push(dir.to_path_buf());
        }
        if let Some(lld_dir) = Self::find_lld_bin_dir() {
            path_dirs.push(lld_dir);
        }

        Ok(Self { clang, path_dirs })
    }

    /// Converts the discovered toolchain into make arguments and env overrides.
    fn into_make_args(self) -> Result<(String, HashMap<String, String>), String> {
        // If the user provided BOXLITE_LIBKRUN_CC_LINUX, return it directly
        if env::var("BOXLITE_LIBKRUN_CC_LINUX").is_ok() {
            let cc_linux = self.clang.to_string_lossy().to_string();
            return Ok((format!("CC_LINUX={}", cc_linux), HashMap::new()));
        }

        let path_override = Self::prepend_path_dirs(&self.path_dirs);

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
            self.clang.display()
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
        let clang_escaped = {
            let s = self.clang.to_string_lossy();
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

    /// Entry point: discovers the toolchain and produces make arguments.
    pub fn resolve() -> Result<(String, HashMap<String, String>), String> {
        Self::setup_libclang_path();
        Self::discover()?.into_make_args()
    }
}

// ── Musl libc fixup ──────────────────────────────────────────────────────

/// Enables musl `statx` support in the libc crate when building for musl targets.
///
/// Two things are needed for `libc::statx` on musl:
///
/// 1. **libc >= 0.2.175** — older versions (e.g., 0.2.172 pinned in the submodule)
///    only define `statx` for `target_env = "gnu"`. Newer versions add a
///    `musl_v1_2_3` cfg gate that also enables it for musl.
///
/// 2. **`RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1`** — the libc crate's build.rs reads
///    this env var to activate the `musl_v1_2_3` cfg flag, which in turn exposes
///    `statx`, `STATX_BASIC_STATS`, and `STATX_MNT_ID` for musl targets.
///
/// We update the submodule's Cargo.lock at build time (not committed) and set the
/// env var process-wide so the nested `cargo rustc` inherits it.
#[cfg(target_os = "linux")]
fn enable_musl_statx_support(libkrun_src: &Path) {
    let target = env::var("TARGET").unwrap_or_default();
    if !target.contains("musl") {
        return;
    }

    // Step 1: Ensure libc is recent enough to have the musl_v1_2_3 cfg gate
    let cargo_lock = libkrun_src.join("Cargo.lock");
    let content = fs::read_to_string(&cargo_lock).unwrap_or_default();

    if !is_libc_version_sufficient(&content, 175) {
        println!("cargo:warning=Updating libc in vendored libkrun for musl statx support...");
        run_command(
            Command::new("cargo")
                .args(["update", "-p", "libc"])
                .current_dir(libkrun_src)
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit()),
            "cargo update -p libc (musl statx fix)",
        );
    }

    // Step 2: Enable the musl_v1_2_3 cfg flag via env var
    println!("cargo:warning=Enabling musl statx support (RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1)");
    env::set_var("RUST_LIBC_UNSTABLE_MUSL_V1_2_3", "1");
}

/// Checks if libc version in Cargo.lock content has patch version >= min_patch.
/// Expects format: name = "libc"\nversion = "0.2.XXX"
#[cfg(target_os = "linux")]
fn is_libc_version_sufficient(lock_content: &str, min_patch: u32) -> bool {
    let Some(pos) = lock_content.find("name = \"libc\"") else {
        return false;
    };
    let rest = &lock_content[pos..];
    for line in rest.lines().skip(1).take(1) {
        if let Some(ver) = line
            .strip_prefix("version = \"")
            .and_then(|s| s.strip_suffix('"'))
        {
            if let Some(patch_str) = ver.strip_prefix("0.2.") {
                if let Ok(patch) = patch_str.parse::<u32>() {
                    return patch >= min_patch;
                }
            }
        }
    }
    false
}

// ── Platform build orchestration ─────────────────────────────────────────────

/// macOS: Build libkrunfw (dylib, dlopen'd at runtime) and libkrun (static archive)
#[cfg(target_os = "macos")]
fn build() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    let libkrunfw_install = out_dir.join("libkrunfw");
    let libkrun_install = out_dir.join("libkrun");
    let libkrunfw_lib = libkrunfw_install.join(LIB_DIR);

    println!("cargo:warning=Building libkrun-sys for macOS (static libkrun)");

    // Verify vendored libkrun source exists (libkrunfw is downloaded as prebuilt)
    verify_vendored_sources(&manifest_dir, false);

    let libkrun_src = manifest_dir.join("vendor/libkrun");

    // 1. Download and extract prebuilt libkrunfw
    let libkrunfw_src = download_libkrunfw_prebuilt(&out_dir);

    // 2. Build libkrunfw (dylib — dlopen'd by libkrun at runtime)
    build_with_make(
        &libkrunfw_src,
        &libkrunfw_install,
        "libkrunfw",
        &HashMap::new(),
        &[],
    );

    // 3. Build libkrun (init binary → static library → linking)
    let (cc_linux_make_arg, env_overrides) =
        MacToolchain::resolve().unwrap_or_else(|e| panic!("{}", e));
    LibBuilder::build(
        &libkrun_src,
        &libkrun_install,
        &libkrunfw_install,
        &env_overrides,
        &[cc_linux_make_arg],
    );

    // 4. Fix install names for libkrunfw only (it's still a .dylib)
    LibFixup::fix(&libkrunfw_lib, "libkrunfw")
        .unwrap_or_else(|e| panic!("Failed to fix libkrunfw: {}", e));
}

/// Linux: Build libkrun (static archive) with pre-compiled libkrunfw (.so, dlopen'd)
#[cfg(target_os = "linux")]
fn build() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    let libkrunfw_install = out_dir.join("libkrunfw");
    let libkrun_install = out_dir.join("libkrun");
    let libkrunfw_lib_dir = libkrunfw_install.join(LIB_DIR);

    // Check if user wants to build libkrunfw from source (slow, ~20 min)
    let build_from_source = env::var("BOXLITE_BUILD_LIBKRUNFW").is_ok();

    if build_from_source {
        println!(
            "cargo:warning=Building libkrun-sys for Linux (static, BOXLITE_BUILD_LIBKRUNFW=1)"
        );
        verify_vendored_sources(&manifest_dir, true);

        let libkrunfw_src = manifest_dir.join("vendor/libkrunfw");

        build_with_make(
            &libkrunfw_src,
            &libkrunfw_install,
            "libkrunfw",
            &HashMap::new(),
            &[],
        );
    } else {
        println!("cargo:warning=Building libkrun-sys for Linux (static, pre-compiled libkrunfw)");
        verify_vendored_sources(&manifest_dir, false);

        download_libkrunfw_so(&libkrunfw_install);
    }

    let libkrun_src = manifest_dir.join("vendor/libkrun");

    // Enable statx support in the libc crate for musl targets
    enable_musl_statx_support(&libkrun_src);

    // Build libkrun (init binary → static library → linking)
    LibBuilder::build(
        &libkrun_src,
        &libkrun_install,
        &libkrunfw_install,
        &HashMap::new(),
        &[],
    );

    // Fix library names for libkrunfw (still a .so)
    LibFixup::fix(&libkrunfw_lib_dir, "libkrunfw")
        .unwrap_or_else(|e| panic!("Failed to fix libkrunfw: {}", e));
}

// ── Entry point ──────────────────────────────────────────────────────────────

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
        println!("cargo:rustc-link-lib=static=krun");
        println!("cargo:LIBKRUN_BOXLITE_DEP=/nonexistent");
        println!("cargo:LIBKRUNFW_BOXLITE_DEP=/nonexistent");
        return;
    }

    build();
}
