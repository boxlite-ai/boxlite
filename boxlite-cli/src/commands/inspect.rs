//! Inspect a box by ID or name; output JSON, YAML, or Go-style template.

use crate::cli::GlobalFlags;
use crate::formatter::{self, OutputFormat};
use boxlite::{BoxInfo, BoxStateInfo};
use clap::Args;
use serde::Serialize;

/// Inspect one or more boxes
#[derive(Args, Debug)]
pub struct InspectArgs {
    /// Box ID(s) or name(s). At least one box or --latest is required.
    #[arg(value_name = "BOX", required = false, num_args = 0..)]
    pub boxes: Vec<String>,

    /// Inspect the most recently created box (cannot be used with BOX)
    #[arg(short, long)]
    pub latest: bool,

    /// Output format: json, yaml, or a Go template (e.g. '{{.State}}', '{{.State.Status}}')
    #[arg(short, long, default_value = "json")]
    pub format: String,
}

/// Single view for inspect: JSON/YAML
#[derive(Debug, Serialize)]
struct InspectPresenter {
    #[serde(rename = "Id")]
    id: String,
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Image")]
    image: String,
    #[serde(rename = "Created")]
    created: String,
    #[serde(rename = "Status")]
    status: String,
    #[serde(rename = "State")]
    state: InspectStatePresenter,
    #[serde(rename = "Cpus")]
    cpus: u8,
    #[serde(rename = "Memory")]
    memory: u64,
}

#[derive(Debug, Serialize)]
struct InspectStatePresenter {
    #[serde(rename = "Status")]
    status: String,
    #[serde(rename = "Running")]
    running: bool,
    #[serde(rename = "Pid")]
    pid: u32,
}

impl From<&BoxInfo> for InspectPresenter {
    fn from(info: &BoxInfo) -> Self {
        let state = BoxStateInfo::from_box_info(info);
        Self {
            id: info.id.to_string(),
            name: info.name.as_deref().unwrap_or("").to_string(),
            image: info.image.clone(),
            created: info.created_at.to_rfc3339(),
            status: info.status.as_str().to_string(),
            state: InspectStatePresenter {
                status: state.status.as_str().to_string(),
                running: state.running,
                pid: state.pid.unwrap_or(0),
            },
            cpus: info.cpus,
            memory: info.memory_mib as u64 * 1024 * 1024,
        }
    }
}

pub async fn execute(args: InspectArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    if !args.latest && args.boxes.is_empty() {
        return Err(anyhow::anyhow!("no names or ids specified"));
    }
    if args.latest && !args.boxes.is_empty() {
        return Err(anyhow::anyhow!(
            "--latest and arguments cannot be used together"
        ));
    }

    let rt = global.create_runtime()?;
    let (infos, errs) = resolve_inspect_infos(&rt, &args).await?;

    if infos.is_empty() {
        println!("[]");
        return Err(errs.into_iter().next().unwrap());
    }

    let presenters: Vec<InspectPresenter> = infos.iter().map(InspectPresenter::from).collect();
    let mut stdout = std::io::stdout().lock();
    write_inspect_output(&presenters, &args.format, &mut stdout)?;

    if !errs.is_empty() {
        for e in &errs {
            eprintln!("Error: {}", e);
        }
        return Err(errs.into_iter().next().unwrap());
    }

    Ok(())
}

/// Build gtmpl context from presenter (same PascalCase shape as JSON/YAML).
fn presenter_to_gtmpl_value(presenter: &InspectPresenter) -> anyhow::Result<gtmpl::Value> {
    let json = serde_json::to_value(presenter)
        .map_err(|e| anyhow::anyhow!("inspect context serialization: {}", e))?;
    Ok(formatter::value_from_serde_json(&json))
}

fn looks_like_template(s: &str) -> bool {
    s.contains("{{")
}

/// Normalize template format: .ID → .Id, .ImageID → .Image
/// so user can write {{.ID}} or {{.ImageID}} and match our GtmplInspectContext field names.
fn normalize_inspect_format(s: &str) -> String {
    let s = s.replace(".ImageID", ".Image");
    s.replace(".ID", ".Id")
}

/// Resolve inspect arguments to a list of box infos and any per-ref errors.
/// For --latest: returns the most recently created box or an error if none exist.
/// Otherwise: looks up each BOX (name or ID) and collects infos plus errors for missing boxes.
async fn resolve_inspect_infos(
    rt: &boxlite::BoxliteRuntime,
    args: &InspectArgs,
) -> anyhow::Result<(Vec<boxlite::BoxInfo>, Vec<anyhow::Error>)> {
    if args.latest {
        let mut list = rt.list_info().await?;
        list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        match list.into_iter().next() {
            Some(info) => Ok((vec![info], Vec::new())),
            None => Err(anyhow::anyhow!("no boxes to inspect")),
        }
    } else {
        let mut infos = Vec::new();
        let mut errs = Vec::new();
        for name_or_id in &args.boxes {
            match rt.get_info(name_or_id).await? {
                Some(i) => infos.push(i),
                None => errs.push(anyhow::anyhow!("no such box: {}", name_or_id)),
            }
        }
        Ok((infos, errs))
    }
}

/// Write inspect presenters to the given writer in the requested format.
fn write_inspect_output<W: std::io::Write>(
    presenters: &Vec<InspectPresenter>,
    format_str: &str,
    writer: &mut W,
) -> anyhow::Result<()> {
    let format_parse = OutputFormat::from_str(format_str);
    match format_parse {
        Ok(OutputFormat::Table) => {
            return Err(anyhow::anyhow!("inspect does not support table format"));
        }
        Ok(fmt @ (OutputFormat::Json | OutputFormat::Yaml)) => {
            formatter::print_output(writer, presenters, fmt, |_, _| Ok(()))?;
        }
        Err(format_err) => {
            if looks_like_template(format_str) {
                let format = normalize_inspect_format(format_str);
                for p in presenters {
                    let ctx = presenter_to_gtmpl_value(p)?;
                    let out = formatter::format_gtmpl(ctx, &format)?;
                    writeln!(writer, "{}", out)?;
                }
            } else {
                return Err(format_err);
            }
        }
    }
    Ok(())
}
