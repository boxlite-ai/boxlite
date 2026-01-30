use crate::cli::{GlobalFlags, ResourceFlags};
use boxlite::{BoxOptions, RootfsSpec};
use clap::Args;

/// Create a new box
#[derive(Args, Debug)]
pub struct CreateArgs {
    /// Image to create from
    #[arg(index = 1)]
    pub image: String,

    #[command(flatten)]
    pub management: crate::cli::ManagementFlags,

    /// Set environment variables
    #[arg(short = 'e', long = "env")]
    pub env: Vec<String>,

    /// Working directory inside the box
    #[arg(short = 'w', long = "workdir")]
    pub workdir: Option<String>,

    #[command(flatten)]
    pub resource: ResourceFlags,
}

pub async fn execute(args: CreateArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let box_options = args.to_box_options();

    let litebox = rt.create(box_options, args.management.name.clone()).await?;
    println!("{}", litebox.id());

    Ok(())
}

impl CreateArgs {
    fn to_box_options(&self) -> BoxOptions {
        let mut options = BoxOptions::default();
        self.resource.apply_to(&mut options);
        self.management.apply_to(&mut options);
        options.working_dir = self.workdir.clone();
        crate::cli::apply_env_vars(&self.env, &mut options);
        options.rootfs = RootfsSpec::Image(self.image.clone());
        options
    }
}
