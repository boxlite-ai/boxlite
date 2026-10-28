use super::*;
use crate::{BoxOptions, BoxStatus, BoxliteOptions, BoxliteRuntime};
use std::time::Duration;

fn unsupported<T>(result: BoxliteResult<T>, operation: &str) {
    let error = result.err().expect("operation must return Unsupported");
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
    unsupported(agents.get("agent").await, "agents.get");
    assert_eq!(sandbox.info().await.unwrap().status, BoxStatus::Configured);
}

#[tokio::test]
async fn agent_operations_return_unsupported() {
    let agent = Agent { _private: () };
    unsupported(
        agent.close(AgentControlOptions::default()).await,
        "agent.close",
    );
    for mode in [AgentSendMode::Queue, AgentSendMode::Reject] {
        unsupported(
            agent
                .send(
                    "task",
                    AgentSendOptions {
                        mode,
                        ..Default::default()
                    },
                )
                .await,
            "agent.send",
        );
    }
    unsupported(agent.get_turn("turn").await, "agent.get_turn");
    unsupported(
        agent
            .events(AgentEventsOptions {
                after: Some("cursor".into()),
            })
            .await,
        "agent.events",
    );
    unsupported(agent.requests().await, "agent.requests");
    for response in [
        AgentResponse::Answer {
            text: "answer".into(),
            data: None,
        },
        AgentResponse::Permission { approved: false },
    ] {
        unsupported(
            agent
                .respond("request", response, AgentControlOptions::default())
                .await,
            "agent.respond",
        );
    }
    unsupported(agent.state(), "agent.state");
    unsupported(agent.config(), "agent.config");
    unsupported(agent.capabilities(), "agent.capabilities");
}

#[tokio::test]
async fn turn_operations_return_unsupported() {
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
