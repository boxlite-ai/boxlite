// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! Tamper-proof cookie values.
//!
//! The proxy hands clients two things it must trust on the way back: the box ID
//! a browser has already authenticated for, and a PKCE verifier. Both are signed
//! with the proxy API key rather than stored server-side, so any replica can
//! validate them.
//!
//! Values are signed, not encrypted — a client may read its own box ID, it just
//! may not change it.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum CookieError {
    #[error("malformed signed cookie")]
    Malformed,

    #[error("signed cookie failed verification")]
    BadSignature,

    #[error("signed cookie has expired")]
    Expired,
}

#[derive(Clone)]
pub struct CookieSigner {
    key: Vec<u8>,
}

impl CookieSigner {
    pub fn new(key: &str) -> Self {
        Self {
            key: key.as_bytes().to_vec(),
        }
    }

    /// Signs `value` for use under exactly `name`; the name is covered by the
    /// signature so a cookie minted for one box cannot be presented for another.
    pub fn encode(&self, name: &str, value: &str) -> String {
        let issued_at = unix_seconds(SystemTime::now());
        let encoded_value = BASE64.encode(value);
        let signature = self.sign(name, issued_at, &encoded_value);
        format!("{encoded_value}|{issued_at}|{signature}")
    }

    pub fn decode(
        &self,
        name: &str,
        cookie: &str,
        max_age: Duration,
    ) -> Result<String, CookieError> {
        let mut parts = cookie.split('|');
        let (Some(encoded_value), Some(issued_at), Some(signature), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(CookieError::Malformed);
        };
        let issued_at: u64 = issued_at.parse().map_err(|_| CookieError::Malformed)?;

        let expected = BASE64
            .decode(signature)
            .map_err(|_| CookieError::Malformed)?;
        let mac = self.mac(name, issued_at, encoded_value);
        mac.verify_slice(&expected)
            .map_err(|_| CookieError::BadSignature)?;

        // Checked only after the signature, so an attacker cannot learn anything
        // from the difference between "expired" and "forged".
        if unix_seconds(SystemTime::now()).saturating_sub(issued_at) > max_age.as_secs() {
            return Err(CookieError::Expired);
        }

        let value = BASE64
            .decode(encoded_value)
            .map_err(|_| CookieError::Malformed)?;
        String::from_utf8(value).map_err(|_| CookieError::Malformed)
    }

    fn sign(&self, name: &str, issued_at: u64, encoded_value: &str) -> String {
        BASE64.encode(
            self.mac(name, issued_at, encoded_value)
                .finalize()
                .into_bytes(),
        )
    }

    fn mac(&self, name: &str, issued_at: u64, encoded_value: &str) -> HmacSha256 {
        let mut mac =
            HmacSha256::new_from_slice(&self.key).expect("HMAC accepts keys of any length");
        mac.update(name.as_bytes());
        mac.update(b"|");
        mac.update(issued_at.to_string().as_bytes());
        mac.update(b"|");
        mac.update(encoded_value.as_bytes());
        mac
    }
}

fn unix_seconds(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: Duration = Duration::from_secs(3600);

    #[test]
    fn round_trips_a_value() {
        let signer = CookieSigner::new("proxy-api-key");
        let cookie = signer.encode("boxlite-box-auth-abc", "53MOZ3jp5Zu1");

        assert_eq!(
            signer.decode("boxlite-box-auth-abc", &cookie, HOUR),
            Ok("53MOZ3jp5Zu1".to_string())
        );
    }

    #[test]
    fn rejects_a_cookie_signed_with_another_key() {
        let cookie = CookieSigner::new("key-a").encode("name", "value");

        assert_eq!(
            CookieSigner::new("key-b").decode("name", &cookie, HOUR),
            Err(CookieError::BadSignature)
        );
    }

    #[test]
    fn rejects_a_cookie_replayed_under_a_different_name() {
        let signer = CookieSigner::new("proxy-api-key");
        let cookie = signer.encode("boxlite-box-auth-victim", "victim-box");

        assert_eq!(
            signer.decode("boxlite-box-auth-attacker", &cookie, HOUR),
            Err(CookieError::BadSignature)
        );
    }

    #[test]
    fn rejects_a_tampered_value() {
        let signer = CookieSigner::new("proxy-api-key");
        let cookie = signer.encode("name", "box-one");
        let forged = format!(
            "{}|{}",
            BASE64.encode("box-two"),
            &cookie[cookie.find('|').unwrap() + 1..]
        );

        assert_eq!(
            signer.decode("name", &forged, HOUR),
            Err(CookieError::BadSignature)
        );
    }

    #[test]
    fn rejects_a_cookie_older_than_its_max_age() {
        let signer = CookieSigner::new("proxy-api-key");
        let issued_at = unix_seconds(SystemTime::now()) - 7200;
        let encoded_value = BASE64.encode("53MOZ3jp5Zu1");
        let signature = signer.sign("name", issued_at, &encoded_value);
        let cookie = format!("{encoded_value}|{issued_at}|{signature}");

        assert_eq!(
            signer.decode("name", &cookie, HOUR),
            Err(CookieError::Expired)
        );
    }

    #[test]
    fn rejects_structurally_invalid_cookies() {
        let signer = CookieSigner::new("proxy-api-key");

        for cookie in ["", "one-part", "a|b", "a|b|c|d", "a|not-a-number|c"] {
            assert!(
                matches!(
                    signer.decode("name", cookie, HOUR),
                    Err(CookieError::Malformed | CookieError::BadSignature)
                ),
                "expected {cookie:?} to be rejected"
            );
        }
    }
}
