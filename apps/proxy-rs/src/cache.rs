// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! Short-lived caches in front of the BoxLite API.
//!
//! Redis is used when configured so every proxy replica shares one view of
//! runner placement and preview authorisation; otherwise entries stay in
//! process, which is enough for a single local instance.

use std::marker::PhantomData;
use std::time::{Duration, Instant};

use redis::AsyncCommands;
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::config::RedisConfig;
use crate::error::{ProxyError, Result};

/// Bounds the in-process cache; box IDs are attacker-supplied, so an unbounded
/// map would be a memory-exhaustion vector.
const MEMORY_CACHE_CAPACITY: u64 = 100_000;

/// A connection shared by every cache, mirroring how one Redis client serves all
/// key prefixes.
#[derive(Clone)]
pub struct RedisPool(redis::aio::ConnectionManager);

impl RedisPool {
    pub async fn connect(config: &RedisConfig) -> std::result::Result<Self, redis::RedisError> {
        use redis::IntoConnectionInfo;

        let address = if config.tls {
            redis::ConnectionAddr::TcpTls {
                host: config.host.clone(),
                port: config.port,
                insecure: false,
                tls_params: None,
            }
        } else {
            redis::ConnectionAddr::Tcp(config.host.clone(), config.port)
        };

        let mut credentials = redis::RedisConnectionInfo::default();
        if let Some(username) = &config.username {
            credentials = credentials.set_username(username);
        }
        if let Some(password) = &config.password {
            credentials = credentials.set_password(password);
        }

        let client = redis::Client::open(
            address
                .into_connection_info()?
                .set_redis_settings(credentials),
        )?;
        Ok(Self(redis::aio::ConnectionManager::new(client).await?))
    }
}

/// A TTL cache of `T` keyed by string.
///
/// Keys are never logged: some of them embed a preview token or bearer token
/// (see [`crate::proxy::Proxy`]'s validation cache), so a failure logs which
/// cache failed, not which entry.
pub struct Cache<T> {
    backend: Backend<T>,
}

enum Backend<T> {
    Memory(moka::future::Cache<String, (T, Duration)>),
    Redis {
        connection: redis::aio::ConnectionManager,
        key_prefix: String,
        _value: PhantomData<T>,
    },
}

impl<T> Cache<T>
where
    T: Clone + Send + Sync + Serialize + DeserializeOwned + 'static,
{
    pub fn in_memory() -> Self {
        Self {
            backend: Backend::Memory(
                moka::future::Cache::builder()
                    .max_capacity(MEMORY_CACHE_CAPACITY)
                    .expire_after(PerEntryTtl)
                    .build(),
            ),
        }
    }

    pub fn redis(pool: &RedisPool, key_prefix: &str) -> Self {
        Self {
            backend: Backend::Redis {
                connection: pool.0.clone(),
                key_prefix: key_prefix.to_string(),
                _value: PhantomData,
            },
        }
    }

    /// A cache miss and a cache failure are the same thing to callers: go ask
    /// the API. Failures are logged rather than propagated so Redis being down
    /// degrades latency, not availability.
    pub async fn get(&self, key: &str) -> Option<T> {
        match &self.backend {
            Backend::Memory(cache) => cache.get(key).await.map(|(value, _)| value),
            Backend::Redis {
                connection,
                key_prefix,
                ..
            } => {
                let mut connection = connection.clone();
                let encoded: Option<String> = match connection
                    .get(format!("{key_prefix}{key}"))
                    .await
                {
                    Ok(encoded) => encoded,
                    Err(err) => {
                        tracing::error!(cache = key_prefix, error = %err, "failed to read cache");
                        return None;
                    }
                };
                match serde_json::from_str::<Envelope<T>>(encoded.as_deref()?) {
                    Ok(envelope) => Some(envelope.value),
                    Err(err) => {
                        tracing::error!(cache = key_prefix, error = %err, "failed to decode cached value");
                        None
                    }
                }
            }
        }
    }

    pub async fn set(&self, key: &str, value: T, ttl: Duration) {
        match &self.backend {
            Backend::Memory(cache) => cache.insert(key.to_string(), (value, ttl)).await,
            Backend::Redis {
                connection,
                key_prefix,
                ..
            } => {
                let encoded = match serde_json::to_string(&Envelope { value }) {
                    Ok(encoded) => encoded,
                    Err(err) => {
                        tracing::error!(cache = key_prefix, error = %err, "failed to encode value for cache");
                        return;
                    }
                };
                let mut connection = connection.clone();
                let stored: std::result::Result<(), _> = connection
                    .set_ex(format!("{key_prefix}{key}"), encoded, ttl.as_secs().max(1))
                    .await;
                if let Err(err) = stored {
                    tracing::error!(cache = key_prefix, error = %err, "failed to write cache");
                }
            }
        }
    }

    /// Unlike [`Cache::get`], a backend failure here is an error: the only
    /// caller uses it to decide whether to skip work, and skipping on a
    /// transport error would silently stop activity reporting.
    pub async fn has(&self, key: &str) -> Result<bool> {
        match &self.backend {
            Backend::Memory(cache) => Ok(cache.contains_key(key)),
            Backend::Redis {
                connection,
                key_prefix,
                ..
            } => {
                let mut connection = connection.clone();
                connection
                    .exists(format!("{key_prefix}{key}"))
                    .await
                    .map_err(|err| ProxyError::internal(format!("cache lookup failed: {err}")))
            }
        }
    }
}

/// Matches the `{"value": …}` envelope written by the Go proxy so both can read
/// the same Redis keys during a rollout.
#[derive(Serialize, serde::Deserialize)]
struct Envelope<T> {
    value: T,
}

struct PerEntryTtl;

impl<K, V> moka::Expiry<K, (V, Duration)> for PerEntryTtl {
    fn expire_after_create(
        &self,
        _key: &K,
        value: &(V, Duration),
        _created_at: Instant,
    ) -> Option<Duration> {
        Some(value.1)
    }

    fn expire_after_update(
        &self,
        _key: &K,
        value: &(V, Duration),
        _updated_at: Instant,
        _duration_until_expiry: Option<Duration>,
    ) -> Option<Duration> {
        Some(value.1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stores_and_reads_back_values() {
        let cache: Cache<String> = Cache::in_memory();
        cache
            .set("box-1", "runner-a".to_string(), Duration::from_secs(60))
            .await;

        assert_eq!(cache.get("box-1").await.as_deref(), Some("runner-a"));
        assert!(cache.has("box-1").await.expect("memory cache never fails"));
        assert_eq!(cache.get("box-2").await, None);
    }

    // Real time, not a paused tokio clock: moka expires against the system
    // clock, which `tokio::time::advance` does not move.
    #[tokio::test]
    async fn honours_per_entry_ttl() {
        let cache: Cache<bool> = Cache::in_memory();
        cache.set("short", true, Duration::from_millis(30)).await;
        cache.set("long", true, Duration::from_secs(120)).await;

        tokio::time::sleep(Duration::from_millis(150)).await;

        assert_eq!(
            cache.get("short").await,
            None,
            "30ms entry should have expired"
        );
        assert_eq!(
            cache.get("long").await,
            Some(true),
            "120s entry should survive"
        );
    }
}
