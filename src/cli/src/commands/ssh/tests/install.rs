use super::*;
use std::os::unix::fs::symlink;

fn test_home() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn plan(home: &Path, alias: &str, identity: &str, overwrite: bool) -> Result<Installation> {
    Installation::with_home(&home.canonicalize()?, alias, identity, overwrite)
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
        fs::read(home.path().join(".ssh/config.boxlite-backup")).unwrap(),
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
        fs::read(home.path().join(".ssh/config.boxlite-backup")).unwrap(),
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
    assert!(Installation::with_home(&selected, "dev", "A", false).is_err());
}

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
        format!("Include \"{}\"\n", managed(home.path()).display()),
        format!(
            "Match all\nInclude \"{}\"\n",
            managed(home.path()).display()
        ),
    ] {
        fs::write(root(home.path()), altered.as_bytes()).unwrap();
        let old = fs::read(managed(home.path())).unwrap();
        assert!(plan(home.path(), "dev", "A", false).is_err());
        assert_eq!(fs::read(root(home.path())).unwrap(), altered.as_bytes());
        assert_eq!(fs::read(managed(home.path())).unwrap(), old);
    }
}
#[test]
fn unsupported_include_expansion_and_relative_handwritten_collision_fail_preflight() {
    let home = test_home();
    let ssh = home.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    let fragment = ssh.join("manual.conf");
    fs::write(&fragment, "Host DEV\n  User manual\n").unwrap();
    for original in [
        "Include manual.conf\n",
        "Include %h.conf\n",
        "Include ${HOME}/manual.conf\n",
    ] {
        fs::write(root(home.path()), original).unwrap();
        assert!(plan(home.path(), "dev", "A", true).is_err());
        assert_eq!(fs::read(root(home.path())).unwrap(), original.as_bytes());
        assert!(!managed(home.path()).exists());
    }
}

#[test]
fn nested_includes_patterns_negation_defaults_and_cycles() {
    let home = test_home();
    let ssh = home.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    fs::create_dir(ssh.join("config.d")).unwrap();
    fs::write(
        root(home.path()),
        format!(
            "Include={}/*.conf\nHost *\n  User default\n",
            ssh.join("config.d").display()
        ),
    )
    .unwrap();
    let fragment = ssh.join("config.d/hosts.conf");
    let nested = ssh.join("config.d/nested.conf");
    fs::write(&fragment, format!("Include {}\n", nested.display())).unwrap();
    fs::write(
        &nested,
        "Host *\n  ServerAliveInterval 12\nHost d* !dev\n  User other\n",
    )
    .unwrap();
    plan(home.path(), "dev", "A", false)
        .unwrap()
        .commit(&stanza("dev", "first"))
        .unwrap();
    assert!(effective(home.path(), "dev").contains("hostname first\n"));
    assert!(effective(home.path(), "unrelated").contains("user default\n"));
    let old = fs::read(managed(home.path())).unwrap();
    for content in [
        "Host d*\n  HostName manual\n",
        "Host DEV\n  HostName manual\n",
        "Include config.d/hosts.conf\n",
        "Match exec true\nHost dev\n  User unsafe\n",
    ] {
        fs::write(&fragment, content).unwrap();
        assert!(plan(home.path(), "dev", "A", true).is_err(), "{content}");
        assert_eq!(fs::read(managed(home.path())).unwrap(), old);
    }
    fs::write(
        &fragment,
        format!(
            "Include {}/*.missing\nHost other\n  User other\n",
            ssh.display()
        ),
    )
    .unwrap();
    plan(home.path(), "dev", "A", false)
        .unwrap()
        .commit(&stanza("dev", "second"))
        .unwrap();
    assert!(effective(home.path(), "dev").contains("hostname second\n"));
}

#[test]
fn quoted_read_only_symlink_include_is_scanned() {
    let home = test_home();
    let ssh = home.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    let fragment = home.path().join("ordinary fragment.conf");
    fs::write(&fragment, "Host *\n  ServerAliveInterval 9\n").unwrap();
    symlink(&fragment, ssh.join("handwritten include.conf")).unwrap();
    fs::write(
        root(home.path()),
        format!(
            "Include \"{}\"\nHost unrelated\n  User other\n",
            ssh.join("handwritten include.conf").display()
        ),
    )
    .unwrap();
    plan(home.path(), "dev", "A", false)
        .unwrap()
        .commit(&stanza("dev", "first"))
        .unwrap();
    assert!(effective(home.path(), "dev").contains("serveraliveinterval 9\n"));
    fs::write(&fragment, "Host d?v\n  HostName stolen\n").unwrap();
    let previous = fs::read(managed(home.path())).unwrap();
    assert!(plan(home.path(), "dev", "A", true).is_err());
    assert_eq!(fs::read(managed(home.path())).unwrap(), previous);
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
    let config = fs::read_to_string(root(&home)).unwrap();
    let (_, include_value) = directive(config.lines().nth(1).unwrap()).unwrap();
    let include = words(include_value).unwrap();
    assert_eq!(include.len(), 1);
    let pattern = include_pattern(&include[0], &home).unwrap();
    assert!(
        glob::Pattern::new(&pattern)
            .unwrap()
            .matches(managed(&home).to_str().unwrap()),
        "generated Include does not resolve to its managed file: {pattern}"
    );
    assert!(effective(&home, "dev").contains("hostname actual-box\n"));
    assert_eq!(fs::read_dir(home.join(".boxlite/ssh")).unwrap().count(), 2);
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
