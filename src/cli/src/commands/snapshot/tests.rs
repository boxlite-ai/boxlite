use super::SnapshotCommand;
use crate::cli::{Cli, Commands};
use clap::Parser;

#[test]
fn snapshot_commands_preserve_scope_and_aliases() {
    for verb in ["ls", "list"] {
        let cli =
            Cli::try_parse_from(["boxlite", "snapshot", verb, "--box", "source", "-q"]).unwrap();
        let Commands::Snapshot(args) = cli.command else {
            panic!("snapshot command")
        };
        let SnapshotCommand::Ls(args) = args.command else {
            panic!("list command")
        };
        assert_eq!(args.box_id.as_deref(), Some("source"));
        assert!(args.quiet);
    }
    for verb in ["rm", "delete"] {
        let cli = Cli::try_parse_from(["boxlite", "snapshot", verb, "a", "b", "--force"]).unwrap();
        let Commands::Snapshot(args) = cli.command else {
            panic!("snapshot command")
        };
        let SnapshotCommand::Rm(args) = args.command else {
            panic!("remove command")
        };
        assert_eq!(args.snapshots, ["a", "b"]);
        assert!(args.force);
    }
    assert!(Cli::try_parse_from(["boxlite", "snapshot", "restore", "snap"]).is_err());
    assert!(
        Cli::try_parse_from(["boxlite", "snapshot", "restore", "snap", "--box", "target"]).is_ok()
    );
}

#[test]
fn snapshot_create_source_is_explicit_and_exclusive() {
    let cli = Cli::try_parse_from([
        "boxlite",
        "create",
        "--snapshot",
        "snap",
        "--name",
        "worker",
    ])
    .unwrap();
    let Commands::Create(args) = cli.command else {
        panic!("create command")
    };
    assert_eq!(args.snapshot.as_deref(), Some("snap"));
    assert_eq!(args.management.name.as_deref(), Some("worker"));
    assert!(Cli::try_parse_from(["boxlite", "create", "--snapshot", "snap", "alpine"]).is_err());
    assert!(
        Cli::try_parse_from([
            "boxlite",
            "create",
            "--snapshot",
            "snap",
            "--rootfs",
            "/rootfs"
        ])
        .is_err()
    );
}
