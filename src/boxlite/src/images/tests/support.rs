#[cfg(test)]
use super::ImageManager;

#[cfg(test)]
pub(crate) use super::store::tests::registry_answering;

/// Put a build in `images`' cache under `image_ref`, as a pull leaves it.
#[cfg(test)]
pub(crate) async fn seed_cached_build(images: &ImageManager, image_ref: &str, digest: &str) {
    super::store::tests::seed_cached_build(images.store(), image_ref, digest).await;
}

/// A real SQLite/cache fixture for SDK and CLI removal tests, without a VM.
pub struct LocalImageFixture {
    runtime: Option<crate::BoxliteRuntime>,
    pub home: tempfile::TempDir,
    pub image_id: String,
    pub manifest_path: std::path::PathBuf,
    index: crate::db::ImageIndexStore,
    cached: crate::db::CachedImage,
}

impl LocalImageFixture {
    pub fn new() -> Self {
        use sha2::{Digest, Sha256};
        let home = tempfile::tempdir().unwrap();
        let runtime = crate::BoxliteRuntime::new_for_test(crate::BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            ..Default::default()
        })
        .unwrap();
        let db = crate::db::Database::open(&home.path().join("db/boxlite.db")).unwrap();
        let index = crate::db::ImageIndexStore::new(db);
        let storage = super::storage::ImageStorage::new(home.path().join("images")).unwrap();
        let digest = |bytes: &[u8]| format!("sha256:{}", hex::encode(Sha256::digest(bytes)));
        let config =
            br#"{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}"#;
        let config_digest = digest(config);
        let layer_digest = digest(b"");
        let manifest = oci_client::manifest::OciImageManifest {
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
        let image_id = digest(&serde_json::to_vec(&manifest).unwrap());
        storage
            .save_manifest(
                &oci_client::manifest::OciManifest::Image(manifest),
                &image_id,
            )
            .unwrap();
        std::fs::write(storage.config_path(&config_digest), config).unwrap();
        std::fs::write(storage.layer_tarball_path(&layer_digest), b"").unwrap();
        let cached = crate::db::CachedImage {
            manifest_digest: image_id.clone(),
            config_digest,
            layers: vec![layer_digest],
            cached_at: "2026-01-01T00:00:00Z".into(),
            complete: true,
        };
        for repository in ["one.example/app", "two.example/app"] {
            index
                .upsert(&format!("{repository}@{image_id}"), &cached)
                .unwrap();
        }
        let manifest_path = storage.manifest_path(&image_id);
        Self {
            runtime: Some(runtime),
            home,
            image_id,
            manifest_path,
            index,
            cached,
        }
    }

    pub fn add_tag(&self) {
        self.index
            .upsert("one.example/app:latest", &self.cached)
            .unwrap();
    }

    pub fn runtime(&self) -> &crate::BoxliteRuntime {
        self.runtime.as_ref().expect("fixture runtime was released")
    }

    pub fn release_runtime(&mut self) {
        self.runtime.take();
    }

    pub fn add_image_id(&self, image_id: &str, reference: &str) {
        let mut cached = self.cached.clone();
        cached.manifest_digest = image_id.into();
        self.index.upsert(reference, &cached).unwrap();
    }

    pub fn has_reference(&self, reference: &str) -> bool {
        self.index.get(reference).unwrap().is_some()
    }
}

impl Default for LocalImageFixture {
    fn default() -> Self {
        Self::new()
    }
}
