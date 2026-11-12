use super::*;
use std::os::unix::fs::symlink;

fn test_home() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

/// Create a locked installation against an isolated canonical home.
fn plan(home: &Path, alias: &str, identity: &str, overwrite: bool) -> Result<Installation> {
    Installation::new(&home.canonicalize()?, alias, identity, overwrite)
}

fn stanza(alias: &str, hostname: &str) -> String {
    format!("Host {alias}\n  HostName {hostname}\n  User box\n  BatchMode yes\n")
}

fn root(home: &Path) -> PathBuf {
    home.join(".ssh/config")
}

fn managed(home: &Path) -> PathBuf {
    home.join(".boxlite/ssh/config")
}

/// Check the actual OpenSSH resolution rather than reconstructing Include rules.
fn effective(home: &Path, alias: &str) -> String {
    let output = Command::new("ssh")
        .args(["-G", "-F"])
        .arg(root(home))
        .arg("--")
        .arg(alias)
        .output()
        .expect("OpenSSH must be available for installer tests");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

/// Reinstalling the same identity preserves handwritten bytes and backup.
#[test]
fn same_identity_updates_without_duplicate_include_or_rewriting_original() {
    let home = test_home();
    fs::create_dir(home.path().join(".ssh")).unwrap();
    let original = b"# personal options\nForwardX11 no\nForwardX11Trusted no\nPKCS11Provider none\nUser private\nHost unrelated\n  HostName elsewhere\n";
    fs::write(root(home.path()), original).unwrap();
    plan(home.path(), "Dev", "local-home/box-A", false)
        .unwrap()
        .commit(&stanza("dev", "first-box"))
        .unwrap();
    let first = fs::read(root(home.path())).unwrap();
    assert!(first.ends_with(original));
    assert!(first.starts_with(INCLUDE_MARKER.as_bytes()));
    assert_eq!(
        fs::read(home.path().join(".boxlite/ssh/config.backup")).unwrap(),
        original
    );
    assert!(effective(home.path(), "unrelated").contains("hostname elsewhere\n"));
    assert!(effective(home.path(), "unrelated").contains("user private\n"));
    assert!(effective(home.path(), "unrelated").contains("forwardx11 no\n"));
    plan(home.path(), "dEV", "local-home/box-A", false)
        .unwrap()
        .commit(&stanza("dev", "updated-box"))
        .unwrap();
    assert_eq!(fs::read(root(home.path())).unwrap(), first);
    assert!(effective(home.path(), "dev").contains("hostname updated-box\n"));
    assert_eq!(
        fs::read(home.path().join(".boxlite/ssh/config.backup")).unwrap(),
        original
    );
}

#[test]
fn conflicting_identity_requires_overwrite_but_only_owned_entry_changes() {
    let home = test_home();
    plan(home.path(), "dev", "box-A", false)
        .unwrap()
        .commit(&stanza("dev", "first"))
        .unwrap();
    plan(home.path(), "other", "box-C", false)
        .unwrap()
        .commit(&stanza("other", "third"))
        .unwrap();
    let old_root = fs::read(root(home.path())).unwrap();
    let old_managed = fs::read(managed(home.path())).unwrap();
    let error = plan(home.path(), "DEV", "box-B", false).err().unwrap();
    assert!(error.to_string().contains("--alias or use --overwrite"));
    assert_eq!(fs::read(root(home.path())).unwrap(), old_root);
    assert_eq!(fs::read(managed(home.path())).unwrap(), old_managed);
    plan(home.path(), "DEV", "box-B", true)
        .unwrap()
        .commit(&stanza("dev", "second"))
        .unwrap();
    assert_eq!(fs::read(root(home.path())).unwrap(), old_root);
    assert!(effective(home.path(), "dev").contains("hostname second\n"));
    assert!(effective(home.path(), "other").contains("hostname third\n"));
}

/// Failed managed-stanza validation and forged identities do not replace files.
#[test]
fn errors_leave_both_published_files_unchanged() {
    let home = test_home();
    plan(home.path(), "dev", "A", false)
        .unwrap()
        .commit(&stanza("dev", "first"))
        .unwrap();
    let old_root = fs::read(root(home.path())).unwrap();
    let old_managed = fs::read(managed(home.path())).unwrap();
    for stanza in [
        "Host other\n  User box\n",
        "Host dev\n  Include /tmp/unsafe\n",
        "Host dev\n  BogusOpenSSHOption yep\n",
        "Host dev\n  User box",
    ] {
        assert!(
            plan(home.path(), "dev", "A", false)
                .unwrap()
                .commit(stanza)
                .is_err()
        );
        assert_eq!(fs::read(root(home.path())).unwrap(), old_root);
        assert_eq!(fs::read(managed(home.path())).unwrap(), old_managed);
    }
    fs::write(managed(home.path()), b"Host dev\n  User manual\n").unwrap();
    let manual = fs::read(managed(home.path())).unwrap();
    assert!(plan(home.path(), "dev", "A", true).is_err());
    assert_eq!(fs::read(managed(home.path())).unwrap(), manual);
    assert_eq!(fs::read(root(home.path())).unwrap(), old_root);
    fs::write(managed(home.path()), &old_managed).unwrap();
    let forged = String::from_utf8(old_managed.clone())
        .unwrap()
        .replace("\"A\"", "\"B\"");
    fs::write(managed(home.path()), forged.as_bytes()).unwrap();
    assert!(plan(home.path(), "dev", "A", true).is_err());
    assert_eq!(fs::read(root(home.path())).unwrap(), old_root);
    assert_eq!(fs::read(managed(home.path())).unwrap(), forged.as_bytes());
}

#[test]
fn invalid_alias_and_unsafe_write_paths_are_rejected() {
    let home = test_home();
    for alias in ["", "-bad", "a b", "a*b", "a/b", "x\nHost evil", "ünicode"] {
        assert!(plan(home.path(), alias, "A", false).is_err(), "{alias:?}");
    }
    let home = test_home();
    symlink(home.path().join("absent"), home.path().join(".ssh")).unwrap();
    assert!(plan(home.path(), "dev", "A", false).is_err());
    let home = test_home();
    fs::create_dir(home.path().join(".ssh")).unwrap();
    symlink(home.path().join("elsewhere"), root(home.path())).unwrap();
    assert!(plan(home.path(), "dev", "A", false).is_err());
    let home = test_home();
    fs::create_dir(home.path().join(".ssh")).unwrap();
    fs::write(root(home.path()), "Host other\n").unwrap();
    fs::set_permissions(root(home.path()), fs::Permissions::from_mode(0o666)).unwrap();
    assert!(plan(home.path(), "dev", "A", false).is_err());
    let home = test_home();
    fs::create_dir(home.path().join(".ssh")).unwrap();
    fs::create_dir(home.path().join(".boxlite")).unwrap();
    fs::create_dir(home.path().join(".boxlite/ssh")).unwrap();
    symlink(home.path().join("elsewhere"), managed(home.path())).unwrap();
    assert!(plan(home.path(), "dev", "A", false).is_err());
    let home = test_home();
    fs::create_dir(home.path().join(".ssh")).unwrap();
    fs::create_dir(home.path().join(".boxlite")).unwrap();
    fs::create_dir(home.path().join(".boxlite/ssh")).unwrap();
    fs::write(managed(home.path()), HEADER).unwrap();
    fs::set_permissions(managed(home.path()), fs::Permissions::from_mode(0o644)).unwrap();
    assert!(plan(home.path(), "dev", "A", false).is_err());
    let home = test_home();
    fs::create_dir(home.path().join(".boxlite")).unwrap();
    fs::set_permissions(
        home.path().join(".boxlite"),
        fs::Permissions::from_mode(0o777),
    )
    .unwrap();
    assert!(plan(home.path(), "dev", "A", false).is_err());
    let home = test_home();
    let selected = home.path().join("home-symlink");
    symlink(home.path(), &selected).unwrap();
    assert!(Installation::new(&selected, "dev", "A", false).is_err());
}

/// A managed marker must stay first; handwritten copies remain unowned.
#[test]
fn include_must_be_exactly_first_and_unique() {
    let home = test_home();
    plan(home.path(), "dev", "A", false)
        .unwrap()
        .commit(&stanza("dev", "first"))
        .unwrap();
    let valid = fs::read(root(home.path())).unwrap();
    for altered in [
        format!("# handwritten\n{}", String::from_utf8_lossy(&valid)),
        format!(
            "{}{}",
            String::from_utf8_lossy(&valid),
            String::from_utf8_lossy(&valid)
        ),
        format!("Match all\n{}", String::from_utf8_lossy(&valid)),
        format!("Host other\n{}", String::from_utf8_lossy(&valid)),
    ] {
        fs::write(root(home.path()), altered.as_bytes()).unwrap();
        let old = fs::read(managed(home.path())).unwrap();
        assert!(plan(home.path(), "dev", "A", false).is_err());
        assert_eq!(fs::read(root(home.path())).unwrap(), altered.as_bytes());
        assert_eq!(fs::read(managed(home.path())).unwrap(), old);
    }
}

#[test]
fn include_path_with_spaces_quotes_glob_chars_and_percent_is_literal() {
    let parent = test_home();
    let path = parent
        .path()
        .join("test [literal] 100% \\\"quote\\\" 'single' \\\\slash");
    fs::create_dir(&path).unwrap();
    let home = path.canonicalize().unwrap();
    plan(&home, "dev", "A", false)
        .unwrap()
        .commit(&stanza("dev", "actual-box"))
        .unwrap();
    assert!(effective(&home, "dev").contains("hostname actual-box\n"));
    assert_eq!(fs::read_dir(home.join(".boxlite/ssh")).unwrap().count(), 2);
}

/// An obsolete percent-escaped prefix can be repaired without editing user bytes.
#[test]
fn reinstall_repairs_percent_include_without_changing_user_configuration() {
    let parent = test_home();
    let home = parent.path().join("home 100%");
    fs::create_dir(&home).unwrap();
    fs::create_dir(home.join(".ssh")).unwrap();
    let original = stanza("unrelated", "personal");
    fs::write(root(&home), &original).unwrap();
    plan(&home, "dev", "A", false)
        .unwrap()
        .commit(&stanza("dev", "first"))
        .unwrap();
    fs::rename(
        home.join(".boxlite/ssh/config.backup"),
        home.join(".ssh/config.boxlite-backup"),
    )
    .unwrap();
    let published = fs::read_to_string(root(&home)).unwrap();
    let obsolete = if published.contains("%%") {
        published.replace("%%", "%")
    } else {
        published.replace('%', "%%")
    };
    fs::write(root(&home), obsolete).unwrap();
    plan(&home, "dev", "A", false)
        .unwrap()
        .commit(&stanza("dev", "repaired"))
        .unwrap();
    assert!(effective(&home, "dev").contains("hostname repaired\n"));
    assert!(effective(&home, "unrelated").contains("hostname personal\n"));
    assert_eq!(fs::read_to_string(root(&home)).unwrap(), published);
    assert_eq!(
        fs::read_to_string(home.join(".boxlite/ssh/config.backup")).unwrap(),
        original
    );
    assert_eq!(
        fs::read_to_string(home.join(".ssh/config.boxlite-backup")).unwrap(),
        original
    );
}

#[test]
fn installer_lock_is_exclusive_and_files_are_private() {
    let home = test_home();
    let first = plan(home.path(), "dev", "A", false).unwrap();
    assert!(plan(home.path(), "other", "B", false).is_err());
    first.commit(&stanza("dev", "first")).unwrap();
    plan(home.path(), "other", "B", false)
        .unwrap()
        .commit(&stanza("other", "second"))
        .unwrap();
    for path in [
        managed(home.path()),
        home.path().join(".boxlite/ssh/install.lock"),
        root(home.path()),
    ] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn installation_home_requires_canonical_account_home_without_writes() {
    let home = test_home();
    let other = test_home();
    checked_installation_home(home.path(), Some(other.path())).unwrap_err();
    assert!(!home.path().join(".ssh").exists());
    assert!(!other.path().join(".ssh").exists());

    let canonical = home.path().canonicalize().unwrap();
    assert_eq!(
        checked_installation_home(home.path(), Some(&canonical)).unwrap(),
        canonical
    );
    let linked = other.path().join("account-home");
    symlink(home.path(), &linked).unwrap();
    assert_eq!(
        checked_installation_home(home.path(), Some(&linked)).unwrap(),
        canonical
    );
    assert!(checked_installation_home(home.path(), None).is_err());
    assert!(checked_installation_home(home.path(), Some(&other.path().join("missing"))).is_err());
}

#[test]
fn shared_configuration_keeps_handwritten_hosts_and_identities() {
    let home = test_home();
    fs::create_dir(home.path().join(".ssh")).unwrap();
    let original = "Host dev\n  HostName personal-host\n  User personal\n  IdentityFile /manual/client\n  CertificateFile /manual/cert\n  ServerAliveInterval 23\n";
    fs::write(root(home.path()), original).unwrap();
    plan(home.path(), "dev", "A", false)
        .unwrap()
        .commit(&stanza("dev", "managed-host"))
        .unwrap();
    let resolved = effective(home.path(), "dev");
    for expected in [
        "hostname managed-host",
        "user box",
        "identityfile /manual/client",
        "certificatefile /manual/cert",
        "serveraliveinterval 23",
    ] {
        assert!(resolved.lines().any(|line| line == expected), "{resolved}");
    }
    assert!(
        fs::read(root(home.path()))
            .unwrap()
            .ends_with(original.as_bytes())
    );
}

#[rstest::rstest]
fn shared_configuration_does_not_execute_match(#[values(false, true)] nested: bool) {
    let home = test_home();
    let ssh = home.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    let marker = home.path().join("must-not-exist");
    let condition = format!(
        "Match exec \"touch {}\"\n  ServerAliveInterval 29\n",
        marker.display()
    );
    let original = if nested {
        let included = ssh.join("personal.conf");
        fs::write(&included, &condition).unwrap();
        format!("Include {}\n", included.display())
    } else {
        condition
    };
    fs::write(root(home.path()), &original).unwrap();
    plan(home.path(), "dev", "A", false)
        .unwrap()
        .commit(&stanza("dev", "managed-host"))
        .unwrap();
    assert!(
        !marker.exists(),
        "installation executed handwritten Match exec"
    );
    assert!(
        fs::read(root(home.path()))
            .unwrap()
            .ends_with(original.as_bytes())
    );
    assert!(effective(home.path(), "dev").contains("serveraliveinterval 29\n"));
    assert!(
        marker.exists(),
        "fixture must execute when OpenSSH reads it"
    );
}

#[test]
fn shared_configuration_backup_stays_outside_user_include_globs() {
    let home = test_home();
    let ssh = home.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    let original = format!("Include {}/config.*\n", ssh.display());
    fs::write(root(home.path()), &original).unwrap();
    plan(home.path(), "dev", "A", false)
        .unwrap()
        .commit(&stanza("dev", "managed-host"))
        .unwrap();
    assert_eq!(
        fs::read(home.path().join(".boxlite/ssh/config.backup")).unwrap(),
        original.as_bytes()
    );
    assert!(!ssh.join("config.boxlite-backup").exists());
    assert!(effective(home.path(), "dev").contains("hostname managed-host\n"));
    assert!(effective(home.path(), "other").contains("hostname other\n"));
}

#[test]
fn concurrent_root_changes_are_not_overwritten() {
    let home = test_home();
    plan(home.path(), "dev", "A", false)
        .unwrap()
        .commit(&stanza("dev", "first"))
        .unwrap();
    let installation = plan(home.path(), "dev", "A", false).unwrap();
    let previous = fs::read(managed(home.path())).unwrap();
    let mut edited = fs::read(root(home.path())).unwrap();
    edited.extend_from_slice(b"\nHost personal\n  User me\n");
    fs::write(root(home.path()), &edited).unwrap();
    assert!(installation.commit(&stanza("dev", "second")).is_err());
    assert_eq!(fs::read(root(home.path())).unwrap(), edited);
    assert_eq!(fs::read(managed(home.path())).unwrap(), previous);
}
