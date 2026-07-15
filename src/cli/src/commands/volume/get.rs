use std::io::Write;

use crate::cli::GlobalFlags;
use crate::commands::volume::ls::VolumePresenter;
use crate::formatter::{self, OutputFormat};
use clap::Args;

/// Show details for a volume.
#[derive(Args, Debug)]
pub struct GetArgs {
    /// Volume id.
    pub id: String,

    /// Output format (table, json, yaml).
    #[arg(long, default_value = "table")]
    pub format: String,
}

pub async fn run(args: GetArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let info = rt.volumes()?.get(&args.id).await?;

    let presenter = VolumePresenter::from(&info);
    let format = OutputFormat::from_str(&args.format)?;
    formatter::print_output(
        &mut std::io::stdout().lock(),
        &presenter,
        format,
        |writer, data| {
            // Table mode: one row for the single volume.
            let table = formatter::create_table(std::iter::once(data)).to_string();
            writeln!(writer, "{}", table)?;
            Ok(())
        },
    )?;

    Ok(())
}
