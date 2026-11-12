use super::*;
use std::os::unix::fs::symlink;

fn test_home() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

/// Create a locked installation against an isolated canonical home.
fn plan(home: &Path, alias: &str, identity: &str, overwrite: bool) -> Result<Installation> {
    Installation::with_system_configs(
        &home.canonicalize()?,
        alias,
        identity,
        overwrite,
        vec![system_root(home)],
    )
}

fn stanza(alias: &str, hostname: &str) -> String {
    format!("Host {alias}\n  HostName {hostname}\n  User box\n  BatchMode yes\n")
}

fn root(home: &Path) -> PathBuf {
    home.join(".ssh/config")
}

fn system_root(home: &Path) -> PathBuf {
    home.join("etc/ssh/ssh_config")
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

#[rstest::rstest]
#[case::user_preflight(false, false)]
#[case::system_preflight(true, false)]
#[case::user_commit(false, true)]
#[case::system_commit(true, true)]
fn posix_class_includes_cannot_hide_personal_identities(
    #[case] system: bool,
    #[case] rescan: bool,
) {
    let home = test_home();
    let directory = home.path().join(".ssh/config.d");
    fs::create_dir_all(&directory).unwrap();
    let control = directory.join("control.inc");
    fs::write(&control, "").unwrap();
    fs::write(
        directory.join("personal.conf"),
        "Host *\n  IdentityFile /manual/personal\n",
    )
    .unwrap();
    let source = if system {
        system_root(home.path())
    } else {
        root(home.path())
    };
    fs::create_dir_all(source.parent().unwrap()).unwrap();
    let original = format!("Include {}\n", control.display());
    fs::write(&source, &original).unwrap();
    let installation = rescan.then(|| plan(home.path(), "dev", "A", false).unwrap());
    fs::write(
        &control,
        format!("Include {}/[[:alpha:]]*.conf\n", directory.display()),
    )
    .unwrap();
    let output = Command::new("ssh")
        .args(["-G", "-F"])
        .arg(&source)
        .arg("dev")
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let effective = String::from_utf8(output.stdout).unwrap();
    assert!(
        effective
            .lines()
            .any(|line| line == "identityfile /manual/personal"),
        "OpenSSH must actually include the personal identity: {effective}"
    );
    let result = match installation {
        Some(installation) => installation.commit(&stanza("dev", "127.0.0.1")),
        None => plan(home.path(), "dev", "A", false).map(drop),
    };
    assert!(
        result.is_err(),
        "installer accepted an Include that hides an active personal identity"
    );
    assert_eq!(fs::read_to_string(&source).unwrap(), original);
    assert!(!managed(home.path()).exists());
    assert!(!home.path().join(".ssh/config.boxlite-backup").exists());
}

#[test]
fn include_patterns_distinguish_posix_expressions_from_literal_brackets() {
    let home = Path::new("/home/test");
    for pattern in ["[.]", "[=]", "[[]", "[]]", "[!]]", "[abc]", "[a-z]"] {
        assert!(
            include_pattern(pattern, home, home, false).is_ok(),
            "{pattern}"
        );
    }
    for pattern in [
        "[[:alpha:]]",
        "[![:digit:]]",
        "[][:alpha:]]",
        "[a[:alpha:]]",
        "[[.a.]]",
        "[[=a=]]",
    ] {
        assert!(
            include_pattern(pattern, home, home, false).is_err(),
            "{pattern}"
        );
    }
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
    assert!(
        Installation::with_system_configs(
            &selected,
            "dev",
            "A",
            false,
            vec![system_root(home.path())],
        )
        .is_err()
    );
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
    fs::write(&fragment, "Host dev\n  User manual\n").unwrap();
    fs::write(ssh.join("%h.conf"), "Host dev\n  User manual\n").unwrap();
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

/// Nested Include conflicts are checked, while unrelated defaults remain usable.
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
        "Host dev\n  HostName manual\n",
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
    assert!(effective(&home, "dev").contains("hostname actual-box\n"));
    assert_eq!(fs::read_dir(home.join(".boxlite/ssh")).unwrap().count(), 2);
}

/// Percent expansion follows the installed OpenSSH version's Include behavior.
#[test]
fn handwritten_percent_includes_match_openssh_conflict_detection() {
    for single_conflicts in [false, true] {
        let home = test_home();
        let ssh = home.path().join(".ssh");
        fs::create_dir(&ssh).unwrap();
        for (name, conflicts) in [
            ("manual%.conf", single_conflicts),
            ("manual%%.conf", !single_conflicts),
        ] {
            let alias = if conflicts { "dev" } else { "unrelated" };
            fs::write(ssh.join(name), stanza(alias, "handwritten")).unwrap();
        }
        let original = format!("Include \"{}\"\n", ssh.join("manual%%.conf").display());
        fs::write(root(home.path()), &original).unwrap();
        let conflicts = effective(home.path(), "dev").contains("hostname handwritten\n");
        let installation = plan(home.path(), "dev", "A", false);
        if conflicts {
            installation.err().expect("handwritten Host must conflict");
            assert_eq!(fs::read_to_string(root(home.path())).unwrap(), original);
            assert!(!managed(home.path()).exists());
        } else {
            installation
                .unwrap()
                .commit(&stanza("dev", "installed"))
                .unwrap();
            assert!(effective(home.path(), "dev").contains("hostname installed\n"));
            assert!(effective(home.path(), "unrelated").contains("hostname handwritten\n"));
        }
    }
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
        fs::read_to_string(home.join(".ssh/config.boxlite-backup")).unwrap(),
        original
    );
}

/// A future backup must not turn an empty root or nested Include into recursion;
/// dot-relative spellings require the same preflight refusal.
#[test]
fn backup_include_matches_fail_before_publishing_configuration() {
    for (pattern, nested) in [
        ("config.*", false),
        ("./config.*", false),
        ("../.ssh/config.*", false),
        ("config.boxlite-backup", false),
        ("config.boxlite-*", true),
    ] {
        let home = test_home();
        let ssh = home.path().join(".ssh");
        fs::create_dir(&ssh).unwrap();
        let include = format!("Include {pattern}\n");
        let original = if nested {
            fs::write(ssh.join("manual.conf"), &include).unwrap();
            "Include manual.conf\n".to_owned()
        } else {
            include
        };
        fs::write(root(home.path()), &original).unwrap();
        assert!(effective(home.path(), "unrelated").contains("hostname unrelated\n"));

        plan(home.path(), "dev", "A", false)
            .err()
            .expect("an Include matching the future backup must fail preflight");
        assert_eq!(fs::read_to_string(root(home.path())).unwrap(), original);
        assert!(!managed(home.path()).exists());
        assert!(!ssh.join("config.boxlite-backup").exists());
        assert!(effective(home.path(), "unrelated").contains("hostname unrelated\n"));
    }
}

/// An absolute Include also names the future backup before the file exists.
#[test]
fn absolute_backup_include_fails_before_publishing_configuration() {
    let home = test_home();
    let ssh = home.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    let original = format!("Include {}.boxlite-*\n", root(home.path()).display());
    fs::write(root(home.path()), &original).unwrap();
    assert!(effective(home.path(), "unrelated").contains("hostname unrelated\n"));

    plan(home.path(), "dev", "A", false)
        .err()
        .expect("an absolute Include matching the future backup must fail preflight");
    assert_eq!(fs::read_to_string(root(home.path())).unwrap(), original);
    assert!(!managed(home.path()).exists());
    assert!(!ssh.join("config.boxlite-backup").exists());
    assert!(effective(home.path(), "unrelated").contains("hostname unrelated\n"));
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
fn active_additive_identities_in_global_host_and_match_scopes_are_rejected() {
    let home = test_home();
    fs::create_dir(home.path().join(".ssh")).unwrap();
    for option in ["IdentityFile", "IdentityFile2", "CertificateFile"] {
        for scope in ["", "Host *\n", "Match all\n"] {
            let original = format!("{scope}  {option} /manual/credential\n");
            fs::write(root(home.path()), &original).unwrap();
            assert!(
                plan(home.path(), "dev", "A", true).is_err(),
                "accepted active {option} in {scope:?}"
            );
            assert_eq!(fs::read(root(home.path())).unwrap(), original.as_bytes());
            assert!(!managed(home.path()).exists());
        }
    }
}

#[test]
fn active_additive_identities_in_direct_and_nested_includes_are_rejected() {
    let home = test_home();
    let ssh = home.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    let first = ssh.join("first.conf");
    let nested = ssh.join("nested.conf");
    fs::write(root(home.path()), "Include first.conf\n").unwrap();
    for option in ["IdentityFile", "IdentityFile2", "CertificateFile"] {
        for scope in ["", "Host *\n", "Match all\n"] {
            let identity = format!("{scope}  {option} /manual/credential\n");
            for indirect in [false, true] {
                fs::write(
                    &first,
                    if indirect {
                        "Include nested.conf\n"
                    } else {
                        &identity
                    },
                )
                .unwrap();
                fs::write(&nested, &identity).unwrap();
                assert!(
                    plan(home.path(), "dev", "A", false).is_err(),
                    "accepted {option} in {scope:?}, nested={indirect}"
                );
                assert!(!managed(home.path()).exists());
            }
        }
    }
}

#[test]
fn unrelated_and_negated_host_identities_preserve_handwritten_configuration() {
    let home = test_home();
    fs::create_dir(home.path().join(".ssh")).unwrap();
    let original = "Host other\n  IdentityFile /manual/other\n  CertificateFile /manual/other-cert\nHost * !dev\n  IdentityFile /manual/excluded\n  CertificateFile /manual/excluded-cert\n";
    fs::write(root(home.path()), original).unwrap();
    plan(home.path(), "dev", "A", false)
        .unwrap()
        .commit(&stanza("dev", "first"))
        .unwrap();
    assert!(
        fs::read_to_string(root(home.path()))
            .unwrap()
            .ends_with(original)
    );
    assert!(effective(home.path(), "dev").contains("hostname first\n"));
}

#[test]
fn inherited_inactive_include_cannot_reactivate_host_or_match() {
    let home = test_home();
    let ssh = home.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    let original = "Host other\n  Include inactive.conf\nHost *\n  User default\n";
    fs::write(root(home.path()), original).unwrap();
    fs::write(
        ssh.join("inactive.conf"),
        "Host dev\n  IdentityFile /manual/inactive\nMatch all\n  CertificateFile /manual/inactive-cert\nInclude nested.conf\n",
    )
    .unwrap();
    fs::write(
        ssh.join("nested.conf"),
        "Host dev\n  IdentityFile /manual/nested\n",
    )
    .unwrap();
    plan(home.path(), "dev", "A", false)
        .unwrap()
        .commit(&stanza("dev", "first"))
        .unwrap();
    assert!(
        fs::read_to_string(root(home.path()))
            .unwrap()
            .ends_with(original)
    );
    assert!(effective(home.path(), "dev").contains("hostname first\n"));
}

#[test]
fn include_child_scope_is_restored_before_parent_identity() {
    let home = test_home();
    let ssh = home.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    fs::write(ssh.join("child.conf"), "Host other\n  User other\n").unwrap();
    for option in ["IdentityFile", "CertificateFile"] {
        fs::write(
            root(home.path()),
            format!("Include child.conf\n{option} /manual/parent\n"),
        )
        .unwrap();
        assert!(
            plan(home.path(), "dev", "A", false).is_err(),
            "child Host scope hid parent {option}"
        );
        assert!(!managed(home.path()).exists());
    }
}

#[test]
fn include_child_scope_is_restored_before_next_included_file() {
    let home = test_home();
    let ssh = home.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    fs::write(root(home.path()), "Include first.conf second.conf\n").unwrap();
    fs::write(ssh.join("first.conf"), "Host other\n  User other\n").unwrap();
    fs::write(ssh.join("second.conf"), "CertificateFile /manual/second\n").unwrap();
    assert!(plan(home.path(), "dev", "A", false).is_err());
    assert!(!managed(home.path()).exists());
}

#[test]
fn uppercase_negated_host_does_not_exclude_normalized_alias_identity() {
    let home = test_home();
    fs::create_dir(home.path().join(".ssh")).unwrap();
    fs::write(
        root(home.path()),
        "Host * !DEV\n  IdentityFile /manual/credential\n",
    )
    .unwrap();
    assert!(plan(home.path(), "DEV", "A", false).is_err());
    assert!(!managed(home.path()).exists());
}

#[rstest::rstest]
#[case::key("IdentityFile", "identityfile")]
#[case::certificate("CertificateFile", "certificatefile")]
fn escaped_host_negation_does_not_hide_extra_identities(
    #[case] directive: &str,
    #[case] effective_keyword: &str,
) {
    let home = test_home();
    fs::create_dir(home.path().join(".ssh")).unwrap();
    fs::write(
        root(home.path()),
        format!("Host * !d\\ev\n  {directive} /manual/escaped\n"),
    )
    .unwrap();
    let resolved = effective(home.path(), "dev");
    assert!(
        resolved
            .lines()
            .any(|line| line == format!("{effective_keyword} /manual/escaped")),
        "OpenSSH must actually apply this identity: {resolved}"
    );
    assert!(
        plan(home.path(), "dev", "A", false).is_err(),
        "an escaped exclusion hid an identity that OpenSSH applies to dev"
    );
    assert!(!managed(home.path()).exists());
}

#[test]
fn literal_backslash_host_does_not_claim_the_managed_alias() {
    let home = test_home();
    fs::create_dir(home.path().join(".ssh")).unwrap();
    fs::write(
        root(home.path()),
        "Host \"d\\ev\"\n  IdentityFile /manual/other\n",
    )
    .unwrap();
    assert!(
        !effective(home.path(), "dev")
            .lines()
            .any(|line| line == "identityfile /manual/other")
    );
    plan(home.path(), "dev", "A", false)
        .unwrap()
        .commit(&stanza("dev", "first"))
        .unwrap();
}

#[test]
fn inactive_include_still_rejects_ambiguous_match_without_execution() {
    let home = test_home();
    let ssh = home.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    let marker = home.path().join("must-not-exist");
    fs::write(root(home.path()), "Host other\n  Include inactive.conf\n").unwrap();
    fs::write(
        ssh.join("inactive.conf"),
        format!("Match exec \"touch {}\"\n", marker.display()),
    )
    .unwrap();
    assert!(plan(home.path(), "dev", "A", false).is_err());
    assert!(!marker.exists());
    assert!(!managed(home.path()).exists());
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
fn uppercase_host_patterns_do_not_claim_normalized_alias() {
    let home = test_home();
    fs::create_dir(home.path().join(".ssh")).unwrap();
    let original =
        "Host DEV\n  IdentityFile /manual/uppercase\n  CertificateFile /manual/uppercase-cert\n";
    fs::write(root(home.path()), original).unwrap();
    plan(home.path(), "DEV", "A", false)
        .unwrap()
        .commit(&stanza("dev", "first"))
        .unwrap();
    assert!(
        fs::read_to_string(root(home.path()))
            .unwrap()
            .ends_with(original)
    );
    let resolved = effective(home.path(), "dev");
    assert!(resolved.contains("hostname first\n"), "{resolved}");
    assert!(!resolved.contains("/manual/uppercase"), "{resolved}");
}

#[test]
fn system_root_active_additive_identities_are_rejected_with_path_diagnostics() {
    let home = test_home();
    let system = system_root(home.path());
    fs::create_dir_all(system.parent().unwrap()).unwrap();
    for option in ["IdentityFile", "IdentityFile2", "CertificateFile"] {
        for scope in ["", "Host *\n", "Host dev\n", "Match all\n"] {
            fs::write(&system, format!("{scope}  {option} /system/credential\n")).unwrap();
            let error = match plan(home.path(), "dev", "A", false) {
                Ok(_) => panic!("accepted system {option} in {scope:?}"),
                Err(error) => format!("{error:#}"),
            };
            assert!(error.contains(system.to_str().unwrap()), "{error}");
            assert!(error.contains(&option.to_ascii_lowercase()), "{error}");
            assert!(!root(home.path()).exists());
            assert!(!managed(home.path()).exists());
        }
    }
}

#[test]
fn system_matching_hosts_without_extra_identities_are_not_user_conflicts() {
    let home = test_home();
    let system = system_root(home.path());
    fs::create_dir_all(system.parent().unwrap()).unwrap();
    let original = "Host dev\n  ServerAliveInterval 12\nHost other\n  IdentityFile /system/other\nHost * !dev\n  CertificateFile /system/excluded\n";
    fs::write(&system, original).unwrap();
    plan(home.path(), "dev", "A", false)
        .unwrap()
        .commit(&stanza("dev", "first"))
        .unwrap();
    assert_eq!(fs::read_to_string(&system).unwrap(), original);
    assert!(effective(home.path(), "dev").contains("hostname first\n"));
}

#[test]
fn nested_system_relative_includes_keep_system_root_base() {
    let home = test_home();
    let system = system_root(home.path());
    let base = system.parent().unwrap();
    fs::create_dir_all(base.join("config.d")).unwrap();
    fs::create_dir(home.path().join(".ssh")).unwrap();
    fs::write(&system, "Include config.d/outer.conf\n").unwrap();
    fs::write(base.join("config.d/outer.conf"), "Include nested.conf\n").unwrap();
    fs::write(home.path().join(".ssh/nested.conf"), "Host other\n").unwrap();
    fs::write(base.join("config.d/nested.conf"), "Host other\n").unwrap();
    let nested = base.join("nested.conf");
    fs::write(&nested, "Match all\nCertificateFile /system/credential\n").unwrap();
    let error = match plan(home.path(), "dev", "A", false) {
        Ok(_) => panic!("accepted nested system certificate"),
        Err(error) => format!("{error:#}"),
    };
    assert!(error.contains(nested.to_str().unwrap()), "{error}");
    assert!(!managed(home.path()).exists());
    fs::write(&nested, "Host other\nIdentityFile /system/other\n").unwrap();
    plan(home.path(), "dev", "A", false)
        .unwrap()
        .commit(&stanza("dev", "first"))
        .unwrap();
}

#[test]
fn inactive_system_include_cannot_reactivate_and_child_scope_does_not_escape() {
    let home = test_home();
    let system = system_root(home.path());
    let base = system.parent().unwrap();
    fs::create_dir_all(base).unwrap();
    fs::write(
        &system,
        "Host other\nInclude inactive.conf\nHost dev\nInclude child.conf\n",
    )
    .unwrap();
    fs::write(
        base.join("inactive.conf"),
        "Host dev\nIdentityFile /system/inactive\nMatch all\nCertificateFile /system/inactive-cert\n",
    )
    .unwrap();
    fs::write(base.join("child.conf"), "Host other\n").unwrap();
    plan(home.path(), "dev", "A", false)
        .unwrap()
        .commit(&stanza("dev", "first"))
        .unwrap();
    fs::write(
        &system,
        "Host dev\nInclude child.conf\nIdentityFile /system/parent\n",
    )
    .unwrap();
    assert!(plan(home.path(), "dev", "A", false).is_err());
}

#[test]
fn commit_rechecks_user_included_identities_before_publishing() {
    let home = test_home();
    let ssh = home.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    let original = "Include child.conf\n";
    fs::write(root(home.path()), original).unwrap();
    let included = ssh.join("child.conf");
    fs::write(&included, "Host other\n").unwrap();
    let installation = plan(home.path(), "dev", "A", false).unwrap();
    fs::write(&included, "IdentityFile /manual/raced\n").unwrap();
    let error = installation.commit(&stanza("dev", "first")).unwrap_err();
    assert!(format!("{error:#}").contains(included.to_str().unwrap()));
    assert_eq!(fs::read_to_string(root(home.path())).unwrap(), original);
    assert!(!managed(home.path()).exists());
    assert!(!ssh.join("config.boxlite-backup").exists());
}

#[test]
fn commit_rechecks_system_root_and_included_identities_before_publishing() {
    let home = test_home();
    let system = system_root(home.path());
    let base = system.parent().unwrap();
    fs::create_dir_all(base).unwrap();
    for nested in [false, true] {
        fs::write(&system, "Include child.conf\n").unwrap();
        let child = base.join("child.conf");
        fs::write(&child, "Host other\n").unwrap();
        let installation = plan(home.path(), "dev", "A", false).unwrap();
        let changed = if nested { &child } else { &system };
        fs::write(changed, "CertificateFile /system/raced\n").unwrap();
        let error = installation.commit(&stanza("dev", "first")).unwrap_err();
        assert!(format!("{error:#}").contains(changed.to_str().unwrap()));
        assert!(!root(home.path()).exists());
        assert!(!managed(home.path()).exists());
        assert!(!home.path().join(".ssh/config.boxlite-backup").exists());
    }
}

#[test]
fn system_include_rejects_home_expansion_while_user_include_accepts_it() {
    let home = test_home();
    let system = system_root(home.path());
    fs::create_dir_all(system.parent().unwrap()).unwrap();
    let fragment = home.path().join("manual.conf");
    fs::write(&fragment, "Host other\nIdentityFile /manual/other\n").unwrap();
    for include in ["~/manual.conf", "~root/manual.conf"] {
        fs::write(&system, format!("Include {include}\n")).unwrap();
        let error = match plan(home.path(), "dev", "A", false) {
            Ok(_) => panic!("accepted system home expansion {include}"),
            Err(error) => format!("{error:#}"),
        };
        assert!(error.contains("system SSH Include"), "{error}");
        assert!(error.contains(include), "{error}");
        assert!(!managed(home.path()).exists());
    }
    fs::write(&system, "").unwrap();
    fs::write(root(home.path()), "Include ~/manual.conf\n").unwrap();
    fs::write(&fragment, "IdentityFile /manual/active\n").unwrap();
    assert!(plan(home.path(), "dev", "A", false).is_err());
    fs::write(&fragment, "Host other\nIdentityFile /manual/other\n").unwrap();
    plan(home.path(), "dev", "A", false)
        .unwrap()
        .commit(&stanza("dev", "first"))
        .unwrap();
}

#[test]
fn identity_none_allows_installation_without_clearing_real_identities() {
    let home = test_home();
    fs::create_dir(home.path().join(".ssh")).unwrap();
    for option in ["IdentityFile", "IdentityFile2"] {
        for value in ["none", "\"NoNe\"", "n\"on\"e # disabled"] {
            let original = format!("Host *\n  {option} {value}\n");
            fs::write(root(home.path()), &original).unwrap();
            plan(home.path(), "dev", "A", false)
                .unwrap_or_else(|error| panic!("rejected {option} {value}: {error:#}"))
                .commit(&stanza("dev", "first"))
                .unwrap();
            assert!(effective(home.path(), "dev").contains("hostname first\n"));
            assert!(
                fs::read_to_string(root(home.path()))
                    .unwrap()
                    .ends_with(&original)
            );
            fs::write(
                root(home.path()),
                format!("{original}  {option} /manual/real-key\n"),
            )
            .unwrap();
            assert!(plan(home.path(), "dev", "A", false).is_err());
        }
    }
}

#[test]
fn sentinel_like_filenames_and_certificates_remain_conflicts() {
    let home = test_home();
    fs::create_dir(home.path().join(".ssh")).unwrap();
    for directive in [
        r"IdentityFile n\one",
        r#"IdentityFile "n\one""#,
        r"IdentityFile2 n\one",
        "IdentityFile ./none",
        "IdentityFile none extra",
        "CertificateFile none",
    ] {
        fs::write(root(home.path()), format!("Host *\n  {directive}\n")).unwrap();
        assert!(
            plan(home.path(), "dev", "A", false).is_err(),
            "accepted real or ambiguous identity: {directive}"
        );
    }
}

#[test]
fn system_root_uses_openssh_hostfile_defaults_instead_of_platform_path() {
    let home = test_home();
    let config = home.path().join("probe.conf");
    let directory = system_root(home.path()).parent().unwrap().to_owned();
    fs::write(
        &config,
        format!(
            "GlobalKnownHostsFile {}/ssh_known_hosts {}/ssh_known_hosts2\n",
            directory.display(),
            directory.display()
        ),
    )
    .unwrap();
    let output = Command::new("ssh")
        .args(["-G", "-F"])
        .arg(&config)
        .args(["--", "127.0.0.1"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let defaults = String::from_utf8(output.stdout).unwrap();
    assert_eq!(
        system_config_from_defaults(&defaults).unwrap(),
        system_root(home.path()),
        "the selected OpenSSH configuration directory must follow its defaults"
    );
}

#[test]
fn unknown_or_ambiguous_openssh_system_roots_are_not_guessed() {
    for defaults in [
        "",
        "globalknownhostsfile none\n",
        "globalknownhostsfile relative/ssh_known_hosts relative/ssh_known_hosts2\n",
        "globalknownhostsfile /one/ssh_known_hosts /two/ssh_known_hosts2\n",
        "globalknownhostsfile /one/not-the-default /one/ssh_known_hosts2\n",
        "globalknownhostsfile /one/ssh_known_hosts /one/ssh_known_hosts2\nglobalknownhostsfile /two/ssh_known_hosts /two/ssh_known_hosts2\n",
    ] {
        assert!(
            system_config_from_defaults(defaults).is_err(),
            "guessed a system root from {defaults:?}"
        );
    }
}

fn plan_system_roots(home: &Path, roots: &[PathBuf]) -> Result<Installation> {
    Installation::with_system_configs(&home.canonicalize()?, "dev", "A", false, roots.to_vec())
}

#[test]
fn vendor_root_is_scanned_when_primary_is_missing_and_keeps_compiled_include_base() {
    let home = test_home();
    let primary = system_root(home.path());
    let vendor = home.path().join("vendor/ssh_config");
    fs::create_dir_all(primary.parent().unwrap()).unwrap();
    fs::create_dir_all(vendor.parent().unwrap()).unwrap();
    fs::write(&vendor, "Include identity.conf\n").unwrap();
    let compiled_include = primary.parent().unwrap().join("identity.conf");
    let decoy = vendor.parent().unwrap().join("identity.conf");
    fs::write(&compiled_include, "IdentityFile /system/personal\n").unwrap();
    fs::write(&decoy, "Host other\n").unwrap();
    let roots = [primary.clone(), vendor];
    assert!(
        plan_system_roots(home.path(), &roots).is_err(),
        "missed the vendor Include's identity in the compiled SSHDIR"
    );
    assert!(!root(home.path()).exists());
    assert!(!managed(home.path()).exists());

    fs::write(&primary, "Host *\n  ServerAliveInterval 12\n").unwrap();
    assert!(
        plan_system_roots(home.path(), &roots).is_err(),
        "creating the primary root must not hide additive vendor identities"
    );
    fs::write(&compiled_include, "Host other\n").unwrap();
    fs::write(&decoy, "IdentityFile /vendor/decoy\n").unwrap();
    plan_system_roots(home.path(), &roots)
        .unwrap()
        .commit(&stanza("dev", "first"))
        .unwrap();
    assert!(effective(home.path(), "dev").contains("hostname first\n"));
}

#[rstest::rstest]
#[case::proxy_host_authentication(
    "Host *\n  NoHostAuthenticationForProxyCommand yes\n",
    "nohostauthenticationforproxycommand yes"
)]
#[case::embedded_carriage_return(
    "Host * !dev\rignored\n  IdentityFile /manual/personal\n",
    "identityfile /manual/personal"
)]
fn inherited_authentication_controls_cannot_bypass_scanning(
    #[case] contents: &str,
    #[case] expected: &str,
    #[values(false, true)] system: bool,
    #[values(false, true)] rescan: bool,
) {
    let home = test_home();
    let source = if system {
        system_root(home.path())
    } else {
        root(home.path())
    };
    fs::create_dir_all(source.parent().unwrap()).unwrap();
    let included = source.with_file_name("included.conf");
    fs::write(&included, "").unwrap();
    let original = format!(
        "IgnoreUnknown NoHostAuthenticationForProxyCommand\nInclude {}\n",
        included.display()
    );
    fs::write(&source, &original).unwrap();
    let installation = rescan.then(|| plan(home.path(), "dev", "A", false).unwrap());
    fs::write(&included, contents).unwrap();

    let output = Command::new("ssh")
        .args(["-G", "-F"])
        .arg(&source)
        .arg("dev")
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let effective = String::from_utf8(output.stdout).unwrap();
    // Portable OpenSSH may also be installed on macOS; the refusal below is
    // unconditional, but only Apple's client exposes this effective option.
    if expected.starts_with("identityfile ")
        || effective
            .lines()
            .any(|line| line.starts_with("nohostauthenticationforproxycommand "))
    {
        assert!(
            effective.lines().any(|line| line == expected),
            "OpenSSH must apply the inherited setting: {effective}"
        );
    }
    let result = match installation {
        Some(installation) => installation.commit(&stanza("dev", "first")),
        None => plan(home.path(), "dev", "A", false).map(drop),
    };
    assert!(
        result.is_err(),
        "installer accepted an inherited authentication bypass: {contents:?}"
    );
    assert_eq!(fs::read_to_string(&source).unwrap(), original);
    assert!(!managed(home.path()).exists());
    assert!(!home.path().join(".ssh/config.boxlite-backup").exists());
}

#[rstest::rstest]
fn unicode_include_names_cannot_hide_personal_identities(
    #[values(false, true)] system: bool,
    #[values(false, true)] rescan: bool,
    #[values(false, true)] directory: bool,
) {
    let home = test_home();
    let source = if system {
        system_root(home.path())
    } else {
        root(home.path())
    };
    fs::create_dir_all(source.parent().unwrap()).unwrap();
    let control = source.with_file_name("control.inc");
    fs::write(&control, "").unwrap();
    let original = format!("Include {}\n", control.display());
    fs::write(&source, &original).unwrap();
    let installation = rescan.then(|| plan(home.path(), "dev", "A", false).unwrap());
    let (name, pattern) = if directory {
        ("é/personal.conf", "??/personal.conf")
    } else {
        ("é.conf", "??.conf")
    };
    let included = source.parent().unwrap().join(name);
    fs::create_dir_all(included.parent().unwrap()).unwrap();
    fs::write(&included, "IdentityFile /manual/personal\n").unwrap();
    fs::write(
        &control,
        format!("Include {}/{pattern}\n", source.parent().unwrap().display()),
    )
    .unwrap();
    let output = Command::new("ssh")
        .args(["-G", "-F"])
        .arg(&source)
        .arg("dev")
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let effective = String::from_utf8(output.stdout).unwrap();
    assert!(
        effective
            .lines()
            .any(|line| line == "identityfile /manual/personal"),
        "OpenSSH must include the Unicode-named identity file: {effective}"
    );
    let result = match installation {
        Some(installation) => installation.commit(&stanza("dev", "first")),
        None => plan(home.path(), "dev", "A", false).map(drop),
    };
    assert!(result.is_err(), "Unicode Include hid a personal identity");
    assert_eq!(fs::read_to_string(&source).unwrap(), original);
    assert!(!managed(home.path()).exists());
    assert!(!home.path().join(".ssh/config.boxlite-backup").exists());
}

#[rstest::rstest]
#[case::disabled("Host *\r\n  NoHostAuthenticationForProxyCommand no\r\n")]
#[case::excluded(
    "Host * !dev\r\n  NoHostAuthenticationForProxyCommand yes\r\n  IdentityFile /manual/excluded\r\n"
)]
fn safe_proxy_authentication_settings_and_crlf_remain_usable(#[case] contents: &str) {
    let home = test_home();
    fs::create_dir(home.path().join(".ssh")).unwrap();
    let original = format!("IgnoreUnknown NoHostAuthenticationForProxyCommand\r\n{contents}");
    fs::write(root(home.path()), &original).unwrap();
    plan(home.path(), "dev", "A", false)
        .unwrap()
        .commit(&stanza("dev", "first"))
        .unwrap();
    let resolved = effective(home.path(), "dev");
    assert!(resolved.lines().any(|line| line == "hostname first"));
    assert!(
        !resolved
            .lines()
            .any(|line| line == "identityfile /manual/excluded")
    );
    assert!(
        fs::read_to_string(root(home.path()))
            .unwrap()
            .ends_with(&original)
    );
}

#[rstest::rstest]
#[case::managed(".boxlite/ssh/config")]
#[case::backup(".ssh/config.boxlite-backup")]
fn unicode_parent_patterns_cannot_include_future_installer_files(#[case] destination: &str) {
    let parent = test_home();
    let home = parent.path().join("é");
    fs::create_dir_all(home.join(".ssh")).unwrap();
    let original = format!("Include {}/??/{destination}\n", parent.path().display());
    fs::write(root(&home), &original).unwrap();
    assert!(
        plan(&home, "dev", "A", false).is_err(),
        "an Include can load a future installer-owned file"
    );
    assert_eq!(fs::read_to_string(root(&home)).unwrap(), original);
    assert!(!managed(&home).exists());
    assert!(!home.join(".ssh/config.boxlite-backup").exists());
}

#[rstest::rstest]
#[case::identity("[^a].conf", "a.conf", "IdentityFile /manual/personal\n")]
#[case::managed("../.boxlite/ssh/[^c]onfig", "", "")]
#[case::backup("[^c]onfig.boxlite-backup", "", "")]
fn ambiguous_caret_include_patterns_are_refused_before_publication(
    #[case] pattern: &str,
    #[case] name: &str,
    #[case] contents: &str,
    #[values(false, true)] rescan: bool,
) {
    let home = test_home();
    fs::create_dir(home.path().join(".ssh")).unwrap();
    let control = home.path().join(".ssh/control.inc");
    fs::write(&control, "").unwrap();
    let original = "Include control.inc\n";
    fs::write(root(home.path()), original).unwrap();
    let installation = rescan.then(|| plan(home.path(), "dev", "A", false).unwrap());
    if !name.is_empty() {
        fs::write(home.path().join(".ssh").join(name), contents).unwrap();
    }
    fs::write(&control, format!("Include {pattern}\n")).unwrap();
    let result = match installation {
        Some(installation) => installation.commit(&stanza("dev", "first")),
        None => plan(home.path(), "dev", "A", false).map(drop),
    };
    assert!(result.is_err(), "ambiguous caret Include was accepted");
    assert_eq!(fs::read_to_string(root(home.path())).unwrap(), original);
    assert!(!managed(home.path()).exists());
    assert!(!home.path().join(".ssh/config.boxlite-backup").exists());
}

#[rstest::rstest]
#[case::user_relative(false, "personal.conf")]
#[case::user_home(false, "~/.ssh/personal.conf")]
#[case::system_relative(true, "personal.conf")]
fn literal_backslashes_in_include_bases_cannot_hide_identities(
    #[case] system: bool,
    #[case] include: &str,
    #[values(false, true)] rescan: bool,
) {
    let parent = test_home();
    let home = parent.path().join(r"a\b");
    let source = if system {
        system_root(&home)
    } else {
        root(&home)
    };
    fs::create_dir_all(source.parent().unwrap()).unwrap();
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
    let personal = source.with_file_name("personal.conf");
    fs::write(&personal, "").unwrap();
    let original = format!("Include {include}\n");
    fs::write(&source, &original).unwrap();
    let installation = rescan.then(|| plan(&home, "dev", "A", false).unwrap());
    fs::write(&personal, "IdentityFile /manual/personal\n").unwrap();
    let result = match installation {
        Some(installation) => installation.commit(&stanza("dev", "first")),
        None => plan(&home, "dev", "A", false).map(drop),
    };
    assert!(
        result.is_err(),
        "native Include expansion consumed a literal backslash in its base"
    );
    assert_eq!(fs::read_to_string(&source).unwrap(), original);
    assert!(!managed(&home).exists());
    assert!(!home.join(".ssh/config.boxlite-backup").exists());
}
