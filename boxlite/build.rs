use regex::Regex;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

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

/// Collects all FFI dependencies into a single runtime directory.
/// This directory can be used by downstream crates (e.g., Python SDK) to
/// bundle all required libraries and binaries together.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    // Compile seccomp filters at build time (even in stub mode)
    // This is fast and required for include_bytes!() to work
    compile_seccomp_filters();

    // Check for stub mode (for CI linting without building dependencies)
    // Set BOXLITE_DEPS_STUB=1 to skip all native dependency builds
    if env::var("BOXLITE_DEPS_STUB").is_ok() {
        println!("cargo:warning=BOXLITE_DEPS_STUB mode: skipping dependency bundling");
        println!("cargo:runtime_dir=/nonexistent");
        return;
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let runtime_dir = out_dir.join("runtime");

    // Force rerun if runtime directory doesn't exist or is empty
    if !runtime_dir.exists()
        || fs::read_dir(&runtime_dir)
            .map(|mut d| d.next().is_none())
            .unwrap_or(true)
    {
        println!("cargo:rerun-if-changed=FORCE_REBUILD");
    }

    // Create the runtime directory
    fs::create_dir_all(&runtime_dir)
        .unwrap_or_else(|e| panic!("Failed to create runtime directory: {}", e));

    // Auto-discover and bundle all dependencies from -sys crates
    let collected = bundle_boxlite_deps(&runtime_dir);

    // Expose the runtime directory to downstream crates (e.g., Python SDK)
    println!("cargo:runtime_dir={}", runtime_dir.display());
    if !collected.is_empty() {
        let names: Vec<_> = collected.iter().map(|(name, _)| name.as_str()).collect();
        println!("cargo:warning=Bundled: {}", names.join(", "));
    }

    // Set rpath for boxlite-shim
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");
    #[cfg(target_os = "linux")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
}
