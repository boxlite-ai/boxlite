use crate::cli::GlobalFlags;
use anyhow::{Result, anyhow};
use boxlite::{BoxStatus, CopyOptions, LiteBox};
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
        ..Default::default()
    };

    let box_name = match &direction {
        Direction::HostToBox { box_name, .. } | Direction::BoxToHost { box_name, .. } => box_name,
    };
    let handle = require_box(&rt, box_name).await?;
    let status = handle.info().await?.status;
    if status == BoxStatus::Paused {
        anyhow::bail!("cp is not allowed on paused boxes: box '{box_name}' is {status}");
    }

    // Let the copy decide whether it can boot the box. An explicit start
    // would bypass the guard against running the user's main command again.
    let copied = match direction {
        Direction::HostToBox { host, box_path, .. } => {
            handle.copy_into(&host, &box_path, opts).await
        }
        Direction::BoxToHost { box_path, host, .. } => {
            handle.copy_out(&box_path, &host, opts).await
        }
    };

    let stopped = stop_after_copy(&handle, status).await;
    copied?;
    stopped?;
    Ok(())
}

async fn stop_after_copy(
    handle: &LiteBox,
    initial_status: BoxStatus,
) -> boxlite::BoxliteResult<()> {
    // Copy may have booted the box even if it failed. Clean up based on the
    // initial status so an unavailable status endpoint can't prevent stopping it.
    if matches!(initial_status, BoxStatus::Configured | BoxStatus::Stopped) {
        handle.stop().await?;
    }
    Ok(())
}

impl CpArgs {
    fn require_supported_backend(&self, targets_rest: bool) -> Result<()> {
        if targets_rest && (self.follow_symlinks || self.no_overwrite) {
            anyhow::bail!(
                "--follow-symlinks and --no-overwrite are supported only by the embedded local \
                 runtime; the REST copy protocol does not carry these options"
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
    use axum::{Json, Router, extract::Request, http::StatusCode, response::IntoResponse};
    use std::sync::{Arc, Mutex};

    const BOX_ID: &str = "cp-box";
    const PID: u32 = 1234;
    const PAYLOAD: &str = "copied file\n";

    #[derive(Default)]
    struct CleanupFailures {
        status_after_copy: bool,
        stop_response: bool,
    }

    async fn copy_against_stub(
        initial: BoxStatus,
        upload: bool,
        boot_on_copy: bool,
        copy_succeeds: bool,
        failures: CleanupFailures,
    ) -> (
        Result<()>,
        (BoxStatus, Option<u32>),
        Vec<String>,
        Option<String>,
    ) {
        let mut tar = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o644);
        header.set_size(PAYLOAD.len() as u64);
        tar.append_data(&mut header, "file.txt", PAYLOAD.as_bytes())
            .unwrap();
        let archive = tar.into_inner().unwrap();
        let pid = (initial.is_active() || initial == BoxStatus::Unknown).then_some(PID);
        let state = Arc::new(Mutex::new((initial, pid, Vec::new())));
        let recorded = state.clone();
        let app = Router::new().fallback(move |request: Request| {
            let recorded = recorded.clone();
            let archive = archive.clone();
            async move {
                let mut state = recorded.lock().unwrap();
                let Some(route) = request.uri().path().strip_prefix("/v1/boxes/cp-box") else {
                    return StatusCode::NOT_FOUND.into_response();
                };
                let method = request.method().as_str();
                if (method, route) != ("GET", "") {
                    state.2.push(format!("{method} {route}"));
                }
                match (method, route) {
                    ("GET" | "PUT", "/files") => {
                        if boot_on_copy {
                            state.0 = BoxStatus::Running;
                            state.1 = Some(PID);
                        }
                        if !copy_succeeds {
                            return (StatusCode::CONFLICT, "backend refused copy").into_response();
                        }
                        return archive.into_response();
                    }
                    ("POST", "/stop") => {
                        state.0 = BoxStatus::Stopped;
                        state.1 = None;
                        if failures.stop_response {
                            return (
                                StatusCode::SERVICE_UNAVAILABLE,
                                Json(serde_json::json!({"message": "stop response failed"})),
                            )
                                .into_response();
                        }
                    }
                    ("GET", "") if failures.status_after_copy && !state.2.is_empty() => {
                        state.2.push("GET box status".to_string());
                        return (StatusCode::SERVICE_UNAVAILABLE, "box status unavailable")
                            .into_response();
                    }
                    ("GET", "") => {}
                    _ => return StatusCode::NOT_FOUND.into_response(),
                }
                Json(serde_json::json!({
                    "box_id": BOX_ID,
                    "status": state.0.as_str(),
                    "pid": state.1,
                    "created_at": "2026-01-01T00:00:00Z",
                    "updated_at": "2026-01-01T00:00:00Z",
                    "image": "alpine:latest",
                    "cpus": 1,
                    "memory_mib": 512,
                }))
                .into_response()
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let home = tempfile::tempdir().unwrap();
        let host_path = home.path().join("file.txt");
        let host = host_path.to_str().unwrap();
        let guest = format!("{BOX_ID}:/file.txt");
        let (src, dst) = if upload {
            std::fs::write(&host_path, PAYLOAD).unwrap();
            (host, guest.as_str())
        } else {
            (guest.as_str(), host)
        };
        let cli = crate::cli::try_parse_from([
            "boxlite",
            "--home",
            home.path().to_str().unwrap(),
            "--url",
            &url,
            "--path-prefix",
            "",
            "cp",
            src,
            dst,
        ])
        .unwrap();
        let crate::cli::Commands::Cp(args) = cli.command else {
            panic!("expected cp command");
        };
        let result = execute(args, &cli.global).await;
        server.abort();
        let mut state = state.lock().unwrap();
        (
            result,
            (state.0, state.1),
            std::mem::take(&mut state.2),
            std::fs::read_to_string(host_path).ok(),
        )
    }

    #[rstest::rstest]
    #[case::paused_upload(BoxStatus::Paused, true)]
    #[case::paused_download(BoxStatus::Paused, false)]
    #[tokio::test]
    async fn frozen_box_copy_leaves_vm_untouched(#[case] status: BoxStatus, #[case] upload: bool) {
        let (result, final_state, operations, contents) =
            copy_against_stub(status, upload, false, false, CleanupFailures::default()).await;
        let error = result.unwrap_err();
        assert_eq!(
            operations,
            Vec::<String>::new(),
            "cp must not copy, start, or stop a frozen box"
        );
        assert_eq!(final_state, (status, Some(PID)));
        assert_eq!(contents.as_deref(), upload.then_some(PAYLOAD));
        assert!(
            error
                .to_string()
                .contains("cp is not allowed on paused boxes"),
            "{error}"
        );
    }

    #[rstest::rstest]
    #[case::unknown(BoxStatus::Unknown, false)]
    #[case::running(BoxStatus::Running, false)]
    #[case::stopped(BoxStatus::Stopped, true)]
    #[tokio::test]
    async fn copy_refused_without_boot_cleans_up_by_initial_status(
        #[case] status: BoxStatus,
        #[case] should_stop: bool,
    ) {
        let (result, final_state, operations, contents) =
            copy_against_stub(status, false, false, false, CleanupFailures::default()).await;
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("backend refused copy")
        );
        if should_stop {
            assert_eq!(operations, ["GET /files", "POST /stop"]);
            assert_eq!(final_state, (BoxStatus::Stopped, None));
        } else {
            assert_eq!(operations, ["GET /files"]);
            assert_eq!(final_state, (status, Some(PID)));
        }
        assert!(contents.is_none());
    }

    #[rstest::rstest]
    #[case::successful(BoxStatus::Configured, true)]
    #[case::failed(BoxStatus::Stopped, false)]
    #[tokio::test]
    async fn copy_that_boots_box_still_stops_it(#[case] status: BoxStatus, #[case] succeeds: bool) {
        let (result, final_state, operations, contents) =
            copy_against_stub(status, false, true, succeeds, CleanupFailures::default()).await;
        if succeeds {
            result.unwrap();
        } else {
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("backend refused copy")
            );
        }
        assert_eq!(contents.as_deref(), succeeds.then_some(PAYLOAD));
        assert_eq!(operations, ["GET /files", "POST /stop"]);
        assert_eq!(final_state, (BoxStatus::Stopped, None));
    }

    #[rstest::rstest]
    #[case::success(true, false, None)]
    #[case::stop_failed(true, true, Some("internal error: stop response failed"))]
    #[case::both_failed(false, true, Some("invalid state: backend refused copy"))]
    #[tokio::test]
    async fn upload_cleanup_does_not_query_status(
        #[case] copy_succeeds: bool,
        #[case] stop_response: bool,
        #[case] expected_error: Option<&str>,
    ) {
        let (result, final_state, operations, _) = copy_against_stub(
            BoxStatus::Stopped,
            true,
            true,
            copy_succeeds,
            CleanupFailures {
                status_after_copy: true,
                stop_response,
            },
        )
        .await;
        assert_eq!(operations, ["PUT /files", "POST /stop"], "{result:?}");
        assert_eq!(final_state, (BoxStatus::Stopped, None));
        assert_eq!(
            result.err().map(|error| error.to_string()).as_deref(),
            expected_error
        );
    }

    fn args() -> CpArgs {
        CpArgs {
            follow_symlinks: false,
            no_overwrite: false,
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

    /// `SRC/.` is read off the raw path further down, so parsing must hand it
    /// over byte for byte on either side. Compared as `OsStr`: `PathBuf`
    /// equality goes through components and would call `dist/.` and `dist`
    /// the same path.
    #[test]
    fn a_trailing_dot_survives_parsing() {
        match parse_direction("mybox:/app/.", "out").unwrap() {
            Direction::BoxToHost { box_path, .. } => assert_eq!(box_path, "/app/."),
            _ => panic!("wrong direction"),
        }
        match parse_direction("./dist/.", "mybox:/app").unwrap() {
            Direction::HostToBox { host, .. } => assert_eq!(host.as_os_str(), "./dist/."),
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
