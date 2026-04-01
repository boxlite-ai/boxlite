//! Shared types for coordinator-worker communication and state management.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};

/// Unique identifier for a worker node.
pub type WorkerId = String;

// ============================================================================
// ID Generation
// ============================================================================

const BASE62: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// Generate a 12-character Base62 worker ID (same format as BoxID).
pub fn mint_worker_id() -> String {
    let mut rng = rand::rng();
    let mut buf = [0u8; 12];
    for b in &mut buf {
        *b = BASE62[(rng.next_u32() % 62) as usize];
    }
    String::from_utf8(buf.to_vec()).unwrap()
}

// Word lists for Heroku-style names (adjective-noun-XXXX)
const ADJECTIVES: &[&str] = &[
    "aged",
    "ancient",
    "autumn",
    "bold",
    "broad",
    "broken",
    "calm",
    "cold",
    "cool",
    "crimson",
    "curly",
    "damp",
    "dark",
    "dawn",
    "dry",
    "early",
    "empty",
    "fading",
    "falling",
    "flat",
    "floral",
    "fragrant",
    "frosty",
    "gentle",
    "green",
    "hidden",
    "holy",
    "icy",
    "late",
    "lingering",
    "little",
    "lively",
    "long",
    "lucky",
    "misty",
    "morning",
    "muddy",
    "nameless",
    "noisy",
    "odd",
    "old",
    "orange",
    "patient",
    "plain",
    "polished",
    "proud",
    "purple",
    "quiet",
    "rapid",
    "raspy",
    "red",
    "restless",
    "rough",
    "round",
    "royal",
    "shiny",
    "shy",
    "silent",
    "small",
    "snowy",
    "soft",
    "solitary",
    "spring",
    "steep",
    "still",
    "summer",
    "super",
    "sweet",
    "throbbing",
    "tight",
    "tiny",
    "twilight",
    "wandering",
    "weathered",
    "white",
    "wild",
    "winter",
    "wispy",
    "young",
];

const NOUNS: &[&str] = &[
    "bird",
    "breeze",
    "brook",
    "bush",
    "butterfly",
    "cherry",
    "cloud",
    "dawn",
    "dew",
    "dream",
    "dust",
    "feather",
    "field",
    "fire",
    "flower",
    "fog",
    "forest",
    "frost",
    "glade",
    "glitter",
    "grass",
    "haze",
    "hill",
    "lake",
    "leaf",
    "meadow",
    "moon",
    "morning",
    "mountain",
    "night",
    "paper",
    "pine",
    "pond",
    "rain",
    "resonance",
    "ridge",
    "river",
    "sea",
    "shadow",
    "shape",
    "silence",
    "sky",
    "smoke",
    "snow",
    "snowflake",
    "sound",
    "star",
    "stone",
    "sun",
    "sunset",
    "surf",
    "thunder",
    "tree",
    "violet",
    "voice",
    "water",
    "wave",
    "wildflower",
    "wind",
    "wood",
];

/// Generate a Heroku-style human-readable name (e.g., "frosty-meadow-42").
pub fn mint_worker_name() -> String {
    let mut rng = rand::rng();
    let adj = ADJECTIVES[(rng.next_u32() as usize) % ADJECTIVES.len()];
    let noun = NOUNS[(rng.next_u32() as usize) % NOUNS.len()];
    let num = rng.next_u32() % 100;
    format!("{adj}-{noun}-{num}")
}

/// Worker registration record stored in the StateStore.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerInfo {
    pub id: WorkerId,
    /// Human-readable name (e.g., "frosty-meadow-42")
    pub name: String,
    /// gRPC endpoint URL (e.g., "http://10.0.1.5:9100")
    pub url: String,
    /// Arbitrary labels for scheduling affinity.
    pub labels: HashMap<String, String>,
    pub registered_at: DateTime<Utc>,
    pub last_heartbeat: DateTime<Utc>,
    pub status: WorkerStatus,
    pub capacity: WorkerCapacity,
}

/// Worker health status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerStatus {
    /// Accepting new boxes.
    Active,
    /// No new boxes; existing boxes keep running.
    Draining,
    /// Missed heartbeats — not used for placement.
    Unreachable,
    /// Administratively removed.
    Removed,
}

impl WorkerStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Draining => "draining",
            Self::Unreachable => "unreachable",
            Self::Removed => "removed",
        }
    }
}

impl std::fmt::Display for WorkerStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Worker resource capacity.
#[derive(Debug, Clone, Serialize, Deserialize, Default, utoipa::ToSchema)]
pub struct WorkerCapacity {
    pub max_boxes: u32,
    pub available_cpus: u32,
    pub available_memory_mib: u64,
    pub running_boxes: u32,
}

/// Maps a box_id to the worker that owns it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoxMapping {
    pub box_id: String,
    pub worker_id: WorkerId,
    pub namespace: String,
    pub created_at: DateTime<Utc>,
}

/// Request context for the scheduler to pick a worker.
#[derive(Debug, Clone, Default)]
pub struct ScheduleRequest {
    pub cpus: Option<u8>,
    pub memory_mib: Option<u32>,
}
