use boxlite::runtime::gc::GcOptions;
use clap::Args;

#[derive(Args, Debug)]
pub struct GcArgs {
    /// Show what would be reclaimed without deleting anything.
    #[arg(short = 'n', long)]
    pub dry_run: bool,
}

pub async fn execute(args: GcArgs, global: &crate::cli::GlobalFlags) -> anyhow::Result<()> {
    let runtime = global.create_runtime()?;

    let report = runtime.collect_garbage(&GcOptions {
        dry_run: args.dry_run,
    })?;

    let verb = if report.dry_run {
        "Would reclaim"
    } else {
        "Reclaimed"
    };
    println!(
        "{verb} {} total ({} orphan box dir(s), {} orphan base(s), {} orphan image disk(s))",
        human_bytes(report.total_bytes()),
        report.box_dirs_removed,
        report.bases_removed,
        report.disk_images_removed,
    );
    if report.dry_run {
        println!("(dry run — nothing deleted; re-run without --dry-run to apply)");
    }
    Ok(())
}

fn human_bytes(bytes: u64) -> String {
    const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MIB: f64 = 1024.0 * 1024.0;
    let b = bytes as f64;
    if b >= GIB {
        format!("{:.2} GiB", b / GIB)
    } else {
        format!("{:.1} MiB", b / MIB)
    }
}
