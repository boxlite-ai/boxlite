//! Display logs from a box.

use crate::cli::GlobalFlags;
use boxlite::runtime::layout::{FilesystemLayout, FsLayoutConfig};
use clap::Args;
use std::fs::File;
use std::io::BufReader;
use std::io::{BufRead, Read, Seek};
use std::path::PathBuf;

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

pub async fn execute(args: LogsArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let options = global.resolve_runtime_options()?;
    let home_dir = options.home_dir.clone();
    let rt = global.create_runtime_with_options(options)?;

    let litebox = rt
        .get(&args.target)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No such box: {}", args.target))?;

    // Construct console.log path: {home_dir}/boxes/{box_id}/logs/console.log
    let box_id = litebox.id();

    let log_path = FilesystemLayout::new(home_dir, FsLayoutConfig::with_bind_mount())
        .box_layout(box_id.as_str(), false)?
        .console_output_path();

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
    let mut file = File::open(path)?;

    if tail_lines == 0 {
        // Read all lines
        let reader = BufReader::new(file);
        let lines: Vec<String> = reader.lines().collect::<Result<_, _>>()?;
        Ok(lines)
    } else {
        // Read last N lines optimized
        let start_pos = find_start_offset(&mut file, tail_lines)?;
        file.seek(std::io::SeekFrom::Start(start_pos))?;
        let reader = BufReader::new(file);
        let lines: Vec<String> = reader.lines().collect::<Result<_, _>>()?;
        Ok(lines)
    }
}

/// Find the file offset to start reading the last N lines from.
fn find_start_offset(file: &mut File, tail_lines: usize) -> anyhow::Result<u64> {
    let file_len = file.metadata()?.len();
    if file_len == 0 {
        return Ok(0);
    }

    let mut lines_found = 0;
    let mut pos = file_len;
    let chunk_size = 4096;
    let mut buf = vec![0u8; chunk_size];

    while pos > 0 {
        let to_read = std::cmp::min(pos, chunk_size as u64) as usize;
        pos -= to_read as u64;

        file.seek(std::io::SeekFrom::Start(pos))?;
        file.read_exact(&mut buf[..to_read])?;

        // Iterate backwards through the buffer
        for i in (0..to_read).rev() {
            if buf[i] == b'\n' {
                // Ignore trailing newline if it's the very last byte of the file
                if pos + i as u64 == file_len - 1 {
                    continue;
                }

                lines_found += 1;
                if lines_found >= tail_lines {
                    return Ok(pos + i as u64 + 1);
                }
            }
        }
    }

    Ok(0)
}

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
                    match read_new_lines(path, last_pos) {
                        Ok(new_lines) => {
                            for line in new_lines {
                                println!("{}", line);
                            }
                            if let Ok(metadata) = std::fs::metadata(path) {
                                last_pos = metadata.len();
                            }
                        }
                        Err(e) => {
                            eprintln!("Warning: failed to read new log lines: {}", e);
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

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
    use tempfile::NamedTempFile;

    #[test]
    fn test_read_logs_all() {
        // Create a temporary file with test content
        let mut file = NamedTempFile::new().unwrap();
        writeln!(file, "Line 1").unwrap();
        writeln!(file, "Line 2").unwrap();
        writeln!(file, "Line 3").unwrap();
        writeln!(file, "Line 4").unwrap();
        writeln!(file, "Line 5").unwrap();

        let file_path = file.path().to_path_buf();

        // Test reading all lines
        let lines = read_logs(&file_path, 0).unwrap();
        assert_eq!(lines.len(), 5);
        assert_eq!(lines[0], "Line 1");
        assert_eq!(lines[4], "Line 5");
    }

    #[test]
    fn test_read_logs_tail() {
        // Create a temporary file with test content
        let mut file = NamedTempFile::new().unwrap();
        for i in 1..=10 {
            writeln!(file, "Line {}", i).unwrap();
        }

        let file_path = file.path().to_path_buf();

        // Test reading last 3 lines
        let lines = read_logs(&file_path, 3).unwrap();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "Line 8");
        assert_eq!(lines[2], "Line 10");
    }

    #[test]
    fn test_read_logs_empty_file() {
        // Test reading from an empty file
        let file = NamedTempFile::new().unwrap();
        let file_path = file.path().to_path_buf();

        let lines = read_logs(&file_path, 0).unwrap();
        assert_eq!(lines.len(), 0);
    }

    #[test]
    fn test_read_logs_tail_exceeds_file() {
        // Test tail larger than file
        let mut file = NamedTempFile::new().unwrap();
        writeln!(file, "Line 1").unwrap();
        let file_path = file.path().to_path_buf();

        // Test tail larger than file (should return all lines)
        let lines = read_logs(&file_path, 10).unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], "Line 1");
    }
}
