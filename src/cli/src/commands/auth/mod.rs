//! `boxlite auth {login,logout,status}` — manage stored REST credentials.
//!
//! Subcommands are dispatched from `main.rs`. Each leaf module owns its own
//! `Args` struct and `run()` to keep workflows isolated (login is async because
//! it validates against the server; logout/status are sync).

use clap::{Args, Subcommand};

pub mod login;
pub mod logout;
pub mod status;

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
    /// Show current authentication status.
    Status,
}

pub async fn run(args: AuthArgs) -> anyhow::Result<()> {
    match args.command {
        AuthCommand::Login(a) => login::run(a).await,
        AuthCommand::Logout(a) => logout::run(a).await,
        AuthCommand::Status => status::run(),
    }
}
