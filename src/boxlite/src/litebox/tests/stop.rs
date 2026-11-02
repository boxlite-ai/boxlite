use super::*;
use crate::litebox::config::ContainerRuntimeConfig;
use crate::runtime::id::BoxIDMint;
use crate::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec};
use crate::runtime::rt_impl::RuntimeImpl;
use crate::runtime::types::ContainerID;
use crate::vmm::VmmKind;
use chrono::Utc;
use tempfile::TempDir;

#[tokio::test]
async fn stop_ordinary_vm_clears_persisted_health() {
    use crate::litebox::state::HealthState;

    for health in [HealthState::Healthy, HealthState::Unhealthy] {
        let temp_dir = TempDir::new_in("/tmp").expect("create temp dir");
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: temp_dir.path().to_path_buf(),
            image_registries: vec![],
            ..Default::default()
        })
        .expect("create runtime");
        let id = BoxIDMint::mint();
        let config = BoxConfig {
            id: id.clone(),
            name: None,
            created_at: Utc::now(),
            container: ContainerRuntimeConfig {
                id: ContainerID::new(),
            },
            options: BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                auto_delete: Some(0),
                ..Default::default()
            },
            engine_kind: VmmKind::Libkrun,
            box_home: runtime.layout.boxes_dir().join(id.as_str()),
        };
        let mut state = BoxState::new();
        state.status = BoxStatus::Running;
        state.set_lock_id(runtime.lock_manager.allocate().expect("allocate lock"));
        state.mark_health_check_success();
        state.mark_health_check_failure(if health == HealthState::Unhealthy {
            1
        } else {
            2
        });
        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("persist test box");

        // Avoid runtime.get's watcher so only stop can clear persisted health.
        let box_impl = BoxImpl::new(
            config,
            state,
            runtime.clone(),
            runtime.shutdown_token.child_token(),
        );
        assert!(!box_impl.live.initialized());
        assert!(!box_impl.layout.pid_file_path().exists());

        box_impl.stop().await.expect("stop ordinary box");

        let persisted = runtime
            .box_manager
            .update_box(&id)
            .expect("reload stopped box");
        assert_eq!(persisted.status, BoxStatus::Stopped);
        assert_eq!(
            persisted.health_status.state,
            HealthState::None,
            "{health:?}"
        );
        assert_eq!(persisted.health_status.failures, 0, "{health:?}");
        assert!(persisted.health_status.last_check.is_none(), "{health:?}");
        assert_eq!(box_impl.state.read().health_status, persisted.health_status);
    }
}
