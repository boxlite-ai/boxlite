// Set rpath so the shim can find libkrunfw.<X>.dylib (loaded via dlopen by
// libkrun at runtime) collected next to it in the runtime directory.
fn main() {
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");
    #[cfg(target_os = "linux")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
}
