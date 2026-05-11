fn main() {
    // libkrun is a Rust staticlib that embeds its own copy of std.
    // When linked into a binary on Linux, std symbols conflict with the
    // binary's own std copy. --allow-multiple-definition suppresses the error.
    #[cfg(target_os = "linux")]
    println!("cargo:rustc-link-arg-bins=-Wl,--allow-multiple-definition");
}
