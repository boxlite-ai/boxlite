use crate::cli::{GlobalFlags, ManagementFlags, ProcessFlags, ResourceFlags};
use boxlite::BoxCommand;
use boxlite::{BoxOptions, BoxliteOptions, BoxliteRuntime, LiteBox, RootfsSpec};
use clap::Args;
use futures::StreamExt;
use nix::sys::signal::Signal;
use nix::sys::termios::{
    InputFlags, LocalFlags, OutputFlags, SetArg, Termios, tcgetattr, tcsetattr,
};
use std::io::{self, IsTerminal, Write};
use tokio::select;
use tokio::signal::unix::{SignalKind, signal};

#[derive(Args, Debug)]
pub struct RunArgs {
    #[command(flatten)]
    pub process: ProcessFlags,

    #[command(flatten)]
    pub resource: ResourceFlags,

    #[command(flatten)]
    pub management: ManagementFlags,

    #[arg(index = 1)]
    pub image: String,

    /// Command to run inside the image
    #[arg(index = 2, trailing_var_arg = true)]
    pub command: Vec<String>,
}

/// Entry point
pub async fn execute(args: RunArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let mut runner = BoxRunner::new(args, global)?;
    runner.run().await
}

struct BoxRunner {
    args: RunArgs,
    rt: BoxliteRuntime,
}

impl BoxRunner {
    fn new(args: RunArgs, global: &GlobalFlags) -> anyhow::Result<Self> {
        let options = if let Some(home) = &global.home {
            BoxliteOptions {
                home_dir: home.clone(),
            }
        } else {
            BoxliteOptions::default()
        };

        let rt = BoxliteRuntime::new(options)?;

        Ok(Self { args, rt })
    }

    async fn run(&mut self) -> anyhow::Result<()> {
        // Validate flags and environment
        self.validate_flags()?;

        let litebox = self.create_box().await?;

        // Start execution
        let cmd = self.prepare_command();
        let mut execution = litebox.exec(cmd).await?;

        // Detach mode: Print ID and exit
        if self.args.management.detach {
            println!("{}", litebox.id());
            return Ok(());
        }

        let _raw_guard = self.setup_raw_mode()?;

        // IO streaming and signal handling
        let (completion_tasks, cancellation_tasks) = self.setup_io_streaming(&mut execution);

        // Wait for box exit and handle IO completion
        let status = self
            .wait_for_completion(execution, completion_tasks, cancellation_tasks)
            .await?;

        // Exit with box's exit code
        if status.exit_code != 0 {
            let code = match status.exit_code {
                // Signal termination: BoxLite encodes signals as negative values.
                // Convert to shell convention: 128 + signal_number
                // e.g. -9 (encoded SIGKILL) -> 128 + 9 = 137
                code if code < 0 => 128 + code.abs(),
                code => code,
            };
            std::process::exit(code);
        }

        Ok(())
    }

    async fn create_box(&self) -> anyhow::Result<LiteBox> {
        let mut options = BoxOptions::default();
        self.args.resource.apply_to(&mut options);
        self.args.management.apply_to(&mut options);
        self.args.process.apply_to(&mut options)?;

        options.rootfs = RootfsSpec::Image(self.args.image.clone());

        let litebox = self
            .rt
            .create(options, self.args.management.name.clone())
            .await?;

        Ok(litebox)
    }

    fn prepare_command(&self) -> BoxCommand {
        let (program, args) = parse_command_args(&self.args.command);

        BoxCommand::new(program)
            .args(args)
            .tty(self.args.process.tty)
    }

    fn setup_io_streaming(
        &self,
        execution: &mut boxlite::Execution,
    ) -> (
        Vec<tokio::task::JoinHandle<()>>,
        Vec<tokio::task::JoinHandle<()>>,
    ) {
        let mut completion_tasks = Vec::new(); // stdout, stderr
        let mut cancellation_tasks = Vec::new(); // stdin only (signals now handled in main loop)

        // IO Streaming
        if let Some(mut stdout) = execution.stdout() {
            completion_tasks.push(tokio::spawn(async move {
                while let Some(line) = stdout.next().await {
                    print!("{}", line);
                    let _ = io::stdout().flush();
                }
            }));
        }

        if let Some(mut stderr) = execution.stderr() {
            let is_tty = self.args.process.tty;
            completion_tasks.push(tokio::spawn(async move {
                while let Some(line) = stderr.next().await {
                    if is_tty {
                        // TTY mode: stderr also goes to stdout (merged output)
                        print!("{}", line);
                        let _ = io::stdout().flush();
                    } else {
                        // Non-TTY mode: stderr goes to stderr (separated output)
                        eprint!("{}", line);
                        let _ = io::stderr().flush();
                    }
                }
            }));
        }

        if self.args.process.interactive
            && let Some(stdin_tx) = execution.stdin()
        {
            cancellation_tasks.push(tokio::spawn(async move {
                stream_stdin(stdin_tx).await;
            }));
        }

        (completion_tasks, cancellation_tasks)
    }

    fn validate_flags(&self) -> anyhow::Result<()> {
        // Check TTY availability if requested
        if self.args.process.tty && !io::stdin().is_terminal() {
            anyhow::bail!("the input device is not a TTY.");
        }

        Ok(())
    }

    fn setup_raw_mode(&self) -> anyhow::Result<Option<RawModeGuard>> {
        if self.args.process.tty && self.args.process.interactive {
            match enable_raw_mode() {
                Ok(guard) => Ok(Some(guard)),
                Err(e) => {
                    eprintln!("Warning: Failed to enable raw mode: {}", e);
                    eprintln!("Continuing in cooked mode. Some features may not work correctly.");
                    Ok(None)
                }
            }
        } else {
            Ok(None)
        }
    }

    async fn wait_for_completion(
        &self,
        mut execution: boxlite::Execution,
        completion_tasks: Vec<tokio::task::JoinHandle<()>>,
        cancellation_tasks: Vec<tokio::task::JoinHandle<()>>,
    ) -> anyhow::Result<boxlite::ExecResult> {
        // created in main task context for reliable delivery
        let mut sig_int = signal(SignalKind::interrupt()).unwrap();
        let mut sig_term = signal(SignalKind::terminate()).unwrap();
        let mut sig_hup = signal(SignalKind::hangup()).unwrap();
        let mut sig_winch = if self.args.process.tty {
            Some(signal(SignalKind::window_change()).unwrap())
        } else {
            None
        };

        if let Some((w, h)) = self.args.process.tty.then(term_size::dimensions).flatten() {
            let _ = execution.resize_tty(h as u32, w as u32).await;
        }

        let signal_exec = execution.clone();
        let exit_fut = execution.wait();

        let io_fut = async {
            for handle in completion_tasks {
                let _ = handle.await;
            }
        };

        tokio::pin!(exit_fut);
        tokio::pin!(io_fut);

        let mut io_done = false;
        let mut exit_status: Option<boxlite::ExecResult> = None;

        // Handles IO, signals, and exit
        loop {
            select! {
                status = &mut exit_fut, if exit_status.is_none() => {
                    exit_status = Some(status?);
                    // Stop stdin forwarding to avoid EPIPE
                    for task in &cancellation_tasks {
                        task.abort();
                    }
                    if io_done {
                        return Ok(exit_status.unwrap());
                    }
                }

                _ = &mut io_fut, if !io_done => {
                    io_done = true;
                    //  exit already happened
                    if let Some(status) = exit_status {
                        return Ok(status);
                    }
                }

                _ = sig_int.recv() => {
                    let _ = signal_exec.signal(Signal::SIGINT as i32).await;
                }

                _ = sig_term.recv() => {
                    let _ = signal_exec.signal(Signal::SIGTERM as i32).await;
                }

                _ = sig_hup.recv() => {
                    let _ = signal_exec.signal(Signal::SIGHUP as i32).await;
                }

                // TTY resize
                Some(_) = async {
                    match sig_winch.as_mut() {
                        Some(s) => s.recv().await,
                        None => std::future::pending().await,
                    }
                } => {
                    if let Some((w, h)) = term_size::dimensions() {
                        let _ = signal_exec.resize_tty(h as u32, w as u32).await;
                    }
                }
            }
        }
    }
}

async fn stream_stdin(mut tx: boxlite::ExecStdin) {
    let mut stdin = tokio::io::stdin();
    let mut buf = [0u8; 1024];
    loop {
        match tokio::io::AsyncReadExt::read(&mut stdin, &mut buf).await {
            Ok(0) => break, // EOF
            Ok(n) => {
                if tx.write(&buf[..n]).await.is_err() {
                    break;
                }
            }
            Err(e) => {
                tracing::debug!("stdin read error: {}", e);
                break;
            }
        }
    }
}

// Raw Mode
struct RawModeGuard {
    original_termios: Termios,
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        let stdin = io::stdin();
        let _ = tcsetattr(&stdin, SetArg::TCSANOW, &self.original_termios);
    }
}

fn enable_raw_mode() -> anyhow::Result<RawModeGuard> {
    if !io::stdin().is_terminal() {
        return Err(anyhow::anyhow!("stdin is not a terminal"));
    }

    let stdin = io::stdin();
    let original = tcgetattr(&stdin)?;
    let mut raw = original.clone();

    // Standard Raw Mode flags
    raw.input_flags &= !(InputFlags::IGNBRK
        | InputFlags::BRKINT
        | InputFlags::PARMRK
        | InputFlags::ISTRIP
        | InputFlags::INLCR
        | InputFlags::IGNCR
        | InputFlags::ICRNL
        | InputFlags::IXON);
    raw.output_flags &= !OutputFlags::OPOST;
    raw.local_flags &= !(LocalFlags::ECHO
        | LocalFlags::ECHONL
        | LocalFlags::ICANON
        | LocalFlags::ISIG
        | LocalFlags::IEXTEN);

    tcsetattr(&stdin, SetArg::TCSANOW, &raw)?;

    Ok(RawModeGuard {
        original_termios: original,
    })
}

fn parse_command_args(input: &[String]) -> (&str, &[String]) {
    if input.is_empty() {
        ("sh", &[])
    } else {
        (&input[0], &input[1..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_command_args_defaults() {
        let empty: Vec<String> = vec![];
        assert_eq!(parse_command_args(&empty), ("sh", &[] as &[String]));
    }

    #[test]
    fn test_parse_command_args_explicit() {
        let input = vec!["echo".to_string(), "hello".to_string()];
        assert_eq!(
            parse_command_args(&input),
            ("echo", &["hello".to_string()] as &[String])
        );
    }
}
