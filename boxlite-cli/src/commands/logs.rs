//! Display logs from a box.

use crate::cli::GlobalFlags;
use clap::Args;
use dirs;
use std::fs::File;
use std::io::BufReader;
use std::io::{BufRead, Seek, SeekFrom};
use std::path::PathBuf;

/// Show logs from a box
#[derive(Args, Debug)]
pub struct LogsArgs {
    /// Box ID or name
    #[arg(index = 1, value_name = "BOX")]
    pub target: String,

    /// Number of lines to show from the end
    #[arg(short = 'n', long = "tail", default_value = "0")]
    pub tail: usize,

    /// Follow log output
    #[arg(short = 'f', long = "follow")]
    pub follow: bool,
}

/// Execute `logs` command.
pub async fn execute(args: LogsArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let litebox = rt
        .get(&args.target)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No such box: {}", args.target))?;

    // Construct console.log path: ~/.boxlite/boxes/{box_id}/console.log
    let box_id = litebox.id();
    let home_dir = global
        .home
        .as_ref()
        .cloned()
        .or_else(|| {
            dirs::home_dir().map(|mut p| {
                p.push(".boxlite");
                p
            })
        })
        .ok_or_else(|| anyhow::anyhow!("Cannot determine BoxLite home directory"))?;

    let log_path = home_dir
        .join("boxes")
        .join(box_id.as_str())
        .join("console.log");

    if !log_path.exists() {
        eprintln!("No log file found for box '{}'", args.target);
        eprintln!("The box may not have been started yet.");
        eprintln!("Log path: {}", log_path.display());
        return Ok(());
    }

    // Read initial logs (with --tail if specified)
    let initial_logs = read_logs(&log_path, args.tail)?;
    for line in initial_logs {
        println!("{}", line);
    }

    // Follow mode if requested
    if args.follow {
        follow_logs(&log_path).await?;
    }

    Ok(())
}

/// Read logs from a file, optionally returning only the last N lines.
fn read_logs(path: &PathBuf, tail_lines: usize) -> anyhow::Result<Vec<String>> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);

    if tail_lines == 0 {
        // Read all lines
        let lines: Vec<String> = reader.lines().collect::<Result<_, _>>()?;
        Ok(lines)
    } else {
        // Read last N lines
        let all_lines: Vec<String> = reader.lines().collect::<Result<_, _>>()?;
        let start = if tail_lines >= all_lines.len() {
            0
        } else {
            all_lines.len() - tail_lines
        };
        Ok(all_lines[start..].to_vec())
    }
}

/// Follow log file for new lines (real-time mode).
async fn follow_logs(path: &PathBuf) -> anyhow::Result<()> {
    use notify::{RecursiveMode, Watcher};
    use tokio::signal;

    eprintln!("\nFollowing log output (Ctrl+C to stop)...\n");

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let mut watcher = notify::recommended_watcher(move |res| {
        if let Ok(e) = res {
            let _ = tx.send(e);
        }
    })?;

    watcher.watch(path, RecursiveMode::NonRecursive)?;

    let mut file = File::open(path)?;
    let mut last_pos = file.seek(std::io::SeekFrom::End(0))?;

    loop {
        tokio::select! {
            _ = signal::ctrl_c() => {
                eprintln!("\nStopped following logs.");
                break;
            }
            Some(event) = rx.recv() => {
                if event.kind.is_modify() {
                    if let Ok(new_lines) = read_new_lines(path, last_pos) {
                        for line in new_lines {
                            println!("{}", line);
                        }
                        if let Ok(metadata) = std::fs::metadata(path) {
                            last_pos = metadata.len();
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

/// Read new lines from a file starting from a given position.
fn read_new_lines(path: &PathBuf, from_pos: u64) -> anyhow::Result<Vec<String>> {
    let mut file = File::open(path)?;
    file.seek(std::io::SeekFrom::Start(from_pos))?;

    let reader = BufReader::new(file);
    let lines: Vec<String> = reader.lines().collect::<Result<_, _>>()?;
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_read_logs_all() {
        // Create a temporary file with test content
        let temp_dir = std::env::temp_dir();
        let file_path = temp_dir.join("test_console.log");

        {
            let mut file = File::create(&file_path).unwrap();
            writeln!(file, "Line 1").unwrap();
            writeln!(file, "Line 2").unwrap();
            writeln!(file, "Line 3").unwrap();
            writeln!(file, "Line 4").unwrap();
            writeln!(file, "Line 5").unwrap();
        }

        // Test reading all lines
        let lines = read_logs(&file_path, 0).unwrap();
        assert_eq!(lines.len(), 5);
        assert_eq!(lines[0], "Line 1");
        assert_eq!(lines[4], "Line 5");

        // Clean up
        std::fs::remove_file(&file_path).unwrap();
    }

    #[test]
    fn test_read_logs_tail() {
        // Create a temporary file with test content
        let temp_dir = std::env::temp_dir();
        let file_path = temp_dir.join("test_tail_console.log");

        {
            let mut file = File::create(&file_path).unwrap();
            for i in 1..=10 {
                writeln!(file, "Line {}", i).unwrap();
            }
        }

        // Test reading last 3 lines
        let lines = read_logs(&file_path, 3).unwrap();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "Line 8");
        assert_eq!(lines[2], "Line 10");

        // Clean up
        std::fs::remove_file(&file_path).unwrap();
    }

    #[test]
    fn test_read_logs_empty_file() {
        // Test reading from an empty file
        let temp_dir = std::env::temp_dir();
        let file_path = temp_dir.join("test_empty.log");

        {
            File::create(&file_path).unwrap();
        }

        let lines = read_logs(&file_path, 0).unwrap();
        assert_eq!(lines.len(), 0);

        // Clean up
        std::fs::remove_file(&file_path).unwrap();
    }

    #[test]
    fn test_read_logs_tail_exceeds_file() {
        // Test tail larger than file
        let temp_dir = std::env::temp_dir();
        let file_path = temp_dir.join("test_exceed.log");

        {
            let mut file = File::create(&file_path).unwrap();
            writeln!(file, "Line 1").unwrap();
        }

        // Test tail larger than file (should return all lines)
        let lines = read_logs(&file_path, 10).unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], "Line 1");

        // Clean up
        std::fs::remove_file(&file_path).unwrap();
    }
}
