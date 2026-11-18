use super::*;

/// A complete cache fixture with real content digests for destructive tests.
pub(crate) async fn seed_removable_build(
    store: &ImageStore,
    image_ref: &str,
    manifest_digest: &str,
) -> ImageManifest {
    use sha2::{Digest, Sha256};
    let config =
        br#"{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}"#;
    let config_digest = format!("sha256:{}", hex::encode(Sha256::digest(config)));
    let layer_digest = format!("sha256:{}", hex::encode(Sha256::digest(b"")));
    let storage = store.storage().await;
    use tokio::io::AsyncWriteExt;
    let mut staged_config = storage.stage_config_download(&config_digest).await.unwrap();
    staged_config.file().write_all(config).await.unwrap();
    assert!(staged_config.commit().await.unwrap());
    assert!(
        storage
            .stage_layer_download(&layer_digest, 0)
            .await
            .unwrap()
            .commit()
            .await
            .unwrap()
    );
    let oci = oci_client::manifest::OciImageManifest {
        schema_version: 2,
        config: oci_client::manifest::OciDescriptor {
            digest: config_digest.clone(),
            size: config.len() as i64,
            media_type: "application/vnd.oci.image.config.v1+json".into(),
            ..Default::default()
        },
        layers: vec![oci_client::manifest::OciDescriptor {
            digest: layer_digest.clone(),
            size: 0,
            media_type: "application/vnd.oci.image.layer.v1.tar+gzip".into(),
            ..Default::default()
        }],
        ..Default::default()
    };
    storage
        .save_manifest(
            &oci_client::manifest::OciManifest::Image(oci),
            manifest_digest,
        )
        .unwrap();
    let manifest = ImageManifest {
        manifest_digest: manifest_digest.into(),
        config_digest,
        layers: vec![LayerInfo {
            digest: layer_digest,
            size: 0,
            media_type: "application/vnd.oci.image.layer.v1.tar+gzip".into(),
        }],
        diff_ids: vec![],
    };
    store.update_index(image_ref, &manifest).await.unwrap();
    manifest
}
