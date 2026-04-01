use clap::Args;

#[derive(Args, Debug)]
pub struct RestartArgs {
    /// Name or ID of the box(es) to restart
    #[arg(required = true, num_args = 1..)]
    pub targets: Vec<String>,
}

pub async fn execute(args: RestartArgs, global: &crate::cli::GlobalFlags) -> anyhow::Result<()> {
    let runtime = global.create_runtime()?;

    let mut errors = Vec::new();
    let mut success_count = 0;

    for target in args.targets {
        let litebox = match runtime.get(&target).await? {
            Some(b) => b,
            None => {
                eprintln!("Error: No such box: {}", target);
                errors.push(format!("{}: not found", target));
                continue;
            }
        };

        if let Err(e) = litebox.stop().await {
            // If stop fails, we should NOT proceed to start, because resources might still be locked.
            eprintln!("Error restarting box '{}': {}", target, e);
            errors.push(format!("{}: {}", target, e));
            continue;
        }

        // After stop, handle is invalidated. Get a new handle.
        // Came across:Handle invalidated after stop(). Use runtime.get() to get a new handle.
        let litebox = match runtime.get(&target).await? {
            Some(b) => b,
            None => {
                eprintln!("Error: Box disappeared after stop: {}", target);
                errors.push(format!("{}: disappeared after stop", target));
                continue;
            }
        };

        if let Err(e) = litebox.start().await {
            eprintln!("Error restarting box '{}': {}", target, e);
            errors.push(format!("{}: {}", target, e));
        } else {
            println!("{}", target);
            success_count += 1;
        }
    }

    if !errors.is_empty() {
        let error_summary = if success_count > 0 {
            format!(
                "Failed to restart {} of {} box(es)",
                errors.len(),
                errors.len() + success_count
            )
        } else {
            format!("Failed to restart all {} box(es)", errors.len())
        };

        anyhow::bail!("{}\nErrors:\n  {}", error_summary, errors.join("\n  "));
    }
    Ok(())
}
