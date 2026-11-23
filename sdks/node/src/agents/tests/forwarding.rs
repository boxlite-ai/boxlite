use super::*;
use serde_json::json;

#[test]
fn agent_bindings_forward_to_core_test_backend() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let home = std::env::temp_dir().join(format!("boxlite-node-agent-{}", std::process::id()));
        let runtime = boxlite::BoxliteRuntime::new_for_test(boxlite::BoxliteOptions {
            home_dir: home.clone(),
            ..Default::default()
        })
        .unwrap();
        let sandbox = runtime
            .create(
                boxlite::BoxOptions {
                    rootfs: boxlite::RootfsSpec::Image("alpine:latest".into()),
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();
        let agents = JsAgents::from_core(sandbox.agents().with_test_backend());
        let empty = JsAgents::new();
        assert!(empty.create("test".into(), None).await.is_err());
        assert!(empty.get("agent-1".into()).await.is_err());
        assert!(agents.create("test".into(), Some(json!(7))).await.is_err());
        assert!(
            agents
                .create("test".into(), Some(json!({"extra":true})))
                .await
                .is_err()
        );
        assert!(
            agents
                .create("test".into(), Some(json!({"cwd":7})))
                .await
                .is_err()
        );
        let agent = agents
            .create("test".into(), Some(json!({"config": {"model": "m"}})))
            .await
            .unwrap();
        assert_eq!(agent.state().unwrap()["id"], "agent-1");
        assert_eq!(agent.config().unwrap()["tools"], json!([]));
        assert_eq!(
            agent.capabilities().unwrap()["operations"],
            json!(["agent.send"])
        );
        assert_eq!(
            agents.get("agent-1".into()).await.unwrap().state().unwrap()["id"],
            "agent-1"
        );
        let turn = agent
            .send("hello".into(), Some(json!({"mode": "reject"})))
            .await
            .unwrap();
        assert_eq!(turn.state().unwrap()["id"], "turn-1");
        assert_eq!(
            turn.wait(Some(json!({"timeoutSeconds": 1}))).await.unwrap()["text"],
            "hello"
        );
        assert_eq!(
            agent
                .get_turn("turn-1".into())
                .await
                .unwrap()
                .state()
                .unwrap()["id"],
            "turn-1"
        );
        assert_eq!(agent.requests().await.unwrap()[0]["id"], "request-1");
        let reply = agent
            .respond(
                "request-1".into(),
                json!({"type":"answer", "text":"yes"}),
                None,
            )
            .await
            .unwrap();
        assert_eq!(reply.wait(None).await.unwrap()["text"], "yes");
        let payload = json!([{"$serde_json::private::Number":"hello"}]);
        let turn = agent
            .send("echo".into(), Some(json!({"data": payload})))
            .await
            .unwrap();
        assert_eq!(turn.wait(None).await.unwrap()["data"], payload);
        assert_eq!(turn.state().unwrap()["result"]["data"], payload);
        assert!(
            agent
                .send("bad".into(), Some(json!({"mode":"bad"})))
                .await
                .is_err()
        );
        assert!(turn.wait(Some(json!({"timeoutSeconds":-1}))).await.is_err());
        assert!(
            turn.wait(Some(json!({"timeoutSeconds":"bad"})))
                .await
                .is_err()
        );
        assert!(agent.send("bad".into(), Some(json!(7))).await.is_err());
        assert!(
            agent
                .send("bad".into(), Some(json!({"extra":true})))
                .await
                .is_err()
        );
        assert!(
            agent
                .respond("request-1".into(), json!({"type":"bad"}), None)
                .await
                .is_err()
        );
        assert!(turn.steer("x".into(), None).await.is_err());
        assert!(turn.interrupt(None).await.is_err());
        assert!(agent.close(None).await.is_err());
        let events = agent.events(Some(json!({"after":"events"}))).unwrap();
        events.opened().await.unwrap();
        assert_eq!(events.next_event().await.unwrap().unwrap()["kind"], "first");
        assert_eq!(
            events.next_event().await.unwrap().unwrap()["kind"],
            "second"
        );
        events.close().await;
        assert!(events.next_event().await.unwrap().is_none());
        assert!(events.opened().await.is_err());
        let errors = agent.events(Some(json!({"after":"read-error"}))).unwrap();
        assert_eq!(errors.next_event().await.unwrap().unwrap()["kind"], "first");
        assert!(errors.next_event().await.is_err());
        assert!(errors.next_event().await.unwrap().is_none());
        errors.close().await;
        let failed = agent.events(Some(json!({"after":"open-error"}))).unwrap();
        assert!(failed.opened().await.is_err());
        failed.close().await;
        let turn_events = turn.events(None).unwrap();
        turn_events.opened().await.unwrap();
        assert!(turn_events.next_event().await.unwrap().is_none());
        turn_events.close().await;
        drop(runtime);
        let _ = std::fs::remove_dir_all(home);
    });
}
