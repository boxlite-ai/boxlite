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

    // When cross-compiling for musl, tell CGO to use the musl C compiler.
    // Without this, Go uses the system's gcc (glibc), producing objects that
    // reference glibc-specific symbols (__fprintf_chk, etc.) which musl lacks.
    let target = env::var("TARGET").unwrap_or_default();
    if target.contains("musl") {
        let arch = target.split('-').next().unwrap_or("x86_64");
        let musl_cc = format!("{}-linux-musl-gcc", arch);
        build_cmd.env("CC", &musl_cc);
        build_cmd.env("CGO_ENABLED", "1");
    }

    build_cmd.args([
        "-o",
        output_path.to_str().expect("Invalid output path"),
        "main.go",
        "stats.go",
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
    // Rebuild if Go sources change
    println!("cargo:rerun-if-changed=gvproxy-bridge/main.go");
    println!("cargo:rerun-if-changed=gvproxy-bridge/stats.go");
    println!("cargo:rerun-if-changed=gvproxy-bridge/go.mod");
    println!("cargo:rerun-if-env-changed=BOXLITE_DEPS_STUB");

    // Check for stub mode (for CI linting without building)
    // Set BOXLITE_DEPS_STUB=1 to skip building and emit stub link directives
    if env::var("BOXLITE_DEPS_STUB").is_ok() {
        println!("cargo:warning=BOXLITE_DEPS_STUB mode: skipping libgvproxy build");
        println!("cargo:rustc-link-lib=static=gvproxy");
        println!("cargo:LIBGVPROXY_BOXLITE_DEP=/nonexistent");
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

    // Transitive dependencies from the Go runtime (embedded in the c-archive)
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=resolv");
    }

    // Expose library directory to downstream crates (used by boxlite/build.rs)
    // Convention: {LIBNAME}_BOXLITE_DEP=<path> for auto-discovery
    println!("cargo:LIBGVPROXY_BOXLITE_DEP={}", out_dir);
}
