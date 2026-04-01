use clap::Args;

#[derive(Args, Debug)]
pub struct RmArgs {
    /// Force the removal of a running box
    #[arg(short, long)]
    pub force: bool,

    /// Remove all boxes
    #[arg(short, long)]
    pub all: bool,

    /// Name or ID of the box(es) to remove
    #[arg(required_unless_present = "all", num_args = 1..)]
    pub targets: Vec<String>,
}

pub async fn execute(args: RmArgs, global: &crate::cli::GlobalFlags) -> anyhow::Result<()> {
    let runtime = global.create_runtime()?;

    // Require confirmation for --all unless --force is specified
    if args.all && !args.force {
        use std::io::{self, Write};
        eprint!("WARNING! This will remove all boxes. Are you sure? [y/N] ");
        io::stderr().flush()?;
        let mut input = String::new();
        io::stdin().read_line(&mut input)?;
        if !input.trim().eq_ignore_ascii_case("y") {
            return Ok(());
        }
    }

    let targets = if args.all {
        runtime
            .list_info()
            .await?
            .into_iter()
            .map(|info| info.id.to_string())
            .collect()
    } else {
        args.targets
    };

    let mut active_error = false;
    for target in targets {
        if let Err(e) = runtime.remove(&target, args.force).await {
            eprintln!("Error removing box '{}': {}", target, e);
            active_error = true;
        } else {
            println!("{}", target);
        }
    }

    if active_error {
        anyhow::bail!("Some boxes could not be removed");
    }
    Ok(())
}
