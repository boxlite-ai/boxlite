//! Inspect a box by ID or name; output JSON, YAML, or Go-style template.

use crate::cli::GlobalFlags;
use crate::formatter::{self, GtmplWithJson, OutputFormat, value_from_serde_json};
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
        let state = BoxStateInfo::from(info);
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

fn looks_like_template(s: &str) -> bool {
    s.contains("{{") && s.contains("}}")
}

/// If the template is a single path like {{.State}} or {{.State.Status}}, return that path.
fn parse_single_path_template(s: &str) -> Option<String> {
    let t = s.trim();
    let inner = t.strip_prefix("{{")?.trim().strip_suffix("}}")?.trim();
    let path = inner.strip_prefix('.')?.trim();
    if path.is_empty() || path.contains("{{") || path.contains("}}") {
        return None;
    }
    if path
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
    {
        Some(path.to_string())
    } else {
        None
    }
}

/// Get a reference to the value at dot-separated path in a JSON value.
fn json_value_at_path<'a>(
    root: &'a serde_json::Value,
    path: &str,
) -> Option<&'a serde_json::Value> {
    let mut current = root;
    for segment in path.split('.') {
        current = current.get(segment)?;
    }
    Some(current)
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
                let gtmpl = GtmplWithJson::parse(&format)
                    .map_err(|e| anyhow::anyhow!("template: {}", e))?;
                for p in presenters {
                    let json_val = serde_json::to_value(p)
                        .map_err(|e| anyhow::anyhow!("inspect serialization: {}", e))?;
                    let out = if let Some(path) = parse_single_path_template(&format) {
                        if let Some(v) = json_value_at_path(&json_val, &path) {
                            if v.is_object() {
                                formatter::format_go_style_value(v)
                            } else {
                                let ctx = value_from_serde_json(&json_val);
                                gtmpl.render(ctx)?
                            }
                        } else {
                            let ctx = value_from_serde_json(&json_val);
                            gtmpl.render(ctx)?
                        }
                    } else {
                        let ctx = value_from_serde_json(&json_val);
                        gtmpl.render(ctx)?
                    };
                    writeln!(writer, "{}", out)?;
                }
            } else {
                return Err(format_err);
            }
        }
    }
    Ok(())
}
