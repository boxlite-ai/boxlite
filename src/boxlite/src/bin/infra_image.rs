//! Project-internal image disk helper for apps/infra-local.

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    boxlite::runtime::internal_image_tool::run_from_args().await
}
