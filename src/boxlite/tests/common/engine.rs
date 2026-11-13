//! Explicit engine selection for the M2/M3 matrices; product defaults stay unchanged.
use boxlite::experimental::{ExperimentalFeature, RuntimeBuilder, custom_kernel, native_vmm};
use boxlite::runtime::options::{BoxOptions, BoxliteOptions};
use boxlite::{BoxliteRuntime, LiteBox};
use boxlite_shared::{BoxliteError, BoxliteResult};

#[derive(Clone, Debug)]
pub struct TestRuntime(BoxliteRuntime);

fn native() -> BoxliteResult<bool> {
    match std::env::var("BOXLITE_TEST_ENGINE").as_deref() {
        Ok("native") => Ok(true),
        Ok("krun") | Err(std::env::VarError::NotPresent) => Ok(false),
        _ => Err(BoxliteError::InvalidArgument(
            "BOXLITE_TEST_ENGINE must be native or krun".into(),
        )),
    }
}

impl TestRuntime {
    pub fn new(options: BoxliteOptions) -> BoxliteResult<Self> {
        let runtime = if native()? {
            RuntimeBuilder::new(options)
                .enable(ExperimentalFeature::CustomKernel)
                .enable(ExperimentalFeature::NativeVmm)
                .build()?
        } else {
            BoxliteRuntime::new(options)?
        };
        Ok(Self(runtime))
    }

    pub fn from_runtime(runtime: BoxliteRuntime) -> Self {
        Self(runtime)
    }

    fn options(mut options: BoxOptions) -> BoxliteResult<BoxOptions> {
        if native()? {
            let kernel = std::env::var_os("VMM_KERNEL").ok_or_else(|| {
                BoxliteError::InvalidArgument("native tests require VMM_KERNEL".into())
            })?;
            native_vmm::configure(&mut options);
            custom_kernel::configure(
                &mut options,
                custom_kernel::KernelOptions::new(kernel)
                    .with_format(custom_kernel::KernelFormat::Elf),
            );
        }
        Ok(options)
    }

    pub async fn create(
        &self,
        options: BoxOptions,
        name: Option<String>,
    ) -> BoxliteResult<LiteBox> {
        self.0.create(Self::options(options)?, name).await
    }

    pub async fn get_or_create(
        &self,
        options: BoxOptions,
        name: Option<String>,
    ) -> BoxliteResult<(LiteBox, bool)> {
        self.0.get_or_create(Self::options(options)?, name).await
    }
}

impl std::ops::Deref for TestRuntime {
    type Target = BoxliteRuntime;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
