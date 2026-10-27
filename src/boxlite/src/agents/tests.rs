use super::*;
use crate::{BoxOptions, BoxStatus, BoxliteOptions, BoxliteRuntime};
use std::time::Duration;

fn unsupported<T>(result: BoxliteResult<T>, operation: &str) {
    let error = result.err().expect("stub must not report success");
    match error {
        BoxliteError::Unsupported(message) => {
            assert_eq!(message, format!("{operation} is not implemented"))
        }
        other => panic!("wrong error for {operation}: {other}"),
    }
}

#[tokio::test]
async fn namespace_does_not_start_box() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = BoxliteRuntime::new_for_test(BoxliteOptions {
        home_dir: directory.path().into(),
        ..Default::default()
    })
    .unwrap();
    let sandbox = runtime
        .create(
            BoxOptions {
                rootfs: crate::RootfsSpec::Image("alpine:latest".into()),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let agents = sandbox.agents();
    unsupported(
        agents.create("agent", AgentCreateOptions::default()).await,
        "agents.create",
    );
    unsupported(agents.get("session").await, "agents.get");
    assert_eq!(sandbox.info().await.unwrap().status, BoxStatus::Configured);
}

#[tokio::test]
async fn session_operations_are_unimplemented() {
    let session = AgentSession { _private: () };
    unsupported(
        session.close(AgentControlOptions::default()).await,
        "session.close",
    );
    for mode in [AgentSendMode::Queue, AgentSendMode::Reject] {
        unsupported(
            session
                .send(
                    "task",
                    AgentSendOptions {
                        mode,
                        ..Default::default()
                    },
                )
                .await,
            "session.send",
        );
    }
    unsupported(session.get_turn("turn").await, "session.get_turn");
    unsupported(
        session
            .events(AgentEventsOptions {
                after: Some("cursor".into()),
            })
            .await,
        "session.events",
    );
    unsupported(session.requests().await, "session.requests");
    for response in [
        AgentResponse::Answer {
            text: "answer".into(),
            data: None,
        },
        AgentResponse::Permission { approved: false },
    ] {
        unsupported(
            session
                .respond("request", response, AgentControlOptions::default())
                .await,
            "session.respond",
        );
    }
    unsupported(session.state(), "session.state");
    unsupported(session.config(), "session.config");
    unsupported(session.capabilities(), "session.capabilities");
}

#[tokio::test]
async fn turn_operations_are_unimplemented() {
    let turn = AgentTurn { _private: () };
    unsupported(
        turn.wait(AgentWaitOptions {
            timeout: Some(Duration::from_secs(1)),
        })
        .await,
        "turn.wait",
    );
    unsupported(
        turn.events(AgentEventsOptions::default()).await,
        "turn.events",
    );
    unsupported(
        turn.steer("new direction", AgentControlOptions::default())
            .await,
        "turn.steer",
    );
    unsupported(
        turn.interrupt(AgentControlOptions::default()).await,
        "turn.interrupt",
    );
    unsupported(turn.state(), "turn.state");
}
