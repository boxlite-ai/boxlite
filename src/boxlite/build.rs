use regex::Regex;
use sha2::{Digest, Sha256};
use std::cell::OnceCell;
use std::env;
use std::fs;
use std::io;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Cargo build-script facts shared across runtime preparation steps.
struct CargoBuildContext {
    manifest_dir: PathBuf,
    out_dir: PathBuf,
    // Resolve lazily so registry/prebuilt builds do not require a source workspace.
    workspace_root: OnceCell<Option<PathBuf>>,
}

impl CargoBuildContext {
    /// Capture the Cargo environment values this build script needs.
    fn new() -> Self {
        let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
        let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

        Self {
            manifest_dir,
            out_dir,
            workspace_root: OnceCell::new(),
        }
    }

    /// Return Cargo's build output directory.
    fn out_dir(&self) -> &Path {
        &self.out_dir
    }

    /// Return the source workspace root when this build is inside one.
    fn workspace_root(&self) -> Option<&Path> {
        self.workspace_root
            .get_or_init(|| Self::find_workspace_root(&self.manifest_dir))
            .as_deref()
    }

    /// Cargo includes this file in crates produced by `cargo package`.
    fn is_packaged(&self) -> bool {
        self.manifest_dir.join(".cargo_vcs_info.json").is_file()
    }

    /// Find the cargo workspace root by walking up from CARGO_MANIFEST_DIR.
    /// Looks for a Cargo.toml containing `[workspace]`.
    fn find_workspace_root(manifest_dir: &Path) -> Option<PathBuf> {
        let mut dir = manifest_dir;
        loop {
            let cargo_toml = dir.join("Cargo.toml");
            if cargo_toml.is_file()
                && fs::read_to_string(&cargo_toml)
                    .is_ok_and(|contents| contents.contains("[workspace]"))
            {
                return Some(dir.to_path_buf());
            }
            dir = match dir.parent() {
                Some(parent) => parent,
                None => {
                    println!(
                        "cargo:warning=BoxLite workspace root was not found from {}; source runtime embedding will be skipped unless a prebuilt runtime is available",
                        manifest_dir.display()
                    );
                    return None;
                }
            };
        }
    }
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
/// Skip seccomp filter generation on non-Linux targets.
fn compile_seccomp_filters() {
    // No-op on non-Linux platforms
    println!("cargo:warning=Seccomp compilation skipped (not Linux)");
}

/// Prebuilt runtime artifact state under OUT_DIR/runtime.
struct PrebuiltRuntime {
    runtime_dir: PathBuf,
}

impl PrebuiltRuntime {
    const FILE_MANIFEST: &'static str = ".boxlite-runtime-files";
    const TARBALL_NAME: &'static str = "boxlite-runtime.tar.gz";

    /// Create a handle for an extracted prebuilt runtime directory.
    fn new(runtime_dir: &Path) -> Self {
        Self {
            runtime_dir: runtime_dir.to_path_buf(),
        }
    }

    /// Return the generated file manifest path.
    fn manifest_path(&self) -> PathBuf {
        self.runtime_dir.join(Self::FILE_MANIFEST)
    }

    /// List runtime files and symlinks that came from the release artifact.
    fn scan_file_names(&self) -> io::Result<Vec<String>> {
        let mut files = Vec::new();
        for entry in fs::read_dir(&self.runtime_dir)? {
            let entry = entry?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name == Self::FILE_MANIFEST || name == Self::TARBALL_NAME {
                continue;
            }

            let metadata = fs::symlink_metadata(&path)?;
            if metadata.is_file() || metadata.file_type().is_symlink() {
                files.push(name);
            }
        }
        files.sort();
        Ok(files)
    }

    /// Write the artifact-defined runtime file manifest.
    fn write_file_manifest(&self) -> io::Result<Vec<String>> {
        let files = self.scan_file_names()?;
        if files.is_empty() {
            return Err(io::Error::other(
                "prebuilt runtime did not contain any files",
            ));
        }

        let mut contents = String::new();
        for file in &files {
            contents.push_str(file);
            contents.push('\n');
        }
        // The release artifact defines the required runtime set; avoid OS-specific lists here.
        fs::write(self.manifest_path(), contents)?;
        Ok(files)
    }

    /// Read the artifact-defined runtime file manifest.
    fn read_file_manifest(&self) -> io::Result<Vec<String>> {
        let contents = fs::read_to_string(self.manifest_path())?;
        Ok(contents
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(ToOwned::to_owned)
            .collect())
    }

    /// Return user-facing reasons why the runtime cannot be embedded.
    fn incomplete_reasons(&self) -> Vec<String> {
        if !self.runtime_dir.exists() {
            return vec!["runtime directory missing".to_string()];
        }

        let files = match self.read_file_manifest() {
            Ok(files) => files,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return vec!["prebuilt runtime manifest missing".to_string()];
            }
            Err(e) => return vec![format!("failed to read prebuilt runtime manifest: {e}")],
        };

        if files.is_empty() {
            return vec!["prebuilt runtime manifest is empty".to_string()];
        }

        files
            .into_iter()
            .filter(|name| !self.runtime_dir.join(name).exists())
            .map(|name| format!("missing manifest entry {name}"))
            .collect()
    }

    /// Return true when every manifest-listed runtime file exists.
    fn is_complete(&self) -> bool {
        self.incomplete_reasons().is_empty()
    }

    /// Maps the Cargo build target to the runtime artifact target name.
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

    /// Extracts an entire tarball to the runtime directory.
    fn extract_tarball(&self, tarball: &Path) -> io::Result<()> {
        let status = Command::new("tar")
            .args([
                "-xzf",
                tarball.to_str().unwrap(),
                "-C",
                self.runtime_dir.to_str().unwrap(),
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
    fn create_library_symlinks(&self) {
        // macOS: lib<name>.<version>.dylib → lib<name>.dylib
        // Linux: lib<name>.so.<version>    → lib<name>.so
        let re = Regex::new(r"^(lib\w+)\.(\d+\.)*\d+\.dylib$|^(lib\w+\.so)\.\d+(\.\d+)*$").unwrap();

        let entries: Vec<_> = fs::read_dir(&self.runtime_dir)
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

                    let symlink_path = self.runtime_dir.join(&symlink_name);
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
    /// Used by packaged crates, whose repository-built runtime is unavailable.
    /// Downloads the full `boxlite-runtime-v{version}-{target}.tar.gz` tarball which contains
    /// all native libraries (libkrun, libgvproxy, etc.) and tool binaries.
    fn download(&self) -> bool {
        if self.is_complete() {
            println!("cargo:warning=Prebuilt runtime already present, skipping download");
            return true;
        }

        let target = match Self::runtime_target() {
            Some(t) => t,
            None => {
                println!("cargo:warning=Unsupported platform for prebuilt download, skipping");
                return false;
            }
        };

        let version = env::var("CARGO_PKG_VERSION").unwrap();
        let default_url = format!(
            "https://github.com/boxlite-ai/boxlite/releases/download/v{version}/boxlite-runtime-v{version}-{target}.tar.gz"
        );

        println!("cargo:rerun-if-env-changed=BOXLITE_RUNTIME_URL");
        let url = env::var("BOXLITE_RUNTIME_URL").unwrap_or(default_url);

        fs::create_dir_all(&self.runtime_dir)
            .unwrap_or_else(|e| panic!("Failed to create runtime directory: {}", e));

        let tarball_path = self.runtime_dir.join(Self::TARBALL_NAME);

        match Self::download_file(&url, &tarball_path) {
            Ok(()) => {}
            Err(e) => {
                println!(
                    "cargo:warning=Failed to download prebuilt runtime from {}: {}",
                    url, e
                );
                println!("cargo:warning=Native libraries will not be available.");
                return false;
            }
        }

        match self.extract_tarball(&tarball_path) {
            Ok(()) => {
                // Clean up tarball before listing
                fs::remove_file(&tarball_path).ok();

                // Create unversioned symlinks for build-time linking
                self.create_library_symlinks();

                let files = match self.write_file_manifest() {
                    Ok(files) => files,
                    Err(e) => {
                        println!("cargo:warning=Failed to write runtime manifest: {}", e);
                        return false;
                    }
                };
                println!(
                    "cargo:warning=Downloaded prebuilt runtime v{}: [{}]",
                    version,
                    files.join(", ")
                );
                let incomplete = self.incomplete_reasons();
                if !incomplete.is_empty() {
                    println!(
                        "cargo:warning=Prebuilt runtime is incomplete: {}",
                        incomplete.join(", ")
                    );
                    return false;
                }
                true
            }
            Err(e) => {
                fs::remove_file(&tarball_path).ok();
                println!("cargo:warning=Failed to extract runtime tarball: {}", e);
                false
            }
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
    fn scan_entries(&self) -> Vec<(String, PathBuf, u32)> {
        let mut entries = Vec::new();
        if self.runtime_dir.exists() {
            for entry in fs::read_dir(&self.runtime_dir)
                .unwrap_or_else(|e| panic!("Failed to read runtime dir: {}", e))
            {
                let entry = entry.unwrap();
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if name == PrebuiltRuntime::FILE_MANIFEST {
                    continue;
                }

                let meta = fs::symlink_metadata(&path).unwrap();
                if !meta.is_file() {
                    continue;
                }

                let mode = Self::file_mode(&path);
                entries.push((name, path, mode));
            }
        }
        // Sort for deterministic code generation and hashing
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        entries
    }

    // ── Private helpers ─────────────────────────────────────────────

    /// Write the generated manifest and emit its build metadata.
    fn emit_manifest(manifest_path: &Path, entries: &[(String, PathBuf, u32)]) {
        Self::write_manifest_rs(manifest_path, entries);
        Self::emit_content_hash(entries);
        if !entries.is_empty() {
            Self::log_summary(entries);
        }
    }

    /// Generate the Rust source included by runtime::embedded.
    fn write_manifest_rs(manifest_path: &Path, entries: &[(String, PathBuf, u32)]) {
        if entries.is_empty() {
            fs::write(
                manifest_path,
                "// Auto-generated by build.rs — no embedded files\n\
                 pub const MANIFEST: &[(&str, u32, &[u8])] = &[];\n",
            )
            .unwrap_or_else(|e| panic!("Failed to write empty manifest: {}", e));
            return;
        }

        let mut code = String::from("// Auto-generated by build.rs — do not edit\n");
        code.push_str("pub const MANIFEST: &[(&str, u32, &[u8])] = &[\n");
        for (name, path, mode) in entries {
            let abs = path.to_string_lossy().replace('\\', "/");
            code.push_str(&format!(
                "    (\"{}\", 0o{:o}, include_bytes!(\"{}\")),\n",
                name, mode, abs
            ));
            println!("cargo:rerun-if-changed={}", path.display());
        }
        code.push_str("];\n");

        fs::write(manifest_path, &code)
            .unwrap_or_else(|e| panic!("Failed to write embedded manifest: {}", e));
    }

    /// Hash manifest names, modes, and bytes for cache invalidation.
    fn emit_content_hash(entries: &[(String, PathBuf, u32)]) {
        let mut hasher = Sha256::new();
        for (name, path, mode) in entries {
            hasher.update(name.as_bytes());
            hasher.update(mode.to_le_bytes());
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

    /// Log the generated embedded runtime size summary.
    fn log_summary(entries: &[(String, PathBuf, u32)]) {
        let total_size: u64 = entries
            .iter()
            .map(|(_, p, _)| fs::metadata(p).map(|m| m.len()).unwrap_or(0))
            .sum();
        println!(
            "cargo:warning=Embedded runtime: {} files, {:.1} MB total",
            entries.len(),
            total_size as f64 / (1024.0 * 1024.0)
        );
    }

    /// Return the Unix permission bits to preserve in the generated manifest.
    fn file_mode(path: &Path) -> u32 {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::metadata(path)
                .map(|metadata| metadata.permissions().mode() & 0o777)
                .unwrap_or(0o644)
        }

        #[cfg(not(unix))]
        {
            let _ = path;
            0o644
        }
    }

    // ── Embedded manifest generation ────────────────────────────────

    /// Top-level entry point for embedded manifest generation.
    ///
    /// Embeds files from the prepared runtime directory.
    ///
    /// When the feature is off, generates an empty manifest.
    fn generate(&self, cargo: &CargoBuildContext) {
        let manifest_path = cargo.out_dir().join("embedded_manifest.rs");

        let enabled = env::var("CARGO_FEATURE_EMBEDDED_RUNTIME").is_ok();

        if !enabled {
            Self::write_manifest_rs(&manifest_path, &[]);
            return;
        }

        let entries = self.scan_entries();
        Self::emit_manifest(&manifest_path, &entries);
    }
}
/// Computes and embeds the `boxlite-guest` hash from the assembled runtime.
///
/// If the binary isn't found, silently skips — runtime will compute the hash as fallback.
struct GuestBinaryHash<'a> {
    runtime_dir: &'a Path,
}

impl<'a> GuestBinaryHash<'a> {
    /// Create a guest binary hash emitter.
    fn new(runtime_dir: &'a Path) -> Self {
        Self { runtime_dir }
    }

    /// Emit BOXLITE_GUEST_HASH when a guest binary is available.
    fn emit(&self) {
        let Some(guest_path) = self.guest_path() else {
            println!("cargo:warning=boxlite-guest not found, skipping compile-time hash");
            return;
        };

        match Self::sha256_file(&guest_path) {
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

    /// Find the guest binary in the assembled runtime.
    fn guest_path(&self) -> Option<PathBuf> {
        let path = self.runtime_dir.join("boxlite-guest");
        path.is_file().then_some(path)
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
}

/// Collects all FFI dependencies into a single runtime directory.
/// This directory can be used by downstream crates (e.g., Python SDK) to
/// bundle all required libraries and binaries together.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");

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

    let cargo = CargoBuildContext::new();
    let packaged = cargo.is_packaged();
    let embedded_runtime = env::var("CARGO_FEATURE_EMBEDDED_RUNTIME").is_ok();

    let runtime_dir = cargo.out_dir().join("runtime");
    if !embedded_runtime {
        if runtime_dir.exists() {
            fs::remove_dir_all(&runtime_dir).unwrap_or_else(|e| {
                panic!(
                    "Failed to remove disabled embedded runtime directory {}: {}",
                    runtime_dir.display(),
                    e
                )
            });
        }
        println!("cargo:runtime_dir=/nonexistent");
        return;
    }

    let canonical_runtime = cargo.workspace_root().map(|root| {
        root.join("target")
            .join("boxlite-runtime")
            .join(env::var("PROFILE").unwrap())
    });
    if let Some(source_dir) = &canonical_runtime {
        println!("cargo:rerun-if-changed={}", source_dir.display());
    }
    if !packaged && let Some(source_dir) = canonical_runtime.filter(|path| path.is_dir()) {
        println!("cargo:rustc-link-search=native={}", source_dir.display());
        println!("cargo:runtime_dir={}", source_dir.display());
        GuestBinaryHash::new(&source_dir).emit();
        EmbeddedManifest::new(&source_dir).generate(&cargo);
        return;
    }
    if !packaged {
        println!(
            "cargo:warning=No assembled runtime found; run `make runtime` before building an embedded artifact"
        );
        println!("cargo:runtime_dir=/nonexistent");
        EmbeddedManifest::new(&runtime_dir).generate(&cargo);
        return;
    }

    // Packaged crates have no repository-assembled runtime, so download the
    // release artifact matching the crate version and target.
    let prebuilt_runtime = PrebuiltRuntime::new(&runtime_dir);
    fs::create_dir_all(&runtime_dir)
        .unwrap_or_else(|e| panic!("Failed to create runtime directory: {}", e));
    if !prebuilt_runtime.download() {
        panic!(
            "Failed to prepare complete prebuilt BoxLite runtime in {}",
            runtime_dir.display()
        );
    }

    // Expose the runtime directory to downstream crates (e.g., Python SDK)
    println!("cargo:runtime_dir={}", runtime_dir.display());

    // Compute and embed guest binary hash at compile time (best-effort).
    // Falls back to runtime computation if the binary isn't available yet.
    GuestBinaryHash::new(&runtime_dir).emit();

    // Generate embedded runtime manifest (include_bytes! for self-contained SDKs)
    EmbeddedManifest::new(&runtime_dir).generate(&cargo);
}
