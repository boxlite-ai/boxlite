use clap::Args;

#[derive(Args, Debug)]
pub struct RmArgs {
    /// Force the removal of a running box
    #[arg(short, long)]
    pub force: bool,

    /// Name or ID of the box(es) to remove
    #[arg(required = true, num_args = 1..)]
    pub targets: Vec<String>,
}

pub async fn execute(args: RmArgs, global: &crate::cli::GlobalFlags) -> anyhow::Result<()> {
    let options = if let Some(home) = &global.home {
        boxlite::BoxliteOptions {
            home_dir: home.clone(),
        }
    } else {
        boxlite::BoxliteOptions::default()
    };
    let runtime = boxlite::BoxliteRuntime::new(options)?;

    let mut active_error = false;
    for target in args.targets {
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
