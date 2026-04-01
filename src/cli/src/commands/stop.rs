use clap::Args;

#[derive(Args, Debug)]
pub struct StopArgs {
    /// Name or ID of the box(es) to stop
    #[arg(required = true, num_args = 1..)]
    pub targets: Vec<String>,
}

pub async fn execute(args: StopArgs, global: &crate::cli::GlobalFlags) -> anyhow::Result<()> {
    let runtime = global.create_runtime()?;

    let mut errors = Vec::new();
    let mut success_count = 0;

    for target in args.targets {
        // Get the box first
        let litebox = match runtime.get(&target).await? {
            Some(b) => b,
            None => {
                eprintln!("Error: No such box: {}", target);
                errors.push(format!("{}: not found", target));
                continue;
            }
        };

        if let Err(e) = litebox.stop().await {
            eprintln!("Error stopping box '{}': {}", target, e);
            errors.push(format!("{}: {}", target, e));
        } else {
            println!("{}", target);
            success_count += 1;
        }
    }

    if !errors.is_empty() {
        let error_summary = if success_count > 0 {
            format!(
                "Failed to stop {} of {} box(es)",
                errors.len(),
                errors.len() + success_count
            )
        } else {
            format!("Failed to stop all {} box(es)", errors.len())
        };

        anyhow::bail!("{}\nErrors:\n  {}", error_summary, errors.join("\n  "));
    }
    Ok(())
}
