use std::env;
use std::fs;
use std::path::Path;
use std::process::Command;

/// Builds libgvproxy from Go sources as a C static archive (Unix only).
///
/// Steps:
/// 1. Downloads Go module dependencies
/// 2. Compiles Go code as a C archive (static library)
///
/// On Windows, gvproxy is built as a DLL (c-shared) and cross-compiled from
/// macOS. Use LIBGVPROXY_PREBUILT to supply the pre-built import library.
fn build_gvproxy(source_dir: &Path, output_path: &Path) {
    println!("cargo:warning=Building libgvproxy from Go sources...");

    // Download Go dependencies
    let download_status = Command::new("go")
        .args(["mod", "download"])
        .current_dir(source_dir)
        .status()
        .expect("Failed to run 'go mod download' - ensure Go is installed");

    if !download_status.success() {
        panic!("Failed to download Go module dependencies");
    }

    // Build as C archive (static library)
    let mut build_cmd = Command::new("go");
    build_cmd.args(["build", "-buildmode=c-archive"]);

    // Use vendor directory if present
    if source_dir.join("vendor").exists() {
        build_cmd.args(["-mod=vendor"]);
    }

    build_cmd.args([
        "-o",
        output_path.to_str().expect("Invalid output path"),
        ".",
    ]);

    let build_status = build_cmd
        .current_dir(source_dir)
        .status()
        .expect("Failed to run 'go build' - ensure Go is installed");

    if !build_status.success() {
        panic!("Failed to build libgvproxy");
    }

    println!("cargo:warning=Successfully built libgvproxy");
}

fn main() {
    // Rebuild when any Go source file changes.
    // cargo:rerun-if-changed on a directory only detects file additions/removals,
    // not content changes. Walk the directory and watch each .go file individually.
    let bridge_dir = Path::new("gvproxy-bridge");
    if bridge_dir.is_dir() {
        for entry in fs::read_dir(bridge_dir).expect("Failed to read gvproxy-bridge directory") {
            let entry = entry.expect("Failed to read directory entry");
            let path = entry.path();
            if path
                .extension()
                .is_some_and(|ext| ext == "go" || ext == "mod" || ext == "sum")
            {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
    println!("cargo:rerun-if-changed=gvproxy-bridge"); // also watch for new files
    println!("cargo:rerun-if-env-changed=BOXLITE_DEPS_STUB");
    println!("cargo:rerun-if-env-changed=LIBGVPROXY_PREBUILT");

    // Auto-detect crates.io download: Cargo injects .cargo_vcs_info.json into
    // published packages. When present, enter stub mode since Go sources are
    // excluded from the package and building from source is not possible.
    if env::var("BOXLITE_DEPS_STUB").is_err() {
        let manifest_dir = std::path::PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
        if manifest_dir.join(".cargo_vcs_info.json").exists() {
            // SAFETY: build.rs is single-threaded; no concurrent env var access.
            unsafe { env::set_var("BOXLITE_DEPS_STUB", "1") };
        }
    }

    // Check for stub mode (for CI linting or crates.io install)
    if env::var("BOXLITE_DEPS_STUB").is_ok() {
        println!("cargo:warning=BOXLITE_DEPS_STUB mode: skipping libgvproxy build");
        println!("cargo:LIBGVPROXY_BOXLITE_DEP=/nonexistent");
        return;
    }

    let out_dir = env::var("OUT_DIR").expect("OUT_DIR not set");
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set");

    let source_dir = Path::new(&manifest_dir).join("gvproxy-bridge");
    // On Unix: linker auto-prepends "lib" → looks for "libgvproxy.a"
    // On Windows: import library for DLL linkage → "gvproxy.lib"
    let lib_output = if cfg!(target_os = "windows") {
        Path::new(&out_dir).join("gvproxy.lib")
    } else {
        Path::new(&out_dir).join("libgvproxy.a")
    };

    // Check for pre-built library (cross-compiled on macOS for Windows).
    //
    // On Windows: LIBGVPROXY_PREBUILT points to the import library (.lib, ~6 KB).
    //   A sibling gvproxy.dll must also exist — it gets copied to OUT_DIR so
    //   boxlite/build.rs can bundle it into the runtime directory.
    //
    // On Unix: LIBGVPROXY_PREBUILT points to the static archive (libgvproxy.a).
    if let Ok(prebuilt) = env::var("LIBGVPROXY_PREBUILT") {
        let prebuilt_path = Path::new(&prebuilt);
        if prebuilt_path.exists() {
            println!(
                "cargo:warning=Using pre-built libgvproxy from {}",
                prebuilt_path.display()
            );
            fs::copy(prebuilt_path, &lib_output).expect("Failed to copy pre-built libgvproxy");

            // On Windows: also copy the sibling DLL for runtime bundling.
            // boxlite/build.rs scans OUT_DIR via LIBGVPROXY_BOXLITE_DEP and
            // copies .dll files to the runtime directory.
            #[cfg(target_os = "windows")]
            {
                if let Some(prebuilt_dir) = prebuilt_path.parent() {
                    let dll_src = prebuilt_dir.join("gvproxy.dll");
                    if dll_src.exists() {
                        let dll_dst = Path::new(&out_dir).join("gvproxy.dll");
                        fs::copy(&dll_src, &dll_dst).expect("Failed to copy gvproxy.dll");
                        println!(
                            "cargo:warning=Copied gvproxy.dll ({:.1} MB)",
                            fs::metadata(&dll_dst).map(|m| m.len()).unwrap_or(0) as f64
                                / (1024.0 * 1024.0)
                        );
                    } else {
                        println!(
                            "cargo:warning=WARNING: gvproxy.dll not found next to {}",
                            prebuilt_path.display()
                        );
                        println!("cargo:warning=  Expected at: {}", dll_src.display());
                        println!(
                            "cargo:warning=  The shim will fail at runtime without gvproxy.dll"
                        );
                    }
                }
            }

            // Copy header if present alongside the library
            let prebuilt_header = prebuilt_path.with_extension("h");
            if prebuilt_header.exists() {
                let header_dst = Path::new(&out_dir).join("libgvproxy.h");
                fs::copy(&prebuilt_header, &header_dst).expect("Failed to copy libgvproxy.h");
            }
        } else {
            panic!(
                "LIBGVPROXY_PREBUILT={} does not exist",
                prebuilt_path.display()
            );
        }
    } else {
        // Build libgvproxy from Go sources
        // Note: cargo only re-runs this script when rerun-if-changed files change,
        // so no extra caching is needed here.
        build_gvproxy(&source_dir, &lib_output);

        // Copy header file for downstream C/C++ usage (optional)
        let header_src = source_dir.join("libgvproxy.h");
        if header_src.exists() {
            let header_dst = Path::new(&out_dir).join("libgvproxy.h");
            fs::copy(&header_src, &header_dst).expect("Failed to copy libgvproxy.h");
        }
    }

    // Tell Cargo where to find the library
    println!("cargo:rustc-link-search=native={}", out_dir);

    // On Windows: link dynamically via import library (.lib thunks → .dll at runtime).
    //
    // gvproxy is built as a DLL (c-shared) on Windows. Go's internal linker handles
    // all MinGW/.pdata internally within the DLL, so MSVC's link.exe only sees the
    // clean import library (~6 KB). This avoids the LNK1223 (.pdata) error that
    // occurs when MSVC tries to link a c-archive containing Go's runtime objects.
    //
    // IMPORTANT: The DLL approach is REQUIRED on Windows. The static c-archive
    // (libgvproxy.lib ~40 MB) hangs on Win11 — Go's _cgo_wait_runtime_init_done()
    // deadlocks when the Go runtime is statically embedded in a Rust/MSVC binary.
    // The DLL (c-shared) avoids this because Go's runtime initializes inside its
    // own DllMain, isolated from the host process's link-time dependencies.
    //
    // On Unix: link statically (c-archive works fine with KVM/Hypervisor.framework).
    #[cfg(target_os = "windows")]
    {
        println!("cargo:rustc-link-lib=dylib=gvproxy");
    }

    #[cfg(not(target_os = "windows"))]
    {
        println!("cargo:rustc-link-lib=static=gvproxy");

        // Transitive dependencies from the Go runtime (embedded in the c-archive).
        // Go's net package uses the CGO resolver by default, which calls res_search
        // from libresolv for DNS lookups on both macOS and Linux.
        #[cfg(target_os = "macos")]
        {
            println!("cargo:rustc-link-lib=framework=CoreFoundation");
            println!("cargo:rustc-link-lib=framework=Security");
            println!("cargo:rustc-link-lib=resolv");
        }

        // On Linux, force static linking of libresolv to ensure the shim binary
        // remains fully static when built with crt-static. Without this, the linker
        // picks libresolv.so (dynamic), making the binary dynamically linked and
        // causing SIGSEGV on TLS access (fs:[0x28]) on some VMs.
        #[cfg(target_os = "linux")]
        {
            let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
            // Debian/Ubuntu: /usr/lib/<triple>
            let gnu_triple = match arch.as_str() {
                "x86_64" => "x86_64-linux-gnu",
                "aarch64" => "aarch64-linux-gnu",
                _ => "x86_64-linux-gnu",
            };
            println!("cargo:rustc-link-search=native=/usr/lib/{}", gnu_triple);
            // RHEL/manylinux: /usr/lib64
            println!("cargo:rustc-link-search=native=/usr/lib64");
            println!("cargo:rustc-link-lib=static=resolv");
        }
    }

    // Expose library directory to downstream crates (used by boxlite/build.rs)
    // Convention: {LIBNAME}_BOXLITE_DEP=<path> for auto-discovery
    println!("cargo:LIBGVPROXY_BOXLITE_DEP={}", out_dir);
}
