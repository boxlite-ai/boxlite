use super::*;

fn checkpoint_options() -> JsBoxOptions {
    JsBoxOptions {
        image: None,
        rootfs_path: None,
        checkpoint: Some("base".into()),
        cpus: None,
        memory_mib: None,
        disk_size_gb: None,
        working_dir: None,
        env: None,
        volumes: None,
        network: None,
        ports: None,
        auto_remove: None,
        auto_stop: None,
        auto_delete: None,
        auto_resume: None,
        detach: None,
        entrypoint: None,
        cmd: None,
        user: None,
        advanced: None,
        security: None,
        health_check: None,
        secrets: None,
    }
}

#[test]
fn checkpoint_conversion_rejects_explicit_defaults_and_empty_collections() {
    let plain = BoxOptions::try_from(checkpoint_options()).unwrap();
    assert!(matches!(plain.rootfs, RootfsSpec::Checkpoint(_)));
    let mutations: &[fn(&mut JsBoxOptions)] = &[
        |o| o.auto_remove = Some(true),
        |o| o.detach = Some(false),
        |o| {
            o.advanced = Some(JsAdvancedBoxOptions {
                privileged: Some(false),
                capabilities: None,
            })
        },
        |o| o.env = Some(vec![]),
        |o| o.volumes = Some(vec![]),
        |o| o.ports = Some(vec![]),
        |o| o.secrets = Some(vec![]),
        |o| o.entrypoint = Some(vec![]),
        |o| o.cmd = Some(vec![]),
        |o| {
            o.network = Some(JsNetworkSpec {
                outbound: None,
                inbound: None,
                mode: None,
                allow_net: None,
            })
        },
    ];
    let mut ignored = Vec::new();
    for (index, mutate) in mutations.iter().enumerate() {
        let mut options = checkpoint_options();
        mutate(&mut options);
        if !matches!(
            BoxOptions::try_from(options),
            Err(boxlite::BoxliteError::InvalidArgument(_))
        ) {
            ignored.push(index);
        }
    }
    assert!(
        ignored.is_empty(),
        "silently accepted checkpoint overrides: {ignored:?}"
    );
}
