use clap::Args;

#[derive(Args, Debug)]
pub struct StartArgs {
    /// Name or ID of the box(es) to start
    #[arg(required = true, num_args = 1..)]
    pub targets: Vec<String>,
}

pub async fn execute(args: StartArgs, global: &crate::cli::GlobalFlags) -> anyhow::Result<()> {
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

        if let Err(e) = litebox.start().await {
            eprintln!("Error starting box '{}': {}", target, e);
            errors.push(format!("{}: {}", target, e));
        } else {
            println!("{}", target);
            success_count += 1;
        }
    }

    if !errors.is_empty() {
        let error_summary = if success_count > 0 {
            format!(
                "Failed to start {} of {} box(es)",
                errors.len(),
                errors.len() + success_count
            )
        } else {
            format!("Failed to start all {} box(es)", errors.len())
        };

        anyhow::bail!("{}\nErrors:\n  {}", error_summary, errors.join("\n  "));
    }
    Ok(())
}
