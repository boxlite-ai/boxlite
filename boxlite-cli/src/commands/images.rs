use crate::cli::GlobalFlags;
use crate::formatter::{self, OutputFormat};
use boxlite::runtime::types::ImageInfo;
use clap::Args;
use serde::Serialize;
use tabled::Tabled;

/// List images
#[derive(Args, Debug)]
pub struct ImagesArgs {
    /// Show all images (default hides intermediate images)
    #[arg(short = 'a', long)]
    pub all: bool,

    /// Only show image IDs
    #[arg(short, long)]
    pub quiet: bool,

    /// Output format (table, json, yaml)
    #[arg(long, default_value = "table")]
    pub format: String,
}

/// Presenter for image output, used by both table and JSON/YAML formats.
#[derive(Tabled, Serialize)]
struct ImagePresenter {
    #[tabled(rename = "REPOSITORY")]
    #[serde(rename = "Repository")]
    repository: String,
    #[tabled(rename = "TAG")]
    #[serde(rename = "Tag")]
    tag: String,
    #[tabled(rename = "IMAGE ID")]
    #[serde(rename = "ID")]
    id: String,
    #[tabled(rename = "CREATED")]
    #[serde(rename = "CreatedAt")]
    created: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[tabled(skip)]
    size: Option<String>,
}

impl From<&ImageInfo> for ImagePresenter {
    fn from(info: &ImageInfo) -> Self {
        Self {
            repository: info.repository.clone(),
            tag: info.tag.clone(),
            id: get_short_id(&info.id),
            created: formatter::format_time(&info.cached_at),
            size: info.size.map(|s| s.to_string()),
        }
    }
}

pub async fn execute(args: ImagesArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let image_handle = rt.images()?;
    let images = image_handle.list().await?;

    if args.quiet {
        for info in images {
            println!("{}", info.id);
        }
        return Ok(());
    }

    let presenters: Vec<ImagePresenter> = images.iter().map(Into::into).collect();
    let format = OutputFormat::from_str(&args.format)?;
    formatter::print_output(
        &mut std::io::stdout().lock(),
        &presenters,
        format,
        |writer, data| {
            print_images(writer, data)?;
            Ok(())
        },
    )?;

    Ok(())
}

fn print_images(writer: &mut impl std::io::Write, images: &[ImagePresenter]) -> anyhow::Result<()> {
    let table = formatter::create_table(images).to_string();
    writeln!(writer, "{}", table)?;
    Ok(())
}

fn get_short_id(id: &str) -> String {
    let clean_id = id.strip_prefix("sha256:").unwrap_or(id);
    if clean_id.len() > 12 {
        clean_id.chars().take(12).collect()
    } else {
        clean_id.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_short_id() {
        assert_eq!(get_short_id("sha256:1234567890abcdef1234"), "1234567890ab");
        assert_eq!(get_short_id("1234567890abcdef1234"), "1234567890ab");
        assert_eq!(get_short_id("short"), "short");
        assert_eq!(get_short_id("sha256:short"), "short");
    }
}
