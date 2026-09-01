use crate::cli::GlobalFlags;
use anyhow::{Result, anyhow};
use boxlite::{CopyOptions, LiteBox};
use clap::Args;
use std::path::PathBuf;

#[derive(Args, Debug)]
pub struct CpArgs {
    /// Copy symlinks by following their targets (local runtime only)
    #[arg(long, default_value_t = false)]
    pub follow_symlinks: bool,

    /// Do not overwrite existing files (local runtime only)
    #[arg(long, default_value_t = false)]
    pub no_overwrite: bool,

    /// Copy directory contents without their parent directory (local runtime only)
    #[arg(long)]
    pub no_include_parent: bool,

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
    args.require_supported_backend(global.targets_rest()?)?;

    let opts = CopyOptions {
        follow_symlinks: args.follow_symlinks,
        overwrite: !args.no_overwrite,
        include_parent: !args.no_include_parent,
        ..Default::default()
    };

    match direction {
        Direction::HostToBox {
            host,
            box_name,
            box_path,
        } => {
            let handle = require_box(&rt, &box_name).await?;
            let was_running = handle.info().await?.status == boxlite::BoxStatus::Running;

            // No explicit start(): copy_into boots the box itself when that is
            // safe, and refuses when it is not. Starting it here would walk
            // straight past that guard and, for a box whose init is the user's
            // own command, run their workload a second time just to fetch a file.
            let copied = handle.copy_into(&host, &box_path, opts).await;

            // copy_into boots a stopped box before copying, so a copy that fails
            // partway (a missing path, say) leaves it running. Restore the box to
            // the state we found it in on both paths, surfacing the copy error
            // first so a cleanup failure can't mask it.
            let stopped = if was_running {
                Ok(())
            } else {
                handle.stop().await
            };
            copied.map_err(anyhow::Error::from)?;
            stopped?;
            Ok(())
        }
        Direction::BoxToHost {
            box_name,
            box_path,
            host,
        } => {
            let handle = require_box(&rt, &box_name).await?;
            let was_running = handle.info().await?.status == boxlite::BoxStatus::Running;

            // Same as above: let copy_out decide whether booting is safe. This
            // is the path that would otherwise turn
            //   boxlite run --name job alpine sh -c 'send-payment'
            //   boxlite cp job:/receipt .
            // into a second payment.
            let copied = handle.copy_out(&box_path, &host, opts).await;

            // Same restore-on-failure as HostToBox: copy_out can boot a stopped
            // box, and a partial failure must not leave it running.
            let stopped = if was_running {
                Ok(())
            } else {
                handle.stop().await
            };
            copied.map_err(anyhow::Error::from)?;
            stopped?;
            Ok(())
        }
    }
}

impl CpArgs {
    fn require_supported_backend(&self, targets_rest: bool) -> Result<()> {
        if targets_rest && (self.follow_symlinks || self.no_overwrite || self.no_include_parent) {
            anyhow::bail!(
                "--follow-symlinks, --no-overwrite, and --no-include-parent are supported only \
                 by the embedded local runtime; the REST copy protocol does not carry these \
                 options"
            );
        }
        Ok(())
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

    fn args() -> CpArgs {
        CpArgs {
            follow_symlinks: false,
            no_overwrite: false,
            no_include_parent: false,
            src: "box:/src".to_string(),
            dst: "/dst".to_string(),
        }
    }

    #[test]
    fn rest_copy_rejects_every_option_the_protocol_would_discard() {
        assert!(args().require_supported_backend(true).is_ok());

        let mut follow = args();
        follow.follow_symlinks = true;
        assert!(follow.require_supported_backend(true).is_err());

        let mut overwrite = args();
        overwrite.no_overwrite = true;
        assert!(overwrite.require_supported_backend(true).is_err());

        let mut parent = args();
        parent.no_include_parent = true;
        assert!(parent.require_supported_backend(true).is_err());
    }

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
