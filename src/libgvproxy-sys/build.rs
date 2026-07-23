use std::env;
use std::fs;
use std::path::Path;
use std::process::Command;

/// Builds libgvproxy from Go sources as a C static archive.
///
/// Steps:
/// 1. Downloads Go module dependencies
/// 2. Compiles Go code as a C archive (static library)
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

    if env::var_os("CARGO_FEATURE_SKIP_NATIVE_BUILD").is_some() {
        println!("cargo:warning=skip-native-build enabled: skipping libgvproxy Go build");
        return;
    }

    let manifest_dir = std::path::PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    if manifest_dir.join(".cargo_vcs_info.json").exists() {
        // TODO: Published libgvproxy-sys packages exclude the Go bridge and
        // therefore provide FFI declarations only; they cannot satisfy a final
        // native link on their own. Stop publishing this crate or ship a
        // target-specific prebuilt libgvproxy archive before removing this skip.
        println!("cargo:warning=published package: skipping excluded libgvproxy Go sources");
        return;
    }

    let out_dir = env::var("OUT_DIR").expect("OUT_DIR not set");
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set");

    let source_dir = Path::new(&manifest_dir).join("gvproxy-bridge");
    let lib_output = Path::new(&out_dir).join("libgvproxy.a");

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

    // Tell Cargo where to find the library
    println!("cargo:rustc-link-search=native={}", out_dir);
    println!("cargo:rustc-link-lib=static=gvproxy");

    // Transitive dependencies from the Go runtime (embedded in the c-archive).
    // Go's net package uses the CGO resolver by default, which calls res_search
    // from libresolv for DNS lookups on both macOS and Linux.
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "macos" {
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=Security");
    }
    // On glibc Linux, force static linking of libresolv to ensure the shim binary
    // remains fully static when built with crt-static. Without this, the linker
    // can pick libresolv.so (dynamic), making the binary dynamically linked and
    // causing SIGSEGV on TLS access (fs:[0x28]) on some VMs.
    // Do not add these glibc system paths for musl targets; they can make the
    // musl static link pick /usr/lib64/libc.so and fail.
    if target_os == "linux" && target_env == "gnu" {
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
    if target_os != "linux" {
        println!("cargo:rustc-link-lib=resolv");
    }
}
