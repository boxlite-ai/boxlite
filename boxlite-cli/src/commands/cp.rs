use crate::cli::GlobalFlags;
use anyhow::{Result, anyhow};
use boxlite::{CopyOptions, LiteBox};
use clap::Args;
use std::path::PathBuf;

#[derive(Args, Debug)]
pub struct CpArgs {
    /// Copy symlinks by following their targets
    #[arg(long, default_value_t = false)]
    pub follow_symlinks: bool,

    /// Do not overwrite existing files
    #[arg(long, default_value_t = false)]
    pub no_overwrite: bool,

    /// Include parent directory when copying from box (docker cp semantics)
    #[arg(long, default_value_t = true)]
    pub include_parent: bool,

    /// Source path (host path or BOX:PATH)
    #[arg(index = 1)]
    pub src: String,

    /// Destination path (host path or BOX:PATH)
    #[arg(index = 2)]
    pub dst: String,
}

pub async fn execute(args: CpArgs, global: &GlobalFlags) -> Result<()> {
    let rt = global.create_runtime()?;

    let direction = parse_direction(&args.src, &args.dst)?;

    let opts = CopyOptions {
        follow_symlinks: args.follow_symlinks,
        overwrite: !args.no_overwrite,
        include_parent: args.include_parent,
        ..Default::default()
    };

    match direction {
        Direction::HostToBox {
            host,
            box_name,
            box_path,
        } => {
            let handle = require_box(&rt, &box_name).await?;
            let was_running = handle.info().status == boxlite::BoxStatus::Running;
            if !was_running {
                handle.start().await?;
            }
            handle
                .copy_into(&host, &box_path, opts)
                .await
                .map_err(anyhow::Error::from)?;
            if !was_running {
                handle.stop().await?;
            }
            Ok(())
        }
        Direction::BoxToHost {
            box_name,
            box_path,
            host,
        } => {
            let handle = require_box(&rt, &box_name).await?;
            let was_running = handle.info().status == boxlite::BoxStatus::Running;
            if !was_running {
                handle.start().await?;
            }
            handle
                .copy_out(&box_path, &host, opts)
                .await
                .map_err(anyhow::Error::from)?;
            if !was_running {
                handle.stop().await?;
            }
            Ok(())
        }
    }
}

pub(crate) enum Direction {
    HostToBox {
        host: PathBuf,
        box_name: String,
        box_path: String,
    },
    BoxToHost {
        box_name: String,
        box_path: String,
        host: PathBuf,
    },
}

fn parse_endpoint(input: &str) -> (Option<String>, String) {
    if let Some(idx) = input.find(':') {
        let (a, b) = input.split_at(idx);
        let path = b.trim_start_matches(':').to_string();
        (Some(a.to_string()), path)
    } else {
        (None, input.to_string())
    }
}

pub(crate) fn parse_direction(src: &str, dst: &str) -> Result<Direction> {
    let (src_box, src_path) = parse_endpoint(src);
    let (dst_box, dst_path) = parse_endpoint(dst);

    match (src_box, dst_box) {
        (Some(box_name), None) => Ok(Direction::BoxToHost {
            box_name,
            box_path: non_empty(&src_path, "source")?,
            host: PathBuf::from(dst_path),
        }),
        (None, Some(box_name)) => Ok(Direction::HostToBox {
            host: PathBuf::from(src_path),
            box_name,
            box_path: non_empty(&dst_path, "destination")?,
        }),
        (Some(_), Some(_)) => Err(anyhow!(
            "copy between boxes is not supported (both SRC and DST reference a box)"
        )),
        (None, None) => Err(anyhow!(
            "at least one of SRC or DST must reference a box (format BOX:PATH)"
        )),
    }
}

fn non_empty(path: &str, role: &str) -> Result<String> {
    if path.is_empty() {
        Err(anyhow!("{} path cannot be empty", role))
    } else {
        Ok(path.to_string())
    }
}

async fn require_box(rt: &boxlite::BoxliteRuntime, name: &str) -> Result<LiteBox> {
    match rt.get(name).await? {
        Some(b) => Ok(b),
        None => Err(anyhow!("box '{}' not found", name)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_host_to_box() {
        let dir = parse_direction("/tmp", "mybox:/app").unwrap();
        match dir {
            Direction::HostToBox {
                box_name,
                box_path,
                host,
            } => {
                assert_eq!(box_name, "mybox");
                assert_eq!(box_path, "/app");
                assert_eq!(host, PathBuf::from("/tmp"));
            }
            _ => panic!("wrong direction"),
        }
    }

    #[test]
    fn parse_box_to_host() {
        let dir = parse_direction("mybox:/etc/hosts", "./hosts").unwrap();
        match dir {
            Direction::BoxToHost {
                box_name,
                box_path,
                host,
            } => {
                assert_eq!(box_name, "mybox");
                assert_eq!(box_path, "/etc/hosts");
                assert_eq!(host, PathBuf::from("./hosts"));
            }
            _ => panic!("wrong direction"),
        }
    }

    #[test]
    fn reject_box_to_box() {
        assert!(parse_direction("a:/x", "b:/y").is_err());
    }

    #[test]
    fn reject_none() {
        assert!(parse_direction("foo", "bar").is_err());
    }
}
