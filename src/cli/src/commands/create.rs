use crate::cli::{GlobalFlags, NetworkFlags, PublishFlags, ResourceFlags, VolumeFlags};
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

    /// Override the image entrypoint with a single executable, mirroring
    /// `docker create --entrypoint`.
    #[arg(long = "entrypoint", value_name = "EXEC")]
    pub entrypoint: Option<String>,

    #[command(flatten)]
    pub resource: ResourceFlags,

    #[command(flatten)]
    pub publish: PublishFlags,

    #[command(flatten)]
    pub volume: VolumeFlags,

    #[command(flatten)]
    pub network: NetworkFlags,
}

pub async fn execute(args: CreateArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let box_options = args.to_box_options(global)?;

    let litebox = rt.create(box_options, args.management.name.clone()).await?;
    println!("{}", litebox.id());

    Ok(())
}

impl CreateArgs {
    fn to_box_options(&self, global: &GlobalFlags) -> anyhow::Result<BoxOptions> {
        let mut options = BoxOptions::default();
        self.resource.apply_to(&mut options);
        self.management.apply_to(&mut options);
        self.publish.apply_to(&mut options)?;
        self.volume.apply_to(&mut options, global.home.as_deref())?;
        self.network.apply_to(&mut options)?;
        options.working_dir = self.workdir.clone();
        if let Some(ref exec) = self.entrypoint {
            options.entrypoint = Some(vec![exec.clone()]);
        }
        crate::cli::apply_env_vars(&self.env, &mut options);
        options.rootfs = RootfsSpec::Image(self.image.clone());
        Ok(options)
    }
}
