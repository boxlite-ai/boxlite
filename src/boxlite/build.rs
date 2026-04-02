use regex::Regex;
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Find the cargo workspace root by walking up from CARGO_MANIFEST_DIR.
/// Looks for a Cargo.toml containing `[workspace]`.
fn find_workspace_root() -> PathBuf {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let mut dir = manifest_dir.as_path();
    loop {
        let cargo_toml = dir.join("Cargo.toml");
        if cargo_toml.is_file()
            && fs::read_to_string(&cargo_toml)
                .is_ok_and(|contents| contents.contains("[workspace]"))
        {
            return dir.to_path_buf();
        }
        dir = match dir.parent() {
            Some(parent) => parent,
            None => panic!(
                "Could not find workspace root from {}",
                manifest_dir.display()
            ),
        };
    }
}

/// Copies all dynamic library files from source directory to destination.
/// Only copies files with library extensions (.dylib, .so, .so.*, .dll).
/// Preserves symlinks to avoid duplicating the same library multiple times.
fn copy_libs(source: &Path, dest: &Path) -> Result<(), String> {
    if !source.exists() {
        return Err(format!(
            "Source directory does not exist: {}",
            source.display()
        ));
    }

    fs::create_dir_all(dest).map_err(|e| {
        format!(
            "Failed to create destination directory {}: {}",
            dest.display(),
            e
        )
    })?;

    for entry in fs::read_dir(source).map_err(|e| {
        format!(
            "Failed to read source directory {}: {}",
            source.display(),
            e
        )
    })? {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let source_path = entry.path();

        let file_name = source_path.file_name().ok_or("Failed to get filename")?;

        // Only process library files
        if !is_library_file(&source_path) {
            continue;
        }

        let dest_path = dest.join(file_name);

        // Check if source is a symlink
        let metadata = fs::symlink_metadata(&source_path).map_err(|e| {
            format!(
                "Failed to read metadata for {}: {}",
                source_path.display(),
                e
            )
        })?;

        if metadata.file_type().is_symlink() {
            // Skip symlinks - runtime linker uses the full versioned name embedded in the binary
            // (e.g., @rpath/libkrun.1.15.1.dylib, not @rpath/libkrun.dylib)
            // Symlinks are only needed during build-time linking
            continue;
        }

        if metadata.is_file() {
            // Regular file - remove existing file first (maybe read-only)
            if dest_path.exists() {
                fs::remove_file(&dest_path).map_err(|e| {
                    format!(
                        "Failed to remove existing file {}: {}",
                        dest_path.display(),
                        e
                    )
                })?;
            }

            // Copy the file
            fs::copy(&source_path, &dest_path).map_err(|e| {
                format!(
                    "Failed to copy {} -> {}: {}",
                    source_path.display(),
                    dest_path.display(),
                    e
                )
            })?;

            println!(
                "cargo:warning=Bundled library: {}",
                file_name.to_string_lossy()
            );
        }
    }

    Ok(())
}

/// Checks if a file is a dynamic library based on its extension.
fn is_library_file(path: &Path) -> bool {
    let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

    // macOS: .dylib
    if filename.ends_with(".dylib") {
        return true;
    }

    // Linux: .so or .so.VERSION
    if filename.contains(".so") {
        return true;
    }

    // Windows: .dll
    if filename.ends_with(".dll") {
        return true;
    }

    false
}

/// Auto-discovers and bundles all dependencies from -sys crates.
///
/// Convention: Each -sys crate emits `cargo:{NAME}_BOXLITE_DEP=<path>`
/// which becomes `DEP_{LINKS}_{NAME}_BOXLITE_DEP` env var.
///
/// The path can be either:
/// - A directory: copies all library files (.dylib, .so, .dll) from it
/// - A file: copies that single file
///
/// Returns a list of (name, bundled_path) pairs.
fn bundle_boxlite_deps(runtime_dir: &Path) -> Vec<(String, PathBuf)> {
    // Pattern: DEP_{LINKS}_{NAME}_BOXLITE_DEP
    // Example: DEP_KRUN_LIBKRUN_BOXLITE_DEP -> libkrun (directory)
    // Example: DEP_E2FSPROGS_MKE2FS_BOXLITE_DEP -> mke2fs (file)
    let re = Regex::new(r"^DEP_[A-Z0-9]+_([A-Z0-9]+)_BOXLITE_DEP$").unwrap();

    let mut collected = Vec::new();

    for (key, source_path_str) in env::vars() {
        if let Some(caps) = re.captures(&key) {
            let name = caps[1].to_lowercase();
            let source_path = Path::new(&source_path_str);

            if !source_path.exists() {
                panic!("Dependency path does not exist: {}", source_path_str);
            }

            println!(
                "cargo:warning=Found dependency: {} at {}",
                name, source_path_str
            );

            if source_path.is_dir() {
                // Directory: copy library files
                match copy_libs(source_path, runtime_dir) {
                    Ok(()) => {
                        collected.push((name, runtime_dir.to_path_buf()));
                    }
                    Err(e) => {
                        panic!("Failed to copy {}: {}", name, e);
                    }
                }
            } else {
                // File: copy single file
                let file_name = source_path.file_name().expect("Failed to get filename");
                let dest_path = runtime_dir.join(file_name);

                if dest_path.exists() {
                    fs::remove_file(&dest_path).unwrap_or_else(|e| {
                        panic!("Failed to remove {}: {}", dest_path.display(), e)
                    });
                }

                fs::copy(source_path, &dest_path).unwrap_or_else(|e| {
                    panic!(
                        "Failed to copy {} -> {}: {}",
                        source_path.display(),
                        dest_path.display(),
                        e
                    )
                });

                println!("cargo:warning=Bundled: {}", file_name.to_string_lossy());
                collected.push((name, dest_path));
            }
        }
    }

    collected
}

/// Compiles seccomp JSON filters to BPF bytecode at build time.
///
/// This function:
/// 1. Determines the appropriate JSON filter based on target architecture
/// 2. Compiles the JSON to BPF bytecode using seccompiler
/// 3. Saves the binary filter to OUT_DIR/seccomp_filter.bpf
///
/// The compiled filter is embedded in the binary and deserialized at runtime,
/// providing zero-overhead syscall filtering.
#[cfg(target_os = "linux")]
fn compile_seccomp_filters() {
    use std::collections::HashMap;
    use std::convert::TryInto;
    use std::fs;
    use std::io::Cursor;

    let target = env::var("TARGET").expect("Missing TARGET env var");
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").expect("Missing target arch");
    let out_dir = env::var("OUT_DIR").expect("Missing OUT_DIR");

    // Determine JSON path based on target
    let json_path = format!("resources/seccomp/{}.json", target);
    let json_path = if Path::new(&json_path).exists() {
        json_path
    } else {
        println!(
            "cargo:warning=No seccomp filter for {}, using unimplemented.json",
            target
        );
        "resources/seccomp/unimplemented.json".to_string()
    };

    // Compile JSON to BPF bytecode using seccompiler 0.5.0 API
    let bpf_path = format!("{}/seccomp_filter.bpf", out_dir);

    println!(
        "cargo:warning=Compiling seccomp filter: {} -> {}",
        json_path, bpf_path
    );

    // Read JSON file
    let json_content = fs::read(&json_path)
        .unwrap_or_else(|e| panic!("Failed to read seccomp JSON {}: {}", json_path, e));

    // Convert target_arch string to TargetArch enum
    let arch: seccompiler::TargetArch = target_arch
        .as_str()
        .try_into()
        .unwrap_or_else(|e| panic!("Unsupported target architecture {}: {:?}", target_arch, e));

    // Compile JSON to BpfMap using Cursor to satisfy Read trait
    let reader = Cursor::new(json_content);
    let bpf_map = seccompiler::compile_from_json(reader, arch).unwrap_or_else(|e| {
        panic!(
            "Failed to compile seccomp filters from {}: {}",
            json_path, e
        )
    });

    // Convert BpfMap (HashMap<String, Vec<sock_filter>>) to our format (HashMap<String, Vec<u64>>)
    // sock_filter is a C struct that is 8 bytes (u64) per instruction
    let mut converted_map: HashMap<String, Vec<u64>> = HashMap::new();
    for (thread_name, filter) in bpf_map {
        let instructions: Vec<u64> = filter
            .iter()
            .map(|instr| {
                // Convert sock_filter to u64
                // sock_filter is #[repr(C)] with fields: code(u16), jt(u8), jf(u8), k(u32)
                // Layout: [code:2][jt:1][jf:1][k:4] = 8 bytes total
                unsafe { std::mem::transmute_copy(instr) }
            })
            .collect();
        converted_map.insert(thread_name, instructions);
    }

    // Serialize converted map to binary using bincode
    // IMPORTANT: Use the same configuration as runtime deserialization (seccomp.rs)
    let bincode_config = bincode::config::standard().with_fixed_int_encoding();
    let serialized = bincode::encode_to_vec(&converted_map, bincode_config)
        .unwrap_or_else(|e| panic!("Failed to serialize BPF filters: {}", e));

    // Write to output file
    fs::write(&bpf_path, serialized)
        .unwrap_or_else(|e| panic!("Failed to write BPF filter to {}: {}", bpf_path, e));

    println!(
        "cargo:warning=Successfully compiled seccomp filter ({} bytes)",
        fs::metadata(&bpf_path).unwrap().len()
    );

    // Rerun if JSON changes
    println!("cargo:rerun-if-changed={}", json_path);
    println!("cargo:rerun-if-changed=resources/seccomp/");
}

#[cfg(not(target_os = "linux"))]
fn compile_seccomp_filters() {
    // No-op on non-Linux platforms
    println!("cargo:warning=Seccomp compilation skipped (not Linux)");
}

/// Downloads a file from URL using curl.
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

/// Maps the host platform to the runtime artifact target name.
/// Matches the naming convention from config.yml and build-runtime.yml.
fn runtime_target() -> Option<&'static str> {
    let os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();

    match (os.as_str(), arch.as_str()) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("linux", "x86_64") => Some("linux-x64-gnu"),
        ("linux", "aarch64") => Some("linux-arm64-gnu"),
        _ => None,
    }
}

/// Extracts an entire tarball to the destination directory.
fn extract_runtime_tarball(tarball: &Path, dest: &Path) -> io::Result<()> {
    let status = Command::new("tar")
        .args([
            "-xzf",
            tarball.to_str().unwrap(),
            "-C",
            dest.to_str().unwrap(),
            "--strip-components=1",
        ])
        .status()?;

    if !status.success() {
        return Err(io::Error::other("tar extraction failed"));
    }

    Ok(())
}

/// Creates unversioned symlinks for versioned library files.
///
/// Build-time linking (`-lkrun`) requires `libkrun.dylib` (unversioned),
/// but the prebuilt tarball only contains versioned files like `libkrun.1.16.0.dylib`.
/// This creates the symlinks that `make install` would normally create.
///
/// Patterns:
/// - macOS: `libfoo.1.2.3.dylib` → `libfoo.dylib`
/// - Linux: `libfoo.so.1.2.3` → `libfoo.so`
fn create_library_symlinks(dir: &Path) {
    // macOS: lib<name>.<version>.dylib → lib<name>.dylib
    // Linux: lib<name>.so.<version>    → lib<name>.so
    let re = Regex::new(r"^(lib\w+)\.(\d+\.)*\d+\.dylib$|^(lib\w+\.so)\.\d+(\.\d+)*$").unwrap();

    let entries: Vec<_> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .collect();

    for entry in &entries {
        let filename = entry.file_name();
        let filename = filename.to_string_lossy();

        if let Some(caps) = re.captures(&filename) {
            // Group 1 = macOS base (e.g., "libkrun"), Group 3 = Linux base (e.g., "libkrun.so")
            let base = caps.get(1).or(caps.get(3)).map(|m| m.as_str());
            if let Some(base) = base {
                let symlink_name = if caps.get(1).is_some() {
                    format!("{}.dylib", base)
                } else {
                    base.to_string()
                };

                let symlink_path = dir.join(&symlink_name);
                if !symlink_path.exists() {
                    #[cfg(unix)]
                    {
                        // Relative symlink: libkrun.dylib → libkrun.1.16.0.dylib
                        std::os::unix::fs::symlink(filename.as_ref(), &symlink_path).ok();
                        println!(
                            "cargo:warning=Created symlink: {} -> {}",
                            symlink_name, filename
                        );
                    }
                }
            }
        }
    }
}

/// Downloads prebuilt runtime binaries from GitHub Releases.
///
/// Called when BOXLITE_DEPS_STUB is set (i.e., -sys crates skipped their builds).
/// Downloads the full `boxlite-runtime-v{version}-{target}.tar.gz` tarball which contains
/// all native libraries (libkrun, libgvproxy, etc.) and tool binaries.
fn download_prebuilt_runtime(runtime_dir: &Path) {
    // Skip if already downloaded (check for any library file)
    if runtime_dir.exists()
        && fs::read_dir(runtime_dir)
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .any(|e| is_library_file(&e.path()))
            })
            .unwrap_or(false)
    {
        println!("cargo:warning=Prebuilt runtime already present, skipping download");
        return;
    }

    let target = match runtime_target() {
        Some(t) => t,
        None => {
            println!("cargo:warning=Unsupported platform for prebuilt download, skipping");
            return;
        }
    };

    let version = env::var("CARGO_PKG_VERSION").unwrap();
    let default_url = format!(
        "https://github.com/boxlite-ai/boxlite/releases/download/v{version}/boxlite-runtime-v{version}-{target}.tar.gz"
    );

    println!("cargo:rerun-if-env-changed=BOXLITE_RUNTIME_URL");
    let url = env::var("BOXLITE_RUNTIME_URL").unwrap_or(default_url);

    fs::create_dir_all(runtime_dir)
        .unwrap_or_else(|e| panic!("Failed to create runtime directory: {}", e));

    let tarball_path = runtime_dir.join("boxlite-runtime.tar.gz");

    match download_file(&url, &tarball_path) {
        Ok(()) => {}
        Err(e) => {
            println!(
                "cargo:warning=Failed to download prebuilt runtime from {}: {}",
                url, e
            );
            println!("cargo:warning=Native libraries will not be available.");
            return;
        }
    }

    match extract_runtime_tarball(&tarball_path, runtime_dir) {
        Ok(()) => {
            // Clean up tarball before listing
            fs::remove_file(&tarball_path).ok();

            // Create unversioned symlinks for build-time linking
            create_library_symlinks(runtime_dir);

            let files: Vec<_> = fs::read_dir(runtime_dir)
                .into_iter()
                .flatten()
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            println!(
                "cargo:warning=Downloaded prebuilt runtime v{}: [{}]",
                version,
                files.join(", ")
            );
        }
        Err(e) => {
            fs::remove_file(&tarball_path).ok();
            println!("cargo:warning=Failed to extract runtime tarball: {}", e);
        }
    }
}

/// How native dependencies are resolved.
///
/// Controlled by the `BOXLITE_DEPS_STUB` environment variable:
/// - unset  → `Source`:   build -sys crates from source, bundle outputs
/// - `1`    → `Stub`:     skip everything, for CI `cargo check`/`cargo clippy`
/// - `2`    → `Prebuilt`: skip -sys builds, download prebuilt from GitHub Releases
enum DepsMode {
    Source,
    Stub,
    Prebuilt,
}

impl DepsMode {
    fn from_env() -> Self {
        match env::var("BOXLITE_DEPS_STUB").ok().as_deref() {
            Some("2") => Self::Prebuilt,
            Some(_) => Self::Stub,
            None => Self::Source,
        }
    }
}

/// Auto-set BOXLITE_DEPS_STUB=2 when downloaded from a registry (crates.io).
/// Cargo adds .cargo_vcs_info.json to published packages.
fn auto_detect_registry() {
    if env::var("BOXLITE_DEPS_STUB").is_err() {
        let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
        if manifest_dir.join(".cargo_vcs_info.json").exists() {
            // SAFETY: build.rs is single-threaded; no concurrent env var access.
            unsafe { env::set_var("BOXLITE_DEPS_STUB", "2") };
        }
    }
}

// ── Embedded runtime manifest generation ────────────────────────────────

/// Embedded runtime manifest generator.
///
/// Lightweight handle that stores the runtime directory path.
/// Call `generate()` to scan the directory, write `embedded_manifest.rs`,
/// and emit content hashes via `cargo:rustc-env`.
struct EmbeddedManifest {
    runtime_dir: PathBuf,
}

impl EmbeddedManifest {
    /// Create a manifest generator for the given runtime directory.
    fn new(runtime_dir: &Path) -> Self {
        Self {
            runtime_dir: runtime_dir.to_path_buf(),
        }
    }

    /// Scan `runtime_dir` for regular files (skipping symlinks/directories).
    fn scan_entries(&self) -> Vec<(String, PathBuf)> {
        let mut entries = Vec::new();
        if self.runtime_dir.exists() {
            for entry in fs::read_dir(&self.runtime_dir)
                .unwrap_or_else(|e| panic!("Failed to read runtime dir: {}", e))
            {
                let entry = entry.unwrap();
                let path = entry.path();

                let meta = fs::symlink_metadata(&path).unwrap();
                if !meta.is_file() {
                    continue;
                }

                let name = entry.file_name().to_string_lossy().to_string();
                entries.push((name, path));
            }
        }
        // Sort for deterministic code generation and hashing
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        entries
    }

    // ── Private helpers ─────────────────────────────────────────────

    fn emit_manifest(manifest_path: &Path, entries: &[(String, PathBuf)]) {
        Self::write_manifest_rs(manifest_path, entries);
        Self::emit_content_hash(entries);
        if !entries.is_empty() {
            Self::log_summary(entries);
        }
    }

    fn write_manifest_rs(manifest_path: &Path, entries: &[(String, PathBuf)]) {
        if entries.is_empty() {
            fs::write(
                manifest_path,
                "// Auto-generated by build.rs — no embedded files\n\
                 pub const MANIFEST: &[(&str, &[u8])] = &[];\n",
            )
            .unwrap_or_else(|e| panic!("Failed to write empty manifest: {}", e));
            return;
        }

        let mut code = String::from("// Auto-generated by build.rs — do not edit\n");
        code.push_str("pub const MANIFEST: &[(&str, &[u8])] = &[\n");
        for (name, path) in entries {
            let abs = path.to_string_lossy().replace('\\', "/");
            code.push_str(&format!(
                "    (\"{}\", include_bytes!(\"{}\")),\n",
                name, abs
            ));
            println!("cargo:rerun-if-changed={}", path.display());
        }
        code.push_str("];\n");

        fs::write(manifest_path, &code)
            .unwrap_or_else(|e| panic!("Failed to write embedded manifest: {}", e));
    }

    fn emit_content_hash(entries: &[(String, PathBuf)]) {
        let mut hasher = Sha256::new();
        for (name, path) in entries {
            hasher.update(name.as_bytes());
            let content = fs::read(path)
                .unwrap_or_else(|e| panic!("Failed to read {} for hashing: {}", path.display(), e));
            hasher.update(&content);
        }
        let hash = format!("{:x}", hasher.finalize());
        let prefix = &hash[..12];
        println!("cargo:rustc-env=BOXLITE_MANIFEST_HASH={}", prefix);
        println!(
            "cargo:rustc-env=BOXLITE_BUILD_PROFILE={}",
            env::var("PROFILE").unwrap()
        );
        println!("cargo:warning=Embedded manifest hash: {}", prefix);
    }

    fn log_summary(entries: &[(String, PathBuf)]) {
        let total_size: u64 = entries
            .iter()
            .map(|(_, p)| fs::metadata(p).map(|m| m.len()).unwrap_or(0))
            .sum();
        println!(
            "cargo:warning=Embedded runtime: {} files, {:.1} MB total",
            entries.len(),
            total_size as f64 / (1024.0 * 1024.0)
        );
    }

    // ── Embedded manifest generation ────────────────────────────────

    /// Top-level entry point for embedded manifest generation.
    ///
    /// When `embedded-runtime` feature is enabled and deps are available (Source mode),
    /// finds pre-built shim/guest binaries, copies them to the runtime dir, and generates
    /// an `include_bytes!` manifest for all files in the runtime dir.
    ///
    /// When the feature is off or in Stub mode, generates an empty manifest.
    fn generate(&self, mode: &DepsMode) {
        let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
        let manifest_path = out_dir.join("embedded_manifest.rs");

        let enabled = env::var("CARGO_FEATURE_EMBEDDED_RUNTIME").is_ok();

        if !enabled || matches!(mode, DepsMode::Stub) {
            Self::emit_manifest(&manifest_path, &[]);
            return;
        }

        // Feature enabled: collect pre-built binaries into runtime_dir,
        // then generate include_bytes! for all files.
        let workspace_root = find_workspace_root();

        fs::create_dir_all(&self.runtime_dir)
            .unwrap_or_else(|e| panic!("Failed to create runtime directory: {}", e));

        let profile = env::var("PROFILE").unwrap();

        self.copy_prebuilt_binary(
            &workspace_root,
            "boxlite-shim",
            &profile,
            Self::find_prebuilt_shim,
        );
        self.copy_prebuilt_binary(
            &workspace_root,
            "boxlite-guest",
            &profile,
            Self::find_prebuilt_guest,
        );

        let entries = self.scan_entries();
        Self::emit_manifest(&manifest_path, &entries);
    }

    /// Copy a pre-built binary into the runtime directory.
    ///
    /// Always overwrites the destination to avoid stale binaries when the source
    /// is rebuilt. Emits `cargo:rerun-if-changed` for the source path so cargo
    /// re-runs build.rs when the binary changes.
    ///
    /// Uses the provided `finder` function to locate the binary. If not found,
    /// warns and skips — this happens when building boxlite-shim itself (the
    /// binary doesn't exist yet). The embedded manifest will simply omit it.
    fn copy_prebuilt_binary(
        &self,
        workspace_root: &Path,
        name: &str,
        profile: &str,
        finder: fn(&Path, &str) -> Option<PathBuf>,
    ) {
        let Some(source) = finder(workspace_root, profile) else {
            println!("cargo:warning={} not found, skipping embed", name);
            return;
        };

        // Re-run build.rs when the source binary changes.
        println!("cargo:rerun-if-changed={}", source.display());

        let dest = self.runtime_dir.join(name);
        fs::copy(&source, &dest).unwrap_or_else(|e| {
            panic!(
                "Failed to copy {} -> {}: {}",
                source.display(),
                dest.display(),
                e
            )
        });

        println!(
            "cargo:warning=Embedded {}: {} ({:.1} MB)",
            name,
            source.display(),
            fs::metadata(&dest).map(|m| m.len()).unwrap_or(0) as f64 / (1024.0 * 1024.0)
        );
    }

    /// Find pre-built boxlite-shim binary for the given build profile.
    ///
    /// Search order:
    /// 1. Native: `target/{profile}/boxlite-shim` (macOS)
    /// 2. Linux gnu: `target/{arch}-unknown-linux-gnu/{profile}/boxlite-shim` (static glibc)
    fn find_prebuilt_shim(workspace_root: &Path, profile: &str) -> Option<PathBuf> {
        let target_dir = workspace_root.join("target");

        // Native path (macOS)
        let native = target_dir.join(profile).join("boxlite-shim");
        if native.is_file() {
            return Some(native);
        }

        // Linux gnu (static glibc — Go c-archive is incompatible with musl TLS)
        // Check matching architecture first to avoid picking wrong binary on
        // multi-arch machines.
        for arch in Self::preferred_arches() {
            let gnu = target_dir
                .join(format!("{}-unknown-linux-gnu", arch))
                .join(profile)
                .join("boxlite-shim");
            if gnu.is_file() {
                return Some(gnu);
            }
        }

        None
    }

    /// Find pre-built boxlite-guest binary for the given build profile.
    ///
    /// Checks matching architecture first to avoid picking wrong binary on
    /// multi-arch machines (e.g., x86_64 guest embedded into aarch64 build).
    fn find_prebuilt_guest(workspace_root: &Path, profile: &str) -> Option<PathBuf> {
        let target_dir = workspace_root.join("target");

        // Check matching architecture first, then fall back to others
        for arch in Self::preferred_arches() {
            let path = target_dir
                .join(format!("{}-unknown-linux-musl", arch))
                .join(profile)
                .join("boxlite-guest");
            if path.is_file() {
                return Some(path);
            }
        }

        None
    }

    /// Return architecture list with the build target's arch first.
    ///
    /// On multi-arch machines with both x86_64 and aarch64 binaries built,
    /// this ensures we pick the one matching the current build target.
    fn preferred_arches() -> Vec<&'static str> {
        let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
        match arch.as_str() {
            "aarch64" => vec!["aarch64", "x86_64"],
            "x86_64" => vec!["x86_64", "aarch64"],
            _ => vec!["x86_64", "aarch64"],
        }
    }
}

/// Collects all FFI dependencies into a single runtime directory.
/// This directory can be used by downstream crates (e.g., Python SDK) to
/// bundle all required libraries and binaries together.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=BOXLITE_DEPS_STUB");

    auto_detect_registry();

    // Compile KVM smoke test helper (C, Linux only).
    // Rust's libc::ioctl() variadic FFI has ABI issues with some KVM ioctls
    // on nested virtualization, so the smoke test is implemented in C.
    #[cfg(target_os = "linux")]
    {
        println!("cargo:rerun-if-changed=src/kvm_smoke.c");
        cc::Build::new()
            .file("src/kvm_smoke.c")
            .compile("kvm_smoke");
    }

    // Compile seccomp filters at build time (fast, required for include_bytes!())
    compile_seccomp_filters();

    let mode = DepsMode::from_env();

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let runtime_dir = out_dir.join("runtime");

    match &mode {
        DepsMode::Stub => {
            // Check-only mode: skip dependency bundling but still generate
            // the embedded manifest (needed for env!() macros in embedded.rs)
            println!("cargo:warning=BOXLITE_DEPS_STUB=1: skipping dependency bundling");
            println!("cargo:runtime_dir=/nonexistent");
            EmbeddedManifest::new(&runtime_dir).generate(&mode);
            return;
        }
        DepsMode::Prebuilt => {
            // Download prebuilt runtime from GitHub Releases
            println!("cargo:warning=BOXLITE_DEPS_STUB=2: downloading prebuilt runtime");
            fs::create_dir_all(&runtime_dir)
                .unwrap_or_else(|e| panic!("Failed to create runtime directory: {}", e));
            download_prebuilt_runtime(&runtime_dir);
            // Embed runtime directory for compile-time fallback by RuntimeBinaryFinder.
            // Runtime override remains BOXLITE_RUNTIME_DIR (read via std::env::var).
            // Compile-time embed is only needed in prebuilt mode.
            println!(
                "cargo:rustc-env=BOXLITE_RUNTIME_DIR={}",
                runtime_dir.display()
            );
        }
        DepsMode::Source => {
            // Normal: -sys crates built from source, bundle outputs
            fs::create_dir_all(&runtime_dir)
                .unwrap_or_else(|e| panic!("Failed to create runtime directory: {}", e));
            let collected = bundle_boxlite_deps(&runtime_dir);
            if !collected.is_empty() {
                let names: Vec<_> = collected.iter().map(|(name, _)| name.as_str()).collect();
                println!("cargo:warning=Bundled: {}", names.join(", "));
            }
        }
    };

    // Tell the linker where to find the bundled libraries.
    println!("cargo:rustc-link-search=native={}", runtime_dir.display());

    // Expose the runtime directory to downstream crates (e.g., Python SDK)
    println!("cargo:runtime_dir={}", runtime_dir.display());

    // Compute and embed guest binary hash at compile time (best-effort).
    // Falls back to runtime computation if the binary isn't available yet.
    compute_guest_hash(&runtime_dir);

    // Generate embedded runtime manifest (include_bytes! for self-contained SDKs)
    EmbeddedManifest::new(&runtime_dir).generate(&mode);

    // Set rpath for boxlite-shim
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");
    #[cfg(target_os = "linux")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
}

/// Compute SHA256 hash of the `boxlite-guest` binary and embed it via `cargo:rustc-env`.
///
/// Search order:
/// 1. Direct build output: `target/{target-triple}/{profile}/boxlite-guest`
/// 2. `runtime_dir` (OUT_DIR/runtime/ — for prebuilt mode)
///
/// IMPORTANT: The source binary (direct build output) must be checked FIRST because
/// `compute_guest_hash` runs before `generate()` in main(). The OUT_DIR/runtime/ copy
/// is placed there by a previous build's `generate()` and may be stale when the guest
/// binary has been rebuilt since then.
///
/// If the binary isn't found, silently skips — runtime will compute the hash as fallback.
fn compute_guest_hash(runtime_dir: &Path) {
    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());

    // Check source binary first (direct build output) to avoid stale OUT_DIR copies.
    let workspace_root = find_workspace_root();
    let guest_path =
        EmbeddedManifest::find_prebuilt_guest(&workspace_root, &profile).or_else(|| {
            // Fallback: OUT_DIR copy (for prebuilt/CI mode where source isn't available)
            let p = runtime_dir.join("boxlite-guest");
            p.is_file().then_some(p)
        });

    let Some(guest_path) = guest_path else {
        println!("cargo:warning=boxlite-guest not found, skipping compile-time hash");
        return;
    };

    match sha256_file(&guest_path) {
        Ok(hash) => {
            println!("cargo:rustc-env=BOXLITE_GUEST_HASH={}", hash);
            println!("cargo:rerun-if-changed={}", guest_path.display());
            println!(
                "cargo:warning=Embedded guest hash: {}... (from {})",
                &hash[..12],
                guest_path.display()
            );
        }
        Err(e) => {
            println!(
                "cargo:warning=Failed to hash boxlite-guest at {}: {}",
                guest_path.display(),
                e
            );
        }
    }
}

/// Compute SHA256 hex digest of a file.
fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
