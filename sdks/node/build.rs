fn main() {
    napi_build::setup();

    // Set rpath at link time (same pattern as Python SDK)
    // This allows the .node binary to find libkrun/libgvproxy in ./runtime/
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path/runtime");

    #[cfg(target_os = "linux")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/runtime");
}
