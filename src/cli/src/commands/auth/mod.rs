//! `boxlite auth {login,logout,status}` — manage stored REST credentials.
//!
//! Subcommands are dispatched from `main.rs`. Each leaf module owns its own
//! `Args` struct and `run()` to keep workflows isolated (login is async because
//! it validates against the server; logout/status are sync).

use clap::{Args, Subcommand};

use crate::cli::GlobalFlags;

pub mod api_key;
pub mod login;
pub mod logout;
pub mod oidc;
pub mod status;
pub mod whoami;

#[derive(Args, Debug, Clone)]
pub struct AuthArgs {
    #[command(subcommand)]
    pub command: AuthCommand,
}

#[derive(Subcommand, Debug, Clone)]
pub enum AuthCommand {
    /// Log in to a BoxLite REST server.
    Login(login::LoginArgs),
    /// Remove stored credentials.
    Logout(logout::LogoutArgs),
    /// Show current authentication status (offline).
    Status,
    /// Confirm the active credential's identity via `GET /v1/me`.
    Whoami,
}

pub async fn run(args: AuthArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let profile = global.resolved_profile();
    match args.command {
        AuthCommand::Login(a) => login::run(a, &profile).await,
        AuthCommand::Logout(a) => logout::run(a, &profile).await,
        AuthCommand::Status => status::run(&profile),
        AuthCommand::Whoami => whoami::run(&profile).await,
    }
}
