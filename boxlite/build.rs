use regex::Regex;
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

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
/// Downloads the full `boxlite-runtime-{target}.tar.gz` tarball which contains
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
        "https://github.com/boxlite-ai/boxlite/releases/download/v{}/boxlite-runtime-{}.tar.gz",
        version, target
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

/// Collects all FFI dependencies into a single runtime directory.
/// This directory can be used by downstream crates (e.g., Python SDK) to
/// bundle all required libraries and binaries together.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=BOXLITE_DEPS_STUB");

    auto_detect_registry();

    // Compile seccomp filters at build time (fast, required for include_bytes!())
    compile_seccomp_filters();

    let mode = DepsMode::from_env();

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let runtime_dir = out_dir.join("runtime");

    match mode {
        DepsMode::Stub => {
            // Check-only mode: skip everything, return early
            println!("cargo:warning=BOXLITE_DEPS_STUB=1: skipping dependency bundling");
            println!("cargo:runtime_dir=/nonexistent");
            return;
        }
        DepsMode::Prebuilt => {
            // Download prebuilt runtime from GitHub Releases
            println!("cargo:warning=BOXLITE_DEPS_STUB=2: downloading prebuilt runtime");
            fs::create_dir_all(&runtime_dir)
                .unwrap_or_else(|e| panic!("Failed to create runtime directory: {}", e));
            download_prebuilt_runtime(&runtime_dir);
            // -sys crates emit rustc-link-lib in STUB mode.
            // Tell the linker where to find the prebuilt libraries.
            println!("cargo:rustc-link-search=native={}", runtime_dir.display());
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
    }

    // Expose the runtime directory to downstream crates (e.g., Python SDK)
    println!("cargo:runtime_dir={}", runtime_dir.display());

    // Embed runtime directory for compile-time discovery by RuntimeBinaryFinder.
    // option_env!("BOXLITE_RUNTIME_DIR") reads this at compile time.
    // std::env::var("BOXLITE_RUNTIME_DIR") at runtime takes priority (checked first).
    println!(
        "cargo:rustc-env=BOXLITE_RUNTIME_DIR={}",
        runtime_dir.display()
    );

    // Compute and embed guest binary hash at compile time (best-effort).
    // Falls back to runtime computation if the binary isn't available yet.
    compute_guest_hash(&runtime_dir);

    // Set rpath for boxlite-shim
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");
    #[cfg(target_os = "linux")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
}

/// Compute SHA256 hash of the `boxlite-guest` binary and embed it via `cargo:rustc-env`.
///
/// Search order:
/// 1. `runtime_dir` (OUT_DIR/runtime/ — for prebuilt mode)
/// 2. `target/boxlite-runtime/boxlite-guest` (assembled by `make runtime-debug`)
///
/// If the binary isn't found, silently skips — runtime will compute the hash as fallback.
fn compute_guest_hash(runtime_dir: &Path) {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());

    let candidates = [
        runtime_dir.join("boxlite-guest"),
        manifest_dir
            .parent()
            .map(|root| root.join("target/boxlite-runtime/boxlite-guest"))
            .unwrap_or_default(),
    ];

    let guest_path = candidates.iter().find(|p| p.is_file());

    let Some(guest_path) = guest_path else {
        println!("cargo:warning=boxlite-guest not found, skipping compile-time hash");
        return;
    };

    match sha256_file(guest_path) {
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
