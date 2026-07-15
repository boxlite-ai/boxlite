use crate::cli::{
    GlobalFlags, ManagementFlags, NetworkFlags, ProcessFlags, PublishFlags, ResourceFlags,
    VolumeFlags,
};
use crate::terminal::StreamManager;
use crate::util::to_shell_exit_code;
use boxlite::{BoxOptions, BoxliteRuntime, LiteBox, RootfsSpec};
use clap::Args;
use std::io::{self, IsTerminal};

#[derive(Args, Debug)]
pub struct RunArgs {
    #[command(flatten)]
    pub process: ProcessFlags,

    #[command(flatten)]
    pub resource: ResourceFlags,

    #[command(flatten)]
    pub publish: PublishFlags,

    #[command(flatten)]
    pub volume: VolumeFlags,

    #[command(flatten)]
    pub network: NetworkFlags,

    #[command(flatten)]
    pub management: ManagementFlags,

    #[arg(index = 1)]
    pub image: String,

    /// Command to run inside the image
    #[arg(index = 2, trailing_var_arg = true)]
    pub command: Vec<String>,
}

/// Entry point.
///
/// Returns the shell exit code the CLI should exit with (0 on success, the
/// box's mapped exit code on a non-zero command exit). Returning the code —
/// instead of calling `std::process::exit` mid-function — lets `BoxRunner`
/// (and the `BoxliteRuntime` it owns) drop normally, so `RuntimeImpl::Drop`
/// runs `shutdown_sync()` and stops the box's shim on every return path.
/// `std::process::exit` would bypass that Drop chain and leak the shim (#622).
pub async fn execute(args: RunArgs, global: &GlobalFlags) -> anyhow::Result<i32> {
    let mut runner = BoxRunner::new(args, global)?;
    runner.run().await
}

struct BoxRunner {
    args: RunArgs,
    rt: BoxliteRuntime,
    home: Option<std::path::PathBuf>,
}

impl BoxRunner {
    fn new(args: RunArgs, global: &GlobalFlags) -> anyhow::Result<Self> {
        let rt = global.create_runtime()?;
        let home = global.home.clone();

        Ok(Self { args, rt, home })
    }

    async fn run(&mut self) -> anyhow::Result<i32> {
        // Validate flags and environment
        self.validate_flags()?;

        // COMMAND becomes the container's init (docker semantics — it
        // replaces the image CMD via options.cmd in create_box), so there
        // is nothing to spawn here: attach to the init session instead.
        let litebox = self.create_box().await?;

        // Detach mode: start it and get out of the way. Nobody is reading the
        // output, so there is nothing to be attached for.
        if self.args.management.detach {
            litebox.start().await?;
            println!("{}", litebox.id());
            return Ok(0);
        }

        // Foreground: attach *before* the command runs. Starting first races it —
        // `run alpine echo hi` can finish before the attach lands, and its output
        // and exit code die with the VM.
        let mut execution = litebox.start_attached().await?;

        // --tty implies --interactive when stdin is a terminal
        // (validate_flags already ensures stdin is a terminal when --tty is set)
        if self.args.process.tty {
            self.args.process.interactive = true;
        }

        // IO streaming and signal handling via shared StreamManager
        let streamer = StreamManager::new(
            &mut execution,
            self.args.process.interactive,
            self.args.process.tty,
        );

        let exit_code = streamer.start().await?;
        // Just return the shell exit code. Returning (vs. calling
        // `std::process::exit` here) lets `execution`, `litebox`, and the
        // owning `BoxliteRuntime` drop normally, so `RuntimeImpl::Drop`
        // runs `shutdown_sync()` and tears the box's shim down — the RAII
        // teardown the success path already relied on. `std::process::exit`
        // bypasses Drop entirely and leaked the shim on the non-zero path
        // (#622).
        Ok(to_shell_exit_code(exit_code))
    }

    async fn create_box(&self) -> anyhow::Result<LiteBox> {
        let mut options = BoxOptions::default();
        self.args.resource.apply_to(&mut options);
        self.args.management.apply_to(&mut options)?;
        self.args.publish.apply_to(&mut options)?;
        self.args
            .volume
            .apply_to(&mut options, self.home.as_deref())?;
        self.args.network.apply_to(&mut options)?;
        self.args.process.apply_to(&mut options)?;

        // Runtime requires detached boxes to have manual lifecycle control (auto_remove=false)
        if self.args.management.detach {
            options.auto_remove = false;
        }

        // Docker semantics: the user COMMAND replaces the image CMD (the
        // image ENTRYPOINT is preserved and prepended) and the result runs
        // as the container's init. No COMMAND → the image default runs.
        if !self.args.command.is_empty() {
            options.cmd = Some(self.args.command.clone());
        }

        options.rootfs = RootfsSpec::Image(self.args.image.clone());

        let litebox = self
            .rt
            .create(options, self.args.management.name.clone())
            .await?;

        Ok(litebox)
    }

    fn validate_flags(&self) -> anyhow::Result<()> {
        // Check TTY availability if requested
        if self.args.process.tty && !io::stdin().is_terminal() {
            anyhow::bail!("the input device is not a TTY.");
        }

        Ok(())
    }
}
