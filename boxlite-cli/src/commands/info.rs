use crate::cli::GlobalFlags;
use crate::formatter;
use clap::Args;
use clap::ValueEnum;

/// Display system-wide runtime information (default: YAML).
#[derive(Args, Debug)]
pub struct InfoArgs {
    /// Output format (yaml, json)
    #[arg(long, default_value_t = InfoFormat::Yaml, value_enum)]
    pub format: InfoFormat,
}

#[derive(Default, Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum InfoFormat {
    #[default]
    Yaml,
    Json,
}

pub async fn execute(args: InfoArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let info = rt.system_info().await?;

    let out = match args.format {
        InfoFormat::Yaml => formatter::format_yaml(&info)?,
        InfoFormat::Json => formatter::format_json(&info)?,
    };
    println!("{}", out);
    Ok(())
}
