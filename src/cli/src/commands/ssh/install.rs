//! Own only the marked Include and the private BoxLite configuration it loads.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail, ensure};
use nix::libc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const HEADER: &str = "# BoxLite managed SSH configuration v1\n";
const ENTRY: &str = "# BoxLite SSH entry v1 ";
const END: &str = "# End BoxLite SSH entry\n";
const NEUTRAL: &str = "Host *\n";
const INCLUDE_MARKER: &str = "# BoxLite managed SSH Include v1\n";

pub(super) struct Installation {
    home: PathBuf,
    root: PathBuf,
    managed: PathBuf,
    backup: PathBuf,
    prefix: String,
    original_prefix_len: usize,
    expand_include_tokens: bool,
    original: Option<Vec<u8>>,
    previous: Option<Vec<u8>>,
    entries: Vec<ManagedEntry>,
    alias: String,
    identity: String,
    _lock: File,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Marker {
    alias: String,
    identity: String,
    sha256: String,
}

struct ManagedEntry {
    marker: Marker,
    stanza: String,
}

impl Installation {
    /// Acquire the installation lock and reject handwritten conflicts before
    /// guest preparation or publication can change the SSH configuration.
    pub(super) fn new(alias: &str, identity: &str, overwrite: bool) -> Result<Self> {
        let home = dirs::home_dir().context("cannot locate the user home for SSH configuration")?;
        Self::with_home(&home, alias, identity, overwrite)
    }

    /// Validate the owning home, managed identity and complete handwritten
    /// Include graph while holding the lock until `commit` or drop.
    fn with_home(home: &Path, alias: &str, identity: &str, overwrite: bool) -> Result<Self> {
        let alias = normalize_alias(alias)?;
        ensure!(
            !identity.is_empty(),
            "SSH installation identity must not be empty"
        );
        ensure!(
            home.is_absolute(),
            "SSH configuration home must be absolute"
        );
        let expand_include_tokens = include_expands_tokens()?;
        check_directory(home)?;
        let home = fs::canonicalize(home).context("resolve SSH configuration home")?;
        check_ancestors(&home)?;
        let ssh = home.join(".ssh");
        let boxlite = home.join(".boxlite");
        let directory = boxlite.join("ssh");
        for path in [&ssh, &boxlite, &directory] {
            private_directory(path)?;
        }
        let lock_path = directory.join("install.lock");
        check_file(&lock_path, true)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&lock_path)
            .context("open private SSH installation lock")?;
        check_metadata(&lock.metadata()?, &lock_path, true)?;
        // SAFETY: lock owns this open descriptor for the duration of the flock call.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(std::io::Error::last_os_error())
                .context("another SSH configuration installation is in progress");
        }
        let root = ssh.join("config");
        let managed = directory.join("config");
        let backup = ssh.join("config.boxlite-backup");
        check_file(&backup, true)?;
        let original = read_owned(&root, false)?;
        let previous = read_owned(&managed, true)?;
        let entries = parse_managed(previous.as_deref())?;
        if let Some(entry) = entries.iter().find(|entry| entry.marker.alias == alias) {
            ensure!(
                entry.marker.identity == identity || overwrite,
                "SSH alias '{alias}' belongs to a different BoxLite target; choose --alias or use --overwrite"
            );
        }
        // Rust glob treats '\\' literally, but OpenSSH's native glob consumes
        // it as an escape. A bracket class means one literal backslash to both.
        let literal =
            glob::Pattern::escape(managed.to_str().context("SSH Include path must be UTF-8")?)
                .replace('\\', r"[\\]");
        let prefix = include_prefix(&literal, expand_include_tokens)?;
        let original_prefix_len = match original.as_deref() {
            Some(original) if original.starts_with(prefix.as_bytes()) => prefix.len(),
            Some(original) => {
                let alternate = include_prefix(&literal, !expand_include_tokens)?;
                if original.starts_with(alternate.as_bytes()) {
                    alternate.len()
                } else {
                    0
                }
            }
            None => 0,
        };
        let installation = Self {
            home,
            root,
            managed,
            backup,
            prefix,
            original_prefix_len,
            expand_include_tokens,
            original,
            previous,
            entries,
            alias,
            identity: identity.to_owned(),
            _lock: lock,
        };
        installation.scan_original()?;
        Ok(installation)
    }

    /// Publish a validated managed stanza before activating its root Include.
    ///
    /// Recheck the snapshot and Include graph before creating the original
    /// config backup so a preflight conflict cannot alter published files.
    pub(super) fn commit(mut self, stanza: &str) -> Result<()> {
        validate_stanza(stanza, &self.alias)?;
        let replacement = ManagedEntry {
            marker: Marker {
                alias: self.alias.clone(),
                identity: self.identity.clone(),
                sha256: entry_digest(&self.alias, &self.identity, stanza),
            },
            stanza: stanza.to_owned(),
        };
        match self
            .entries
            .iter()
            .position(|entry| entry.marker.alias == self.alias)
        {
            Some(index) => self.entries[index] = replacement,
            None => self.entries.push(replacement),
        }
        let mut candidate = String::from(HEADER);
        for entry in &self.entries {
            candidate.push_str(ENTRY);
            candidate.push_str(&serde_json::to_string(&entry.marker)?);
            candidate.push('\n');
            candidate.push_str(&entry.stanza);
            candidate.push_str(END);
        }
        candidate.push_str(NEUTRAL);
        let temporary = temporary_file(&self.managed, candidate.as_bytes())?;
        // Never pass handwritten configuration to ssh -G: Match exec can run commands.
        let result = Command::new("ssh")
            .args(["-G", "-F"])
            .arg(temporary.path())
            .arg("--")
            .arg(&self.alias)
            .stdin(Stdio::null())
            .output()
            .context("validate managed configuration with OpenSSH ssh -G")?;
        ensure!(
            result.status.success(),
            "OpenSSH rejected managed SSH configuration: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        );
        self.check_unchanged()?;
        self.scan_original()?;
        let root_has_prefix = self
            .original
            .as_deref()
            .unwrap_or_default()
            .starts_with(self.prefix.as_bytes());
        let root_candidate = if root_has_prefix {
            None
        } else {
            let mut bytes = self.prefix.as_bytes().to_vec();
            let original = self.original.as_deref().unwrap_or_default();
            bytes.extend_from_slice(&original[self.original_prefix_len..]);
            Some(temporary_file(&self.root, &bytes)?)
        };
        if root_candidate.is_some()
            && let Some(original) = &self.original
            && read_owned(&self.backup, true)?.is_none()
        {
            temporary_file(&self.backup, original)?
                .persist_noclobber(&self.backup)
                .context("save original SSH config backup")?;
        }
        self.check_unchanged()?;
        // A complete managed file must exist before activating its Include.
        temporary
            .persist(&self.managed)
            .context("install managed SSH configuration")?;
        if let Some(root_candidate) = root_candidate {
            if self.original.is_some() {
                root_candidate
                    .persist(&self.root)
                    .context("install SSH Include")?;
            } else {
                root_candidate
                    .persist_noclobber(&self.root)
                    .context("install SSH Include")?;
            }
        }
        Ok(())
    }

    /// Detect edits or unsafe replacements of the locked installation inputs
    /// before either managed or root configuration is published.
    fn check_unchanged(&self) -> Result<()> {
        for directory in [
            self.home.clone(),
            self.home.join(".ssh"),
            self.home.join(".boxlite"),
            self.home.join(".boxlite/ssh"),
        ] {
            check_ancestors(&directory)?;
            check_directory(&directory)?;
        }
        ensure!(
            read_owned(&self.root, false)? == self.original,
            "SSH config changed during installation; retry"
        );
        ensure!(
            read_owned(&self.managed, true)? == self.previous,
            "managed SSH config changed during installation; retry"
        );
        check_file(&self.backup, true)?;
        Ok(())
    }

    /// Scan only handwritten bytes, protecting files that installation may publish.
    fn scan_original(&self) -> Result<()> {
        let original = self.original.as_deref().unwrap_or_default();
        scan_config(
            &original[self.original_prefix_len..],
            &self.home,
            &self.managed,
            &self.backup,
            &self.alias,
            self.expand_include_tokens,
            &mut Vec::new(),
        )
    }
}

/// Detect percent-token support in Include; reject unrecognized client banners
/// rather than silently generating a path with the wrong expansion rules.
fn include_expands_tokens() -> Result<bool> {
    let output = Command::new("ssh")
        .arg("-V")
        .stdin(Stdio::null())
        .output()
        .context("read OpenSSH version for Include syntax")?;
    let banner = String::from_utf8_lossy(&output.stderr);
    ensure!(output.status.success(), "OpenSSH ssh -V failed: {banner}");
    let version = banner
        .split_whitespace()
        .next()
        .and_then(|value| value.strip_prefix("OpenSSH_"))
        .context("cannot determine OpenSSH version for Include syntax")?;
    let (major, minor) = version
        .split_once('.')
        .context("invalid OpenSSH version for Include syntax")?;
    let minor_end = minor
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(minor.len());
    let major: u32 = major.parse().context("invalid OpenSSH major version")?;
    let minor: u32 = minor[..minor_end]
        .parse()
        .context("invalid OpenSSH minor version")?;
    // Include gained percent-token expansion in OpenSSH 9.9.
    Ok((major, minor) >= (9, 9))
}

/// Encode the marked Include using version-specific percent expansion.
/// The caller has already escaped glob characters in the literal destination.
fn include_prefix(literal: &str, expand_tokens: bool) -> Result<String> {
    let value = super::connect::ssh_path(Path::new(literal))?;
    let mut prefix = String::with_capacity(INCLUDE_MARKER.len() + value.len() + 11);
    prefix.push_str(INCLUDE_MARKER);
    prefix.push_str("Include \"");
    for character in value.chars() {
        match character {
            '\\' | '"' => prefix.push('\\'),
            '%' if expand_tokens => prefix.push('%'),
            _ => {}
        }
        prefix.push(character);
    }
    prefix.push_str("\"\n");
    Ok(prefix)
}

/// Reject Host-pattern/injection characters and normalize owned alias matching.
fn normalize_alias(alias: &str) -> Result<String> {
    ensure!(
        alias
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
            && alias
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')),
        "invalid SSH alias '{alias}'; use --alias with an ASCII letter or digit followed by letters, digits, '.', '_' or '-'"
    );
    Ok(alias.to_ascii_lowercase())
}

/// Refuse symlink and parent-directory traversal before configuration mutations.
fn check_ancestors(path: &Path) -> Result<()> {
    ensure!(
        path.is_absolute(),
        "SSH configuration home must be absolute"
    );
    let mut current = PathBuf::new();
    for component in path.components() {
        ensure!(
            !matches!(component, Component::ParentDir),
            "SSH configuration paths cannot contain '..'"
        );
        current.push(component);
        let metadata = fs::symlink_metadata(&current)
            .with_context(|| format!("inspect SSH directory {}", current.display()))?;
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "SSH configuration ancestor is not a real directory: {}",
            current.display()
        );
    }
    Ok(())
}

/// Require a real, effective-user-owned directory without group/other writes.
fn check_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    // SAFETY: geteuid reads process credentials and has no pointer arguments.
    let uid = unsafe { libc::geteuid() };
    ensure!(
        metadata.is_dir()
            && !metadata.file_type().is_symlink()
            && metadata.uid() == uid
            && metadata.mode() & 0o022 == 0,
        "unsafe SSH configuration directory: {}",
        path.display()
    );
    Ok(())
}

/// Create a missing private directory without repairing unsafe existing paths.
fn private_directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(path)
                .with_context(|| format!("create private SSH directory {}", path.display()))?;
        }
        Err(error) => return Err(error).context("inspect SSH configuration directory"),
    }
    check_directory(path)
}

/// Validate ownership, regular-file type and single-link identity.
/// Managed files require exactly 0600; handwritten files may be world-readable.
fn check_metadata(metadata: &fs::Metadata, path: &Path, private: bool) -> Result<()> {
    // SAFETY: geteuid reads process credentials and has no pointer arguments.
    let uid = unsafe { libc::geteuid() };
    ensure!(
        metadata.is_file()
            && !metadata.file_type().is_symlink()
            && metadata.uid() == uid
            && metadata.nlink() == 1
            && if private {
                metadata.mode() & 0o777 == 0o600
            } else {
                metadata.mode() & 0o022 == 0
            },
        "unsafe SSH configuration file ownership, type or permissions: {}",
        path.display()
    );
    Ok(())
}

/// Validate existing destinations while allowing files not yet published.
fn check_file(path: &Path, private: bool) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => check_metadata(&metadata, path, private),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("inspect SSH file {}", path.display())),
    }
}

/// Read an optional owned file without following its final symlink, then
/// recheck the opened descriptor so validation applies to the file actually read.
fn read_owned(path: &Path, private: bool) -> Result<Option<Vec<u8>>> {
    check_file(path, private)?;
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("read SSH file {}", path.display()));
        }
    };
    check_metadata(&file.metadata()?, path, private)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

/// Write and sync a private sibling file for the caller's atomic publication.
fn temporary_file(destination: &Path, bytes: &[u8]) -> Result<tempfile::NamedTempFile> {
    let mut temporary =
        tempfile::NamedTempFile::new_in(destination.parent().context("SSH file has no parent")?)?;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    Ok(temporary)
}

/// Accept only versioned, digest-verified entries owned by this installer.
/// Reject manual edits rather than silently replacing user-maintained content.
fn parse_managed(bytes: Option<&[u8]>) -> Result<Vec<ManagedEntry>> {
    let Some(bytes) = bytes else {
        return Ok(Vec::new());
    };
    let text = std::str::from_utf8(bytes).context("managed SSH configuration is not UTF-8")?;
    let mut remaining = text
        .strip_prefix(HEADER)
        .context("refusing manual or unsupported managed SSH configuration")?;
    let mut entries: Vec<ManagedEntry> = Vec::new();
    while remaining != NEUTRAL {
        let line = remaining
            .strip_prefix(ENTRY)
            .context("malformed managed SSH entry marker")?;
        let (marker, rest) = line
            .split_once('\n')
            .context("incomplete managed SSH entry marker")?;
        let marker: Marker =
            serde_json::from_str(marker).context("invalid managed SSH identity marker")?;
        ensure!(
            normalize_alias(&marker.alias)? == marker.alias && !marker.identity.is_empty(),
            "invalid managed SSH identity"
        );
        ensure!(
            !entries
                .iter()
                .any(|entry| entry.marker.alias == marker.alias),
            "duplicate managed SSH alias"
        );
        let (stanza, rest) = rest
            .split_once(END)
            .context("missing managed SSH entry end marker")?;
        validate_stanza(stanza, &marker.alias)?;
        ensure!(
            marker.sha256 == entry_digest(&marker.alias, &marker.identity, stanza),
            "managed SSH identity or stanza was edited manually; refusing to replace it"
        );
        entries.push(ManagedEntry {
            marker,
            stanza: stanza.to_owned(),
        });
        remaining = rest;
    }
    Ok(entries)
}

/// Bind alias, target identity and stanza with length-delimited digest inputs.
fn entry_digest(alias: &str, identity: &str, stanza: &str) -> String {
    let mut digest = Sha256::new();
    for value in [alias, identity, stanza] {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

/// Keep each managed stanza inside its exact Host block; reject nested controls.
fn validate_stanza(stanza: &str, alias: &str) -> Result<()> {
    let (host, body) = stanza
        .split_once('\n')
        .context("managed SSH stanza is missing its Host line")?;
    ensure!(
        host == format!("Host {alias}") && stanza.ends_with('\n'),
        "managed SSH stanza must begin with its exact alias and end with a newline"
    );
    for line in body.lines() {
        let (keyword, _) = directive(line)?;
        ensure!(
            !keyword.is_empty() && !matches!(keyword.as_str(), "host" | "include" | "match"),
            "unexpected control directive in managed SSH stanza"
        );
    }
    Ok(())
}

/// Parse only directive boundaries; shell-valued options such as ProxyCommand
/// must not be interpreted with the quoting rules for control directives.
fn directive(line: &str) -> Result<(String, &str)> {
    let line = line.trim_start_matches([' ', '\t', '\r']);
    if line.is_empty() || line.starts_with('#') {
        return Ok((String::new(), ""));
    }
    let end = line.find([' ', '\t', '\r', '=']).unwrap_or(line.len());
    let keyword = &line[..end];
    ensure!(
        keyword
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
            && keyword.bytes().all(|byte| byte.is_ascii_alphanumeric()),
        "unsupported SSH configuration keyword syntax"
    );
    let values = line[end..].trim_start_matches([' ', '\t', '\r']);
    let values = values
        .strip_prefix('=')
        .unwrap_or(values)
        .trim_start_matches([' ', '\t', '\r']);
    Ok((keyword.to_ascii_lowercase(), values))
}

/// Parse supported control-directive quoting without evaluating shell syntax.
/// Ambiguous single quotes, escapes and unterminated quotes fail closed.
fn words(value: &str) -> Result<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quoted = false;
    let mut started = false;
    let mut characters = value.chars();
    while let Some(character) = characters.next() {
        match character {
            '\\' => {
                let escaped = characters
                    .next()
                    .context("unterminated SSH configuration escape")?;
                ensure!(
                    !escaped.is_control(),
                    "unsupported SSH configuration escape"
                );
                word.push(escaped);
                started = true;
            }
            '"' => {
                quoted = !quoted;
                started = true;
            }
            '#' if !quoted && !started => break,
            '\'' if !quoted => bail!("unsupported single-quoted SSH control directive"),
            ' ' | '\t' | '\r' if !quoted => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            character => {
                ensure!(
                    !character.is_control(),
                    "unsupported control character in SSH configuration"
                );
                word.push(character);
                started = true;
            }
        }
    }
    ensure!(!quoted, "unterminated SSH configuration quote");
    if started {
        words.push(word);
    }
    Ok(words)
}

/// Reject alias conflicts and unsafe Include graphs without evaluating Match exec.
///
/// The backup is protected before enumerating included files, even when it does
/// not exist yet, so publishing it cannot introduce a new recursive Include.
fn scan_config(
    bytes: &[u8],
    home: &Path,
    managed: &Path,
    backup: &Path,
    alias: &str,
    expand_include_tokens: bool,
    stack: &mut Vec<PathBuf>,
) -> Result<()> {
    let text =
        std::str::from_utf8(bytes).context("cannot safely scan non-UTF-8 SSH configuration")?;
    for line in text.lines() {
        ensure!(
            !line
                .trim_start()
                .starts_with("# BoxLite managed SSH Include"),
            "BoxLite Include must be the single exact leading prefix; remove misplaced or duplicate Includes manually"
        );
        let (keyword, value) = directive(line)?;
        match keyword.as_str() {
            "host" => {
                let patterns = words(value)?;
                ensure!(
                    !patterns.is_empty()
                        && patterns
                            .iter()
                            .all(|pattern| !pattern.is_empty() && pattern != "!"),
                    "invalid SSH Host patterns"
                );
                let excluded = patterns
                    .iter()
                    .filter_map(|pattern| pattern.strip_prefix('!'))
                    .any(|pattern| host_matches(pattern, alias));
                let matched = patterns
                    .iter()
                    .filter(|pattern| !pattern.starts_with('!'))
                    .any(|pattern| host_matches(pattern, alias));
                ensure!(
                    excluded || !matched || (patterns.len() == 1 && patterns[0] == "*"),
                    "SSH alias '{alias}' conflicts with a handwritten Host entry; choose --alias (even --overwrite cannot replace it)"
                );
            }
            "include" => {
                let paths = words(value)?;
                ensure!(!paths.is_empty(), "empty SSH Include directive");
                for path in paths {
                    let pattern = include_pattern(&path, home, expand_include_tokens)?;
                    let managed_text = managed.to_str().context("managed SSH path is not UTF-8")?;
                    ensure!(
                        !glob::Pattern::new(&pattern)?.matches(managed_text),
                        "unowned or conditional Include of the BoxLite managed file; remove it manually"
                    );
                    ensure!(
                        !include_matches_backup(&pattern, backup)?,
                        "SSH Include matches the BoxLite config backup; narrow it before installing"
                    );
                    for included in glob::glob(&pattern).context("unsupported SSH Include glob")? {
                        let included = included.context("read SSH Include glob")?;
                        let canonical = fs::canonicalize(&included).with_context(|| {
                            format!("resolve SSH Include {}", included.display())
                        })?;
                        ensure!(
                            canonical != managed,
                            "unowned Include of BoxLite configuration"
                        );
                        ensure!(
                            stack.len() < 32 && !stack.contains(&canonical),
                            "recursive SSH Include: {}",
                            included.display()
                        );
                        ensure!(
                            fs::metadata(&included)?.is_file(),
                            "SSH Include is not a regular file: {}",
                            included.display()
                        );
                        let bytes = fs::read(&included)
                            .with_context(|| format!("read SSH Include {}", included.display()))?;
                        stack.push(canonical);
                        scan_config(
                            &bytes,
                            home,
                            managed,
                            backup,
                            alias,
                            expand_include_tokens,
                            stack,
                        )?;
                        stack.pop();
                    }
                }
            }
            "match" => {
                let conditions = words(value)?;
                ensure!(
                    conditions.len() == 1 && conditions[0].eq_ignore_ascii_case("all"),
                    "cannot safely install through ambiguous SSH Match conditions; Match exec is never executed"
                );
            }
            _ => {}
        }
    }
    Ok(())
}

/// Match a future backup without requiring the backup file to exist.
///
/// Expand only its prospective parent directories, then resolve them through the
/// filesystem. This preserves `.`/`..`, directory glob and symlink semantics
/// rather than lexically collapsing paths that OpenSSH resolves differently.
fn include_matches_backup(pattern: &str, backup: &Path) -> Result<bool> {
    let (directory, filename) = pattern
        .rsplit_once('/')
        .context("SSH Include pattern must be absolute")?;
    let backup_name = backup
        .file_name()
        .and_then(|name| name.to_str())
        .context("SSH backup filename must be UTF-8")?;
    if !glob::Pattern::new(filename)?.matches(backup_name) {
        return Ok(false);
    }
    let backup_parent = backup.parent().context("SSH backup has no parent")?;
    let directory = if directory.is_empty() { "/" } else { directory };
    for parent in glob::glob(directory).context("unsupported SSH Include directory glob")? {
        let parent = parent.context("read SSH Include directory glob")?;
        let canonical = fs::canonicalize(&parent)
            .with_context(|| format!("resolve SSH Include directory {}", parent.display()))?;
        if canonical == backup_parent {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Resolve OpenSSH's supported Include spellings against the config home.
///
/// Leave glob components intact: prospective-file checks and existing-file
/// enumeration must interpret the same pattern without expanding Match exec.
fn include_pattern(value: &str, home: &Path, expand_tokens: bool) -> Result<String> {
    ensure!(
        !value.is_empty() && !value.contains('$') && !value.contains('`'),
        "unsupported SSH Include environment expansion"
    );
    // Native and Rust globbing agree on our literal-backslash bracket class,
    // but other backslash escapes are ambiguous between the two parsers.
    ensure!(
        value.split(r"[\\]").all(|part| !part.contains('\\')),
        "unsupported SSH Include backslash pattern"
    );
    let mut literal = String::new();
    let mut characters = value.chars();
    while let Some(character) = characters.next() {
        if expand_tokens && character == '%' {
            ensure!(
                characters.next() == Some('%'),
                "unsupported SSH Include token expansion"
            );
        }
        literal.push(character);
    }
    let home = glob::Pattern::escape(home.to_str().context("SSH home must be UTF-8")?);
    if let Some(relative) = literal.strip_prefix("~/") {
        Ok(format!("{home}/{relative}"))
    } else if literal.starts_with('/') {
        Ok(literal)
    } else {
        ensure!(
            !literal.starts_with('~'),
            "unsupported SSH Include user-home expansion"
        );
        Ok(format!("{home}/.ssh/{literal}"))
    }
}

/// Match OpenSSH Host patterns: only '*' and '?' are wildcards, not glob classes.
fn host_matches(pattern: &str, alias: &str) -> bool {
    let pattern = pattern.as_bytes();
    let alias = alias.as_bytes();
    let (mut p, mut a, mut star, mut retry) = (0, 0, None, 0);
    while a < alias.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p].eq_ignore_ascii_case(&alias[a])) {
            p += 1;
            a += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            retry = a;
        } else if let Some(previous) = star {
            retry += 1;
            a = retry;
            p = previous + 1;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

#[cfg(test)]
#[path = "tests/install.rs"]
mod tests;
