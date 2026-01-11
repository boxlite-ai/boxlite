use crate::cli::{ManagementFlags, ProcessFlags, ResourceFlags};
use boxlite::BoxCommand;
use boxlite::{BoxOptions, BoxliteRuntime, RootfsSpec};
use clap::Args;

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

pub async fn execute(args: RunArgs) -> anyhow::Result<()> {
    // Prepare options
    let mut options = BoxOptions::default();
    args.resource.apply_to(&mut options);
    args.management.apply_to(&mut options);
    args.process.apply_to(&mut options)?;

    options.rootfs = RootfsSpec::Image(args.image.clone());
    let rt = BoxliteRuntime::default_runtime();
    println!("Creating box from image '{}'...", args.image);

    let litebox = rt.create(options, args.management.name.clone()).await?;
    println!("Box created: {}", litebox.id());

    // Prepare Command
    let cmd_str = if args.command.is_empty() {
        "sh".to_string()
    } else {
        args.command[0].clone()
    };

    let mut box_cmd = BoxCommand::new(cmd_str);
    if args.command.len() > 1 {
        box_cmd = box_cmd.args(&args.command[1..]);
    }

    box_cmd = box_cmd.tty(args.process.tty);

    // TODO: Connect stdin/stdout for interactive mode if args.process.interactive is true
    println!("Starting execution...");
    let mut result = litebox.exec(box_cmd).await?;

    // Wait for completion
    let status = result.wait().await?;
    println!("Box finished with exit code: {}", status.exit_code);

    // Note: auto_remove is handled automatically by the runtime when the box stops.
    // No need to manually call rt.remove() here.

    Ok(())
}
