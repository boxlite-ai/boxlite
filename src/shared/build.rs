//! Build script to compile Protocol Buffer definitions and stamp the build
//! with the git commit it came from.

use std::path::PathBuf;
use std::process::Command;

/// Emits `BOXLITE_GIT_COMMIT`, the short commit of the checkout being built.
///
/// Read back as [`crate::GIT_COMMIT`](../src/lib.rs) via `option_env!`, so a
/// build with no git checkout to read — a published crate, a vendored source
/// tree, a container without `.git` — simply reports no commit.
///
/// Lives in the shared crate rather than in `boxlite`'s own build script so any
/// workspace member can report the same commit from one emission point. Today
/// the only consumer is the host's embedded-runtime cache directory name.
struct GitProvenance {
    /// Crate root; also the cwd every `git` call runs in.
    manifest_dir: PathBuf,
}

impl GitProvenance {
    fn new(manifest_dir: PathBuf) -> Self {
        Self { manifest_dir }
    }

    /// Emit the commit plus the `rerun-if-changed` watches that keep it honest.
    ///
    /// Without the watches cargo would replay a cached build-script run after
    /// HEAD moved and stamp the build with a commit that no longer describes
    /// it — a silently wrong label is worse than none.
    fn emit(&self) {
        if !self.is_tracked_here() {
            return;
        }
        let Some(commit) = self.git(&["rev-parse", "--short", "HEAD"]) else {
            return;
        };
        self.watch("HEAD");
        // Committing on the current branch leaves HEAD untouched and moves only
        // the branch ref, which lives in `packed-refs` until written out loose —
        // so both are watched.
        if let Some(branch) = self.git(&["symbolic-ref", "--quiet", "HEAD"]) {
            self.watch(&branch);
        }
        self.watch("packed-refs");
        println!("cargo:rustc-env=BOXLITE_GIT_COMMIT={}", commit);
    }

    /// True when this crate's own manifest is tracked by the repository the
    /// `git` calls resolve to.
    ///
    /// Guards against stamping an unrelated enclosing repository: a crate
    /// unpacked under `~/.cargo/registry/` is inside a git repo whenever the
    /// user keeps `$HOME` under version control, but is never tracked by it.
    fn is_tracked_here(&self) -> bool {
        self.git(&["ls-files", "--error-unmatch", "Cargo.toml"])
            .is_some()
    }

    /// Watch a path inside the git directory, resolved through `--git-path` so
    /// linked worktrees (whose `.git` is a file) reach the real location.
    ///
    /// Absent paths are skipped: cargo treats a missing `rerun-if-changed`
    /// target as always-dirty, which would re-run this script on every build.
    fn watch(&self, git_relative: &str) {
        let Some(path) = self.git(&["rev-parse", "--git-path", git_relative]) else {
            return;
        };
        // `--git-path` may answer relative to the cwd; join is a no-op when absolute.
        let path = self.manifest_dir.join(path);
        if path.exists() {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }

    /// Run git in the crate root, returning trimmed stdout on success.
    fn git(&self, args: &[&str]) -> Option<String> {
        let output = Command::new("git")
            .args(args)
            .current_dir(&self.manifest_dir)
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8(output.stdout).ok()?.trim().to_string();
        (!text.is_empty()).then_some(text)
    }
}

fn get_protoc_version() -> Result<(u32, u32), Box<dyn std::error::Error>> {
    let output = Command::new("protoc").arg("--version").output()?;

    if !output.status.success() {
        return Err("protoc --version failed".into());
    }

    let version_str = String::from_utf8_lossy(&output.stdout);
    // Parse "libprotoc 3.12.4" or "protoc 3.15.0"
    let version = version_str
        .split_whitespace()
        .nth(1)
        .ok_or("Invalid protoc version output")?;

    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() < 2 {
        return Err("Invalid protoc version format".into());
    }

    let major: u32 = parts[0].parse()?;
    let minor: u32 = parts[1].parse()?;
    Ok((major, minor))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    GitProvenance::new(std::env::var("CARGO_MANIFEST_DIR")?.into()).emit();

    let mut config = tonic_build::configure()
        .build_server(true)
        .build_client(true);

    // proto3 optional fields require protoc >= 3.12
    // For 3.12-3.14, we need --experimental_allow_proto3_optional
    // For 3.15+, it's enabled by default
    match get_protoc_version() {
        Ok((major, minor)) if major == 3 && (12..=14).contains(&minor) => {
            config = config.protoc_arg("--experimental_allow_proto3_optional");
        }
        Ok((major, minor)) if major < 3 || (major == 3 && minor < 12) => {
            return Err(format!(
                "protoc version {}.{} is not supported. boxlite requires protoc >= 3.12 for proto3 optional support.",
                major, minor
            ).into());
        }
        Err(e) => {
            return Err(format!(
                "Failed to determine protoc version: {}. boxlite requires protoc >= 3.12.",
                e
            )
            .into());
        }
        _ => {
            // Version 3.15+ or future versions - no special handling needed
        }
    }

    config.compile_protos(&["proto/boxlite/v1/service.proto"], &["proto"])?;

    println!("cargo:rerun-if-changed=proto/");
    Ok(())
}
