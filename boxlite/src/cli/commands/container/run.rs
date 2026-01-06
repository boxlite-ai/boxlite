use crate::cli::flags::{GlobalFlags, ManagementFlags, ProcessFlags, ResourceFlags};
use boxlite::BoxCommand;
use boxlite::{BoxOptions, BoxliteOptions, BoxliteRuntime, LiteBox, RootfsSpec};
use clap::Args;
use futures::StreamExt;
use nix::sys::termios::{
    InputFlags, LocalFlags, OutputFlags, SetArg, Termios, tcgetattr, tcsetattr,
};
use std::io::IsTerminal;
use std::io::Write;
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
    let mut runner = ContainerRunner::new(args, global)?;
    runner.run().await
}

struct ContainerRunner {
    args: RunArgs,
    rt: BoxliteRuntime,
}

impl ContainerRunner {
    fn new(args: RunArgs, global: &GlobalFlags) -> anyhow::Result<Self> {
        let options = if let Some(home) = &global.home {
            BoxliteOptions {
                home_dir: home.clone(),
            }
        } else {
            BoxliteOptions::default() // This defaults to ~/.boxlite
        };

        // We use new() instead of default_runtime() to pass options
        let rt = BoxliteRuntime::new(options)?;

        Ok(Self { args, rt })
    }

    async fn run(&mut self) -> anyhow::Result<()> {
        // Validate flags and environment
        self.validate_flags()?;

        let litebox = self.create_container().await?;

        // Start execution
        let box_cmd = self.prepare_command();
        let mut execution = litebox.exec(box_cmd).await?;

        // Detach mode: Print ID and exit
        if self.args.management.detach {
            println!("{}", litebox.id());
            return Ok(());
        }

        // Setup Raw Mode
        let _raw_guard = self.setup_raw_mode()?;

        // Setup IO streaming and signal handling
        let (wait_tasks, abort_tasks) = self.setup_io_streaming(&mut execution);

        // Wait for container exit and handle IO completion
        let status = self
            .wait_for_completion(execution, wait_tasks, abort_tasks)
            .await?;

        // Cleanup container and handle exit code
        self.cleanup_container(&litebox, status.exit_code).await?;

        Ok(())
    }

    async fn create_container(&self) -> anyhow::Result<LiteBox> {
        let mut options = BoxOptions::default();
        self.args.resource.apply_to(&mut options);
        self.args.management.apply_to(&mut options);
        self.args.process.apply_to(&mut options)?;

        options.rootfs = RootfsSpec::Image(self.args.image.clone());

        let litebox = self.rt.create(options, self.args.management.name.clone())?;

        Ok(litebox)
    }

    fn prepare_command(&self) -> BoxCommand {
        let cmd_str = if self.args.command.is_empty() {
            "sh".to_string()
        } else {
            self.args.command[0].clone()
        };

        let mut box_cmd = BoxCommand::new(cmd_str);
        if self.args.command.len() > 1 {
            box_cmd = box_cmd.args(&self.args.command[1..]);
        }

        box_cmd.tty(self.args.process.tty)
    }

    fn setup_io_streaming(
        &self,
        execution: &mut boxlite::Execution,
    ) -> (
        Vec<tokio::task::JoinHandle<()>>,
        Vec<tokio::task::JoinHandle<()>>,
    ) {
        let mut wait_tasks = Vec::new(); // stdout, stderr
        let mut abort_tasks = Vec::new(); // signals, stdin

        // Setup Signal Forwarding & Resize (if TTY)
        {
            let exec = execution.clone();
            let tty = self.args.process.tty;
            abort_tasks.push(tokio::spawn(async move {
                handle_signals_and_resize(exec, tty).await;
            }));
        }

        // Setup IO Streaming
        if let Some(mut stdout) = execution.stdout() {
            wait_tasks.push(tokio::spawn(async move {
                while let Some(line) = stdout.next().await {
                    print!("{}", line);
                    let _ = std::io::stdout().flush();
                }
            }));
        }

        if let Some(mut stderr) = execution.stderr() {
            let is_tty = self.args.process.tty;
            wait_tasks.push(tokio::spawn(async move {
                while let Some(line) = stderr.next().await {
                    if is_tty {
                        // TTY mode: stderr also goes to stdout (merged output)
                        print!("{}", line);
                        let _ = std::io::stdout().flush();
                    } else {
                        // Non-TTY mode: stderr goes to stderr (separated output)
                        eprint!("{}", line);
                        let _ = std::io::stderr().flush();
                    }
                }
            }));
        }

        if self.args.process.interactive {
            if let Some(stdin_tx) = execution.stdin() {
                abort_tasks.push(tokio::spawn(async move {
                    stream_stdin(stdin_tx).await;
                }));
            }
        }

        (wait_tasks, abort_tasks)
    }

    async fn cleanup_container(&self, litebox: &LiteBox, exit_code: i32) -> anyhow::Result<()> {
        // Auto-remove container if requested
        if self.args.management.rm {
            let _ = self.rt.remove(litebox.id().as_str(), true).await;
        }

        // Exit with container's exit code
        if exit_code != 0 {
            std::process::exit(exit_code);
        }

        Ok(())
    }

    fn validate_flags(&self) -> anyhow::Result<()> {
        // Check TTY availability if requested
        if self.args.process.tty && !std::io::stdin().is_terminal() {
            anyhow::bail!(
                "the input device is not a TTY. \
                 If you are using mintty, try prefixing the command with 'winpty'"
            );
        }

        // Warn if interactive + TTY but stdin is not a terminal
        if self.args.process.interactive && self.args.process.tty && !std::io::stdin().is_terminal()
        {
            eprintln!(
                "Warning: The input device is not a TTY. \
                 The --tty and --interactive flags might not work properly"
            );
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
        wait_tasks: Vec<tokio::task::JoinHandle<()>>,
        abort_tasks: Vec<tokio::task::JoinHandle<()>>,
    ) -> anyhow::Result<boxlite::ExecResult> {
        use tokio::select;

        // Create a future for container exit
        let exit_fut = execution.wait();

        // Create a future for stdout/stderr completion
        let io_fut = async {
            for handle in wait_tasks {
                let _ = handle.await;
            }
        };

        tokio::pin!(exit_fut);
        tokio::pin!(io_fut);

        // Wait for either container exit or IO completion
        select! {
            status = &mut exit_fut => {
                // Container exited first.
                // 1. Stop sending signals/stdin immediately
                for task in abort_tasks {
                    task.abort();
                }
                // 2. Wait for output buffers to drain
                io_fut.await;
                Ok(status?)
            }
            _ = &mut io_fut => {
                // IO streams closed (EOF).
                // Wait for the process to actually exit if it hasn't yet.
                let status = exit_fut.await?;
                // Cleanup signal handlers
                for task in abort_tasks {
                    task.abort();
                }
                Ok(status)
            }
        }
    }
}

// Helper Functions
async fn handle_signals_and_resize(exec: boxlite::Execution, tty: bool) {
    let mut sig_int = signal(SignalKind::interrupt()).unwrap();
    let mut sig_term = signal(SignalKind::terminate()).unwrap();

    let mut sig_winch = if tty {
        Some(signal(SignalKind::window_change()).unwrap())
    } else {
        None
    };

    // Initial resize if TTY
    if tty {
        if let Some((w, h)) = term_size::dimensions() {
            let _ = exec.resize_tty(h as u32, w as u32).await;
        }
    }

    loop {
        tokio::select! {
            _ = sig_int.recv() => {
                let _ = exec.signal(2).await; // SIGINT
            }
            _ = sig_term.recv() => {
                let _ = exec.signal(15).await; // SIGTERM
            }
            Some(_) = async {
                match sig_winch.as_mut() {
                    Some(s) => s.recv().await,
                    None => std::future::pending().await,
                }
            } => {
                if let Some((w, h)) = term_size::dimensions() {
                    let _ = exec.resize_tty(h as u32, w as u32).await;
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
            Err(_) => break,
        }
    }
}

// Raw Mode
struct RawModeGuard {
    original_termios: Termios,
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        let stdin = std::io::stdin();
        let _ = tcsetattr(&stdin, SetArg::TCSANOW, &self.original_termios);
    }
}

fn enable_raw_mode() -> anyhow::Result<RawModeGuard> {
    if !std::io::stdin().is_terminal() {
        return Err(anyhow::anyhow!("stdin is not a terminal"));
    }

    let stdin = std::io::stdin();
    let original = tcgetattr(&stdin)?;
    let mut raw = original.clone();

    // Standard Raw Mode flags (cfmakeraw style)
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
