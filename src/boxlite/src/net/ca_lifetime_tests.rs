use super::*;
use x509_cert::{Certificate, der::DecodePem};

// Exercise the portable trust installer on macOS as well as Linux.
#[path = "../../../guest/src/ca_trust.rs"]
mod ca_trust;

/// Model a legacy 24-hour CA with a caller-selected expiry.
fn short_lived_ca(key: &KeyPair, expires: OffsetDateTime) -> String {
    let mut params = CertificateParams::default();
    params.distinguished_name = DistinguishedName::new();
    params
        .distinguished_name
        .push(DnType::CommonName, "BoxLite MITM CA");
    params.is_ca = IsCa::Ca(rcgen::BasicConstraints::Constrained(0));
    params.not_before = expires - Duration::hours(24);
    params.not_after = expires;
    params.self_signed(key).unwrap().pem()
}

fn assert_long_lived(pem: &str) {
    let cert = Certificate::from_pem(pem).unwrap();
    let expires = cert
        .tbs_certificate
        .validity
        .not_after
        .to_unix_duration()
        .as_secs();
    assert!(
        expires > (OffsetDateTime::now_utc() + Duration::days(3649)).unix_timestamp() as u64,
        "CA must remain valid for approximately ten years"
    );
}

#[test]
fn generated_ca_survives_day_two() {
    assert_long_lived(&generate().unwrap().cert_pem);
}

#[test]
fn restart_renews_legacy_ca_and_preserves_key() {
    for remaining in [Duration::hours(-1), Duration::hours(12), Duration::days(31)] {
        let dir = tempfile::tempdir().unwrap();
        let key = KeyPair::generate().unwrap();
        let old = short_lived_ca(&key, OffsetDateTime::now_utc() + remaining);
        std::fs::write(dir.path().join("cert.pem"), &old).unwrap();
        write_private_key(&dir.path().join("key.pem"), &key.serialize_pem()).unwrap();

        let renewed = load_or_generate(dir.path()).unwrap();
        assert_ne!(renewed.cert_pem, old, "restart must replace the legacy CA");
        assert_eq!(renewed.key_pem, key.serialize_pem());
        assert_long_lived(&renewed.cert_pem);
        assert_eq!(
            load_or_generate(dir.path()).unwrap().cert_pem,
            renewed.cert_pem
        );
    }
}

#[test]
fn invalid_persisted_ca_material_is_rejected_without_overwriting_it() {
    let key = KeyPair::generate().unwrap();
    let expired = short_lived_ca(&key, OffsetDateTime::now_utc() - Duration::hours(1));
    for (cert_pem, key_pem) in [
        ("invalid", key.serialize_pem()),
        (expired.as_str(), "invalid".into()),
    ] {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("cert.pem"), cert_pem).unwrap();
        write_private_key(&dir.path().join("key.pem"), &key_pem).unwrap();
        assert!(load_or_generate(dir.path()).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("cert.pem")).unwrap(),
            cert_pem
        );
    }
}

#[test]
fn trust_renewal_removes_old_certificate_and_preserves_other_roots() {
    let dir = tempfile::tempdir().unwrap();
    let bundle = dir.path().join("ca-certificates.crt");
    let key = KeyPair::generate().unwrap();
    let now = OffsetDateTime::now_utc();
    let old = short_lived_ca(&key, now - Duration::hours(1));
    std::fs::write(dir.path().join("cert.pem"), &old).unwrap();
    write_private_key(&dir.path().join("key.pem"), &key.serialize_pem()).unwrap();
    let renewed = load_or_generate(dir.path()).unwrap().cert_pem;
    let unrelated = format!(
        "{}\n-----BEGIN CERTIFICATE-----\nbroken\n-----END CERTIFICATE-----",
        generate().unwrap().cert_pem
    );
    std::fs::write(&bundle, format!("# system roots\n{unrelated}\n{old}")).unwrap();

    let installer = ca_trust::CaInstaller::with_bundle(bundle.clone());
    installer.install(renewed.as_bytes()).unwrap();
    installer.install(renewed.as_bytes()).unwrap();
    let installed = std::fs::read_to_string(bundle).unwrap();
    assert!(
        !installed.contains(old.trim()),
        "expired CA must leave the trust bundle"
    );
    assert!(installed.contains(unrelated.trim()));
    assert!(installed.starts_with("# system roots\n"));
    assert_eq!(installed.matches(renewed.trim()).count(), 1);
}

#[test]
fn invalid_ca_does_not_change_trust_bundle() {
    let dir = tempfile::tempdir().unwrap();
    let bundle = dir.path().join("ca-certificates.crt");
    let original = generate().unwrap().cert_pem;
    std::fs::write(&bundle, &original).unwrap();
    assert!(
        ca_trust::CaInstaller::with_bundle(bundle.clone())
            .install(b"invalid")
            .is_err()
    );
    assert_eq!(std::fs::read_to_string(bundle).unwrap(), original);
}
